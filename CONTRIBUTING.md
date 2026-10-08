# Contributing Guide

Thank you for your interest in contributing to the **DeRec Reference App**.

This repository contains a reference implementation of the
[DeRec Protocol](https://github.com/derecalliance/protocol/blob/main/protocol.md),
providing both an Owner and a Helper for interoperability testing, built on the
[DeRec SDK](https://github.com/derecalliance/lib-derec).

All contributions are welcome.

---

# Repository Overview

This repository is a monorepo containing two applications.

```
reference-app/
├── apps/web       # React + Vite front end: executes the DeRec flows in the browser
├── apps/backend   # Rust + Axum backend: actor registry, message relay, hosted helpers
├── examples/      # Configuration, environment and Docker Compose examples
├── docs/          # Architecture and design history
```

Application responsibilities:

| App | Purpose |
|------|--------|
| `apps/web` | Owner and Helper UI; runs the protocol client-side through `@derec-alliance/web` |
| `apps/backend` | Thin node: actors, mailboxes, the provisioned helper pool, gRPC transport; built on `derec-library` |

The backend deliberately implements **no protocol logic** — see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

# Development Setup

Before building the project, install the required development tools:

- Rust (1.89 or newer)
- `protoc` (Protocol Buffers compiler), for the backend's vendored transport protos
- Node.js (22 or newer) and npm
- Google Chrome, for the end-to-end tests
- Docker, to build and run the image

---

# Building the Apps

Run the backend:

```bash
cd apps/backend
cargo run
```

Run the front end, in a second terminal:

```bash
cd apps/web
npm install
npm run dev
```

Then open `http://localhost:5173/reference-app/`.

Run tests:

```bash
# backend
cd apps/backend
cargo test --all-targets

# front end
cd apps/web
npx tsc -b --noEmit
npx eslint src e2e
npx vitest run
npm run test:e2e
```

Format the code:

```bash
cd apps/backend
cargo fmt
```

---

# Docker Builds

The image bundles the built front end and the backend into one container.

Users pull the published image (`ghcr.io/derecalliance/reference-app`). To run
your own changes, build it from the repository root:

```bash
docker build -f apps/backend/Dockerfile -t derec/reference-app:dev .
# or, with the node started and waited on:
./start.sh --build
```

See [docs/DOCKER.md](docs/DOCKER.md) for running it, persistence and
configuration.

---

# Reporting Issues

If you find a bug or want to request a feature, please open an issue including:

- A clear and descriptive title
- Steps to reproduce the issue
- Expected vs actual behavior
- Logs, screenshots, or examples if applicable

The Console panel's **Download** and `GET /debug/events` are useful attachments.
Please do not report security vulnerabilities in public issues — see
`SECURITY.md` in the [DeRec SDK](https://github.com/derecalliance/lib-derec)
repository, or email <security@derec.org>.

---

# Submitting Contributions

1. Fork the repository.

2. Clone your fork:

```bash
git clone https://github.com/<your-username>/reference-app
cd reference-app
```

3. Add the upstream repository:

```bash
git remote add upstream https://github.com/derecalliance/reference-app
```

4. Create a new branch:

```bash
git checkout -b my-feature
```

5. Implement your changes.

6. Ensure the project builds and tests pass:

```bash
(cd apps/backend && cargo build && cargo test --all-targets)
(cd apps/web && npx tsc -b --noEmit && npx vitest run && npm run test:e2e)
```

7. Push your branch:

```bash
git push origin my-feature
```

8. Open a Pull Request.

---

# Code Style

Please follow existing project conventions:

- Use `rustfmt` formatting for the backend, and the project's ESLint configuration for the front end
- Prefer clear and descriptive names
- Document public APIs using `rustdoc`, and the API in `apps/backend/openapi.yaml`
- Add tests for new functionality
- Start every new source file with the license header:

```
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.
```

Run formatting locally:

```bash
cargo fmt
```

---

# Release Process

The app's version follows the DeRec SDK it is built against, and the Docker
image is tagged with it. Changes are recorded in `CHANGELOG.md`, under the
entry for the version being prepared.

## Versions

The app's version is declared once, as `version` in
[`apps/backend/Cargo.toml`](apps/backend/Cargo.toml), next to the SDK it pins.
It is the SDK version, optionally with a pre-release suffix:

```
0.0.8-alpha.1 → 0.0.8-alpha.2 → … → 0.0.8-rc.1 → 0.0.8
```

Every other copy (the web package, the API spec, the Dockerfile, the compose
files, the image tags in the docs, the CHANGELOG heading) follows it.
[`scripts/version.sh`](scripts/version.sh) keeps them in step:

```bash
scripts/version.sh                     # print it
scripts/version.sh check               # every copy agrees, and the base is the SDK's
scripts/version.sh set 0.0.8-alpha.2   # change it everywhere
```

`set` refuses a version whose base is not the pinned SDK: moving to a new SDK
means bumping `derec-library`, `derec-proto` and `@derec-alliance/web` first.

## Publishing the image

Releases go to `ghcr.io/derecalliance/reference-app` with
[`scripts/publish-image.sh`](scripts/publish-image.sh). It publishes the
version above, built from its release commit, for `linux/amd64` and
`linux/arm64`. A pre-release is pushed under its own tag only; a release also
moves `latest`. A version already published is never overwritten.

1. **Set the version** and commit the result:

   ```bash
   scripts/version.sh set 0.0.8-alpha.1
   ```

2. **Tag the release commit and push the tag.** The image's `revision` label
   points at this commit, so it must be on GitHub:

   ```bash
   git tag -a v0.0.8-alpha.1 -m "Release 0.0.8-alpha.1"
   git push origin v0.0.8-alpha.1
   ```

3. **Log in to GHCR** (once per machine) with a GitHub token that has
   `write:packages`:

   ```bash
   echo "$GITHUB_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
   ```

4. **Publish:**

   ```bash
   scripts/publish-image.sh
   ```

   It checks that the tree is clean, HEAD is the pushed tag, every copy of the
   version agrees, you are logged in, the builder handles both platforms and
   the version is not yet published. It then shows the plan and asks before
   pushing. After the push it confirms both platforms are in the registry and
   prints the digest. `--dry-run` runs the checks and prints the build without
   pushing; `--yes` skips the question.

5. **First publish only:** GHCR creates the package private. Make it public in
   the package's settings on GitHub, or nobody else can pull it.

**Rehearse first** with `--local`. It pushes to a registry on your own machine
(`localhost:5055`, started if needed) and turns the source checks into
warnings, so it also works on uncommitted changes. Nothing leaves the machine:

```bash
scripts/publish-image.sh --local
DEREC_IMAGE=localhost:5055/derecalliance/reference-app ./start.sh --fresh
docker rm -f derec-registry           # when done
```

Building the platform your machine does not run natively is emulated, so its
Rust build is slow (on Apple Silicon, `linux/amd64`). How to run the image,
and every setting it takes, is in [docs/DOCKER.md](docs/DOCKER.md).

---

# Getting Help

If you need help:

- Check the README and documentation
- Search existing issues
- Open a new issue or discussion if necessary

---

Thank you for contributing to the **DeRec ecosystem**.
