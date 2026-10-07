# Storage Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a `sqlx` connection pool, a portable migration set and a `database_url` setting into the backend, and prove a store-conformance suite meaningful by running it against the *existing in-memory stores* — so that Phase 4 can swap SQL implementations in behind a test suite that already has teeth.

**Architecture:** A new `apps/backend/src/db.rs` owns everything about reaching a database: turning the four accepted `database_url` spellings into a real connection string, redacting any password before it reaches a log, opening an `AnyPool`, and running `migrations/` at boot. The migration set defines the whole schema now — including the tables Phase 4's stores and registries will use — because one migration set that runs unmodified on SQLite and Postgres is easier to get right in one pass than to grow. No store changes: `stores.rs` is untouched and still in-memory at the end of this plan. The conformance suite lands as a `pub` module in the library (following `state::test_support`, which is how this repo already exposes helpers to integration tests) so Phase 4 can call the identical assertions against SQL stores on both engines.

**Tech Stack:** Rust, `sqlx` 0.8 (`runtime-tokio-rustls`, `any`, `sqlite`, `postgres`, `migrate`), Axum 0.8, `figment` 0.10, `derec-library` 0.0.4 with its `serde` feature, `base64` 0.22.

**Spec:** `docs/superpowers/specs/2026-09-21-docker-packaging-design.md` — "Persistence" (line 279) and "Implementation order" item 3 (line 747).

## Global Constraints

- **Phase 3 only.** The spec has nine phases. This plan is item 3: `sqlx`, `db.rs`, the migration set, URL resolution, and the conformance suite proven against the in-memory stores. **No SQL store is written here** — that is Phase 4. If you find yourself implementing `DeRecChannelStore for SqlChannelStore`, you have left this plan.
- **Baseline entering this plan:** backend `cargo test` = **164 passing, 13 suites, 0 failures, 0 warnings**. Frontend `npx vitest run` = **408 passing**. Every task must leave both at or above these numbers.
- **The migration set must run unmodified on both engines.** No `AUTOINCREMENT`, no `SERIAL`, no backticks, no `BLOB`, no engine-specific types or functions. Integers are `INTEGER`, text is `TEXT`, timestamps are `INTEGER` (unix seconds).
- **`u64` ids are `TEXT`, decimal-encoded.** Every `secret_id`, `channel_id` and `replica_id`. SQLite has no unsigned 64-bit integer and Postgres has no `u64`; an `i64` bit-cast breaks ordering at the high end invisibly. This is the decision the HTTP layer already made — `Actor::secret_id` serialises as a string.
- **Binary goes in as base64 `TEXT`.** Not a portable blob type.
- **The uniformity constraint.** No table, column or key may distinguish a provisioned actor from a real one: no `is_bot`, no `provisioned`, no role-dependent tables. Being a provisioned fixture is node configuration and must never reach a row.
- **The schema is shared, not owned.** Node separation is ahead on the roadmap, so no table may assume a single process holds all of them.
- **No `unwrap()` / `expect()` in production paths.** Test code may use them.
- **Do not commit `docs/`.** Stage only the files each task names.
- **The user commits.** Do **not** run `git commit`, `git add` or `git stash`. Each task ends with a verification step and a list of the files it touched; the user reviews and commits. This overrides the commit steps in any earlier plan in this directory.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/backend/Cargo.toml` | `sqlx`, `derec-library` `serde` feature | modify |
| `apps/backend/src/db.rs` | URL resolution, redaction, pool, migrations | **new** |
| `apps/backend/src/lib.rs` | `pub mod db;`, `pub mod conformance;` | modify |
| `apps/backend/migrations/0001_initial.sql` | the whole schema | **new** |
| `apps/backend/src/config.rs` | `server.database_url` | modify |
| `apps/backend/src/conformance.rs` | the store-conformance suite | **new** |
| `apps/backend/src/main.rs` | open the pool at boot, report it | modify |
| `apps/backend/tests/config_route.rs:47` | origin count 16 → 17 | modify |
| `apps/backend/tests/store_conformance.rs` | runs the suite against in-memory stores | **new** |
| `apps/backend/tests/migrations.rs` | migrations apply and are idempotent | **new** |
| `examples/config.example.toml` | document `database_url` | modify |
| `examples/.env.example` | document `DEREC_DATABASE_URL` | modify |
| `README.md` | the new setting in the mapping table | modify |

`db.rs` is new and stays one file: resolution, redaction, pool and migration are all "how do we reach the database", and splitting them would separate the URL table from the function that implements it. `conformance.rs` is separate from `stores.rs` because Phase 4 deletes `stores.rs` and must not delete the suite with it.

---

## Task 1: The database URL

`database_url` accepts four spellings and the difference between them is not obvious. Resolution is a pure function so it can be tested exhaustively without a database.

**Files:**
- Modify: `apps/backend/Cargo.toml`
- Create: `apps/backend/src/db.rs`
- Modify: `apps/backend/src/lib.rs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pub const DEFAULT_DATABASE_URL: &str = "/var/lib/derec/derec.db"`
  - `pub fn resolve_url(raw: &str) -> String`
  - Task 3 calls `resolve_url`; Task 5 passes its output to `connect`.

- [ ] **Step 1: Add the dependencies**

In `apps/backend/Cargo.toml`, add below `thiserror`:

```toml
# Persistence. `any` is what makes SQLite and Postgres one code path; SQLite is
# compiled in, so the image needs no database service and nothing installed.
sqlx = { version = "0.8", default-features = false, features = [
    "runtime-tokio-rustls",
    "any",
    "sqlite",
    "postgres",
    "migrate",
    "macros",
] }
```

and change the `derec-library` line to enable serde — the stores serialise the SDK's own types rather than inventing DTOs, and the SDK's tests name serde "the path a store implementation takes":

```toml
derec-library = { version = "0.0.4", features = ["serde"] }
```

Run: `cd apps/backend && cargo build 2>&1 | tail -5`
Expected: compiles, no warnings.

- [ ] **Step 2: Write the failing tests**

Create `apps/backend/src/db.rs`:

```rust
//! Reaching the database: which URL, opened how, migrated when.
//!
//! One `AnyPool` over SQLite or Postgres. The scheme in the URL picks the
//! engine — there is deliberately no `database_type` setting, because a second
//! setting could only ever contradict the URL.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_path_becomes_a_sqlite_url_that_may_create_the_file() {
        // `mode=rwc` is the difference between a fresh container booting and a
        // fresh container failing on a database nobody has created yet.
        assert_eq!(resolve_url("./derec.db"), "sqlite://./derec.db?mode=rwc");
        assert_eq!(
            resolve_url("/var/lib/derec/derec.db"),
            "sqlite:///var/lib/derec/derec.db?mode=rwc"
        );
    }

    #[test]
    fn anything_with_a_scheme_is_passed_through_untouched() {
        // A tuned SQLite URL and a Postgres URL arrive the same way: the
        // operator has spelled out what they want and we must not edit it.
        for url in [
            "postgres://user:pw@db:5432/derec",
            "postgresql://db/derec",
            "sqlite://./derec.db?mode=rwc&cache=shared",
        ] {
            assert_eq!(resolve_url(url), url);
        }
    }

    #[test]
    fn the_in_memory_spelling_survives_resolution() {
        // `sqlite::memory:` contains `:` but not `://`. Treating it as a bare
        // path would produce `sqlite://sqlite::memory:?mode=rwc`, which names a
        // file called `sqlite::memory:` — an ephemeral node that silently
        // persists is the exact opposite of what was asked for.
        assert_eq!(resolve_url("sqlite::memory:"), "sqlite::memory:");
    }

    #[test]
    fn surrounding_whitespace_is_ignored() {
        // `DEREC_DATABASE_URL=" ./derec.db"` out of a compose file is a typo
        // that should not produce a database named " ./derec.db".
        assert_eq!(resolve_url("  ./derec.db  "), "sqlite://./derec.db?mode=rwc");
    }

    #[test]
    fn an_empty_value_falls_back_to_the_built_in_default() {
        assert_eq!(resolve_url(""), resolve_url(DEFAULT_DATABASE_URL));
        assert_eq!(resolve_url("   "), resolve_url(DEFAULT_DATABASE_URL));
    }
}
```

Add to `apps/backend/src/lib.rs`, beside the other module declarations:

```rust
pub mod db;
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/backend && cargo test --lib db 2>&1 | tail -10`
Expected: compile errors — `resolve_url` and `DEFAULT_DATABASE_URL` do not exist.

- [ ] **Step 4: Implement**

Add above the `mod tests` block in `apps/backend/src/db.rs`:

```rust
/// Where the database lives when nothing says otherwise.
///
/// An absolute path under the image's `VOLUME`, so an unconfigured
/// `docker run` already survives a restart. Outside a container this is
/// usually not writable, which is why `config.example.toml` shows a relative
/// path for local development.
pub const DEFAULT_DATABASE_URL: &str = "/var/lib/derec/derec.db";

/// Turn an operator-supplied `database_url` into a connection string.
///
/// | Input | Result |
/// | --- | --- |
/// | empty | the default, resolved as a bare path |
/// | `sqlite::memory:` | passed through — an explicitly ephemeral node |
/// | contains `://` | passed through untouched |
/// | anything else | a bare path; `sqlite://<path>?mode=rwc` |
///
/// `mode=rwc` is on the derived form only. A URL the operator spelled out is
/// theirs, including the absence of a mode.
pub fn resolve_url(raw: &str) -> String {
    let trimmed = raw.trim();

    if trimmed.is_empty() {
        return resolve_url(DEFAULT_DATABASE_URL);
    }
    // Checked before `://` so the in-memory spelling, which has no authority
    // component, is not mistaken for a bare path.
    if trimmed.starts_with("sqlite:") || trimmed.contains("://") {
        return trimmed.to_owned();
    }
    format!("sqlite://{trimmed}?mode=rwc")
}
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/backend && cargo test --lib db 2>&1 | tail -10`
Expected: 5 tests pass.

- [ ] **Step 6: Verify the whole suite is unchanged**

Run: `cd apps/backend && cargo test 2>&1 | grep -cE "^test result: ok"`
Expected: `13`

Run: `cd apps/backend && cargo test 2>&1 | grep -E "FAILED|^warning" | head`
Expected: no output.

- [ ] **Step 7: Report, do not commit**

Files touched: `apps/backend/Cargo.toml`, `apps/backend/Cargo.lock`, `apps/backend/src/db.rs`, `apps/backend/src/lib.rs`. Leave them unstaged and tell the user what changed.

---

## Task 2: Redacting the password

The URL can arrive from a file, an `env_file`, or the command line, and it reaches the boot banner. A Postgres URL carries a password.

**Files:**
- Modify: `apps/backend/src/db.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: `pub fn redact_url(url: &str) -> String`. Task 5 calls it before logging.

- [ ] **Step 1: Write the failing tests**

Append to `mod tests` in `apps/backend/src/db.rs`:

```rust
    #[test]
    fn a_password_is_replaced_rather_than_shortened() {
        // Not a truncation: the length of a secret is itself information.
        assert_eq!(
            redact_url("postgres://user:hunter2@db:5432/derec"),
            "postgres://user:***@db:5432/derec"
        );
    }

    #[test]
    fn a_url_with_no_password_is_left_alone() {
        for url in [
            "postgres://user@db:5432/derec",
            "postgres://db:5432/derec",
            "sqlite://./derec.db?mode=rwc",
            "sqlite::memory:",
        ] {
            assert_eq!(redact_url(url), url, "{url} should be unchanged");
        }
    }

    #[test]
    fn only_the_credentials_section_is_touched() {
        // A colon in the path or query is not a password. Redacting on any
        // colon would mangle `:5432` and make the banner useless for the one
        // thing it is for — seeing what was actually configured.
        assert_eq!(
            redact_url("postgres://user:pw@db:5432/derec?opt=a:b"),
            "postgres://user:***@db:5432/derec?opt=a:b"
        );
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/backend && cargo test --lib db 2>&1 | tail -10`
Expected: `cannot find function 'redact_url' in this scope`.

- [ ] **Step 3: Implement**

Add to `apps/backend/src/db.rs`, after `resolve_url`:

```rust
/// Replace the password in a URL's credentials with `***`.
///
/// Hand-written rather than via a URL parser: this runs on a value that may be
/// malformed — that is often *why* it is being logged — and a parser that
/// rejects the input would suppress the line that explains the failure.
///
/// Only the section between `://` and the first `@` is considered, so a colon
/// in a host, port, path or query is untouched.
pub fn redact_url(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_owned();
    };
    let Some((credentials, host)) = rest.split_once('@') else {
        return url.to_owned();
    };
    let Some((user, _password)) = credentials.split_once(':') else {
        return url.to_owned();
    };
    format!("{scheme}://{user}:***@{host}")
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/backend && cargo test --lib db 2>&1 | grep "test result"`
Expected: `test result: ok. 8 passed`

- [ ] **Step 5: Report, do not commit**

Files touched: `apps/backend/src/db.rs`.

---

## Task 3: The `database_url` setting

One setting, layered exactly as every other one already is.

**Files:**
- Modify: `apps/backend/src/config.rs`
- Modify: `apps/backend/tests/config_route.rs:47`

**Interfaces:**
- Consumes: `db::DEFAULT_DATABASE_URL` from Task 1.
- Produces: `ServerSettings::database_url: String`, `DEREC_DATABASE_URL` in `ENV_KEYS`. Task 5 reads `loaded.settings.server.database_url`.

**Watch this:** `ENV_KEYS` grows from 16 to 17. Three tests assert the count, directly or indirectly: `every_config_path_gets_an_origin` (derives it, no edit needed), `tests/config_route.rs:47` (`assert_eq!(origins.len(), 16)` — **must** become 17), and the banner tests (derive it). The `/debug/config` route needs no change.

- [ ] **Step 1: Write the failing tests**

Append to `mod tests` in `apps/backend/src/config.rs`:

```rust
    #[test]
    fn the_database_url_comes_through_the_same_ladder_as_everything_else() {
        let loaded = settings_from(
            "[server]\ndatabase_url = \"./from-file.db\"\n",
            &[("DEREC_DATABASE_URL", "postgres://db/derec")],
        );

        assert_eq!(loaded.settings.server.database_url, "postgres://db/derec");

        let origin = loaded
            .origins
            .iter()
            .find(|o| o.path == "server.database_url")
            .expect("database_url has an origin");
        assert_eq!(origin.source, Source::Env("DEREC_DATABASE_URL"));
    }

    #[test]
    fn an_unset_database_url_is_the_built_in_default() {
        let loaded = settings_from("", &[]);

        assert_eq!(
            loaded.settings.server.database_url,
            crate::db::DEFAULT_DATABASE_URL
        );
    }

    #[test]
    fn a_database_url_from_the_file_is_used_and_reported_as_file() {
        let loaded = settings_from("[server]\ndatabase_url = \"sqlite::memory:\"\n", &[]);

        assert_eq!(loaded.settings.server.database_url, "sqlite::memory:");
        assert_eq!(
            loaded
                .origins
                .iter()
                .find(|o| o.path == "server.database_url")
                .expect("origin")
                .source,
            Source::File
        );
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/backend && cargo test --lib config 2>&1 | tail -10`
Expected: `no field 'database_url' on type 'ServerSettings'`.

- [ ] **Step 3: Implement**

In `apps/backend/src/config.rs`, add to `RawServer`:

```rust
    database_url: Option<String>,
```

Add to `ServerSettings`, after `port`:

```rust
    /// Where state lives. See [`crate::db::resolve_url`] for the accepted
    /// spellings — a bare path means SQLite, anything with a scheme is passed
    /// through, and `sqlite::memory:` asks for a node that forgets on exit.
    pub database_url: String,
```

In `impl Default for ServerSettings`, add:

```rust
            database_url: crate::db::DEFAULT_DATABASE_URL.to_owned(),
```

In `ServerSettings::resolve`, add:

```rust
            database_url: raw.database_url.unwrap_or(base.database_url),
```

In `ServerSettings::validate`, add before `Ok(())`:

```rust
        if self.database_url.trim().is_empty() {
            return Err("database_url must not be empty".to_owned());
        }
```

Add to `ENV_KEYS`, directly after the `DEREC_PORT` entry so the banner lists it with the rest of `[server]`:

```rust
    ("DEREC_DATABASE_URL", "server.database_url"),
```

- [ ] **Step 4: Fix the route test's origin count**

In `apps/backend/tests/config_route.rs`, line 47:

```rust
    assert_eq!(origins.len(), 17, "every setting needs an origin");
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/backend && cargo test --lib config 2>&1 | grep "test result"`
Expected: all config tests pass.

Run: `cd apps/backend && cargo test --test config_route 2>&1 | grep "test result"`
Expected: `test result: ok. 2 passed`

- [ ] **Step 6: Look at the banner**

Run:

```bash
cd apps/backend && DEREC_DATABASE_URL=sqlite::memory: \
  perl -e 'alarm 5; exec @ARGV' ./target/debug/derec-backend 2>&1 | head -12
```

**Note on `timeout`:** this machine has no `timeout` and no `gtimeout`; the `perl -e 'alarm N'` form above is the working substitute. If a `.env` in `apps/backend` sets legacy names the boot will abort — that is the Phase 2 legacy check working, not a bug.

Expected: a `[server]` block listing `database_url  sqlite::memory:  env DEREC_DATABASE_URL`.

- [ ] **Step 7: Report, do not commit**

Files touched: `apps/backend/src/config.rs`, `apps/backend/tests/config_route.rs`.

---

## Task 4: The migration set

The whole schema, in one migration, portable across both engines. Phase 4's stores and registries land on these tables; nothing reads them yet.

**Files:**
- Create: `apps/backend/migrations/0001_initial.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: the schema. Task 5 runs it; Phase 4 queries it.

- [ ] **Step 1: Write the schema**

Create `apps/backend/migrations/0001_initial.sql`:

```sql
-- The whole schema, in one migration that must run unmodified on SQLite and
-- Postgres. That rules out AUTOINCREMENT, SERIAL, backticks, BLOB, and any
-- type either engine lacks.
--
-- Every u64 id -- secret_id, channel_id, replica_id -- is decimal-encoded TEXT.
-- SQLite has no unsigned 64-bit integer and Postgres has no u64; an i64
-- bit-cast makes ordering wrong at the high end and stays invisible until it
-- bites. The HTTP layer already made this call: Actor::secret_id serialises as
-- a string because u64 exceeds JavaScript's exact integer range.
--
-- Binary is base64 TEXT rather than a portable blob type.
--
-- No table distinguishes a provisioned actor from a real one. Being a
-- provisioned fixture is node configuration and must never reach a row.
--
-- The schema is shared, not owned: node separation is ahead on the roadmap, so
-- no table may assume a single process holds all of them.

-- ── SDK store tables ────────────────────────────────────────────────────────

-- DeRecChannelStore. Helper channels and replica-group members live in one
-- table discriminated by `kind`, because the store loads them through a single
-- ChannelQuery -- but they are keyed differently, which `entity_id` carries:
-- a helper by channel_id, a group member by replica_id alone. A member moves
-- between channels during an admission handover while remaining the same
-- member, so keying on both would lose the row exactly when that move needs to
-- be observed.
CREATE TABLE channels (
    secret_id   TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('helper', 'replica')),
    entity_id   TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    record      TEXT NOT NULL,
    PRIMARY KEY (secret_id, kind, entity_id)
);

-- The channel-link graph: channels belonging to the same Owner identity, e.g.
-- after a recovery re-pairing. Bidirectional, so both directions are stored
-- and `linked_channels` is a BFS over the rows.
CREATE TABLE channel_links (
    secret_id  TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    linked_id  TEXT NOT NULL,
    PRIMARY KEY (secret_id, channel_id, linked_id)
);

-- DeRecSecretStore. Keyed by (secret_id, channel_id, kind) -- matching the
-- in-memory store's HashMap<(u64, u64, u8), SecretValue>. `kind` is the
-- SecretKind discriminant (0 SharedKey, 1 PairingSecret, 2 PairingContact),
-- stored as TEXT for readability since a developer will be reading these rows.
-- `value` is a serialised SecretValue, which derives serde behind the
-- library's `serde` feature.
CREATE TABLE secrets (
    secret_id  TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('shared_key', 'pairing_secret', 'pairing_contact')),
    value      TEXT NOT NULL,
    PRIMARY KEY (secret_id, channel_id, kind)
);

-- DeRecUserSecretStore. One current snapshot per secret.
CREATE TABLE user_secrets (
    secret_id TEXT NOT NULL,
    payload   TEXT NOT NULL,
    PRIMARY KEY (secret_id)
);

-- DeRecShareStore. Share has public scalar fields and maps straight to
-- columns; the channel comes from the method argument rather than the struct.
-- `bytes` is base64.
--
-- Keyed by (secret_id, channel_id, version), matching the in-memory store's
-- HashMap<(u64, u64, u32), Share>. There is deliberately no replica_id column:
-- the 0.0.4 `DeRecShareStore::save` signature is
-- `save(&mut self, secret_id, channel_id: ChannelId, share: Share)` and takes
-- no replica. Adding a column no trait method can populate would be a column
-- that is always '' and a key that is a lie.
CREATE TABLE shares (
    secret_id  TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    version    INTEGER NOT NULL,
    bytes      TEXT NOT NULL,
    PRIMARY KEY (secret_id, channel_id, version)
);

-- `latest_version` scans every version for a secret across all channels.
CREATE INDEX shares_by_secret_version ON shares (secret_id, version);

-- DeRecStateStore. Keyed by (secret_id, StateKey), matching the in-memory
-- store's HashMap<(u64, StateKey), StateItem>. `state_key` is the serialised
-- StateKeyRecord; `kind` is denormalised out of it because `load_all` filters
-- on kind alone and should not have to deserialise every row to do it.
--
-- StateItem has no serde of its own and round-trips through the SDK's
-- StateItemRecord, which does.
CREATE TABLE state_items (
    secret_id TEXT NOT NULL,
    state_key TEXT NOT NULL,
    kind      TEXT NOT NULL,
    item      TEXT NOT NULL,
    PRIMARY KEY (secret_id, state_key)
);

CREATE INDEX state_items_by_kind ON state_items (secret_id, kind);

-- ── Node registry tables ────────────────────────────────────────────────────
-- These replace the dashmaps in state.rs in Phase 4.

-- One flat, server-wide list of actors. `role` is owner or helper; a replica is
-- a pairing mode, not an actor kind, so it is deliberately not a role here.
CREATE TABLE actors (
    actor_id   TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('owner', 'helper')),
    name       TEXT NOT NULL,
    secret_id  TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id)
);

-- Helper-side channel ids, one row per paired owner.
CREATE TABLE actor_channels (
    actor_id   TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    PRIMARY KEY (actor_id, channel_id)
);

-- Helpers the operator has switched off to simulate being offline. A row means
-- disabled; absence means enabled.
CREATE TABLE disabled_helpers (
    actor_id TEXT NOT NULL,
    PRIMARY KEY (actor_id)
);

-- Contact messages posted by browser-managed participants for the owner to
-- fetch.
CREATE TABLE participant_contacts (
    actor_id TEXT NOT NULL,
    contact  TEXT NOT NULL,
    PRIMARY KEY (actor_id)
);

-- Store-and-forward mailbox. Ordering is by `seq`, which is assigned by the
-- writer rather than by the engine -- AUTOINCREMENT and SERIAL are both
-- unavailable under the portability rule.
CREATE TABLE mailbox (
    actor_id TEXT NOT NULL,
    seq      INTEGER NOT NULL,
    payload  TEXT NOT NULL,
    PRIMARY KEY (actor_id, seq)
);
```

- [ ] **Step 2: Report, do not commit**

Files touched: `apps/backend/migrations/0001_initial.sql`. Task 5 is what proves it runs.

---

## Task 5: The pool and the migration runner

**Files:**
- Modify: `apps/backend/src/db.rs`
- Modify: `apps/backend/src/main.rs`
- Create: `apps/backend/tests/migrations.rs`

**Interfaces:**
- Consumes: `resolve_url` and `redact_url` (Tasks 1–2), the migration set (Task 4), `settings.server.database_url` (Task 3).
- Produces: `pub async fn connect(database_url: &str) -> Result<sqlx::AnyPool, DbError>` and `pub enum DbError`. Phase 4 takes the pool from `AppState`.

**Note:** this task opens the pool and runs migrations at boot but does **not** put it in `AppState` — nothing reads it yet, and a field nothing reads is Phase 4's to add with its first consumer.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/migrations.rs`:

```rust
//! The migration set has to apply cleanly to an empty database and be safe to
//! run again on a database that already has it — which is what every restart
//! does.
//!
//! SQLite in-memory only. The Postgres run is opt-in and arrives in Phase 4
//! with the SQL stores; nobody should need a Postgres to work on this repo.

use derec_backend::db;

#[tokio::test]
async fn migrations_apply_to_an_empty_database() {
    let pool = db::connect("sqlite::memory:")
        .await
        .expect("an in-memory database always connects");

    // Every table the schema declares must exist afterwards.
    for table in [
        "channels",
        "channel_links",
        "secrets",
        "user_secrets",
        "shares",
        "state_items",
        "actors",
        "actor_channels",
        "disabled_helpers",
        "participant_contacts",
        "mailbox",
    ] {
        let sql = format!("SELECT COUNT(*) FROM {table}");
        sqlx::query(&sql)
            .fetch_one(&pool)
            .await
            .unwrap_or_else(|e| panic!("table {table} is missing or unreadable: {e}"));
    }
}

#[tokio::test]
async fn connecting_twice_to_the_same_database_does_not_re_run_migrations() {
    // A restart against an existing volume takes this path. `sqlx::migrate!`
    // records what it has applied, so the second call must be a no-op rather
    // than a duplicate-table error.
    let dir = std::env::temp_dir().join(format!("derec-migr-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let path = dir.join("derec.db");
    let url = db::resolve_url(&path.to_string_lossy());

    let first = db::connect(&url).await.expect("first connect");
    drop(first);

    let second = db::connect(&url).await.expect("second connect must succeed");
    drop(second);

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn an_unreachable_database_is_an_error_rather_than_a_panic() {
    // A directory that does not exist, so SQLite cannot create the file.
    let result = db::connect("sqlite:///nonexistent-directory-here/derec.db?mode=rwc").await;

    assert!(result.is_err(), "expected an error, got a pool");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/backend && cargo test --test migrations 2>&1 | tail -10`
Expected: `cannot find function 'connect'`.

- [ ] **Step 3: Implement**

Add to `apps/backend/src/db.rs`, above `mod tests`:

```rust
use sqlx::any::{AnyPoolOptions, install_default_drivers};

/// Why the database could not be reached or prepared.
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("could not connect to {url}: {source}")]
    Connect {
        /// Already redacted — this string reaches logs.
        url: String,
        #[source]
        source: sqlx::Error,
    },
    #[error("could not apply migrations to {url}: {source}")]
    Migrate {
        url: String,
        #[source]
        source: sqlx::migrate::MigrateError,
    },
}

/// Open a pool and bring the schema up to date.
///
/// `install_default_drivers` is what teaches `AnyPool` the `sqlite:` and
/// `postgres:` schemes; without it every URL fails with a driver-not-found
/// error that names neither. It is idempotent, so calling it per connect is
/// safe and keeps the requirement next to the code that needs it.
///
/// Migrations run on every boot. `sqlx::migrate!` embeds the files in the
/// binary at compile time — the image carries no `migrations/` directory — and
/// records what it has applied, so an existing database is left alone.
pub async fn connect(database_url: &str) -> Result<sqlx::AnyPool, DbError> {
    install_default_drivers();

    let url = resolve_url(database_url);
    let safe = redact_url(&url);

    let pool = AnyPoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
        .map_err(|source| DbError::Connect {
            url: safe.clone(),
            source,
        })?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .map_err(|source| DbError::Migrate { url: safe, source })?;

    Ok(pool)
}
```

- [ ] **Step 4: Run the test**

Run: `cd apps/backend && cargo test --test migrations 2>&1 | grep "test result"`
Expected: `test result: ok. 3 passed`

If `migrations_apply_to_an_empty_database` fails on a table name, the DDL and the list in the test have diverged — fix the DDL, not the test.

- [ ] **Step 5: Open it at boot**

In `apps/backend/src/main.rs`, after the banner line and before the loopback warning:

```rust
    let pool = match db::connect(&loaded.settings.server.database_url).await {
        Ok(pool) => pool,
        Err(e) => {
            // Same shape as the configuration abort: a node that cannot reach
            // its database must not come up serving an empty one.
            eprintln!("database error: {e}");
            std::process::exit(1);
        }
    };

    info!(
        database = %db::redact_url(&db::resolve_url(&loaded.settings.server.database_url)),
        "database ready"
    );

    // Nothing reads the pool yet — the SQL stores arrive in the next phase.
    // Held rather than dropped so the connection and the migration run are
    // real at boot rather than a check that is thrown away.
    let _pool = pool;
```

Add to the imports at the top of `main.rs`:

```rust
use derec_backend::db;
```

- [ ] **Step 6: Verify it boots and reports**

Run:

```bash
cd apps/backend && DEREC_DATABASE_URL=sqlite::memory: \
  perl -e 'alarm 5; exec @ARGV' ./target/debug/derec-backend 2>&1 | grep -E "database ready|listening"
```

Expected: `database ready database=sqlite::memory:` and the listening line.

Run, to see the failure path:

```bash
cd apps/backend && DEREC_DATABASE_URL=/nonexistent-dir/derec.db \
  perl -e 'alarm 5; exec @ARGV' ./target/debug/derec-backend 2>&1 | head -3
```

Expected: `database error: could not connect to sqlite:///nonexistent-dir/derec.db?mode=rwc: ...` and a non-zero exit.

- [ ] **Step 7: Run the full suite**

Run: `cd apps/backend && cargo test 2>&1 | grep -cE "^test result: ok"`
Expected: `14` — 13 baseline plus the new `migrations` suite. The `db` unit tests live inside the lib suite and add no suite of their own; `store_conformance` arrives in Task 6 and makes it 15.

Run: `cd apps/backend && cargo test 2>&1 | grep -E "FAILED|^warning" | head`
Expected: no output.

- [ ] **Step 8: Report, do not commit**

Files touched: `apps/backend/src/db.rs`, `apps/backend/src/main.rs`, `apps/backend/tests/migrations.rs`.

---

## Task 6: The conformance suite

The point of this task: prove the suite catches real breakage *before* any SQL store exists, by running it against the in-memory stores that already work. Phase 4 then runs the same assertions against SQL stores on both engines.

**Files:**
- Create: `apps/backend/src/conformance.rs`
- Modify: `apps/backend/src/lib.rs`
- Create: `apps/backend/tests/store_conformance.rs`

**Interfaces:**
- Consumes: the SDK store traits; `stores::InMemory*`.
- Produces:
  - `pub async fn channel_store_conforms<S: DeRecChannelStore>(store: &mut S)`
  - `pub async fn secret_store_conforms<S: DeRecSecretStore>(store: &mut S)`
  - `pub async fn share_store_conforms<S: DeRecShareStore>(store: &mut S)`
  - `pub async fn user_secret_store_conforms<S: DeRecUserSecretStore>(store: &mut S)`
  - `pub async fn state_store_conforms<S: DeRecStateStore>(store: &mut S)`
  - Phase 4 calls all five against its SQL stores.

**Why a `pub` module in the library rather than `tests/common/`:** Phase 4 deletes `stores.rs` and its unit tests; a suite living beside them would go too. `state::test_support` is already re-exported this way (`lib.rs:34`), so the pattern is established.

- [ ] **Step 1: Write the suite**

Create `apps/backend/src/conformance.rs`:

```rust
//! Behaviour every store implementation must have, independent of engine.
//!
//! Written against the in-memory stores first, so it is proven to catch real
//! breakage before any SQL exists — a suite that has only ever run against the
//! implementation it was written from is not evidence of anything.
//!
//! Each function takes an empty store and leaves it dirty. Callers construct a
//! fresh one per call.
//!
//! Two properties matter more than the individual assertions and are checked
//! throughout: every operation is partitioned by `secret_id`, and a `u64` id
//! near `u64::MAX` round-trips exactly. The second is what an `i64` bit-cast
//! would break invisibly.

use derec_library::protocol::types::{ChannelStatus, HelperFilter};
use derec_library::protocol::{
    ChannelQuery, ChannelRecord, DeRecChannelStore, DeRecSecretStore, DeRecShareStore,
    DeRecStateStore, DeRecUserSecretStore, HelperChannel, SecretKind, SecretValue, Share,
    UserSecrets,
};
use derec_library::types::ChannelId;

/// An id above `i64::MAX`. Stored as TEXT it round-trips; bit-cast to `i64` it
/// comes back negative and sorts wrong.
pub const HIGH_ID: u64 = u64::MAX - 7;

/// Two secrets, to prove partitioning.
pub const SECRET_A: u64 = 11;
pub const SECRET_B: u64 = 22;

/// A helper channel with a single HTTPS endpoint.
///
/// Every field is written out: `HelperChannel` has no `Default`, which the
/// existing unit tests in `stores.rs` also work around this way.
fn helper_channel(channel_id: u64) -> HelperChannel {
    HelperChannel {
        channel_id: ChannelId(channel_id),
        transports: vec![derec_proto::TransportProtocol {
            uri: format!("https://example.test/derec/{channel_id}"),
            protocol: derec_proto::Protocol::Https as i32,
        }],
        communication_info: Default::default(),
        peer_role: derec_proto::SenderKind::Owner,
        status: ChannelStatus::Paired,
        created_at: 0,
    }
}

/// Every `DeRecChannelStore` behaviour the protocol relies on.
///
/// Every store method returns a future of `Result`, so each call ends in
/// `.expect(...)` — an in-memory store cannot fail, and a SQL store failing
/// here is a test failure rather than something to handle.
pub async fn channel_store_conforms<S: DeRecChannelStore>(store: &mut S) {
    let query = |id: u64| ChannelQuery::Helper {
        channel_id: ChannelId(id),
    };

    // Absent before saved.
    assert!(
        store
            .load(SECRET_A, query(HIGH_ID))
            .await
            .expect("readable")
            .is_none(),
        "an unsaved channel must not load"
    );

    store
        .save(SECRET_A, ChannelRecord::Helper(helper_channel(HIGH_ID)))
        .await
        .expect("save");

    // Round-trips, including an id above i64::MAX.
    let loaded = store
        .load(SECRET_A, query(HIGH_ID))
        .await
        .expect("readable")
        .expect("a saved channel loads");
    match loaded {
        ChannelRecord::Helper(h) => assert_eq!(h.channel_id.0, HIGH_ID, "id must survive exactly"),
        other => panic!("expected a helper record, got {other:?}"),
    }

    // Partitioned: the same channel id under another secret is a different row.
    assert!(
        store
            .load(SECRET_B, query(HIGH_ID))
            .await
            .expect("readable")
            .is_none(),
        "channels must be partitioned by secret_id"
    );

    // Save is upsert, not insert: re-saving replaces rather than duplicating.
    store
        .save(SECRET_A, ChannelRecord::Helper(helper_channel(HIGH_ID)))
        .await
        .expect("save");
    assert_eq!(
        store
            .helpers(SECRET_A, HelperFilter::default())
            .await
            .expect("readable")
            .len(),
        1,
        "saving the same channel twice must not duplicate it"
    );

    // Links are bidirectional.
    store
        .save(SECRET_A, ChannelRecord::Helper(helper_channel(5)))
        .await
        .expect("save");
    store
        .link_channel(SECRET_A, ChannelId(HIGH_ID), ChannelId(5))
        .await
        .expect("link");

    let from_high = store
        .linked_channels(SECRET_A, ChannelId(HIGH_ID))
        .await
        .expect("readable");
    let from_five = store
        .linked_channels(SECRET_A, ChannelId(5))
        .await
        .expect("readable");
    assert!(
        from_high.iter().any(|c| c.0 == 5),
        "link must be visible from the channel it was made on, got {from_high:?}"
    );
    assert!(
        from_five.iter().any(|c| c.0 == HIGH_ID),
        "link must be visible from the other side, got {from_five:?}"
    );

    // Remove reports whether it removed anything.
    assert!(
        store
            .remove(SECRET_A, query(HIGH_ID))
            .await
            .expect("remove"),
        "removing a present channel reports true"
    );
    assert!(
        !store
            .remove(SECRET_A, query(HIGH_ID))
            .await
            .expect("remove"),
        "removing an absent channel reports false"
    );
}

/// Every `DeRecShareStore` behaviour the protocol relies on.
///
/// Note the signatures: `save` takes `(secret_id, channel_id, share)` with no
/// replica argument, and both `load_all` and `load_many` take a channel-id
/// slice. The key is `(secret_id, channel_id, version)`.
pub async fn share_store_conforms<S: DeRecShareStore>(store: &mut S) {
    let channel = ChannelId(HIGH_ID);

    assert_eq!(
        store
            .latest_version(SECRET_A)
            .await
            .expect("readable"),
        None,
        "no shares means no latest version"
    );

    for version in [1u32, 2, 3] {
        store
            .save(
                SECRET_A,
                channel,
                Share {
                    secret_id: SECRET_A,
                    version,
                    bytes: vec![version as u8, 0xff, 0x00],
                },
            )
            .await
            .expect("save");
    }

    assert_eq!(
        store
            .latest_version(SECRET_A)
            .await
            .expect("readable"),
        Some(3),
        "latest_version must be the maximum, not the most recently written"
    );

    // Binary survives the round trip byte for byte — base64 encoding is an
    // implementation detail that must not be observable.
    let all = store
        .load_all(SECRET_A, &[channel])
        .await
        .expect("readable");
    let three = all
        .iter()
        .find(|s| s.version == 3)
        .expect("version 3 was saved");
    assert_eq!(
        three.bytes,
        vec![3u8, 0xff, 0x00],
        "share bytes must round-trip exactly, including 0xff and 0x00"
    );

    // An explicit version filter narrows; an empty one means "every version".
    let filtered = store
        .load(SECRET_A, channel, &[2])
        .await
        .expect("readable");
    assert_eq!(filtered.len(), 1, "a version filter must narrow the result");
    assert_eq!(filtered[0].version, 2);

    assert_eq!(
        store
            .latest_version(SECRET_B)
            .await
            .expect("readable"),
        None,
        "shares must be partitioned by secret_id"
    );

    store
        .remove_channel(SECRET_A, channel)
        .await
        .expect("remove_channel");
    assert!(
        store
            .load_all(SECRET_A, &[channel])
            .await
            .expect("readable")
            .is_empty(),
        "removing the channel removes its shares"
    );
}

/// Every `DeRecUserSecretStore` behaviour the protocol relies on.
pub async fn user_secret_store_conforms<S: DeRecUserSecretStore>(store: &mut S) {
    assert!(
        store
            .load_latest(SECRET_A)
            .await
            .expect("readable")
            .is_none(),
        "nothing saved means nothing loads"
    );

    store
        .save_latest(
            SECRET_A,
            UserSecrets {
                version: 4,
                secrets: Vec::new(),
                description: Some("first".to_owned()),
                replicas: None,
            },
        )
        .await
        .expect("save_latest");

    let loaded = store
        .load_latest(SECRET_A)
        .await
        .expect("readable")
        .expect("saved snapshot");
    assert_eq!(loaded.version, 4);
    assert_eq!(loaded.description.as_deref(), Some("first"));

    // save_latest replaces rather than accumulating.
    store
        .save_latest(
            SECRET_A,
            UserSecrets {
                version: 5,
                secrets: Vec::new(),
                description: Some("second".to_owned()),
                replicas: None,
            },
        )
        .await
        .expect("save_latest");
    assert_eq!(
        store
            .load_latest(SECRET_A)
            .await
            .expect("readable")
            .expect("snapshot")
            .version,
        5,
        "save_latest must replace the previous snapshot"
    );

    assert!(
        store
            .load_latest(SECRET_B)
            .await
            .expect("readable")
            .is_none(),
        "user secrets must be partitioned by secret_id"
    );

    store.remove(SECRET_A).await.expect("remove");
    assert!(
        store
            .load_latest(SECRET_A)
            .await
            .expect("readable")
            .is_none(),
        "remove must clear the snapshot"
    );
}

/// Every `DeRecSecretStore` behaviour the protocol relies on.
///
/// Keyed by `(secret_id, channel_id, kind)`. `save` takes no `kind` — it is
/// derived from the `SecretValue` variant, so a store that keys on anything
/// else will overwrite one kind with another.
pub async fn secret_store_conforms<S: DeRecSecretStore>(store: &mut S) {
    let channel = ChannelId(HIGH_ID);

    assert!(
        store
            .load(SECRET_A, channel, SecretKind::SharedKey)
            .await
            .expect("readable")
            .is_none(),
        "an unsaved secret must not load"
    );

    store
        .save(SECRET_A, channel, SecretValue::SharedKey([7u8; 32]))
        .await
        .expect("save");

    match store
        .load(SECRET_A, channel, SecretKind::SharedKey)
        .await
        .expect("readable")
        .expect("a saved secret loads")
    {
        SecretValue::SharedKey(key) => assert_eq!(key, [7u8; 32], "key must round-trip exactly"),
        other => panic!("expected a shared key, got {other:?}"),
    }

    // A different kind on the same channel is a different row, not an
    // overwrite. This is what keying on the value's own variant buys.
    assert!(
        store
            .load(SECRET_A, channel, SecretKind::PairingSecret)
            .await
            .expect("readable")
            .is_none(),
        "kinds must not collide on one channel"
    );

    assert!(
        store
            .load(SECRET_B, channel, SecretKind::SharedKey)
            .await
            .expect("readable")
            .is_none(),
        "secrets must be partitioned by secret_id"
    );

    // Save is upsert.
    store
        .save(SECRET_A, channel, SecretValue::SharedKey([9u8; 32]))
        .await
        .expect("save");
    match store
        .load(SECRET_A, channel, SecretKind::SharedKey)
        .await
        .expect("readable")
        .expect("still present")
    {
        SecretValue::SharedKey(key) => assert_eq!(key, [9u8; 32], "save must replace in place"),
        other => panic!("expected a shared key, got {other:?}"),
    }

    store
        .remove(SECRET_A, channel, SecretKind::SharedKey)
        .await
        .expect("remove");
    assert!(
        store
            .load(SECRET_A, channel, SecretKind::SharedKey)
            .await
            .expect("readable")
            .is_none(),
        "remove must clear the row"
    );
}

/// Every `DeRecStateStore` behaviour the protocol relies on.
///
/// `save` takes only `(secret_id, item)` — the key comes from `item.key()`,
/// so a store must derive it rather than expect one to be passed.
///
/// `item` is built by the caller because `StateItem`'s variants are protocol
/// internals; `state_item` below is the factory each caller supplies.
pub async fn state_store_conforms<S: DeRecStateStore>(
    store: &mut S,
    state_item: impl Fn(u64) -> derec_library::protocol::StateItem,
) {
    let first = state_item(1);
    let key = first.key();
    let kind = key.kind();

    assert!(
        store
            .load(SECRET_A, key)
            .await
            .expect("readable")
            .is_none(),
        "an unsaved item must not load"
    );

    store.save(SECRET_A, first).await.expect("save");

    assert!(
        store
            .load(SECRET_A, key)
            .await
            .expect("readable")
            .is_some(),
        "a saved item loads"
    );

    assert!(
        store
            .load(SECRET_B, key)
            .await
            .expect("readable")
            .is_none(),
        "state must be partitioned by secret_id"
    );

    // Save is upsert on the item's own key.
    store.save(SECRET_A, state_item(1)).await.expect("save");
    assert_eq!(
        store
            .load_all(SECRET_A, kind)
            .await
            .expect("readable")
            .len(),
        1,
        "saving the same key twice must not duplicate it"
    );

    // A second, distinct key is a second row under the same kind.
    store.save(SECRET_A, state_item(2)).await.expect("save");
    assert_eq!(
        store
            .load_all(SECRET_A, kind)
            .await
            .expect("readable")
            .len(),
        2,
        "load_all must return every item of the kind"
    );

    assert!(
        store.remove(SECRET_A, key).await.expect("remove"),
        "removing a present item reports true"
    );
    assert!(
        !store.remove(SECRET_A, key).await.expect("remove"),
        "removing an absent item reports false"
    );
}
```

**On the `state_item` factory:** `StateItem`'s variants are protocol internals and its constructors are not part of the store contract, so the suite takes a factory rather than guessing at one. Find a concrete variant the codebase already builds — grep `StateItem::` across `src/` — and write the factory in the test file (Step 3), where `n` varies the key so `state_item(1)` and `state_item(2)` are distinct. If no `StateItem` is constructed anywhere in `src/`, build one through the SDK's `StateItemRecord` and its `From`/`TryFrom` conversions; `StateItem` has no serde of its own, which is exactly why that record type exists.

- [ ] **Step 2: Export it**

Add to `apps/backend/src/lib.rs`, beside `pub mod db;`:

```rust
/// Behaviour every store implementation must have. Lives in the library, not
/// in `tests/`, so Phase 4's SQL stores can run the identical assertions.
pub mod conformance;
```

- [ ] **Step 3: Run the suite against the in-memory stores**

Create `apps/backend/tests/store_conformance.rs`:

```rust
//! The conformance suite against the stores that already work.
//!
//! This is the proving run. If these pass, the suite is known to describe real
//! behaviour rather than whatever a new implementation happens to do — which is
//! what makes it worth anything when Phase 4 points it at SQL.

use derec_backend::conformance;
use derec_backend::stores::{
    InMemoryChannelStore, InMemoryShareStore, InMemoryStateStore, InMemorySecretStore,
    InMemoryUserSecretStore,
};

#[tokio::test]
async fn the_in_memory_channel_store_conforms() {
    let mut store = InMemoryChannelStore::default();
    conformance::channel_store_conforms(&mut store).await;
}

#[tokio::test]
async fn the_in_memory_share_store_conforms() {
    let mut store = InMemoryShareStore::default();
    conformance::share_store_conforms(&mut store).await;
}

#[tokio::test]
async fn the_in_memory_user_secret_store_conforms() {
    let mut store = InMemoryUserSecretStore::default();
    conformance::user_secret_store_conforms(&mut store).await;
}

#[tokio::test]
async fn the_in_memory_secret_store_conforms() {
    let mut store = InMemorySecretStore::default();
    conformance::secret_store_conforms(&mut store).await;
}

#[tokio::test]
async fn the_in_memory_state_store_conforms() {
    let mut store = InMemoryStateStore::default();
    // `n` must vary the key, so `state_item(1)` and `state_item(2)` are two
    // distinct rows of the same kind. Fill this in from a concrete variant —
    // see the factory note in the suite.
    conformance::state_store_conforms(&mut store, state_item).await;
}
```

Write `state_item` in this file, above the tests. All five in-memory stores derive `Default`, so `::default()` is the constructor throughout.

Run: `cd apps/backend && cargo test --test store_conformance 2>&1 | tail -15`
Expected: 5 tests pass.

If one fails, **do not weaken the assertion to make it pass.** Either the in-memory store has a real bug worth reporting, or the assertion describes behaviour the protocol does not actually require — decide which, and say so.

- [ ] **Step 4: Prove the suite has teeth**

A suite that passes against a correct implementation proves nothing on its own. Break one behaviour deliberately and confirm the suite notices.

In `src/stores.rs`, temporarily make `InMemoryChannelStore::load` ignore the secret partition — change the `helpers.get(&(secret_id, channel_id.0))` lookup to search on `channel_id` alone.

Run: `cd apps/backend && cargo test --test store_conformance 2>&1 | grep -E "FAILED|panicked" | head -3`
Expected: `the_in_memory_channel_store_conforms` FAILS on "channels must be partitioned by secret_id".

**Revert that edit.** Confirm with `git diff src/stores.rs` — expected: no output.

Run: `cd apps/backend && cargo test --test store_conformance 2>&1 | grep "test result"`
Expected: `test result: ok. 5 passed`

- [ ] **Step 5: Run the full suite**

Run: `cd apps/backend && cargo test 2>&1 | grep -cE "^test result: ok"`
Expected: `15` (13 baseline + `migrations` + `store_conformance`).

Run: `cd apps/backend && cargo test 2>&1 | grep -E "FAILED|^warning" | head`
Expected: no output.

- [ ] **Step 6: Report, do not commit**

Files touched: `apps/backend/src/conformance.rs`, `apps/backend/src/lib.rs`, `apps/backend/tests/store_conformance.rs`.

---

## Task 7: Document the setting

**Files:**
- Modify: `examples/config.example.toml`
- Modify: `examples/.env.example`
- Modify: `README.md`

- [ ] **Step 1: Add it to the TOML example**

In `examples/config.example.toml`, in the `[server]` table after `port`:

```toml
# Where state lives.
#
#   a bare path         SQLite at that path — "./derec.db" for local runs
#   anything with ://   passed through untouched (Postgres, or a tuned SQLite)
#   "sqlite::memory:"   a scratch node that forgets everything on exit
#
# Unset, this is /var/lib/derec/derec.db — an absolute path under the image's
# volume, so an unconfigured container already survives a restart. That path is
# usually not writable outside a container, so use a relative one locally.
database_url = "./derec.db"
```

- [ ] **Step 2: Add it to the env example**

In `examples/.env.example`, after `DEREC_PORT`:

```bash
# Where state lives. A bare path is SQLite; anything with :// is passed through
# untouched. Inside the image this defaults to /var/lib/derec/derec.db, and the
# named volume is what makes it durable across `docker rm`.
# DEREC_DATABASE_URL=./derec.db

# A scratch node that forgets everything on exit:
# DEREC_DATABASE_URL=sqlite::memory:
```

- [ ] **Step 3: Add it to the README mapping table**

In `README.md`, in the file-key-to-variable table, directly after the `server.port` row:

```markdown
| `server.database_url` | `DEREC_DATABASE_URL` |
```

- [ ] **Step 4: Verify the example still loads**

Run:

```bash
cd apps/backend && DEREC_CONFIG_PATH=../../examples/config.example.toml \
  perl -e 'alarm 5; exec @ARGV' ./target/debug/derec-backend 2>&1 | head -14
```

Expected: the banner reports `database_url  ./derec.db  file`, and the node boots. A validation error here means the example contradicts itself — fix the example.

Note this creates a `derec.db` in `apps/backend`. Add `derec.db` and `derec.db-*` to `.gitignore` if they are not already covered, and delete the file afterwards.

- [ ] **Step 5: Run everything**

Run: `cd apps/backend && cargo test 2>&1 | grep -cE "^test result: ok"`
Expected: `15`, no `FAILED`, no warnings.

- [ ] **Step 6: Report, do not commit**

Files touched: `examples/config.example.toml`, `examples/.env.example`, `README.md`, possibly `.gitignore`.

---

## Definition of Done

- [ ] `cargo test` in `apps/backend`: **15 suites, ≥ 180 tests, 0 failures, 0 warnings**
- [ ] `npx vitest run` in `apps/web`: **408 passing** (unchanged — this plan touches no frontend code)
- [ ] `db::resolve_url` handles all four spellings from the spec's table
- [ ] A Postgres URL's password never appears in the boot banner
- [ ] Migrations apply to an empty SQLite database and are a no-op on the second connect
- [ ] The boot banner lists `database_url` with its origin, redacted
- [ ] An unreachable database aborts the boot with a message rather than serving an empty one
- [ ] The conformance suite passes against all five in-memory stores, **and** was demonstrated to fail when a partitioning behaviour was deliberately broken
- [ ] `stores.rs` is functionally unchanged — no SQL store exists yet
- [ ] Every file left **unstaged** for the user to review

## Notes for the next plan

- Phase 4 writes the five SQL stores. Each runs `conformance::*_store_conforms` on SQLite, and on Postgres when `TEST_DATABASE_URL` names a reachable database — printing a skip otherwise, in the shape `tests/proto_drift.rs` already uses.
- The pool reaches `AppState` in Phase 4, with its first real consumer. `AppState::with_config` (`state.rs`) is the pattern for adding a field without churning the five construction sites.
- `stores.rs` is deleted once nothing imports it. `conformance.rs` must survive that deletion — it lives in `src/`, not beside the in-memory stores, for exactly this reason.
- The registry tables in `0001_initial.sql` (`actors`, `actor_channels`, `disabled_helpers`, `participant_contacts`, `mailbox`) have no consumer until Phase 4 moves the dashmaps onto them. They ship now so the schema is one migration rather than two.
- Phase 5 adds the Actix `Supervisor`. It is only worth having once there is state to recover, which is why it follows the stores rather than leading them.
