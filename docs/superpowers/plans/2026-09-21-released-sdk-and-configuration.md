# Released SDK and Layered Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut both halves of the app over to the published SDK 0.0.3 so no sibling checkout is required, then give the backend one configuration surface that reads from a TOML file and environment variables with the environment winning, and reports at boot exactly what it loaded and where each value came from.

**Architecture:** Phase 1 removes the `path`/`file:` dependencies on `../../../lib-derec` by pinning the registry releases and vendoring the 15 `.proto` files `build.rs` needs into `apps/backend/proto/`. Phase 2 restructures `config.rs` around a `[server]`/`[defaults]` TOML shape merged by `figment` beneath a custom `DEREC_*` environment provider, keeping the existing `Option`-level merge so `Defaults::resolve`'s adaptive clamping survives, and adds a boot banner plus a `GET /debug/config` route that report per-key provenance.

**Tech Stack:** Rust, Axum 0.8, `figment` 0.10, `dotenvy` 0.15, `sqlx` (later phases only), React + Vite, `derec-library` / `derec-proto` 0.0.3 from crates.io, `@derec-alliance/web` 0.0.3 from npm.

**Spec:** `docs/superpowers/specs/2026-09-21-docker-packaging-design.md`

## Global Constraints

- **Phases 1 and 2 only.** The spec has nine phases; this plan covers 1 (dependency switch) and 2 (configuration). Persistence, the image, and the frontend change are later plans.
- **A setting is only added when it has a consumer.** `static_dir` and `database_url` appear in the spec's `[server]` table but are consumed in spec phases 6 and 3. They are **not** part of this plan. `[server]` ships with `base_url` and `port`, which `main.rs` already reads. Documentation written here describes only what ships here.
- **Baseline entering this plan:** backend `cargo test` = **141 passing, 11 suites, 0 failures**. Frontend `npx vitest run` = **408 passing, 0 failures**. Every task must leave both at or above these numbers.
- **No `unwrap()` / `expect()` in production paths.** Test code may use them.
- **No HTTP API change to `GET /config`.** Its response is deserialised directly by the front end (`apps/web/src/config.ts`). Provenance goes to a new `GET /debug/config`.
- **No frontend behaviour change in this plan.** Task 3 edits `vite.config.ts` only to delete a dependency workaround; no `src/` file changes.
- **SDK version is 0.0.3** for all three packages — `derec-library`, `derec-proto`, `@derec-alliance/web`. Verified published: crates.io 2026-09-12, npm dist-tag `latest`.
- **Do not commit `docs/`.** Stage only the files each task names.
- **The user commits.** Each task's final step stages and commits its own files; do not amend or rebase earlier tasks.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/backend/proto/grpc/derectransport.proto` | vendored transport service schema | **new** |
| `apps/backend/proto/protobufs/*.proto` | vendored message schema, 14 files | **new** |
| `apps/backend/build.rs` | tonic codegen from the vendored protos | modify |
| `apps/backend/Cargo.toml` | registry pins, `figment`, `dotenvy` | modify |
| `apps/backend/tests/proto_drift.rs` | vendored protos vs the published crate | **new** |
| `apps/backend/src/config.rs` | the whole configuration surface: shapes, merge, provenance, banner | modify |
| `apps/backend/src/routes/debug.rs` | `GET /debug/config` handler | modify |
| `apps/backend/src/lib.rs` | route registration | modify |
| `apps/backend/src/main.rs` | consume `Settings`, reject legacy variables, print the banner | modify |
| `apps/backend/openapi.yaml` | document `/debug/config` | modify |
| `apps/backend/config.example.toml` | restructured into `[server]` / `[defaults]` | modify |
| `apps/web/package.json` | npm registry pin | modify |
| `apps/web/vite.config.ts` | delete the `file:`-symlink workaround | modify |
| `.github/workflows/deploy-web-app.yml` | run npm in `apps/web` | modify |
| `.env.example` | worked environment file | **new** |
| `compose.yaml` | worked compose file | **new** |
| `README.md` | running it, configuring it | modify |

`config.rs` is 485 lines today and this plan adds the merge layer, the provenance lookup and the banner to it. It stays one file: every piece is about turning operator input into `Settings`, and splitting it would separate the env-name table from the struct it names fields of. If it passes ~800 lines after Task 7, splitting the banner into `config/report.rs` is reasonable — but do not do it pre-emptively.

---

# Phase 1 — The dependency switch

## Task 1: Vendor the protos

`build.rs` compiles `derectransport.proto` from `../../../lib-derec/protobufs`. A Docker build context rooted at this repo cannot see that, and neither can CI. Copy in the exact transitive closure and repoint the build.

The closure is 15 files: `derectransport.proto` imports `derecmessage.proto`, which imports nine, which reach four more. `contact.proto`, `derecsecret.proto` and `committedderecshare.proto` are **not** in the graph — do not copy them.

**Files:**
- Create: `apps/backend/proto/grpc/derectransport.proto`
- Create: `apps/backend/proto/protobufs/` — 14 files, listed in Step 1
- Modify: `apps/backend/build.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: `apps/backend/proto/` as the proto root. Task 2's drift test reads it.

- [ ] **Step 1: Copy the 15 files**

Run from the repo root:

```bash
mkdir -p apps/backend/proto/grpc apps/backend/proto/protobufs

cp ../lib-derec/protobufs/grpc/derectransport.proto apps/backend/proto/grpc/

for f in derecmessage pair unpair storeshare verify getshare secretidsversions \
         updatechannelinfo prepair error result transportprotocol \
         communicationinfo parameterrange; do
  cp "../lib-derec/protobufs/protobufs/$f.proto" apps/backend/proto/protobufs/
done
```

Verify the count is exactly 15:

```bash
find apps/backend/proto -name '*.proto' | wc -l
```

Expected: `15`

- [ ] **Step 2: Repoint `build.rs`**

Replace the whole of `apps/backend/build.rs` with:

```rust
fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Vendored from the published `derec-proto` crate rather than read from a
    // sibling checkout: a Docker build context rooted at this repo cannot see
    // a sibling, and the crate exposes no supported way to locate the copies it
    // ships. `tests/proto_drift.rs` guards these against the pinned release.
    let proto_root = "proto";

    println!("cargo:rerun-if-changed={proto_root}");

    tonic_prost_build::configure()
        .build_server(true)
        .build_client(true)
        .extern_path(".org.derecalliance.derec.protobuf", "::derec_proto")
        .compile_protos(
            &[format!("{proto_root}/grpc/derectransport.proto")],
            &[
                format!("{proto_root}/grpc"),
                format!("{proto_root}/protobufs"),
            ],
        )?;
    Ok(())
}
```

`build.rs` runs with the working directory set to the package root, so `proto` resolves to `apps/backend/proto`. Watching the directory rather than two named files means adding a proto later does not silently skip a rebuild.

- [ ] **Step 3: Verify the build still works and gRPC still passes**

Run: `cd apps/backend && cargo build 2>&1 | tail -5`
Expected: compiles with no errors.

Run: `cd apps/backend && cargo test --test grpc_ingress 2>&1 | grep "test result"`
Expected: `test result: ok. 8 passed; 0 failed`

This is the test that proves the generated transport service is still correct — it exercises the tonic server built from the vendored schema.

- [ ] **Step 4: Verify the full suite is unchanged**

Run: `cd apps/backend && cargo test 2>&1 | grep -c "test result: ok"`
Expected: `11`

Run: `cd apps/backend && cargo test 2>&1 | grep "FAILED\|panicked" | head`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/proto apps/backend/build.rs
git commit -m "Vendor the transport protos instead of reading a sibling checkout"
```

---

## Task 2: Pin the Rust SDK to the registry

**Files:**
- Modify: `apps/backend/Cargo.toml:36-37`
- Modify: `apps/backend/Cargo.lock` (regenerated)
- Test: `apps/backend/tests/proto_drift.rs` (create)

**Interfaces:**
- Consumes: `apps/backend/proto/` from Task 1.
- Produces: `derec-library` and `derec-proto` resolved from crates.io. Nothing in `apps/backend` reads `../../../lib-derec` afterwards.

- [ ] **Step 1: Write the failing drift test**

Create `apps/backend/tests/proto_drift.rs`:

```rust
//! The vendored protos in `proto/` must match the `derec-proto` release the
//! backend is pinned to.
//!
//! `build.rs` deliberately does not locate the crate's shipped copies — a
//! consumer cannot do that without guessing at the registry cache layout, and a
//! wrong guess there fails the build on a machine whose only sin is a different
//! `CARGO_HOME`. The same guess is fine *here*: when it does not resolve this
//! test skips and costs coverage rather than breaking anything.

use std::path::{Path, PathBuf};

/// The 15 files `derectransport.proto` needs transitively. Paths are relative
/// to both `proto/` here and the crate root upstream, which share a layout.
const VENDORED: &[&str] = &[
    "grpc/derectransport.proto",
    "protobufs/derecmessage.proto",
    "protobufs/pair.proto",
    "protobufs/unpair.proto",
    "protobufs/storeshare.proto",
    "protobufs/verify.proto",
    "protobufs/getshare.proto",
    "protobufs/secretidsversions.proto",
    "protobufs/updatechannelinfo.proto",
    "protobufs/prepair.proto",
    "protobufs/error.proto",
    "protobufs/result.proto",
    "protobufs/transportprotocol.proto",
    "protobufs/communicationinfo.proto",
    "protobufs/parameterrange.proto",
];

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The `derec-proto` version this crate depends on, read from the manifest so
/// bumping the dependency cannot leave this test checking the old release.
fn pinned_version() -> String {
    let manifest = std::fs::read_to_string(manifest_dir().join("Cargo.toml"))
        .expect("read Cargo.toml");
    let parsed: toml::Value = manifest.parse().expect("parse Cargo.toml");
    let dep = &parsed["dependencies"]["derec-proto"];

    if let Some(version) = dep.as_str() {
        return version.to_owned();
    }
    dep.get("version")
        .and_then(toml::Value::as_str)
        .expect("derec-proto needs a version")
        .to_owned()
}

/// Find the extracted crate source under any registry directory.
fn upstream_root(version: &str) -> Option<PathBuf> {
    let cargo_home = std::env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cargo")))?;

    let registries = std::fs::read_dir(cargo_home.join("registry").join("src")).ok()?;
    for registry in registries.flatten() {
        let candidate = registry.path().join(format!("derec-proto-{version}"));
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    None
}

fn read(root: &Path, relative: &str) -> String {
    std::fs::read_to_string(root.join(relative))
        .unwrap_or_else(|e| panic!("read {}: {e}", root.join(relative).display()))
}

#[test]
fn vendored_protos_match_the_pinned_release() {
    let version = pinned_version();

    let Some(upstream) = upstream_root(&version) else {
        eprintln!(
            "SKIPPED: no derec-proto-{version} under any registry src directory. \
             Run `cargo fetch` first, or ignore if this is a vendored build."
        );
        return;
    };

    let local = manifest_dir().join("proto");

    for relative in VENDORED {
        assert_eq!(
            read(&local, relative),
            read(&upstream, relative),
            "proto/{relative} has drifted from derec-proto {version}. \
             Re-copy it from the crate and rebuild."
        );
    }
}

#[test]
fn the_vendored_set_is_exactly_what_is_listed() {
    let local = manifest_dir().join("proto");
    let mut found = Vec::new();

    for dir in ["grpc", "protobufs"] {
        let entries = std::fs::read_dir(local.join(dir)).expect("read proto dir");
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".proto") {
                found.push(format!("{dir}/{name}"));
            }
        }
    }

    found.sort();
    let mut expected: Vec<String> = VENDORED.iter().map(|s| (*s).to_owned()).collect();
    expected.sort();

    assert_eq!(
        found, expected,
        "the files on disk and the list in this test have diverged"
    );
}
```

- [ ] **Step 2: Run it and watch it skip**

Run: `cd apps/backend && cargo test --test proto_drift 2>&1 | tail -15`
Expected: `the_vendored_set_is_exactly_what_is_listed` PASSES, and `vendored_protos_match_the_pinned_release` passes *having printed `SKIPPED`* — because the dependency is still a path dependency, so nothing has been extracted into the registry.

That skip is the point of the next step: it must stop skipping once the pin is real.

- [ ] **Step 3: Switch the pins**

In `apps/backend/Cargo.toml`, replace lines 36-37 and the comment block above them:

```toml
# SDK. Plaintext endpoints are not a compile-time feature — they are
# `DeRecProtocolBuilder::with_unsafe_connection`, decided per instance at
# runtime.
derec-library = "0.0.3"
derec-proto = "0.0.3"
```

Then regenerate the lockfile:

```bash
cd apps/backend && cargo update -p derec-library -p derec-proto
```

- [ ] **Step 4: Verify no path dependency survives**

Run:

```bash
cd apps/backend && cargo metadata --format-version 1 --no-deps=false 2>/dev/null \
  | python3 -c "
import json,sys
m = json.load(sys.stdin)
for p in m['packages']:
    if p['name'] in ('derec-library','derec-proto'):
        print(p['name'], p['version'], p['source'])
"
```

Expected: both lines end with `registry+https://github.com/rust-lang/crates.io-index`, **not** `None` (which is what a path dependency reports).

- [ ] **Step 5: Run the drift test again — it must no longer skip**

Run: `cd apps/backend && cargo test --test proto_drift 2>&1 | tail -15`
Expected: both tests pass, and **no `SKIPPED` line is printed**. If it still skips, `cargo fetch` has not extracted the crate; run `cargo fetch` and retry.

If the comparison now *fails*, the vendored copies differ from the 0.0.3 release — recopy from the path the test prints and rerun.

- [ ] **Step 6: Run the full suite**

Run: `cd apps/backend && cargo test 2>&1 | grep -E "test result|FAILED" `
Expected: 12 `test result: ok` lines (11 baseline suites plus `proto_drift`), no `FAILED`.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/Cargo.toml apps/backend/Cargo.lock apps/backend/tests/proto_drift.rs
git commit -m "Take the Rust SDK from crates.io and guard the vendored protos"
```

---

## Task 3: Pin the web SDK to npm

**Files:**
- Modify: `apps/web/package.json:22`
- Modify: `apps/web/package-lock.json` (regenerated)
- Modify: `apps/web/vite.config.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `@derec-alliance/web` resolved from npm. `vite.config.ts` exports a config with no `resolve.alias`-style workarounds for a linked package.

- [ ] **Step 1: Switch the dependency**

In `apps/web/package.json`, change the first dependency:

```json
"@derec-alliance/web": "^0.0.3",
```

Then:

```bash
cd apps/web && rm -rf node_modules/@derec-alliance && npm install
```

- [ ] **Step 2: Verify it came from the registry, not a symlink**

Run:

```bash
cd apps/web && node -e "
const fs = require('fs');
const p = 'node_modules/@derec-alliance/web';
console.log('symlink:', fs.lstatSync(p).isSymbolicLink());
console.log('version:', require('./' + p + '/package.json').version);
"
```

Expected:
```
symlink: false
version: 0.0.3
```

`symlink: true` means npm still resolved the `file:` dependency — check `package-lock.json` for a lingering `"file:../../../lib-derec/..."` entry and rerun `npm install`.

- [ ] **Step 3: Delete the symlink workaround from `vite.config.ts`**

Remove the `existsSync`/`realpathSync` imports, the entire `linkedSdkDirs` function and its doc comment, the `optimizeDeps` block, and the `server.fs` block. The `resolve.mainFields` block **stays** — it is about the package's missing `exports` map, not about linking.

The file becomes:

```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// No SPA fallback middleware: the app has no client-side routes — every screen
// lives at the base path.
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/reference-app/',
  resolve: {
    // `@derec-alliance/web` has no `exports` map — only `main` (raw
    // wasm-bindgen output) and `module` (the hand-written re-export surface
    // that includes SenderKind, ContactMode, etc). Vitest's SSR module
    // resolution prefers `main` by default, which silently drops those named
    // exports. This `resolve` block is app-wide (drives dev server and
    // production build too, not just tests), so keep Vite's default
    // `mainFields` ordering and only add `module` ahead of `main`.
    mainFields: ['browser', 'module', 'main'],
  },
  server: {
    watch: {
      // Playwright writes screenshots, videos and traces into the project root
      // *while* a run is in progress, and adding a spec file changes this tree
      // too. Watching either makes the dev server reload the page mid-test —
      // which surfaces as a blank page and a run where every test fails at the
      // first assertion, looking nothing like the file change that caused it.
      ignored: ['**/test-results/**', '**/playwright-report/**', '**/e2e/**'],
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
```

`projectRoot`, `dirname` and `fileURLToPath` all existed only to build the `server.fs.allow` entry, so they go with it — leaving them would fail lint as unused.

- [ ] **Step 4: Verify typecheck, unit tests and a production build**

Run: `cd apps/web && npm run typecheck`
Expected: no output, exit 0.

Run: `cd apps/web && npx vitest run 2>&1 | tail -3`
Expected: `PASS (408) FAIL (0)`

Run: `cd apps/web && npm run build 2>&1 | tail -5`
Expected: a `built in` line, no errors. This is the step that proves the WASM resolves without `server.fs.allow` — a production build inlines the asset paths the dev server was previously refusing.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json apps/web/package-lock.json apps/web/vite.config.ts
git commit -m "Take the web SDK from npm and drop the linked-package workaround"
```

---

## Task 4: Unbreak the Pages deploy

The workflow runs `npm ci` at the repo root, where there is no `package.json`. It has been failing independently of everything else; Task 3 removed the second reason it could not have worked.

**Files:**
- Modify: `.github/workflows/deploy-web-app.yml`

**Interfaces:**
- Consumes: the registry dependency from Task 3.
- Produces: nothing other tasks read.

- [ ] **Step 1: Point the job at `apps/web`**

Add a `defaults` block to the `build` job, immediately after `runs-on`, and point the npm cache at the right lockfile:

```yaml
  build:
    name: Build
    runs-on: ubuntu-latest

    defaults:
      run:
        working-directory: apps/web

    steps:
      - name: Checkout
        uses: actions/checkout@v5
        with:
          ref: ${{ github.event.inputs.ref || github.ref }}

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: apps/web/package-lock.json

      - name: Install dependencies
        run: npm ci

      - name: Build (Vite)
        run: npm run build

      - name: Configure GitHub Pages
        uses: actions/configure-pages@v5

      - name: Upload build artifact
        with:
          path: apps/web/dist
        uses: actions/upload-pages-artifact@v3
```

Two things that are easy to get wrong: `defaults.run.working-directory` applies only to `run:` steps, so `upload-pages-artifact`'s `path` must be repo-root-relative (`apps/web/dist`, not `./dist`); and `cache-dependency-path` is needed because `setup-node` looks for a lockfile at the root by default.

- [ ] **Step 2: Verify the workflow parses**

Run:

```bash
ruby -ryaml -e "
d = YAML.load_file('.github/workflows/deploy-web-app.yml')
b = d['jobs']['build']
puts 'workdir: ' + b['defaults']['run']['working-directory']
steps = b['steps'].map { |s| [s['name'], s] }.to_h
puts 'cache path: ' + steps['Setup Node']['with']['cache-dependency-path']
puts 'artifact path: ' + steps['Upload build artifact']['with']['path']
"
```

**Use `ruby`, not `python3`.** Neither `python3` on this machine has PyYAML
installed (`/opt/homebrew/bin/python3` and `/usr/bin/python3` both raise
`ModuleNotFoundError: No module named 'yaml'`). Ruby ships with Psych and works.
If this command errors, report it — do not substitute the expected values.

Expected:
```
workdir: apps/web
cache path: apps/web/package-lock.json
artifact path: apps/web/dist
```

- [ ] **Step 3: Reproduce the CI build locally from a clean install**

Run:

```bash
cd apps/web && rm -rf node_modules && npm ci && npm run build 2>&1 | tail -5
```

Expected: `npm ci` succeeds — it would have failed on the `file:` dependency before Task 3 — and the build emits `dist/`. This is the closest local equivalent of the CI job.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy-web-app.yml
git commit -m "Run the Pages build in apps/web, where the package lives"
```

---

# Phase 2 — Layered configuration

## Task 5: The merged configuration surface

The biggest task in the plan. `config.rs` gains: a two-table file shape, a custom `DEREC_*` environment provider, a figment merge, and the `Settings` type that carries both halves.

**Critically:** there is **no figment defaults provider**. `Defaults::resolve` (`config.rs:132`) already owns the built-in values, and it clamps `min_participants`, `recommended_participants` and `pre_paired_count` against whatever `participant_count` ended up being. A defaults layer would populate every `Option` before `resolve` saw it, turning every unset field into an explicit one and destroying that behaviour. figment merges the `Option`s; `resolve` fills them; `validate` judges the result.

**Files:**
- Modify: `apps/backend/Cargo.toml` (add `figment`, swap `dotenv` for `dotenvy`)
- Modify: `apps/backend/src/config.rs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `pub struct ServerSettings { pub base_url: String, pub port: u16 }`
  - `pub struct Settings { pub server: ServerSettings, pub defaults: Defaults }`
  - `pub fn load_settings(path: &Path) -> Result<Loaded, ConfigError>`
  - `pub struct Loaded { pub settings: Settings, pub origins: Vec<Origin>, pub file_found: bool, pub unknown_env: Vec<String> }`
  - `pub struct Origin { pub path: &'static str, pub source: Source }`
  - `pub enum Source { Default, File, Env(&'static str) }`
  - `pub fn legacy_env_in_use() -> Vec<(&'static str, &'static str)>`
  - Task 6 calls `load_settings`; Task 7 renders `Loaded`; Task 8 serialises it.

- [ ] **Step 1: Add the dependencies**

In `apps/backend/Cargo.toml`, replace `dotenv = "0.15.0"` with:

```toml
# `dotenv` 0.15 is unmaintained (RUSTSEC-2021-0141). `dotenvy` is the maintained
# fork and keeps the same non-overriding semantics: a `.env` fills variables
# that are not already set, so a real environment variable always wins.
dotenvy = "0.15"
# Layered configuration: TOML file beneath a DEREC_* environment provider.
figment = { version = "0.10", features = ["toml"] }
```

Run: `cd apps/backend && cargo build 2>&1 | tail -5`
Expected: compiles. `dotenv::dotenv()` in `main.rs:12` now fails to resolve — that is expected and Task 6 fixes it. If you want a green build between tasks, change that one line to `dotenvy::dotenv().ok();` now.

- [ ] **Step 2: Write the failing tests**

Append to the `mod tests` block at the bottom of `apps/backend/src/config.rs`:

```rust
    use std::collections::HashSet;

    /// Set `vars` for the duration of `body`, restoring the previous values
    /// afterwards. Tests touching the process environment must not run
    /// concurrently; `ENV_LOCK` serialises them.
    fn with_env<T>(vars: &[(&str, &str)], body: impl FnOnce() -> T) -> T {
        use std::sync::{Mutex, OnceLock};
        static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap_or_else(|e| e.into_inner());

        let saved: Vec<(String, Option<String>)> = vars
            .iter()
            .map(|(k, _)| ((*k).to_owned(), std::env::var(k).ok()))
            .collect();

        // This crate is edition 2021, where `set_var`/`remove_var` are safe.
        // Do NOT wrap these in `unsafe` — that is an `unused_unsafe` warning,
        // and this plan requires a zero-warning build.
        for (k, v) in vars {
            std::env::set_var(k, v);
        }
        let out = body();
        for (k, v) in saved {
            match v {
                Some(v) => std::env::set_var(&k, v),
                None => std::env::remove_var(&k),
            }
        }
        out
    }

    fn settings_from(contents: &str, vars: &[(&str, &str)]) -> Loaded {
        with_env(vars, || {
            Settings::merge(Path::new("test.toml"), Some(contents.to_owned()))
                .expect("settings must load")
        })
    }

    #[test]
    fn env_beats_the_file() {
        let loaded = settings_from(
            "[defaults]\nprotocol_timeout_secs = 45\n",
            &[("DEREC_PROTOCOL_TIMEOUT_SECS", "99")],
        );

        assert_eq!(loaded.settings.defaults.protocol_timeout_secs, 99);
    }

    #[test]
    fn the_file_is_used_where_the_env_is_silent() {
        let loaded = settings_from("[defaults]\nprotocol_timeout_secs = 45\n", &[]);

        assert_eq!(loaded.settings.defaults.protocol_timeout_secs, 45);
    }

    #[test]
    fn an_absent_setting_falls_through_to_the_built_in_default() {
        let loaded = settings_from("", &[]);

        assert_eq!(
            loaded.settings.defaults.protocol_timeout_secs,
            Defaults::default().protocol_timeout_secs
        );
        assert_eq!(loaded.settings.server.port, 5000);
        assert_eq!(loaded.settings.server.base_url, "http://localhost");
    }

    #[test]
    fn a_partial_override_still_adapts_the_rest() {
        // The whole reason there is no figment defaults layer: setting only the
        // count must clamp the thresholds around it rather than fail against
        // the stock recommendation of five.
        let loaded = settings_from("", &[("DEREC_PARTICIPANT_COUNT", "4")]);

        assert_eq!(loaded.settings.defaults.participant_count, 4);
        assert_eq!(loaded.settings.defaults.recommended_participants, 4);
        assert_eq!(loaded.settings.defaults.helper_transports.http, 4);
    }

    #[test]
    fn validation_runs_on_the_merged_result_not_on_either_layer() {
        // Each layer is fine alone: the file sums 7/0/0 against its own count of
        // 7, and the env just says 3. Together they contradict.
        let err = with_env(&[("DEREC_PARTICIPANT_COUNT", "3")], || {
            Settings::merge(
                Path::new("test.toml"),
                Some(
                    "[defaults]\nparticipant_count = 7\n\
                     [defaults.helper_transports]\nhttp = 7\ngrpc = 0\nboth = 0\n"
                        .to_owned(),
                ),
            )
            .unwrap_err()
        });

        let message = err.to_string();
        assert!(
            message.contains("helper_transports"),
            "expected the sum check to fail, got: {message}"
        );
    }

    #[test]
    fn server_settings_come_from_their_own_table() {
        let loaded = settings_from(
            "[server]\nbase_url = \"http://10.0.0.5\"\nport = 6000\n",
            &[],
        );

        assert_eq!(loaded.settings.server.base_url, "http://10.0.0.5");
        assert_eq!(loaded.settings.server.port, 6000);
    }

    #[test]
    fn booleans_and_numbers_survive_the_environment() {
        let loaded = settings_from(
            "",
            &[
                ("DEREC_GRPC_ENABLED", "false"),
                ("DEREC_GRPC_PORT", "60051"),
                ("DEREC_AUTHENTICATION_METHOD", "user"),
                ("DEREC_PARTICIPANT_COUNT", "2"),
                ("DEREC_HELPER_TRANSPORTS_HTTP", "2"),
            ],
        );

        assert!(!loaded.settings.defaults.grpc_enabled);
        assert_eq!(loaded.settings.defaults.grpc_port, 60051);
        assert_eq!(
            loaded.settings.defaults.authentication_method,
            AuthenticationMethod::User
        );
    }

    #[test]
    fn a_misspelled_file_key_is_rejected_rather_than_ignored() {
        let err = with_env(&[], || {
            Settings::merge(
                Path::new("test.toml"),
                Some("[defaults]\nprotocol_timeout_sec = 45\n".to_owned()),
            )
            .unwrap_err()
        });

        assert!(
            err.to_string().contains("protocol_timeout_sec"),
            "the error must name the offending key, got: {err}"
        );
    }

    #[test]
    fn an_unknown_env_variable_warns_rather_than_aborting() {
        let loaded = settings_from("", &[("DEREC_PARTICIPNT_COUNT", "4")]);

        assert_eq!(loaded.unknown_env, vec!["DEREC_PARTICIPNT_COUNT".to_owned()]);
        assert_eq!(
            loaded.settings.defaults.participant_count,
            Defaults::default().participant_count
        );
    }

    #[test]
    fn config_path_is_not_treated_as_a_config_key() {
        let loaded = settings_from("", &[("DEREC_CONFIG_PATH", "/etc/derec/config.toml")]);

        assert!(loaded.unknown_env.is_empty(), "got {:?}", loaded.unknown_env);
    }

    #[test]
    fn the_env_namespace_has_no_collisions() {
        let mut names = HashSet::new();
        let mut paths = HashSet::new();

        for (name, path) in ENV_KEYS {
            assert!(names.insert(*name), "duplicate variable name: DEREC_{name}");
            assert!(paths.insert(*path), "duplicate config path: {path}");
        }

        for (name, _) in ENV_KEYS {
            assert!(
                !RESERVED_ENV.contains(name),
                "DEREC_{name} is both a config key and reserved"
            );
        }
    }

    #[test]
    fn origins_report_where_each_value_actually_came_from() {
        let loaded = settings_from(
            "[defaults]\nunpair_ack = \"required\"\n",
            &[("DEREC_PARTICIPANT_COUNT", "3"), ("DEREC_HELPER_TRANSPORTS_HTTP", "3")],
        );

        let origin = |path: &str| {
            loaded
                .origins
                .iter()
                .find(|o| o.path == path)
                .unwrap_or_else(|| panic!("no origin recorded for {path}"))
                .source
                .clone()
        };

        assert_eq!(
            origin("defaults.participant_count"),
            Source::Env("DEREC_PARTICIPANT_COUNT")
        );
        assert_eq!(origin("defaults.unpair_ack"), Source::File);
        assert_eq!(origin("defaults.protocol_timeout_secs"), Source::Default);
        assert_eq!(origin("server.port"), Source::Default);
    }

    #[test]
    fn a_file_value_equal_to_the_default_still_reports_as_file() {
        // The developer editing that line needs to see it took effect.
        let loaded = settings_from("[defaults]\nprotocol_timeout_secs = 300\n", &[]);

        let origin = loaded
            .origins
            .iter()
            .find(|o| o.path == "defaults.protocol_timeout_secs")
            .expect("origin recorded");

        assert_eq!(origin.source, Source::File);
    }

    #[test]
    fn every_config_path_gets_an_origin() {
        let loaded = settings_from("", &[]);
        let reported: HashSet<&str> = loaded.origins.iter().map(|o| o.path).collect();

        for (_, path) in ENV_KEYS {
            assert!(reported.contains(path), "{path} has no origin");
        }
        assert_eq!(reported.len(), ENV_KEYS.len());
    }

    #[test]
    fn legacy_unprefixed_names_are_detected() {
        let found = with_env(&[("BASE_URL", "http://10.0.0.5")], legacy_env_in_use);

        assert_eq!(found, vec![("BASE_URL", "DEREC_BASE_URL")]);
    }

    #[test]
    fn a_legacy_name_is_ignored_once_its_replacement_is_set() {
        let found = with_env(
            &[("BASE_URL", "http://old"), ("DEREC_BASE_URL", "http://new")],
            legacy_env_in_use,
        );

        assert!(found.is_empty(), "got {found:?}");
    }
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/backend && cargo test --lib config 2>&1 | tail -20`
Expected: compile errors — `Settings`, `Loaded`, `Origin`, `Source`, `ENV_KEYS`, `RESERVED_ENV` and `legacy_env_in_use` do not exist.

- [ ] **Step 4: Implement**

In `apps/backend/src/config.rs`, add these imports at the top:

```rust
use figment::{
    Figment, Metadata, Profile, Provider,
    providers::{Format, Toml},
    value::{Dict, Map, Value},
};
```

Rename the existing constant and add the environment tables, immediately after `CONFIG_PATH_ENV`:

```rust
/// Prefix every configuration variable carries.
const ENV_PREFIX: &str = "DEREC_";

/// `DEREC_*` variables that are not configuration keys.
const RESERVED_ENV: &[&str] = &["DEREC_CONFIG_PATH"];

/// Variable name → dotted path in the config tree.
///
/// Full names, not suffixes: `Source::Env` carries one of these straight into
/// the banner and into `/debug/config`, and a `&'static str` cannot be
/// assembled from a prefix at runtime without leaking.
///
/// Names are deliberately flat: the table a key lives in does not appear, so a
/// compose file reads as `DEREC_PARTICIPANT_COUNT` rather than
/// `DEREC_DEFAULTS__PARTICIPANT_COUNT`. Keys are unique across both tables,
/// which `the_env_namespace_has_no_collisions` enforces.
const ENV_KEYS: &[(&str, &str)] = &[
    ("DEREC_BASE_URL", "server.base_url"),
    ("DEREC_PORT", "server.port"),
    ("DEREC_PARTICIPANT_COUNT", "defaults.participant_count"),
    ("DEREC_PRE_PAIRED_COUNT", "defaults.pre_paired_count"),
    ("DEREC_MIN_PARTICIPANTS", "defaults.min_participants"),
    ("DEREC_RECOMMENDED_PARTICIPANTS", "defaults.recommended_participants"),
    ("DEREC_PROTOCOL_TIMEOUT_SECS", "defaults.protocol_timeout_secs"),
    ("DEREC_AUTHENTICATION_METHOD", "defaults.authentication_method"),
    ("DEREC_UNPAIR_ACK", "defaults.unpair_ack"),
    ("DEREC_AUTO_ACCEPT_UNPAIR_REQUESTS", "defaults.auto_accept_unpair_requests"),
    ("DEREC_GRPC_ENABLED", "defaults.grpc_enabled"),
    ("DEREC_GRPC_PORT", "defaults.grpc_port"),
    ("DEREC_GRPC_RELAY_ENABLED", "defaults.grpc_relay_enabled"),
    ("DEREC_HELPER_TRANSPORTS_HTTP", "defaults.helper_transports.http"),
    ("DEREC_HELPER_TRANSPORTS_GRPC", "defaults.helper_transports.grpc"),
    ("DEREC_HELPER_TRANSPORTS_BOTH", "defaults.helper_transports.both"),
];

/// Unprefixed names this app used to read, and what replaced them.
const LEGACY_ENV: &[(&str, &str)] = &[("BASE_URL", "DEREC_BASE_URL"), ("PORT", "DEREC_PORT")];

/// Legacy variables that are set while their replacement is not.
///
/// Set both and nothing is reported: that is a migrated environment keeping the
/// old name around for something else.
pub fn legacy_env_in_use() -> Vec<(&'static str, &'static str)> {
    LEGACY_ENV
        .iter()
        .filter(|(old, new)| {
            std::env::var_os(old).is_some() && std::env::var_os(new).is_none()
        })
        .copied()
        .collect()
}
```

Add the new shapes. `RawDefaults` is unchanged; wrap it:

```rust
/// The file as written, before unset fields are resolved.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    #[serde(default)]
    server: RawServer,
    #[serde(default)]
    defaults: RawDefaults,
}

/// Process settings, before unset fields are resolved.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawServer {
    base_url: Option<String>,
    port: Option<u16>,
}

/// How this node runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ServerSettings {
    /// Stamped into every transport URI handed to a peer. The port is appended,
    /// so this is a scheme and host with no port of its own.
    pub base_url: String,
    /// The HTTP listener port.
    pub port: u16,
}

impl Default for ServerSettings {
    fn default() -> Self {
        Self {
            base_url: "http://localhost".to_owned(),
            port: 5000,
        }
    }
}

impl ServerSettings {
    fn resolve(raw: RawServer) -> Self {
        let base = Self::default();
        Self {
            base_url: raw.base_url.unwrap_or(base.base_url),
            port: raw.port.unwrap_or(base.port),
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.port == 0 {
            return Err("port must be greater than 0".to_owned());
        }
        if self.base_url.is_empty() {
            return Err("base_url must not be empty".to_owned());
        }
        Ok(())
    }
}

/// Everything the node was configured with.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Settings {
    pub server: ServerSettings,
    pub defaults: Defaults,
}

/// Where a value came from. `Env` carries the variable that supplied it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Default,
    File,
    Env(&'static str),
}

/// One setting's provenance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    pub path: &'static str,
    pub source: Source,
}

// Written by hand rather than derived: `Source` is an enum with a payload on
// one variant only, and the wire shape wanted here is a flat
// `{path, source, variable?}`. `#[serde(flatten)]` over a tagged enum is the
// one serde combination that does not reliably produce that.
impl Serialize for Origin {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;

        let fields = if matches!(self.source, Source::Env(_)) { 3 } else { 2 };
        let mut out = serializer.serialize_struct("Origin", fields)?;
        out.serialize_field("path", self.path)?;
        match self.source {
            Source::Default => out.serialize_field("source", "default")?,
            Source::File => out.serialize_field("source", "file")?,
            Source::Env(variable) => {
                out.serialize_field("source", "env")?;
                out.serialize_field("variable", variable)?;
            }
        }
        out.end()
    }
}

/// The result of loading configuration: the values, and how they got there.
///
/// `Default` exists so `AppState` can hold one before `main` has loaded
/// anything — every test fixture constructs state without a configuration pass.
#[derive(Debug, Clone)]
pub struct Loaded {
    pub settings: Settings,
    pub origins: Vec<Origin>,
    /// Whether a config file was actually read.
    pub file_found: bool,
    /// `DEREC_*` variables that match no known key. Warned about, not fatal.
    pub unknown_env: Vec<String>,
}

// Hand-written rather than derived: a derived `Default` would leave `origins`
// empty, and an empty origins list is a lie — it would make `/debug/config`
// report *no* settings rather than reporting that every setting is a built-in
// default, which is what a `Loaded` nobody configured actually means.
impl Default for Loaded {
    fn default() -> Self {
        Self {
            settings: Settings::default(),
            origins: ENV_KEYS
                .iter()
                .map(|(_, path)| Origin { path, source: Source::Default })
                .collect(),
            file_found: false,
            unknown_env: Vec::new(),
        }
    }
}
```

Now the environment provider:

```rust
/// Reads `DEREC_*` into the config tree.
///
/// A hand-written provider rather than figment's `Env`: this one owns the
/// flat-name-to-dotted-path mapping, and it can separate variables that match a
/// known key from ones that do not, which is what makes "unknown warns" possible.
#[derive(Clone)]
struct EnvProvider {
    values: Vec<(&'static str, String)>,
    unknown: Vec<String>,
}

impl EnvProvider {
    fn from_env() -> Self {
        let mut values = Vec::new();
        let mut unknown = Vec::new();

        for (name, raw) in std::env::vars() {
            if !name.starts_with(ENV_PREFIX) || RESERVED_ENV.contains(&name.as_str()) {
                continue;
            }
            match ENV_KEYS.iter().find(|(var, _)| *var == name) {
                Some((_, path)) => values.push((*path, raw)),
                None => unknown.push(name),
            }
        }

        values.sort_by_key(|(path, _)| *path);
        unknown.sort();
        Self { values, unknown }
    }

    /// The variable that maps to `path`, if any.
    fn variable_for(path: &str) -> Option<&'static str> {
        ENV_KEYS.iter().find(|(_, p)| *p == path).map(|(name, _)| *name)
    }
}

/// Environment values arrive as strings; give figment the right shape so serde
/// does not have to coerce `"false"` into a `bool`.
fn coerce(raw: &str) -> Value {
    if let Ok(b) = raw.parse::<bool>() {
        return Value::from(b);
    }
    if let Ok(n) = raw.parse::<u64>() {
        return Value::from(n);
    }
    Value::from(raw)
}

/// Insert `value` at a dotted path, creating intermediate dictionaries.
fn insert_path(root: &mut Dict, path: &str, value: Value) {
    let mut segments: Vec<&str> = path.split('.').collect();
    let Some(leaf) = segments.pop() else {
        return;
    };

    let mut cursor = root;
    for segment in segments {
        let entry = cursor
            .entry(segment.to_owned())
            .or_insert_with(|| Value::from(Dict::new()));
        match entry {
            Value::Dict(_, dict) => cursor = dict,
            _ => return,
        }
    }
    cursor.insert(leaf.to_owned(), value);
}

impl Provider for EnvProvider {
    fn metadata(&self) -> Metadata {
        Metadata::named("environment")
    }

    fn data(&self) -> Result<Map<Profile, Dict>, figment::Error> {
        let mut root = Dict::new();
        for (path, raw) in &self.values {
            insert_path(&mut root, path, coerce(raw));
        }
        Ok(Profile::Default.collect(root))
    }
}
```

And the merge itself, on `Settings`:

```rust
impl Settings {
    /// Merge file and environment into one validated configuration.
    ///
    /// `contents` is `None` when no file was found, which is the ordinary case
    /// for a plain `docker run` with nothing mounted.
    ///
    /// There is no figment defaults provider on purpose. `Defaults::resolve`
    /// owns the built-in values *and* adapts the participant thresholds around
    /// whatever count survived the merge; a defaults layer would fill every
    /// `Option` first and turn each unset field into an explicit one.
    pub fn merge(path: &Path, contents: Option<String>) -> Result<Loaded, ConfigError> {
        let file_found = contents.is_some();
        let body = contents.unwrap_or_default();

        // Parse first so a syntax error keeps reporting as `Parse`.
        let _: toml::Value = body.parse().map_err(|source| ConfigError::Parse {
            path: path.to_path_buf(),
            source,
        })?;

        let env = EnvProvider::from_env();
        let unknown_env = env.unknown.clone();

        let from_file = Figment::from(Toml::string(&body));
        let from_env = Figment::from(env.clone());
        let merged = Figment::from(Toml::string(&body)).merge(env);

        let raw: RawConfig = merged.extract().map_err(|e| ConfigError::Invalid {
            path: path.to_path_buf(),
            reason: e.to_string(),
        })?;

        let settings = Settings {
            server: ServerSettings::resolve(raw.server),
            defaults: Defaults::resolve(raw.defaults),
        };

        settings
            .server
            .validate()
            .and_then(|()| settings.defaults.validate())
            .map_err(|reason| ConfigError::Invalid {
                path: path.to_path_buf(),
                reason,
            })?;

        let origins = ENV_KEYS
            .iter()
            .map(|(_, config_path)| {
                let source = if from_env.find_value(config_path).is_ok() {
                    EnvProvider::variable_for(config_path)
                        .map(Source::Env)
                        .unwrap_or(Source::Default)
                } else if from_file.find_value(config_path).is_ok() {
                    Source::File
                } else {
                    Source::Default
                };
                Origin { path: config_path, source }
            })
            .collect();

        Ok(Loaded { settings, origins, file_found, unknown_env })
    }
}
```

`Source::Env` holds the *unprefixed* name in `ENV_KEYS`, so the banner must print `DEREC_{name}`. Keep it that way rather than storing the full name twice.

Finally, replace the body of `load` so it feeds `Settings::merge` and returns `Loaded`:

```rust
/// Read configuration from `path`, merged with the environment.
///
/// A missing file is not an error — that is the ordinary `docker run` case, and
/// the environment plus built-in defaults are a complete configuration. Every
/// other read failure is returned: a developer who mounted a file that cannot be
/// read wants to hear about it at boot rather than silently get stock values.
pub fn load(path: &Path) -> Result<Loaded, ConfigError> {
    let contents = match std::fs::read_to_string(path) {
        Ok(c) => Some(c),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => None,
        Err(source) => {
            return Err(ConfigError::Read {
                path: path.to_path_buf(),
                source,
            });
        }
    };

    Settings::merge(path, contents)
}
```

Delete `Defaults::parse` — `Settings::merge` replaces it — and update the four existing tests that called the local `parse` helper to go through `settings_from(contents, &[])` and read `.settings.defaults` instead.

- [ ] **Step 5: Run the tests**

Run: `cd apps/backend && cargo test --lib config 2>&1 | tail -25`
Expected: all config tests pass.

If `Profile::Default.collect(root)` does not resolve, figment's helper is named differently in the resolved version — build the map directly instead:

```rust
let mut map = Map::new();
map.insert(Profile::Default, root);
Ok(map)
```

If `Toml::string` is not found, the `Format` trait is not in scope — it is imported above, check the import survived.

- [ ] **Step 6: Run the whole backend suite**

Run: `cd apps/backend && cargo test 2>&1 | grep -E "test result|FAILED"`
Expected: no `FAILED`. `main.rs` still calls the old API and will not compile until Task 6 — if the binary breaks the test build, complete Task 6 before judging this step, but keep the commits separate.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/Cargo.toml apps/backend/Cargo.lock apps/backend/src/config.rs
git commit -m "Merge configuration from a two-table file and DEREC_ variables"
```

---

## Task 6: Wire the binary to the merged settings

**Files:**
- Modify: `apps/backend/src/main.rs`
- Modify: `apps/backend/src/state.rs` (only if `AppState::new` needs the new type — check first)

**Interfaces:**
- Consumes: `config::load`, `config::Loaded`, `config::legacy_env_in_use` from Task 5.
- Produces: a binary whose `base_url` and `port` come from the merged settings. Task 7 adds the banner to the same boot path.

- [ ] **Step 1: Check what `AppState::new` expects**

Run: `cd apps/backend && rg -n "fn new" src/state.rs | head -3`

`AppState::new(base_url, defaults, http_client, arbiter_handle)` takes `Defaults` by value. `Loaded.settings.defaults` is a `Defaults`, so **no change to `state.rs` is needed** — pass `loaded.settings.defaults`. Confirm before editing.

- [ ] **Step 2: Rewrite the boot path**

In `apps/backend/src/main.rs`, replace the `dotenv` line, the `load_defaults()` call and the `base_url`/`port` block (lines 12-35) with:

```rust
    dotenvy::dotenv().ok();
```

...then, after the tracing setup:

```rust
    // Unprefixed names are no longer read. Failing here beats a node that
    // quietly advertises `http://localhost:5000` to peers that cannot reach it.
    let legacy = config::legacy_env_in_use();
    if !legacy.is_empty() {
        for (old, new) in &legacy {
            eprintln!("configuration error: {old} is no longer read; use {new}");
        }
        std::process::exit(1);
    }

    let loaded = load_configuration();

    let base_url = format!("{}:{}", loaded.settings.server.base_url, loaded.settings.server.port);
    let port = loaded.settings.server.port;

    // `base_url` is not just where this server listens — it is the address
    // stamped into every transport URI this node hands to a peer, and the
    // address that peer will post to. A loopback value works right up until a
    // second device joins, at which point the peer dutifully sends to its *own*
    // localhost and the pairing dies with nothing pointing at the cause.
    if base_url.contains("localhost") || base_url.contains("127.0.0.1") {
        warn!(
            base_url = %base_url,
            "BASE_URL is loopback — reachable only from this machine. Set it to \
             this host's LAN address (e.g. DEREC_BASE_URL=http://192.168.0.28) \
             before pairing from another device."
        );
    }

    let defaults = loaded.settings.defaults.clone();
```

Replace the `format!("0.0.0.0:{port}")` bind to use the `u16` directly:

```rust
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("failed to bind to port");
```

And replace `load_defaults()` at the bottom of the file with:

```rust
/// Read the merged configuration.
///
/// No file is the ordinary case for a plain `docker run` with nothing mounted,
/// so that falls back to the environment and the built-in values. A file that
/// *is* there but cannot be read, parsed, or validated aborts the boot: silently
/// serving stock values would leave a developer debugging a config they believe
/// is in effect.
fn load_configuration() -> config::Loaded {
    let path = config::configured_path();

    match config::load(&path) {
        Ok(loaded) => loaded,
        Err(e) => {
            // `tracing` is already initialised, but a boot abort should also
            // reach a plain `docker logs` reader who has filtered the level.
            eprintln!("configuration error: {e}");
            std::process::exit(1);
        }
    }
}
```

Update the imports at the top: `use derec_backend::config::{self};` replaces `use derec_backend::config::{self, Defaults};` if `Defaults` is no longer named directly.

- [ ] **Step 3: Verify it compiles and boots**

Run: `cd apps/backend && cargo build 2>&1 | tail -5`
Expected: no errors, no warnings.

Run:

```bash
cd apps/backend && DEREC_PORT=5099 DEREC_BASE_URL=http://127.0.0.1 \
  timeout 5 cargo run 2>&1 | grep -E "listening|base URL"
```

Expected: `server listening on 0.0.0.0:5099` and `base URL: http://127.0.0.1:5099`.

- [ ] **Step 4: Verify a legacy name aborts**

Run:

```bash
cd apps/backend && BASE_URL=http://10.0.0.5 timeout 5 cargo run 2>&1 | head -3; echo "exit=$?"
```

Expected: `configuration error: BASE_URL is no longer read; use DEREC_BASE_URL`, and the process exits rather than serving.

- [ ] **Step 5: Verify a bad config still aborts**

Run:

```bash
cd apps/backend && printf '[defaults]\nparticipant_count = 0\n' > /tmp/bad.toml && \
  DEREC_CONFIG_PATH=/tmp/bad.toml timeout 5 cargo run 2>&1 | head -3
```

Expected: `configuration error: /tmp/bad.toml is not a usable configuration: participant_count must be at least 1`

- [ ] **Step 6: Run the full suite**

Run: `cd apps/backend && cargo test 2>&1 | grep -E "test result|FAILED"`
Expected: 12 `ok` lines, no `FAILED`.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/main.rs
git commit -m "Boot from merged settings and refuse the retired variable names"
```

---

## Task 7: The boot banner

Every setting, its value, and where it came from — printed once, after validation, before serving.

**Files:**
- Modify: `apps/backend/src/config.rs` (add `report`)
- Modify: `apps/backend/src/main.rs` (call it)

**Interfaces:**
- Consumes: `Loaded` from Task 5.
- Produces: `pub fn report(loaded: &Loaded, path: &Path) -> String`. Task 8 does not use it — it serialises `origins` directly.

- [ ] **Step 1: Write the failing tests**

Append to `mod tests` in `config.rs`:

```rust
    #[test]
    fn the_banner_lists_every_setting_with_its_origin() {
        let loaded = settings_from(
            "[defaults]\nunpair_ack = \"not_required\"\n",
            &[("DEREC_PARTICIPANT_COUNT", "3"), ("DEREC_HELPER_TRANSPORTS_HTTP", "3")],
        );

        let banner = report(&loaded, Path::new("/etc/derec/config.toml"));

        // An overridden value names the variable that won.
        assert!(
            banner.contains("participant_count") && banner.contains("DEREC_PARTICIPANT_COUNT"),
            "{banner}"
        );
        // A file value reports the file.
        assert!(banner.contains("unpair_ack") && banner.contains("not_required"), "{banner}");
        // An untouched value is still listed, marked default — that is the
        // whole diagnostic: "I set it and nothing happened" looks like this.
        assert!(banner.contains("protocol_timeout_secs"), "{banner}");
        assert!(banner.contains("default"), "{banner}");
    }

    #[test]
    fn the_banner_says_whether_a_file_was_found() {
        let missing = with_env(&[], || {
            Settings::merge(Path::new("/nope/config.toml"), None).expect("loads")
        });

        let banner = report(&missing, Path::new("/nope/config.toml"));
        assert!(banner.contains("not found"), "{banner}");
        assert!(banner.contains("/nope/config.toml"), "{banner}");
    }

    #[test]
    fn the_banner_reports_unknown_variables() {
        let loaded = settings_from("", &[("DEREC_NOT_A_KEY", "1")]);
        let banner = report(&loaded, Path::new("config.toml"));

        assert!(banner.contains("DEREC_NOT_A_KEY"), "{banner}");
    }

    #[test]
    fn the_banner_is_stable_across_runs() {
        let a = settings_from("", &[("DEREC_PARTICIPANT_COUNT", "3"), ("DEREC_HELPER_TRANSPORTS_HTTP", "3")]);
        let b = settings_from("", &[("DEREC_HELPER_TRANSPORTS_HTTP", "3"), ("DEREC_PARTICIPANT_COUNT", "3")]);

        assert_eq!(
            report(&a, Path::new("config.toml")),
            report(&b, Path::new("config.toml")),
            "two logs of the same configuration must be diffable"
        );
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/backend && cargo test --lib config 2>&1 | tail -10`
Expected: `cannot find function 'report' in this scope`.

- [ ] **Step 3: Implement `report`**

Add to `config.rs`:

```rust
/// Render the resolved configuration for the boot log.
///
/// Every setting appears, not only the overridden ones: a developer who set a
/// variable and saw no effect needs to see that key reported as `default`,
/// because that *is* the diagnosis. Order follows `ENV_KEYS`, which is fixed, so
/// two runs of the same configuration produce identical text and can be diffed.
pub fn report(loaded: &Loaded, path: &Path) -> String {
    use std::fmt::Write as _;

    let mut out = String::from("configuration\n");

    let _ = writeln!(
        out,
        "  file   {}  {}",
        path.display(),
        if loaded.file_found { "loaded" } else { "not found" }
    );
    let env_count = loaded
        .origins
        .iter()
        .filter(|o| matches!(o.source, Source::Env(_)))
        .count();
    let _ = writeln!(out, "  env    {env_count} DEREC_* variables");

    for name in &loaded.unknown_env {
        let _ = writeln!(out, "  env    {name} is not a known setting; ignored");
    }

    let values = values_by_path(&loaded.settings);
    let width = ENV_KEYS
        .iter()
        .map(|(_, path)| leaf_of(path).len())
        .max()
        .unwrap_or(0);

    let mut table = String::new();
    for (_, config_path) in ENV_KEYS {
        let table_name = config_path.split('.').next().unwrap_or("");
        if !table.contains(&format!("[{table_name}]")) {
            let _ = write!(table, "\n  [{table_name}]\n");
        }

        let origin = loaded
            .origins
            .iter()
            .find(|o| o.path == *config_path)
            .map(|o| match o.source {
                Source::Default => "default".to_owned(),
                Source::File => "file".to_owned(),
                Source::Env(name) => format!("env {name}"),
            })
            .unwrap_or_else(|| "default".to_owned());

        let value = values
            .iter()
            .find(|(p, _)| p == config_path)
            .map(|(_, v)| v.clone())
            .unwrap_or_default();

        let _ = writeln!(
            table,
            "  {:<width$}  {:<24}  {}",
            leaf_of(config_path),
            value,
            origin,
            width = width
        );
    }

    out.push_str(&table);
    out
}

/// The part of a dotted path the banner shows, e.g.
/// `defaults.helper_transports.http` → `helper_transports.http`.
fn leaf_of(path: &str) -> &str {
    path.split_once('.').map(|(_, rest)| rest).unwrap_or(path)
}

/// Every setting's value as displayed text, keyed by its dotted path.
///
/// Goes through `serde_json` rather than a hand-written match so a field added
/// to `Defaults` cannot be silently missing from the banner — the
/// `every_config_path_gets_an_origin` test pairs with this to keep both honest.
fn values_by_path(settings: &Settings) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Ok(root) = serde_json::to_value(settings) else {
        return out;
    };

    for (_, path) in ENV_KEYS {
        let mut cursor = &root;
        let mut found = true;
        for segment in path.split('.') {
            match cursor.get(segment) {
                Some(next) => cursor = next,
                None => {
                    found = false;
                    break;
                }
            }
        }
        if found {
            let text = match cursor {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            out.push(((*path).to_owned(), text));
        }
    }
    out
}
```

`Settings` and `ServerSettings` already derive `Serialize`; `Defaults` does too. `serde_json` is already a dependency.

- [ ] **Step 4: Run the tests**

Run: `cd apps/backend && cargo test --lib config 2>&1 | tail -20`
Expected: all pass.

- [ ] **Step 5: Print it at boot**

In `main.rs`, immediately after `load_configuration()` returns and the legacy check has passed, before the loopback warning:

```rust
    info!("\n{}", config::report(&loaded, &config::configured_path()));
```

- [ ] **Step 6: Look at it**

Run:

```bash
cd apps/backend && DEREC_PARTICIPANT_COUNT=3 DEREC_HELPER_TRANSPORTS_HTTP=3 \
  DEREC_PORT=5099 DEREC_NONSENSE=1 timeout 5 cargo run 2>&1 | head -35
```

Expected: the banner, with `participant_count` showing `env DEREC_PARTICIPANT_COUNT`, `port` showing `env DEREC_PORT`, `protocol_timeout_secs` showing `default`, a line noting `DEREC_NONSENSE` is not a known setting, and a `file ... not found` header. Read it as a developer would — if a column does not line up or a value is unreadable, fix it now.

- [ ] **Step 7: Run the full suite and commit**

Run: `cd apps/backend && cargo test 2>&1 | grep -E "test result|FAILED"`
Expected: 12 `ok` lines, no `FAILED`.

```bash
git add apps/backend/src/config.rs apps/backend/src/main.rs
git commit -m "Report the resolved configuration and its provenance at boot"
```

---

## Task 8: `GET /debug/config`

The same data the banner renders, as JSON, for the Inspect tab to consume later.

**Files:**
- Modify: `apps/backend/src/routes/debug.rs`
- Modify: `apps/backend/src/lib.rs:47-48`
- Modify: `apps/backend/src/state.rs` (store the origins)
- Modify: `apps/backend/openapi.yaml`
- Test: `apps/backend/tests/config_route.rs` (create)

**Interfaces:**
- Consumes: `Loaded`, `Origin`, `Source`, `Settings` from Task 5.
- Produces: `GET /debug/config` returning `{ "settings": {...}, "origins": [...], "file_found": bool, "unknown_env": [...] }`.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/config_route.rs`:

```rust
//! `/debug/config` reports what the node was configured with and where each
//! value came from. `/config` must keep its existing shape — the front end
//! deserialises it directly, so widening it would be an API break for every
//! consumer in exchange for data only a debugging view wants.
//!
//! Follows the `replica_contact_route.rs` pattern: the real
//! `derec_backend::build_router` driven through `tower::ServiceExt::oneshot`.

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use serde_json::Value;
use tower::ServiceExt;

fn app() -> Router {
    derec_backend::build_router(derec_backend::test_support::app_state())
}

async fn get(router: &Router, path: &str) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(
            Request::get(path)
                .body(Body::empty())
                .expect("request builds"),
        )
        .await
        .expect("router is infallible");

    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body readable");

    (status, serde_json::from_slice(&bytes).expect("body is JSON"))
}

#[tokio::test]
async fn debug_config_reports_values_and_origins() {
    let (status, body) = get(&app(), "/debug/config").await;
    assert_eq!(status, StatusCode::OK);

    assert!(body["settings"]["defaults"]["participant_count"].is_number());
    assert!(body["settings"]["server"]["port"].is_number());

    let origins = body["origins"].as_array().expect("origins array");
    assert_eq!(origins.len(), 16, "every setting needs an origin");

    let participant = origins
        .iter()
        .find(|o| o["path"] == "defaults.participant_count")
        .expect("participant_count origin");

    // `test_support::app_state()` loads no file and reads no environment, so
    // everything is a built-in default and no `variable` key is emitted.
    assert_eq!(participant["source"], "default");
    assert!(participant["variable"].is_null());
}

#[tokio::test]
async fn plain_config_keeps_its_flat_shape() {
    let (status, body) = get(&app(), "/config").await;
    assert_eq!(status, StatusCode::OK);

    // Flat, no nesting, no provenance — the front end reads these keys directly.
    assert!(body["participant_count"].is_number());
    assert!(body["settings"].is_null());
    assert!(body["origins"].is_null());
}
```

`test_support::app_state()` returns `Arc<AppState>` and is what every other route test uses; it builds state with `Defaults::default()` and no configuration pass, which is exactly the "everything is a default" case asserted above.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/backend && cargo test --test config_route 2>&1 | tail -10`
Expected: 404 on `/debug/config`, or a compile error naming the missing helper.

- [ ] **Step 3: Carry the load result into state**

`AppState::new` has five call sites (`state.rs:270`, `state.rs:620`, `state.rs:635`, `main.rs:59`, `tests/common/mod.rs:98`, `tests/helper_auto_confirm.rs:56`). Adding parameters would churn all of them to pass values only one caller has. Add one field with a default instead, and a setter the binary uses.

In `apps/backend/src/state.rs`, add a field beside `defaults`:

```rust
    /// What this node was configured with and where each value came from.
    /// Served by `GET /debug/config`. Empty under `test_support`, which builds
    /// state without a configuration pass.
    pub config: Arc<crate::config::Loaded>,
```

Initialise it inside `AppState::new` alongside the other fields — no new parameter:

```rust
            config: Arc::new(crate::config::Loaded::default()),
```

And add, in the same `impl AppState` block:

```rust
    /// Attach the configuration this node actually booted with.
    ///
    /// Separate from `new` so the five other construction sites — all test
    /// fixtures — do not have to supply something they have no opinion about.
    pub fn with_config(mut self, loaded: crate::config::Loaded) -> Self {
        self.config = Arc::new(loaded);
        self
    }
```

In `main.rs`, chain it where state is built:

```rust
    let state = Arc::new(
        AppState::new(
            base_url.as_str(),
            defaults,
            http_client,
            arbiter_handle,
        )
        .with_config(loaded),
    );
```

`loaded` is moved here, so take the `defaults` clone before this point — Task 6 already does (`let defaults = loaded.settings.defaults.clone();`).

- [ ] **Step 4: Add the handler**

In `apps/backend/src/routes/debug.rs`:

```rust
/// GET /debug/config
///
/// The resolved configuration and where each value came from — the same data
/// the boot banner renders. Separate from `GET /config`, which returns a flat
/// `Defaults` the front end deserialises directly and must not grow a wrapper.
pub async fn config(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(serde_json::json!({
        "settings": state.config.settings,
        "origins": state.config.origins,
        "file_found": state.config.file_found,
        "unknown_env": state.config.unknown_env,
    }))
}
```

Match the imports the rest of `debug.rs` already uses.

Note this reports `state.config.settings.defaults`, not `state.defaults`. They are the same values in the binary — `main` builds one from the other — and under `test_support` both are `Defaults::default()`. Reporting the loaded one keeps `/debug/config` an honest account of the configuration pass rather than of whatever state was later constructed.

- [ ] **Step 5: Register the route**

In `apps/backend/src/lib.rs`, beside the other debug routes:

```rust
        .route("/debug/config", get(routes::debug::config))
```

- [ ] **Step 6: Run the test**

Run: `cd apps/backend && cargo test --test config_route 2>&1 | grep "test result"`
Expected: `test result: ok. 2 passed`

- [ ] **Step 7: Document it and satisfy the drift test**

`apps/backend/tests/openapi_drift.rs` asserts `openapi.yaml` matches the router. Add the path to `openapi.yaml` next to `/debug/state`:

```yaml
  /debug/config:
    get:
      summary: Resolved configuration and per-setting provenance
      description: >
        Every setting the node is running with, the source each value came from
        (built-in default, the config file, or a named DEREC_ variable), whether
        a config file was found, and any DEREC_ variables that matched no
        setting. The same data the boot banner prints.
      responses:
        "200":
          description: Configuration and provenance
          content:
            application/json:
              schema:
                type: object
                required: [settings, origins, file_found, unknown_env]
                properties:
                  settings:
                    type: object
                  origins:
                    type: array
                    items:
                      type: object
                      required: [path, source]
                      properties:
                        path:
                          type: string
                          example: defaults.participant_count
                        source:
                          type: string
                          enum: [default, file, env]
                        variable:
                          type: string
                          example: DEREC_PARTICIPANT_COUNT
                  file_found:
                    type: boolean
                  unknown_env:
                    type: array
                    items:
                      type: string
```

Run: `cd apps/backend && cargo test --test openapi_drift 2>&1 | grep "test result"`
Expected: `test result: ok`

- [ ] **Step 8: Full suite and commit**

Run: `cd apps/backend && cargo test 2>&1 | grep -E "test result|FAILED"`
Expected: 13 `ok` lines, no `FAILED`.

```bash
git add apps/backend/src/routes/debug.rs apps/backend/src/lib.rs \
        apps/backend/src/state.rs apps/backend/src/main.rs \
        apps/backend/openapi.yaml apps/backend/tests/config_route.rs
git commit -m "Serve resolved configuration and provenance from /debug/config"
```

---

## Task 9: Documentation and worked examples

**Files:**
- Modify: `apps/backend/config.example.toml`
- Create: `.env.example`
- Create: `compose.yaml`
- Modify: `README.md`

**Interfaces:**
- Consumes: the setting names from Task 5.
- Produces: files the spec's later image phase extends with `database_url`, `static_dir` and the volume.

**Scope note:** the spec's worked examples include `database_url`, `static_dir` and a data volume. Those settings do not exist yet — they arrive with persistence and the image. Write these files describing **only what ships now**, and leave the rest to the phase that implements it. A documented setting that does nothing is worse than a missing one.

- [ ] **Step 1: Restructure `config.example.toml`**

Replace it entirely:

```toml
# Default configuration for the DeRec reference app.
#
# Two tables:
#   [server]    how this node runs
#   [defaults]  starting values for the front-end setup wizard
#
# The [defaults] values are defaults only — the user can change any of them
# before setting up, and the backend does not enforce them: the settings a node
# actually runs with are whatever the front end sends on each provisioning
# request.
#
# Every key is optional. Omit one and the built-in default (shown below)
# applies. An unrecognised key is a boot error, so a typo fails loudly.
#
# Every key is also an environment variable, which wins over this file. Names
# are flat and prefixed — the table does not appear:
#
#   participant_count           -> DEREC_PARTICIPANT_COUNT
#   base_url                    -> DEREC_BASE_URL
#   helper_transports.http      -> DEREC_HELPER_TRANSPORTS_HTTP
#
# An unrecognised DEREC_ variable is warned about, not fatal: the environment is
# shared, and refusing to boot over an unrelated variable would be hostile.
#
# Copy this file to `config.toml` next to the binary, or mount it anywhere and
# point `DEREC_CONFIG_PATH` at it.

[server]
# Stamped into every transport URI this node hands to a peer, and the address
# that peer posts back to. The port is appended, so write the host only.
# A loopback value works right up until a second device joins.
base_url = "http://localhost"

# The HTTP listener port. The UI and the API share it.
port = 5000

[defaults]
# Participants to provision when setting up. Must be at least 1.
participant_count = 7

# How many of those to pair automatically, skipping the QR exchange.
# A testing shortcut. Must not exceed `participant_count`.
pre_paired_count = 3

# Paired participants required before secret protection is allowed.
# Must be at least 1 and must not exceed `participant_count`.
min_participants = 3

# Paired participants below which the UI shows a warning.
# Must fall between `min_participants` and `participant_count`.
recommended_participants = 5

# General protocol timeout, in seconds. The single timeout the app uses: the
# protocol discards expired messages and stale rounds with it, and the UI uses
# the same value as its active deadline for pairing waits and auto-rejects.
# Lower = snappier failures; higher = more tolerant of slow peers.
protocol_timeout_secs = 300

# How the app decides that two pairing channels belong to the same user. An
# app-level concern — the DeRec protocol itself is identity-blind.
#
#   "user"         the helper links channels manually when accepting a pairing
#   "application"  reserved for a future identity-driven mode; not yet selectable
authentication_method = "user"

# Protocol-level acknowledgement policy for the unpair flow.
#
#   "required"      the initiator keeps local state until the peer acknowledges
#                   or the protocol timeout elapses
#   "not_required"  fire-and-forget: state drops immediately, later replies ignored
unpair_ack = "required"

# Whether an incoming unpair request is accepted quietly (true) or surfaced as a
# confirmation dialog the operator must answer (false). UI behaviour only.
auto_accept_unpair_requests = true

# The gRPC transport listener. Provisioned helpers can advertise a `grpc://`
# endpoint only while this is running; set false to run HTTP-only.
grpc_enabled = true
grpc_port = 50051

# Whether the backend will dial gRPC on a browser owner's behalf. A browser
# cannot speak gRPC itself. Turning this off makes a gRPC-only helper
# unreachable from a browser, which is a behaviour worth observing on purpose.
grpc_relay_enabled = true

# Prefills the wizard's transport breakdown. Must sum to `participant_count`.
[defaults.helper_transports]
http = 7
grpc = 0
both = 0
```

The old file carried a warning that the table section had to be last, because a plain key after a table header is parsed into that table. Explicit `[server]` and `[defaults]` tables retire that note — do not carry it over.

- [ ] **Step 2: Create `.env.example`**

```bash
# Environment configuration for the DeRec reference app.
#
# Two ways this file reaches the process:
#
#   * `env_file: .env` in compose, which injects these as real environment
#     variables into the container;
#   * a `.env` next to the binary, which the app reads itself — and which fills
#     only variables that are NOT already set, so a real variable always wins.
#
# Either way these outrank config.toml.
#
# Copy to `.env` and edit.

# Peers post back to this address, so loopback works right up until a second
# device joins. No port — the node appends its own.
DEREC_BASE_URL=http://localhost

# The HTTP listener port. The UI and the API share it.
DEREC_PORT=5000

# Where to read the config file from.
# DEREC_CONFIG_PATH=/etc/derec/config.toml

# A smaller set than the file's 7, for a quicker loop.
#
# Changing the count means changing the breakdown too: it must sum to
# participant_count, and that check runs on the MERGED result. Override the
# count here and leave the file's 7/0/0 alone and the node refuses to boot.
# DEREC_PARTICIPANT_COUNT=3
# DEREC_PRE_PAIRED_COUNT=1
# DEREC_MIN_PARTICIPANTS=2
# DEREC_RECOMMENDED_PARTICIPANTS=2
# DEREC_HELPER_TRANSPORTS_HTTP=3
# DEREC_HELPER_TRANSPORTS_GRPC=0
# DEREC_HELPER_TRANSPORTS_BOTH=0
```

- [ ] **Step 3: Create `compose.yaml`**

There is no image yet, so this builds from source. The image phase replaces `build:` with `image:` and adds the data volume.

```yaml
name: derec

services:
  node:
    # Until the image ships, build the backend from this repo.
    build:
      context: .
      dockerfile: apps/backend/Dockerfile

    # Bulk configuration. `env_file` injects real environment variables into
    # the container, so everything here outranks config.toml.
    env_file: .env

    # Highest precedence — wins over .env and over the file.
    environment:
      # ${LAN_IP} is substituted by compose from the .env at the project root —
      # a different mechanism from `env_file` above, which passes variables
      # into the container rather than into this file.
      DEREC_BASE_URL: "http://${LAN_IP:-localhost}"
      DEREC_CONFIG_PATH: /etc/derec/config.toml

    ports:
      - "5000:5000"      # HTTP API
      - "50051:50051"    # gRPC transport

    volumes:
      - ./apps/backend/config.toml:/etc/derec/config.toml:ro

    restart: unless-stopped
```

Note in a comment at the top of the file that `apps/backend/Dockerfile` does not exist yet and this file becomes usable when it does — an example that silently fails is worse than one that says why.

- [ ] **Step 4: Rewrite the README's SDK section**

Delete the whole "### Building the SDK from source (temporary)" section — the temporary period is over — and replace with:

```markdown
### The SDK

Both halves track SDK **0.0.3**, taken from the registries: `derec-library`
and `derec-proto` from crates.io, `@derec-alliance/web` from npm. No sibling
checkout is required for anything, including the end-to-end tests.

The backend generates its own gRPC transport service, because the published
`derec-proto` ships message types only. The 15 `.proto` files that needs are
vendored in `apps/backend/proto/`, and `tests/proto_drift.rs` checks them
against the pinned release — so bumping the SDK means re-copying them, and the
test tells you when you forgot.
```

- [ ] **Step 5: Add the configuration section to the README**

After "### Configuring defaults" — replacing it — add:

````markdown
### Configuring it

Two ways in, one merged result: a TOML file and environment variables, with the
environment winning. Anything settable one way is settable the other.

Precedence, highest first:

| | Source | Beats |
| --- | --- | --- |
| 4 | `environment:` or `-e` on the container | everything |
| 3 | `env_file:` in compose — injects real variables | the file and the defaults |
| 2 | a `.env` beside the process — fills only variables **not already set** | the config file |
| 1 | the TOML config file | the built-in defaults |

Tiers 3 and 4 look the same to the app — both are just the environment by the
time it starts, and compose resolves that precedence itself.

Variable names are flat and prefixed; the table a key lives in does not appear:

| File key | Variable |
| --- | --- |
| `server.base_url` | `DEREC_BASE_URL` |
| `server.port` | `DEREC_PORT` |
| `defaults.participant_count` | `DEREC_PARTICIPANT_COUNT` |
| `defaults.pre_paired_count` | `DEREC_PRE_PAIRED_COUNT` |
| `defaults.min_participants` | `DEREC_MIN_PARTICIPANTS` |
| `defaults.recommended_participants` | `DEREC_RECOMMENDED_PARTICIPANTS` |
| `defaults.protocol_timeout_secs` | `DEREC_PROTOCOL_TIMEOUT_SECS` |
| `defaults.authentication_method` | `DEREC_AUTHENTICATION_METHOD` |
| `defaults.unpair_ack` | `DEREC_UNPAIR_ACK` |
| `defaults.auto_accept_unpair_requests` | `DEREC_AUTO_ACCEPT_UNPAIR_REQUESTS` |
| `defaults.grpc_enabled` | `DEREC_GRPC_ENABLED` |
| `defaults.grpc_port` | `DEREC_GRPC_PORT` |
| `defaults.grpc_relay_enabled` | `DEREC_GRPC_RELAY_ENABLED` |
| `defaults.helper_transports.http` | `DEREC_HELPER_TRANSPORTS_HTTP` |
| `defaults.helper_transports.grpc` | `DEREC_HELPER_TRANSPORTS_GRPC` |
| `defaults.helper_transports.both` | `DEREC_HELPER_TRANSPORTS_BOTH` |

`DEREC_CONFIG_PATH` names the config file and is not itself a setting.

`BASE_URL`, `PORT` and `STATIC_DIR` are no longer read. Setting one without its
`DEREC_`-prefixed replacement aborts the boot with a message naming it, rather
than leaving a node quietly running on defaults.

A misspelled key in the file aborts the boot — the file is unambiguously yours.
An unrecognised `DEREC_` variable only warns: the environment is shared.

Validation runs on the **merged** result. `helper_transports` must sum to
`participant_count`, so overriding the count in `.env` while the file still
lists the old breakdown is a configuration that passes per-source and fails as
a whole. See `.env.example`, which calls this out where you would hit it.

#### Seeing what was loaded

The node prints its entire resolved configuration at boot — every setting, its
value, and where the value came from:

```
configuration
  file   /etc/derec/config.toml  loaded
  env    3 DEREC_* variables

  [server]
  base_url                  http://192.168.0.28  env DEREC_BASE_URL
  port                      5000                 default

  [defaults]
  participant_count         3                    env DEREC_PARTICIPANT_COUNT
  protocol_timeout_secs     300                  default
  unpair_ack                required             file
  ...
```

Every setting is listed, not only the overridden ones — if you set something
and nothing happened, seeing that key marked `default` is the answer. The same
data is available as JSON from `GET /debug/config`.
````

- [ ] **Step 6: Verify the examples actually work**

Run:

```bash
cd apps/backend && cp config.example.toml /tmp/example.toml && \
  DEREC_CONFIG_PATH=/tmp/example.toml timeout 5 cargo run 2>&1 | head -30
```

Expected: the banner shows every `[defaults]` key reporting `file` (the example sets them all explicitly), `base_url` and `port` reporting `file`, and the server starts. A validation error here means the example file contradicts itself — fix the example.

Run:

```bash
ruby -ryaml -e "YAML.load_file('compose.yaml'); puts 'compose.yaml parses'"
```

Expected: `compose.yaml parses`

**Use `ruby`, not `python3`** — neither `python3` here has PyYAML. If the
command errors, report it rather than substituting the expected output.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/config.example.toml .env.example compose.yaml README.md
git commit -m "Document the merged configuration surface with worked examples"
```

---

## Definition of Done

- [ ] `cargo test` in `apps/backend`: **13 suites, ≥ 155 tests, 0 failures, 0 warnings**
- [ ] `npx vitest run` in `apps/web`: **408 passing, 0 failures**
- [ ] `npm run typecheck` and `npm run build` in `apps/web`: clean
- [ ] `cargo metadata` shows `derec-library` and `derec-proto` sourced from `registry+https://github.com/rust-lang/crates.io-index`
- [ ] `node_modules/@derec-alliance/web` is a real directory, not a symlink, at version 0.0.3
- [ ] `tests/proto_drift.rs` passes **without printing `SKIPPED`**
- [ ] `BASE_URL=x cargo run` aborts naming `DEREC_BASE_URL`
- [ ] The boot banner lists all 16 settings with an origin each
- [ ] `GET /debug/config` returns 16 origins; `GET /config` is unchanged and still flat
- [ ] Playwright: run `npm run test:e2e` once at the end. It has never needed the sibling checkout less than it does now, and `pairing.spec.ts:35` is a known flake — re-run a single failure there before treating it as a regression.

## Notes for the next plan

- `[server]` has two keys. `static_dir` joins it when `ServeDir` lands; `database_url` when `sqlx` does. Both already have their variable names reserved by convention (`DEREC_STATIC_DIR`, `DEREC_DATABASE_URL`) — add them to `ENV_KEYS` and the collision test will keep them honest.
- `compose.yaml` builds from source because no image exists. The image phase swaps `build:` for `image: derec/reference-app:<sdk-version>` and adds `- derec-data:/var/lib/derec`.
- `config.rs` will be near 800 lines after this plan. If persistence pushes it further, split `report` into `config/report.rs` — but not before.
- The Inspect tab does not yet consume `/debug/config`. That is frontend work and belongs with the other UI changes.
