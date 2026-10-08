#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 DeRec Alliance. All rights reserved.
#
# The app's release version: show it, check it, change it.
#
#   scripts/version.sh                     print the version
#   scripts/version.sh check               verify every copy agrees and matches the SDK
#   scripts/version.sh set 0.0.8-alpha.1   change it everywhere
#
# The version is declared once, in apps/backend/Cargo.toml (`version`), next to
# the SDK it is built against. It is the SDK version, optionally followed by a
# pre-release suffix: 0.0.8-alpha.1, 0.0.8-beta.2, 0.0.8-rc.1, then 0.0.8.
# Every other copy — the web package, the API spec, the Dockerfile, the compose
# files, the image tags in the docs and the CHANGELOG heading — follows it, and
# `set` rewrites them all.

set -euo pipefail

cd "$(dirname "$0")/.."

CARGO_TOML=apps/backend/Cargo.toml
CARGO_LOCK=apps/backend/Cargo.lock
PACKAGE_JSON=apps/web/package.json
PACKAGE_LOCK=apps/web/package-lock.json
OPENAPI=apps/backend/openapi.yaml
DOCKERFILE=apps/backend/Dockerfile
CHANGELOG=CHANGELOG.md
COMPOSE_FILES=(examples/compose.sqlite.yaml examples/compose.postgres.yaml)
# Files that show the image with its tag, as a reader would copy it.
IMAGE_REF_FILES=(README.md CONTRIBUTING.md docs/DOCKER.md "$DOCKERFILE")

VERSION_PATTERN='^[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?$'

usage() { sed -n '5,16p' "$0" | sed 's/^# \{0,1\}//'; }
fail() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

# The first `version = "…"` in Cargo.toml is the package's own, under [package].
current_version() {
  local v
  v=$(sed -n 's/^version = "\(.*\)"$/\1/p' "$CARGO_TOML" | head -1)
  [ -n "$v" ] || fail "no version in $CARGO_TOML"
  echo "$v"
}

# The SDK versions the app pins, one per line as "<where>: <version>".
sdk_versions() {
  sed -n 's/^derec-library = .*version = "\([^"]*\)".*/derec-library (Cargo.toml): \1/p' "$CARGO_TOML"
  sed -n 's/^derec-proto = "\([^"]*\)"/derec-proto (Cargo.toml): \1/p' "$CARGO_TOML"
  sed -n 's/.*"@derec-alliance\/web": "[\^~]\{0,1\}\([^"]*\)".*/@derec-alliance\/web (package.json): \1/p' "$PACKAGE_JSON"
}

validate_format() {
  [[ "$1" =~ $VERSION_PATTERN ]] ||
    fail "'$1' is not a release version: expected X.Y.Z or X.Y.Z-alpha.N / -beta.N / -rc.N"
}

# The base must be the SDK's: the SDK is compiled into both halves, so a
# different SDK is a different release, never a pre-release of this one.
validate_base() {
  local base="${1%%-*}" line sdk problems=0
  while IFS= read -r line; do
    sdk="${line##*: }"
    if [ "$sdk" != "$base" ]; then
      echo "  ${line%%: *} is $sdk, but the version's base is $base" >&2
      problems=1
    fi
  done < <(sdk_versions)
  [ "$problems" = 0 ] || fail "the version must be the SDK version (plus an optional pre-release suffix); move the SDK first"
}

# ── check ───────────────────────────────────────────────────────────────────

# Report one copy that disagrees; the caller collects them.
mismatch() { printf '  %-40s %s\n' "$1" "$2" >&2; MISMATCHES=$((MISMATCHES + 1)); }

check() {
  local v ref f got
  v=$(current_version)
  validate_format "$v"
  validate_base "$v"
  MISMATCHES=0

  got=$(perl -0ne 'print $1 if /name = "derec-backend"\nversion = "([^"]+)"/' "$CARGO_LOCK")
  [ "$got" = "$v" ] || mismatch "$CARGO_LOCK" "derec-backend is ${got:-missing}"

  got=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$PACKAGE_JSON" | head -1)
  [ "$got" = "$v" ] || mismatch "$PACKAGE_JSON" "version is ${got:-missing}"

  got=$(perl -0ne 'print $1 if /\A\{\n  "name": "[^"]+",\n  "version": "([^"]+)"/' "$PACKAGE_LOCK")
  [ "$got" = "$v" ] || mismatch "$PACKAGE_LOCK" "version is ${got:-missing}"
  got=$(perl -0ne 'print $1 if /"packages": \{\n    "": \{\n      "name": "[^"]+",\n      "version": "([^"]+)"/' "$PACKAGE_LOCK")
  [ "$got" = "$v" ] || mismatch "$PACKAGE_LOCK" "packages[\"\"].version is ${got:-missing}"

  got=$(sed -n 's/^  version: "\(.*\)"$/\1/p' "$OPENAPI" | head -1)
  [ "$got" = "$v" ] || mismatch "$OPENAPI" "info.version is ${got:-missing}"

  got=$(sed -n 's/^ARG VERSION=\(.*\)$/\1/p' "$DOCKERFILE")
  [ "$got" = "$v" ] || mismatch "$DOCKERFILE" "ARG VERSION is ${got:-missing}"

  for f in "${COMPOSE_FILES[@]}"; do
    got=$(sed -n 's/^ *image: .*reference-app}:\(.*\)$/\1/p' "$f")
    [ "$got" = "$v" ] || mismatch "$f" "image tag is ${got:-missing}"
  done

  for f in "${IMAGE_REF_FILES[@]}"; do
    [ -f "$f" ] || continue
    while IFS= read -r ref; do
      [ "$ref" = "$v" ] || mismatch "$f" "shows the image tagged $ref"
    done < <(grep -oE 'reference-app:[0-9]+\.[0-9]+\.[0-9]+(-[a-z]+\.[0-9]+)?' "$f" | sed 's/^reference-app://' | sort -u)
  done

  got=$(sed -n 's/^## \[\([^]]*\)\].*/\1/p' "$CHANGELOG" | head -1)
  [ "$got" = "$v" ] || mismatch "$CHANGELOG" "top entry is ${got:-missing}"

  if [ "$MISMATCHES" -gt 0 ]; then
    fail "$MISMATCHES cop$([ "$MISMATCHES" = 1 ] && echo y || echo ies) disagree with $v in $CARGO_TOML; update them to $v by hand (set only moves a version that is already consistent)"
  fi
  echo "version $v: consistent, built against SDK ${v%%-*}"
}

# ── set ─────────────────────────────────────────────────────────────────────

# Replace in place, literally: the old version is data, not a pattern. The
# lookahead keeps `:0.0.8` from matching the start of `:0.0.8-alpha.1`.
replace() {
  local file="$1" from="$2" to="$3"
  FROM="$from" TO="$to" perl -0pi -e 's/\Q$ENV{FROM}\E(?![0-9A-Za-z.-])/$ENV{TO}/g' "$file"
}

# Replace the first line that is exactly `from`. For the version fields, whose
# text (`version = "0.0.8"`) can also appear inside a dependency's entry.
replace_line() {
  local file="$1" from="$2" to="$3"
  FROM="$from" TO="$to" perl -0pi -e 's/^\Q$ENV{FROM}\E$/$ENV{TO}/m' "$file"
}

set_version() {
  local new="$1" old f
  validate_format "$new"
  validate_base "$new"
  old=$(current_version)

  if [ "$old" = "$new" ]; then
    echo "already $new"
    check
    return
  fi

  replace_line "$CARGO_TOML" "version = \"$old\"" "version = \"$new\""
  FROM="$old" TO="$new" perl -0pi -e \
    's/(name = "derec-backend"\nversion = ")\Q$ENV{FROM}\E"/$1$ENV{TO}"/' "$CARGO_LOCK"
  replace_line "$PACKAGE_JSON" "  \"version\": \"$old\"," "  \"version\": \"$new\","
  FROM="$old" TO="$new" perl -0pi -e '
    s/\A(\{\n  "name": "[^"]+",\n  "version": ")\Q$ENV{FROM}\E"/$1$ENV{TO}"/;
    s/("packages": \{\n    "": \{\n      "name": "[^"]+",\n      "version": ")\Q$ENV{FROM}\E"/$1$ENV{TO}"/;
  ' "$PACKAGE_LOCK"
  replace_line "$OPENAPI" "  version: \"$old\"" "  version: \"$new\""
  replace_line "$DOCKERFILE" "ARG VERSION=$old" "ARG VERSION=$new"
  for f in "${COMPOSE_FILES[@]}"; do
    replace "$f" "reference-app}:$old" "reference-app}:$new"
  done
  for f in "${IMAGE_REF_FILES[@]}"; do
    [ -f "$f" ] && replace "$f" "reference-app:$old" "reference-app:$new"
  done
  FROM="$old" TO="$new" perl -0pi -e 's/^## \[\Q$ENV{FROM}\E\]/## [$ENV{TO}]/m' "$CHANGELOG"

  echo "version $old -> $new"
  check
  echo "Review with git diff; then commit, and tag the release commit v$new."
}

case "${1:-}" in
  "") current_version ;;
  check) check ;;
  set)
    [ $# -eq 2 ] || fail "usage: scripts/version.sh set <version>"
    set_version "$2"
    ;;
  -h | --help) usage ;;
  *) fail "unknown command: $1 (try --help)" ;;
esac
