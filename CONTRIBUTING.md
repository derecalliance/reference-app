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

- Rust (1.88 or newer)
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

From the repository root run:

```bash
docker build -f apps/backend/Dockerfile -t derec/reference-app:0.0.6 .
```

See the README's **In Docker** section for running it, persistence and
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
image is tagged with it. Changes are recorded in `CHANGELOG.md`.

---

# Getting Help

If you need help:

- Check the README and documentation
- Search existing issues
- Open a new issue or discussion if necessary

---

Thank you for contributing to the **DeRec ecosystem**.
