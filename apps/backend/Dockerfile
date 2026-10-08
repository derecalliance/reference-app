# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 DeRec Alliance. All rights reserved.

# The DeRec reference app: front end and backend in one image.
#
# Build from the REPO ROOT, not from this directory — the web build needs
# `apps/web` and the backend needs the vendored protos:
#
#   docker build -f apps/backend/Dockerfile -t derec/reference-app:dev .
#
# Releases are built and pushed by scripts/publish-image.sh, which also passes
# VERSION, REVISION and CREATED for the OCI labels below; a local build leaves
# them at their defaults. See docs/DOCKER.md for running the image.
#
# The version names the SDK the image was built against. The SDK is compiled in —
# `derec-library` into the binary, `@derec-alliance/web` into the bundled WASM —
# so it is deliberately not a build argument: with one, any image-to-SDK
# combination could be produced and only the default would ever be exercised.

# ── Web builder ─────────────────────────────────────────────────────────────
#
# `--base=/` is the only thing separating this from the Pages build, which
# keeps the configured `/reference-app/`. Here the app is served from the root
# of the backend's own origin.
#
# `VITE_API_SAME_ORIGIN` makes the page call whatever served it rather than the
# derived port 5000 — without it a container published on any other host port
# would call an address nothing is listening on.
#
# Neither wasm-pack nor protoc appears here: the npm package ships prebuilt
# WASM, which is most of why a released SDK makes a single-image build
# tractable.
FROM node:22-bookworm-slim AS web

WORKDIR /build/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci

COPY apps/web/ ./
ENV VITE_API_SAME_ORIGIN=1
# `404.html` is the GitHub Pages redirect shim and hard-codes the
# `/reference-app/` base; served from here it would bounce a mistyped URL to a
# path that does not exist.
RUN npm run build -- --base=/ \
    && rm -f dist/404.html

# ── Backend builder ─────────────────────────────────────────────────────────
#
# The Rust pin is the oldest toolchain the locked dependency tree builds with,
# and matches `rust-version` in Cargo.toml. The SDK crates declare 1.88, but
# their own dependencies (`aes` 0.9 through `aes-gcm`, `enum-ordinalize`
# through the `ark` crates) need 1.89, as does `uuid`. `protoc` is still
# needed — not for the SDK, which ships generated types, but for the vendored
# transport protos this app compiles itself.
FROM rust:1.89-bookworm AS backend

# `libprotobuf-dev` as well as the compiler: it ships the well-known types
# (`google/protobuf/timestamp.proto` and friends) under /usr/include, which the
# `derec-proto` crate's own build needs for `contact.proto`. Without it the
# build fails inside a *dependency*, which reads like an SDK problem rather than
# a missing package.
RUN apt-get update \
    && apt-get install -y --no-install-recommends protobuf-compiler libprotobuf-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build/apps/backend

# Manifests and protos first, then a throwaway build, so the dependency layer
# survives an ordinary source edit. The protos must be here before this build:
# `build.rs` compiles them, so a warm-up without them fails rather than caching.
COPY apps/backend/Cargo.toml apps/backend/Cargo.lock ./
COPY apps/backend/build.rs ./
COPY apps/backend/proto/ ./proto/
RUN mkdir -p src \
    && echo 'fn main() {}' > src/main.rs \
    && echo '' > src/lib.rs \
    && cargo build --release \
    && rm -rf src

COPY apps/backend/ ./

# The image's own defaults, compiled in as *built-in defaults* rather than set
# as runtime `ENV`. Precedence is built-in < config file < environment, so an
# `ENV` preset would outrank a mounted config file and make these keys
# impossible to set from one. Declared after the dependency warm-up so changing
# one does not throw that layer away. The boot banner reports them as
# `default`.
ENV DEREC_BUILTIN_CONFIG_PATH=/etc/derec/config.toml \
    DEREC_BUILTIN_STATIC_DIR=/app/static \
    DEREC_BUILTIN_DATABASE_URL=/var/lib/derec/derec.db

# Cargo skips a rebuild when mtimes look unchanged; the sources were just
# copied over the stubs, so touch them to be certain the real build runs.
RUN touch src/main.rs src/lib.rs && cargo build --release

# ── Runtime ─────────────────────────────────────────────────────────────────
#
# Slim over distroless is deliberate. `build_router` carries the comment that
# this app "ships as a developer's local container and exposing its internals
# is the point", and the README frames the whole thing as built to be
# inspected. A shell to `docker exec` into is worth a few megabytes in a tool
# whose purpose is debugging.
#
# `sqlite3` is here for the same reason the Inspect tab is: the app does not
# use the CLI — SQLite is linked into the binary — but a developer who wants to
# know why a channel is in the state it is in should be able to open the
# database and look. Nothing else depends on it, so it can go if image size
# ever becomes the binding constraint. There is no `curl`: the healthcheck is
# the binary itself (`derec-backend healthcheck`), which reads the port the
# same way the server does.
FROM debian:bookworm-slim AS runtime

# Set by scripts/publish-image.sh; VERSION follows apps/backend/Cargo.toml
# (scripts/version.sh keeps them in step).
ARG VERSION=0.0.8-alpha.1
ARG REVISION=unknown
ARG CREATED=unknown

LABEL org.opencontainers.image.title="DeRec reference app" \
      org.opencontainers.image.description="Reference DeRec Owner and Helper for interoperability testing: web UI and backend in one image. A development tool with no authentication." \
      org.opencontainers.image.vendor="DeRec Alliance" \
      org.opencontainers.image.url="https://github.com/derecalliance/reference-app" \
      org.opencontainers.image.source="https://github.com/derecalliance/reference-app" \
      org.opencontainers.image.documentation="https://github.com/derecalliance/reference-app/blob/main/docs/DOCKER.md" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Non-root. The uid is fixed so a bind-mounted host directory can be chowned to
# something predictable.
RUN useradd --system --uid 10001 --create-home --home-dir /home/derec derec

COPY --from=backend /build/apps/backend/target/release/derec-backend /usr/local/bin/derec-backend
COPY --from=web /build/apps/web/dist/ /app/static/
COPY apps/backend/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# The data directory, owned by the runtime user. A fresh named or anonymous
# volume inherits this ownership, so that case needs nothing further; a
# bind-mounted host directory keeps host ownership, which the entrypoint
# reconciles. `/etc/derec` is where the built-in config path points; it is
# created empty so the mount point exists either way.
RUN mkdir -p /var/lib/derec /etc/derec && chown derec:derec /var/lib/derec

# Relative paths in a mounted config (`database_url = "./mine.db"`) land in the
# volume rather than in `/`, which the runtime user cannot write.
WORKDIR /var/lib/derec

# Declared so an unconfigured `docker run` already survives a restart: Docker
# gives it an anonymous volume. A *named* volume is what a developer adds to
# keep data across `docker rm` — the same bargain the official Postgres image
# offers, which is the point.
#
# Prefer a named volume to a bind mount: SQLite's locking over bind-mounted host
# filesystems is unreliable on macOS and Windows, where the mount crosses
# gRPC-FUSE or virtiofs, and it presents as intermittent "database is locked"
# rather than as anything naming the mount.
VOLUME /var/lib/derec

# The API and the UI share an origin; gRPC is its own listener. These are the
# default ports; a config file or DEREC_PORT / DEREC_GRPC_PORT can move them.
EXPOSE 5000 50051

# No `ENV DEREC_*` presets: every setting is at its built-in default until a
# mounted file (/etc/derec/config.toml, read with no variable needed) or an
# environment variable says otherwise.
#
# The probe is the binary, not `curl http://localhost:${DEREC_PORT}`: that
# only knew the port when it came from that one variable, so a port set in the
# config file, or left unset, was probed at the wrong address.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD ["derec-backend", "healthcheck"]

# No `USER`: the entrypoint starts as root only to fix the data directory's
# ownership, then drops to `derec` (uid 10001) for the server itself. A side
# effect is that `docker exec` lands as root; use `docker exec -u derec ...` to
# act as the server does, so files you create stay writable by it.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["derec-backend"]
