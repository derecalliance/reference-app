#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 DeRec Alliance. All rights reserved.
#
# Publish the node image to the GitHub Container Registry.
#
#   scripts/publish-image.sh                 check, confirm, build, push, verify
#   scripts/publish-image.sh --dry-run       run every check and print the build; push nothing
#   scripts/publish-image.sh --local         rehearse against a registry on this machine
#
# Options:
#   --yes              do not ask for confirmation
#   --platforms LIST   default linux/amd64,linux/arm64
#   --image NAME       default ghcr.io/derecalliance/reference-app
#
# What gets published is the version in apps/backend/Cargo.toml (see
# scripts/version.sh), built from the commit tagged v<version>, for both
# platforms. A pre-release (0.0.8-alpha.1) is pushed under its own tag only; a
# release (0.0.8) also moves `latest`. A version already in the registry is
# never overwritten: publish the next pre-release instead.
#
# Before the first run: `docker login ghcr.io` with a token that can write
# packages. After the first push, make the package public in its settings on
# GitHub (GHCR creates it private).

set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE=ghcr.io/derecalliance/reference-app
PLATFORMS=linux/amd64,linux/arm64
LOCAL_REGISTRY=localhost:5055
LOCAL_REGISTRY_CONTAINER=derec-registry
DOCS_URL=https://github.com/derecalliance/reference-app/blob/main/docs/DOCKER.md
DESCRIPTION="Reference DeRec Owner and Helper for interoperability testing: web UI and backend in one image."

DRY_RUN=0
LOCAL=0
ASSUME_YES=0

usage() { sed -n '5,24p' "$0" | sed 's/^# \{0,1\}//'; }
bold() { printf '\033[1m%s\033[0m' "$*"; }
step() { printf '\n\033[1m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
# A problem, then one indented line per detail.
report() {
  printf '  %b %s\n' "$1" "$2" >&2
  shift 2
  local line
  for line in "$@"; do printf '    %s\n' "$line" >&2; done
}
warn() { report '\033[33m!\033[0m' "$@"; }
fail() {
  report '\033[31m✗\033[0m' "$@"
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --local) LOCAL=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --image)
      [ $# -ge 2 ] || fail "--image needs a name"
      IMAGE="$2"
      shift
      ;;
    --platforms)
      [ $# -ge 2 ] || fail "--platforms needs a list"
      PLATFORMS="$2"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) fail "unknown option: $1" "try --help" ;;
  esac
  shift
done

[ "$LOCAL" = 1 ] && IMAGE="$LOCAL_REGISTRY/derecalliance/reference-app"
REGISTRY="${IMAGE%%/*}"

# ── Preflight ───────────────────────────────────────────────────────────────

step "Checking the release"

for tool in git docker perl; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed"
done
docker buildx version >/dev/null 2>&1 || fail "docker buildx is not available" "Docker Desktop includes it; on Linux install the buildx plugin."
docker info >/dev/null 2>&1 || fail "the Docker daemon is not running"
ok "tools: git, docker, buildx"

scripts/version.sh check >/dev/null || { scripts/version.sh check; exit 1; }
VERSION=$(scripts/version.sh)
SDK="${VERSION%%-*}"
if [ "$VERSION" = "$SDK" ]; then
  PRERELEASE=0
  TAGS=("$VERSION" latest)
else
  PRERELEASE=1
  TAGS=("$VERSION")
fi
ok "version $VERSION, consistent everywhere, built against SDK $SDK"

REVISION=$(git rev-parse HEAD)
SHORT_REVISION=$(git rev-parse --short HEAD)
GIT_TAG="v$VERSION"

# The image must be exactly a commit anyone can check out: no local edits, and
# nothing untracked in apps/, which is what the build copies in.
SOURCE="$GIT_TAG ($SHORT_REVISION)"

check_source() {
  local dirty untracked tagged
  dirty=$(git status --porcelain --untracked-files=no)
  untracked=$(git ls-files --others --exclude-standard -- apps)
  tagged=$(git rev-parse -q --verify "refs/tags/$GIT_TAG^{commit}" || true)

  if [ -n "$dirty" ] || [ -n "$untracked" ] || [ "$tagged" != "$REVISION" ]; then
    SOURCE="working tree at $SHORT_REVISION, not a release commit"
  fi
  if [ -n "$dirty" ]; then
    $1 "the working tree has uncommitted changes" "Commit or stash them: the image must be built from the tagged commit."
  else
    ok "working tree clean"
  fi
  if [ -n "$untracked" ]; then
    $1 "untracked files under apps/ would be built into the image:" $untracked
  fi
  if [ -z "$tagged" ]; then
    $1 "tag $GIT_TAG does not exist" "Create it on the release commit:  git tag -a $GIT_TAG -m \"Release $VERSION\""
  elif [ "$tagged" != "$REVISION" ]; then
    $1 "tag $GIT_TAG points at $(git rev-parse --short "$tagged"), not HEAD ($SHORT_REVISION)" "Check out the tag:  git checkout $GIT_TAG"
  else
    ok "HEAD is $GIT_TAG ($SHORT_REVISION)"
  fi
}

if [ "$LOCAL" = 1 ]; then
  # A rehearsal may run on work in progress; say so, but carry on.
  check_source warn
else
  check_source fail
  git remote get-url origin >/dev/null 2>&1 || fail "no 'origin' remote to check the tag against"
  git ls-remote --exit-code --tags origin "refs/tags/$GIT_TAG" >/dev/null 2>&1 ||
    fail "tag $GIT_TAG is not on origin" "Push it, so the image's source revision can be found:  git push origin $GIT_TAG"
  ok "tag $GIT_TAG is on origin"
fi

# Every requested platform must be buildable by the active builder.
BUILDER_PLATFORMS=$(docker buildx inspect --bootstrap 2>/dev/null | sed -n 's/^Platforms: *//p' | tr -d ' *' | tr ',' '\n')
IFS=',' read -r -a REQUESTED <<<"$PLATFORMS"
for platform in "${REQUESTED[@]}"; do
  grep -qx "$platform" <<<"$BUILDER_PLATFORMS" ||
    fail "the active buildx builder cannot build $platform" "Install QEMU emulation (docker run --privileged --rm tonistiigi/binfmt --install all) or pick a builder that can."
done
ok "builder supports $PLATFORMS"

if [ "$LOCAL" = 1 ]; then
  if [ "$DRY_RUN" = 0 ] && [ -z "$(docker ps -q --filter "name=^${LOCAL_REGISTRY_CONTAINER}$")" ]; then
    if [ -n "$(docker ps -aq --filter "name=^${LOCAL_REGISTRY_CONTAINER}$")" ]; then
      docker start "$LOCAL_REGISTRY_CONTAINER" >/dev/null
    else
      docker run -d --name "$LOCAL_REGISTRY_CONTAINER" --restart unless-stopped \
        -p "${LOCAL_REGISTRY#localhost:}:5000" registry:2 >/dev/null
    fi
  fi
  ok "local registry at $LOCAL_REGISTRY (container $LOCAL_REGISTRY_CONTAINER)"
else
  DOCKER_CONFIG_FILE="${DOCKER_CONFIG:-$HOME/.docker}/config.json"
  grep -q "\"$REGISTRY\"" "$DOCKER_CONFIG_FILE" 2>/dev/null ||
    fail "not logged in to $REGISTRY" "Log in with a GitHub token that has write:packages:" \
      "echo \"\$GITHUB_TOKEN\" | docker login $REGISTRY -u <github-user> --password-stdin"
  ok "logged in to $REGISTRY"

  # Published versions are immutable: users pin them, and caches keep them.
  if docker buildx imagetools inspect "$IMAGE:$VERSION" >/dev/null 2>&1; then
    fail "$IMAGE:$VERSION is already published" "Versions are never overwritten. Publish the next one:  scripts/version.sh set <next>"
  fi
  ok "$IMAGE:$VERSION is not published yet"
fi

# ── Plan ────────────────────────────────────────────────────────────────────

CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TAG_ARGS=()
for tag in "${TAGS[@]}"; do TAG_ARGS+=(-t "$IMAGE:$tag"); done

# Labels live in the Dockerfile; these build args fill them in. The index
# annotations are what a registry shows for a multi-platform image (GHCR reads
# its package description from them).
BUILD=(
  docker buildx build
  --file apps/backend/Dockerfile
  --platform "$PLATFORMS"
  --build-arg "VERSION=$VERSION"
  --build-arg "REVISION=$REVISION"
  --build-arg "CREATED=$CREATED"
  --annotation "index:org.opencontainers.image.description=$DESCRIPTION"
  --annotation "index:org.opencontainers.image.source=https://github.com/derecalliance/reference-app"
  --annotation "index:org.opencontainers.image.documentation=$DOCS_URL"
  --annotation "index:org.opencontainers.image.licenses=Apache-2.0"
  --annotation "index:org.opencontainers.image.version=$VERSION"
  --annotation "index:org.opencontainers.image.revision=$REVISION"
  --annotation "index:org.opencontainers.image.created=$CREATED"
  --provenance=mode=max
  --sbom=true
  "${TAG_ARGS[@]}"
  --push
  .
)

step "Plan"
printf '  %-11s %s\n' "Image" "$IMAGE"
printf '  %-11s %s\n' "Tags" "${TAGS[*]}$([ "$PRERELEASE" = 1 ] && echo "   (pre-release: latest is left alone)")"
printf '  %-11s %s\n' "Platforms" "${PLATFORMS//,/, }"
printf '  %-11s %s\n' "Source" "$SOURCE"
printf '  %-11s %s\n' "SDK" "$SDK"

if [ "$DRY_RUN" = 1 ]; then
  step "Dry run: the build that would run"
  printf '  '
  printf '%q ' "${BUILD[@]}"
  printf '\n\nNothing was pushed.\n'
  exit 0
fi

if [ "$LOCAL" = 0 ] && [ "$ASSUME_YES" = 0 ]; then
  [ -t 0 ] || fail "not a terminal, so cannot confirm" "Re-run with --yes to publish without asking."
  printf '\n  Publish %s? [y/N] ' "$(bold "$IMAGE:$VERSION")"
  read -r answer
  case "$answer" in
    y | Y | yes | YES) ;;
    *)
      echo "  Cancelled; nothing was pushed."
      exit 1
      ;;
  esac
fi

# ── Build and push ──────────────────────────────────────────────────────────

step "Building and pushing"
echo "  A platform this machine does not run natively is emulated; its Rust build takes a while."
"${BUILD[@]}"

# ── Verify ──────────────────────────────────────────────────────────────────

step "Verifying"
MANIFEST=$(docker buildx imagetools inspect "$IMAGE:$VERSION")
for platform in "${REQUESTED[@]}"; do
  grep -q "Platform: *$platform\$" <<<"$MANIFEST" || fail "$IMAGE:$VERSION has no $platform image"
  ok "$platform"
done
DIGEST=$(docker buildx imagetools inspect "$IMAGE:$VERSION" --format '{{json .Manifest.Digest}}' | tr -d '"')
for tag in "${TAGS[@]}"; do
  [ "$tag" = "$VERSION" ] && continue
  [ "$(docker buildx imagetools inspect "$IMAGE:$tag" --format '{{json .Manifest.Digest}}' | tr -d '"')" = "$DIGEST" ] ||
    fail "$IMAGE:$tag does not point at the image just pushed"
  ok "$tag -> $VERSION"
done

step "Published $IMAGE:$VERSION"
printf '  %-11s %s\n' "Digest" "$DIGEST"
printf '  %-11s %s\n' "Pull" "docker pull $IMAGE:$VERSION"
if [ "$LOCAL" = 1 ]; then
  printf '  %-11s %s\n' "Try it" "DEREC_IMAGE=$IMAGE ./start.sh --fresh"
  printf '  %-11s %s\n' "Clean up" "docker rm -f $LOCAL_REGISTRY_CONTAINER"
else
  printf '  %-11s %s\n' "Package" "https://github.com/orgs/derecalliance/packages/container/package/reference-app"
  echo
  echo "  First publish? The package is private until you make it public in its settings."
fi
