# Persistence and Supervision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move backend state out of memory into SQLite (default) or PostgreSQL, under a schema that cannot distinguish a provisioned actor from a real one, and put helper actors under an Actix `Supervisor` so a restart recovers instead of resetting.

**Architecture:** The five `InMemory*` stores in `stores.rs` are replaced by `sqlx`-backed implementations of the same SDK traits, and the `dashmap` registries in `state.rs` by database tables. A trait-conformance suite is written **first**, against the existing in-memory implementations, so it is proven meaningful before any SQL exists; each new store must then pass that same suite on both engines. Supervision comes last, because a supervised restart is only worth having once state survives it.

**Tech Stack:** Rust, `sqlx` 0.8 (SQLite + Postgres, `runtime-tokio-rustls`), Actix actors, `derec-library` 0.0.2 with its `serde` feature enabled.

**Spec:** `docs/superpowers/specs/2026-09-01-node-separation-admin-ui-design.md`

## Phase Roadmap

Plan 3 of 5.

| # | Plan | Status |
|---|---|---|
| 1 | Per-secret protocol instances | complete (11 commits, e2e 39/39) |
| 2 | Actor model cleanup | complete (12 commits, e2e 39/39) |
| 3 | **Persistence + supervision** (this document) | in progress |
| 4 | Node separation — two nodes, three modes, owner independence | not started |
| 5 | Admin UI — auth, panels, config domains, message tap, inspection | not started |

## Global Constraints

- **The protocol is immutable.** No changes to `derec-library`, `derec-proto`, the protobufs, or `../lib-derec` (read-only reference). **Enabling a Cargo *feature* on the dependency is not a change to it** and is explicitly permitted — this plan requires the `serde` feature.
- **Verify SDK facts against the pinned published version**, not `../lib-derec`. Authoritative: `~/.cargo/registry/src/*/derec-library-0.0.2/`.
- **The uniformity constraint (spec:310-334):** no table, column or key may distinguish a provisioned actor from a real one. No `is_bot`, no `provisioned`, no role-dependent tables, no role-dependent code paths in the store layer. Bot behaviour is node configuration and must never reach a row.
- **Both nodes share one schema.** Plan 4 splits the process; this plan must not assume a single node owns all tables.
- No `unwrap()` / `expect()` in production Rust paths. Test code may use them.
- Backend baseline entering this plan: **77 passing, 8 suites, 0 warnings**. Frontend: `tsc -b` clean, **344 vitest**. Playwright: **39/39**.
- **No HTTP API change anywhere in this plan.** If a task appears to require one, stop and report.
- **No frontend change in Tasks 1-8** — they are backend-internal. Task 9 is an audit of browser-side storage and is the single exception; it changes frontend code only if the audit finds a genuine violation.
- Stage only the files each task touches. `docs/` is untracked and must never be committed by an implementer.

## Inherited follow-ups from plan 2

Carry these; some are cheap to close while already in the relevant file:

- `LoadSharedKeyMsg` (`actor.rs`) still resolves via `take_own()`, the own-instance assumption that plan 2 fixed for the fingerprint handlers. For a replica-backing helper the roster asks for that channel's key on the wrong instance and gets `None`. Degrades to a missing display value, not an error. **Task 7 touches this file; close it there.**
- Dead machinery on the frontend (`PeerConfirmation`, `replicasAwaitingFirstSync`, `ReplicaStatus = 'unpaired'`) — **out of scope for this plan**, which changes no frontend code. Recorded so it is not lost.

---

## Verified SDK facts — build on these, do not re-derive

| Type | Persistence path |
|---|---|
| `ChannelRecord`, `HelperChannel`, `ReplicaMember` | `#[derive(Serialize, Deserialize)]` unconditionally |
| `SecretValue` | `#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]` — needs the feature |
| `StateItem` | **No serde.** Use the SDK's own helper: `StateItemRecord` (`protocol/types/state_record.rs:96`) is serde-derived, with `impl From<&StateItem> for StateItemRecord` (`:138`) and `pub fn into_item(self) -> Result<StateItem, String>` (`:301`). `StateKeyRecord` has `impl From<&StateKey>` (`:46`). |
| `Share` | **No serde**, but fields are public and scalar: `secret_id: u64`, `version: u32`, `bytes: Vec<u8>`. Map to columns directly. Its channel/replica keying comes from the *method arguments*, not the struct. |

The SDK's own test names serde "the path a store implementation takes when it opts for serde over the byte-level accessors" (`types/mod.rs`, `secret_value_serde_round_trips_all_variants`), so this is the endorsed route, not a workaround.

**`u64` and SQL:** SQLite has no unsigned 64-bit integer and Postgres has no `u64`. Every `secret_id`, `channel_id` and `replica_id` is a `u64`. Store them as **`TEXT`, decimal-encoded** — the same decision the HTTP layer already made for `secret_id` (`Actor::secret_id` serialises as a string because `u64` exceeds JavaScript's exact integer range). Do **not** use `i64` with a bit-cast: it makes every query's ordering and comparison semantics wrong at the high end and is invisible until it bites.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/backend/migrations/` | **new** — `sqlx::migrate!` SQL migrations, one schema for both engines |
| `apps/backend/src/db.rs` | **new** — engine detection, pool construction, migration runner. No domain knowledge. |
| `apps/backend/src/stores/mod.rs` | **new** — re-exports; `ActorProtocol` type alias moves here |
| `apps/backend/src/stores/channel.rs` | **new** — `SqlChannelStore` |
| `apps/backend/src/stores/secret.rs` | **new** — `SqlSecretStore`, `SqlUserSecretStore` |
| `apps/backend/src/stores/share.rs` | **new** — `SqlShareStore` |
| `apps/backend/src/stores/state.rs` | **new** — `SqlStateStore` |
| `apps/backend/src/stores/transport.rs` | **new** — `HttpTransport`, moved unchanged from `stores.rs` |
| `apps/backend/src/stores.rs` | **delete** at the end of Task 6, once nothing imports the in-memory types |
| `apps/backend/src/state.rs` | **modify** — registries become DB-backed |
| `apps/backend/src/actor.rs` | **modify** — `Supervised`, `restarting()`, store construction |
| `apps/backend/tests/store_conformance.rs` | **new** — the suite every store implementation must pass, on every engine |

`stores.rs` is 489 lines holding five unrelated stores plus a transport; splitting it by store is the point at which each file gets one responsibility, and it is the file this plan rewrites wholesale anyway.

---

## Task 1: Storage foundation

**Files:**
- Create: `apps/backend/src/db.rs`, `apps/backend/migrations/0001_init.sql`
- Modify: `apps/backend/Cargo.toml`, `apps/backend/src/lib.rs`, `apps/backend/src/main.rs`, `apps/backend/src/config.rs`

**Interfaces:**
- Produces:
  - `pub enum DbError` (`thiserror`) with variants for connect failure and migration failure
  - `pub async fn connect(url: &str) -> Result<sqlx::AnyPool, DbError>`
  - `pub async fn migrate(pool: &sqlx::AnyPool) -> Result<(), DbError>`
  - `pub fn resolve_url(raw: Option<&str>) -> String` — normalises a bare filesystem path to a `sqlite://` URL, passes through anything containing `://`, and returns the default when `None`

Nothing consumes the pool yet. This task ends with the process booting against a real database and applying migrations, and no behaviour changed.

- [ ] **Step 1: Add the dependencies**

In `apps/backend/Cargo.toml`:

```toml
sqlx = { version = "0.8", default-features = false, features = [
    "runtime-tokio-rustls",
    "any",
    "sqlite",
    "postgres",
    "migrate",
] }
```

and enable the SDK's serde feature on the existing dependency:

```toml
derec-library = { version = "0.0.2", features = ["serde"] }
```

`derec-proto` stays as it is — `serde` on `derec-library` already pulls `derec-proto/serde`.

- [ ] **Step 2: Confirm the feature actually lands**

Run: `cargo build --manifest-path apps/backend/Cargo.toml`
Expected: compiles.

Then confirm `SecretValue` really gained serde, rather than assuming the feature flag did what the Cargo.toml says. Add a temporary test in `apps/backend/src/db.rs`:

```rust
#[cfg(test)]
mod feature_check {
    #[test]
    fn secret_value_is_serde_enabled() {
        // The `serde` feature on derec-library is what makes SecretValue
        // persistable at all. If it silently stops applying, every secret
        // store method breaks in a way that reads as a type error far from
        // the cause — so assert it here, where the cause is obvious.
        let v = derec_library::protocol::SecretValue::SharedKey([7u8; 32]);
        let json = serde_json::to_string(&v).expect("SecretValue serialises");
        assert!(json.contains('7') || !json.is_empty());
    }
}
```

Run: `cargo test --manifest-path apps/backend/Cargo.toml secret_value_is_serde_enabled`
Expected: PASS. If it fails to compile, the feature is not applying — stop and report rather than working around it.

- [ ] **Step 3: Write the URL resolution and its tests**

Create `apps/backend/src/db.rs`:

```rust
//! Database connection, migration and engine selection.
//!
//! Deliberately domain-free: this module knows how to reach a database and
//! nothing about actors, channels or shares.

use sqlx::any::{AnyPool, AnyPoolOptions};

/// Where the database lives when the operator says nothing.
pub const DEFAULT_URL: &str = "sqlite://derec.db?mode=rwc";

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("could not connect to the database: {0}")]
    Connect(sqlx::Error),
    #[error("database migration failed: {0}")]
    Migrate(sqlx::migrate::MigrateError),
}

/// Turn operator input into a URL `sqlx` understands.
///
/// A bare filesystem path is the common case for SQLite and is accepted as
/// such — `DATABASE_URL=./derec.db` means what it looks like. Anything
/// containing `://` is passed through untouched, which is how Postgres URLs
/// and tuned SQLite URLs both arrive.
pub fn resolve_url(raw: Option<&str>) -> String {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        None => DEFAULT_URL.to_owned(),
        Some(url) if url.contains("://") => url.to_owned(),
        Some(path) => format!("sqlite://{path}?mode=rwc"),
    }
}

pub async fn connect(url: &str) -> Result<AnyPool, DbError> {
    sqlx::any::install_default_drivers();
    AnyPoolOptions::new()
        .max_connections(8)
        .connect(url)
        .await
        .map_err(DbError::Connect)
}

pub async fn migrate(pool: &AnyPool) -> Result<(), DbError> {
    sqlx::migrate!("./migrations")
        .run(pool)
        .await
        .map_err(DbError::Migrate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_absent_url_falls_back_to_the_default() {
        assert_eq!(resolve_url(None), DEFAULT_URL);
        assert_eq!(resolve_url(Some("   ")), DEFAULT_URL);
    }

    #[test]
    fn a_bare_path_becomes_a_sqlite_url() {
        assert_eq!(resolve_url(Some("./derec.db")), "sqlite://./derec.db?mode=rwc");
    }

    #[test]
    fn a_real_url_passes_through_untouched() {
        let pg = "postgres://user:pw@localhost:5432/derec";
        assert_eq!(resolve_url(Some(pg)), pg);
        let tuned = "sqlite://derec.db?mode=rwc&cache=shared";
        assert_eq!(resolve_url(Some(tuned)), tuned);
    }
}
```

- [ ] **Step 4: Write the initial migration**

Create `apps/backend/migrations/0001_init.sql` with a single table proving the pipeline, which later tasks extend:

```sql
-- Schema version marker. Later migrations add the real tables; this one
-- exists so the migration runner has something to apply on a fresh database
-- and so a boot against an empty file is exercised from the first task.
CREATE TABLE IF NOT EXISTS schema_marker (
    id          INTEGER PRIMARY KEY,
    description TEXT NOT NULL
);

INSERT INTO schema_marker (id, description) VALUES (1, 'derec reference app');
```

Portability note: this file must run unmodified on both SQLite and Postgres. Avoid `AUTOINCREMENT`, `SERIAL`, backticks, and type names either engine lacks. `TEXT`, `INTEGER`, `BLOB`/`BYTEA` differences are handled by choosing `TEXT` for ids (see Global Constraints) and by storing binary as base64 `TEXT` where a portable blob type would otherwise be needed.

- [ ] **Step 5: Wire it into boot**

In `apps/backend/src/main.rs`, after `load_defaults()` and before the actor system starts:

```rust
    let db_url = db::resolve_url(std::env::var("DATABASE_URL").ok().as_deref());
    let pool = match db::connect(&db_url).await {
        Ok(pool) => pool,
        Err(e) => {
            // Starting with an unusable store surfaces later as inexplicable
            // protocol failures, so fail here where the cause is legible.
            // The URL is logged with any password segment removed.
            eprintln!("database error: {e}");
            std::process::exit(1);
        }
    };
    if let Err(e) = db::migrate(&pool).await {
        eprintln!("database error: {e}");
        std::process::exit(1);
    }
    info!(url = %redact(&db_url), "database ready");
```

Add a `redact` helper next to it that strips a `:password@` segment from a URL before logging, and a unit test for it:

```rust
#[test]
fn redact_removes_a_password_but_keeps_the_rest() {
    assert_eq!(
        redact("postgres://user:hunter2@localhost:5432/derec"),
        "postgres://user:***@localhost:5432/derec"
    );
    assert_eq!(redact("sqlite://derec.db?mode=rwc"), "sqlite://derec.db?mode=rwc");
}
```

Register `mod db;` in `apps/backend/src/lib.rs` alongside the others.

- [ ] **Step 6: Verify boot end to end**

Run: `cd apps/backend && rm -f /tmp/derec-boot-test.db && DATABASE_URL=/tmp/derec-boot-test.db PORT=5099 timeout 10 cargo run 2>&1 | head -20`
Expected: a `database ready` log line, then `server listening`. No panic.

Then confirm the file was created and the migration applied:

Run: `sqlite3 /tmp/derec-boot-test.db "select description from schema_marker; select count(*) from _sqlx_migrations;"`
Expected: `derec reference app` and `1`.

- [ ] **Step 7: Run the full backend suite**

Run: `cargo test --manifest-path apps/backend/Cargo.toml`
Expected: 77 baseline plus the new `db` unit tests. Nothing else changed.

- [ ] **Step 8: STOP for review**

---

## Task 2: The conformance suite, proven against the in-memory stores

**Files:**
- Create: `apps/backend/tests/store_conformance.rs`

**Interfaces:**
- Consumes: nothing from Task 1 — this task deliberately does not touch the database.
- Produces: `pub async fn run_channel_store_suite<S: DeRecChannelStore>(store: S)` and one such function per store trait, callable against any implementation.

This task writes the tests **before** the implementations they will judge, against the known-good in-memory stores. That ordering is the point: a conformance suite written after the SQL exists tends to encode what the SQL does. Written first, against an implementation already trusted in production, it encodes what the *trait* means — and any suite the in-memory stores fail is a suite with a bug in it, which is exactly the feedback wanted at this stage.

- [ ] **Step 1: Write the channel-store suite**

Create `apps/backend/tests/store_conformance.rs`:

```rust
//! One suite per store trait, run against every implementation.
//!
//! Written against the in-memory stores first, so the suite is validated by
//! an implementation already trusted in production before any SQL exists.
//! A SQL store is then correct exactly insofar as it passes the same suite.

use derec_library::protocol::{
    ChannelQuery, ChannelRecord, DeRecChannelStore, HelperChannel,
};
use derec_library::types::ChannelId;

const SECRET_A: u64 = 0xA1;
const SECRET_B: u64 = 0xB2;

/// Every behaviour `DeRecChannelStore` promises, in one place.
pub async fn run_channel_store_suite<S: DeRecChannelStore>(mut store: S) {
    // A saved helper channel is loadable by its channel id.
    let record = helper_record(SECRET_A, 100);
    store.save(SECRET_A, record.clone()).await.expect("save");
    let loaded = store
        .load(SECRET_A, ChannelQuery::Helper(ChannelId(100)))
        .await
        .expect("load");
    assert!(loaded.is_some(), "a saved channel must load back");

    // Partitioning by secret_id is not advisory: the same channel id under a
    // different secret must not resolve.
    let other = store
        .load(SECRET_B, ChannelQuery::Helper(ChannelId(100)))
        .await
        .expect("load");
    assert!(other.is_none(), "channels must not leak across secret_id");

    // helpers() lists what was saved, scoped to the secret.
    let helpers = store.helpers(SECRET_A).await.expect("helpers");
    assert_eq!(helpers.len(), 1);
    assert!(store.helpers(SECRET_B).await.expect("helpers").is_empty());

    // remove() reports whether it removed something, and the row is gone.
    let removed = store
        .remove(SECRET_A, ChannelQuery::Helper(ChannelId(100)))
        .await
        .expect("remove");
    assert!(removed, "removing an existing channel reports true");
    assert!(
        !store
            .remove(SECRET_A, ChannelQuery::Helper(ChannelId(100)))
            .await
            .expect("remove"),
        "removing a missing channel reports false"
    );
    assert!(store.helpers(SECRET_A).await.expect("helpers").is_empty());

    // The link graph is bidirectional and transitive, and scoped by secret.
    store.save(SECRET_A, helper_record(SECRET_A, 200)).await.expect("save");
    store.save(SECRET_A, helper_record(SECRET_A, 201)).await.expect("save");
    store.save(SECRET_A, helper_record(SECRET_A, 202)).await.expect("save");
    store
        .link_channel(SECRET_A, ChannelId(200), ChannelId(201))
        .await
        .expect("link");
    store
        .link_channel(SECRET_A, ChannelId(201), ChannelId(202))
        .await
        .expect("link");

    let mut linked: Vec<u64> = store
        .linked_channels(SECRET_A, ChannelId(200))
        .await
        .expect("linked")
        .into_iter()
        .map(|c| c.0)
        .collect();
    linked.sort_unstable();
    assert_eq!(
        linked,
        vec![200, 201, 202],
        "linked_channels is a transitive closure including the queried channel"
    );

    assert!(
        store
            .linked_channels(SECRET_B, ChannelId(200))
            .await
            .expect("linked")
            .is_empty(),
        "the link graph is partitioned by secret_id"
    );
}

/// The smallest valid helper `ChannelRecord` the trait will accept.
///
/// Construct this from `ChannelRecord`'s real definition in
/// `derec-library-0.0.2/src/protocol/types/mod.rs`. It is deliberately not
/// spelled out here: the plan has not read that struct field by field, and a
/// guessed literal that happens to compile would give the whole suite a
/// false foundation.
fn helper_record(secret_id: u64, channel_id: u64) -> ChannelRecord {
    // Read the struct, fill every field with the simplest value that is
    // genuinely valid for it, and keep `secret_id` / `channel_id` flowing
    // through from the arguments so the partitioning assertions above mean
    // something.
    unimplemented!("construct from ChannelRecord's real definition — see doc comment")
}
```

**Writing `helper_record` is the first thing you do in this task**, before anything else compiles. Read `ChannelRecord` in the pinned SDK source and replace the `unimplemented!` with a real construction — the `unimplemented!` is there so a forgotten implementation fails loudly at the first test rather than silently producing a degenerate record.

If `ChannelRecord` requires values you cannot legitimately synthesise (real key material, a live transport), stop and report rather than inventing them: a suite built on invalid records proves nothing, and every later task in this plan is judged by it.

Assert the transitive-closure semantics you actually observe from the in-memory implementation rather than the ones written above if they differ — `InMemoryChannelStore`'s `linked_channels` is documented as a BFS over a bidirectional adjacency list, and the suite must encode what the trait means, with the in-memory store as the reference. **Say in your report if you changed an assertion and why.**

- [ ] **Step 2: Run the suite against the in-memory store**

Add at the bottom of the file:

```rust
#[tokio::test]
async fn in_memory_channel_store_conforms() {
    run_channel_store_suite(derec_backend::stores::InMemoryChannelStore::default()).await;
}
```

Run: `cargo test --manifest-path apps/backend/Cargo.toml --test store_conformance`
Expected: PASS. **A failure here means the suite is wrong, not the store** — the in-memory implementation is what production has been running. Fix the suite until it passes, and report any assertion you had to change.

- [ ] **Step 3: Write the remaining four suites the same way**

Add `run_secret_store_suite`, `run_user_secret_store_suite`, `run_share_store_suite` and `run_state_store_suite`, each with an in-memory conformance test beside it. Cover, at minimum:

- **Secret store:** save/load round-trip per `SecretKind`; `secret_id` partitioning; load of an absent key returns `None`; remove.
- **User secret store:** round-trip of `UserSecrets`; partitioning; absent load.
- **Share store:** `save` then `load` for one channel; `load_many` across channels; `load_all`; `latest_version` reflecting the highest saved version and `None` when empty; `remove_channel` removing only that channel's shares.
- **State store:** round-trip of at least two distinct `StateItem` variants (`PendingVerification` and `SharingRound` exercise different `StateItemRecord` fields); overwrite-on-save (the SDK documents save as a full-replacement upsert, not a merge); load of an absent key; remove.

Every suite must be partition-aware: two different `secret_id`s must not see each other's rows. That property is what the uniformity constraint rests on, so it is the one to get right.

- [ ] **Step 4: Run all five against the in-memory stores**

Run: `cargo test --manifest-path apps/backend/Cargo.toml --test store_conformance`
Expected: 5 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `cargo test --manifest-path apps/backend/Cargo.toml`
Expected: 77 baseline + Task 1's db tests + 5 conformance tests.

- [ ] **Step 6: STOP for review**

Report: every assertion you had to change from the sketch and why, and anything about a trait's contract that the in-memory implementation revealed and the sketch got wrong.

---

## Task 3: The SQL channel store

**Files:**
- Create: `apps/backend/src/stores/mod.rs`, `apps/backend/src/stores/channel.rs`, `apps/backend/src/stores/transport.rs`
- Modify: `apps/backend/migrations/0001_init.sql`, `apps/backend/src/lib.rs`
- Test: `apps/backend/tests/store_conformance.rs`

**Interfaces:**
- Consumes: `run_channel_store_suite` (Task 2), `db::connect`/`db::migrate` (Task 1).
- Produces: `pub struct SqlChannelStore { pool: sqlx::AnyPool }` with `pub fn new(pool: AnyPool) -> Self`, implementing `DeRecChannelStore`.

- [ ] **Step 1: Move the module without changing it**

```bash
mkdir -p apps/backend/src/stores
git mv apps/backend/src/stores.rs apps/backend/src/stores/mod.rs
```

Create `apps/backend/src/stores/transport.rs` and move `HttpTransport` and the `ActorProtocol` type alias into it **unchanged**, re-exporting both from `mod.rs` so no importer changes. Verify with `cargo test` that nothing broke before writing any SQL — a move and a rewrite in one commit is unreviewable.

- [ ] **Step 2: Add the channel tables**

Append to `apps/backend/migrations/0001_init.sql`:

```sql
-- Ids are TEXT holding a decimal u64. Neither SQLite nor Postgres has an
-- unsigned 64-bit integer, and a signed bit-cast makes ordering and
-- comparison wrong at the high end in a way nothing surfaces until it bites.
CREATE TABLE IF NOT EXISTS channels (
    secret_id   TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    replica_id  TEXT,
    kind        TEXT NOT NULL,   -- 'helper' | 'replica'
    record      TEXT NOT NULL,   -- serde_json of ChannelRecord
    PRIMARY KEY (secret_id, kind, channel_id, replica_id)
);

CREATE TABLE IF NOT EXISTS channel_links (
    secret_id TEXT NOT NULL,
    a         TEXT NOT NULL,
    b         TEXT NOT NULL,
    PRIMARY KEY (secret_id, a, b)
);
```

The link table stores **both directions** of every edge, so `linked_channels` is a breadth-first walk without a union query. Note there is no column here that could name an actor kind — the uniformity constraint holds by construction, because the store layer never learns what kind of actor owns a secret.

`PRIMARY KEY` including a nullable `replica_id` behaves differently across engines; if that bites, use a sentinel empty string rather than `NULL` and say so in your report.

- [ ] **Step 3: Implement `SqlChannelStore`**

Create `apps/backend/src/stores/channel.rs` implementing all seven methods against those tables. Shape notes:

- Each method returns `ChannelStoreFuture<'_, T>`, a boxed future borrowing `self`. Clone the `AnyPool` into the async block rather than borrowing it across the await.
- `save` is an upsert. `INSERT ... ON CONFLICT ... DO UPDATE` works on both engines with the same syntax; use it rather than delete-then-insert, which is not atomic.
- `helpers` and `replicas` filter on `kind` and deserialise `record`.
- `link_channel` inserts both `(a,b)` and `(b,a)`.
- `linked_channels` performs the BFS in Rust over repeated single-hop queries. Do **not** write a recursive CTE — the two engines differ on `WITH RECURSIVE` details and the graphs here are tiny.
- A row whose `record` fails to deserialise is a corrupt row: log it and skip, do not panic and do not silently treat it as absent in a way that would let `remove` report `false` for a row that exists.

- [ ] **Step 4: Run the conformance suite against it, on SQLite**

Add to `apps/backend/tests/store_conformance.rs`:

```rust
/// A fresh, migrated database per test, so nothing leaks between them.
async fn sqlite_pool() -> sqlx::AnyPool {
    sqlx::any::install_default_drivers();
    let pool = sqlx::any::AnyPoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("in-memory sqlite");
    derec_backend::db::migrate(&pool).await.expect("migrate");
    pool
}

#[tokio::test]
async fn sql_channel_store_conforms_on_sqlite() {
    let pool = sqlite_pool().await;
    run_channel_store_suite(derec_backend::stores::SqlChannelStore::new(pool)).await;
}
```

Run: `cargo test --manifest-path apps/backend/Cargo.toml --test store_conformance`
Expected: both the in-memory and the SQLite channel-store tests pass — the same suite, two implementations.

- [ ] **Step 5: Make the Postgres run possible**

Add a second test that runs only when a URL is supplied, so the suite is engine-parameterised rather than SQLite-only:

```rust
/// Postgres conformance runs only when `TEST_DATABASE_URL` names a reachable
/// server, because a database server is not a reasonable thing to require of
/// every `cargo test`. The controller runs this against a throwaway container.
/// Skipping is reported, not silent — a suite that quietly tests nothing is
/// worse than one that does not exist.
#[tokio::test]
async fn sql_channel_store_conforms_on_postgres() {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        eprintln!("SKIPPED: set TEST_DATABASE_URL to run Postgres conformance");
        return;
    };
    sqlx::any::install_default_drivers();
    let pool = sqlx::any::AnyPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .expect("postgres");
    derec_backend::db::migrate(&pool).await.expect("migrate");
    run_channel_store_suite(derec_backend::stores::SqlChannelStore::new(pool)).await;
}
```

Because Postgres is not per-test-isolated the way `sqlite::memory:` is, the suite must not assume an empty database. Either use ids unique per run, or truncate the tables at the start of the Postgres test. Say which you chose.

- [ ] **Step 6: Run the full suite**

Run: `cargo test --manifest-path apps/backend/Cargo.toml`
Expected: all pass; the Postgres test prints `SKIPPED` unless a URL is set.

- [ ] **Step 7: STOP for review**

Report whether the same suite genuinely passed against both implementations, and any place the trait's contract turned out to be under-specified such that the two implementations could both be "right".

---

## Task 4: The SQL secret and user-secret stores

**Files:**
- Create: `apps/backend/src/stores/secret.rs`
- Modify: `apps/backend/migrations/0001_init.sql`, `apps/backend/src/stores/mod.rs`
- Test: `apps/backend/tests/store_conformance.rs`

**Interfaces:**
- Consumes: `run_secret_store_suite`, `run_user_secret_store_suite` (Task 2).
- Produces: `pub struct SqlSecretStore { pool: AnyPool }` and `pub struct SqlUserSecretStore { pool: AnyPool }`, each with `pub fn new(pool: AnyPool) -> Self`.

- [ ] **Step 1: Add the tables**

```sql
CREATE TABLE IF NOT EXISTS secrets (
    secret_id  TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    kind       INTEGER NOT NULL,  -- SecretKind discriminant
    value      TEXT NOT NULL,     -- serde_json of SecretValue
    PRIMARY KEY (secret_id, channel_id, kind)
);

CREATE TABLE IF NOT EXISTS user_secrets (
    secret_id TEXT PRIMARY KEY,
    value     TEXT NOT NULL       -- serde_json of UserSecrets
);
```

- [ ] **Step 2: Implement both stores**

`SecretValue` serialises with `serde_json` thanks to the feature enabled in Task 1. Read `DeRecSecretStore`'s four methods and `DeRecUserSecretStore`'s three in the pinned source and implement each against the tables above. `SecretKind` is an enum; store its discriminant and map back on load — if it does not expose a stable numeric conversion, serialise the kind as its serde representation instead and say which you did.

- [ ] **Step 3: Run conformance on both engines**

Add `sql_secret_store_conforms_on_sqlite`, `sql_user_secret_store_conforms_on_sqlite` and the two matching `_on_postgres` variants, following the shape Task 3 established.

Run: `cargo test --manifest-path apps/backend/Cargo.toml --test store_conformance`
Expected: all pass.

- [ ] **Step 4: Run the full suite, then STOP for review**

---

## Task 5: The SQL share store

**Files:**
- Create: `apps/backend/src/stores/share.rs`
- Modify: `apps/backend/migrations/0001_init.sql`, `apps/backend/src/stores/mod.rs`
- Test: `apps/backend/tests/store_conformance.rs`

**Interfaces:**
- Consumes: `run_share_store_suite` (Task 2).
- Produces: `pub struct SqlShareStore { pool: AnyPool }` with `pub fn new(pool: AnyPool) -> Self`.

- [ ] **Step 1: Add the table**

```sql
CREATE TABLE IF NOT EXISTS shares (
    secret_id  TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    replica_id TEXT NOT NULL,   -- '0' is the reserved "absent" replica id
    version    INTEGER NOT NULL,
    bytes      TEXT NOT NULL,   -- base64 of Share::bytes
    PRIMARY KEY (secret_id, channel_id, replica_id, version)
);
```

`Share` has no serde, so its three public fields map to columns directly: `secret_id` and `version` as their own columns, `bytes` base64-encoded into `TEXT` (portable across both engines without a blob type). The `base64` crate is already a dependency.

The key `(secret_id, channel_id, version, replica_id)` is the one the spec names, and it is why a replica needs an instance bound to the mirrored owner's secret — getting this key wrong makes every replica lookup miss.

- [ ] **Step 2: Implement the six methods**

`load`, `load_many`, `load_all`, `latest_version`, `save`, `remove_channel`. `latest_version` is `SELECT MAX(version)` scoped to `secret_id`, returning `None` on an empty set — note that `MAX` over zero rows yields SQL `NULL`, so decode into `Option<i64>` and map, rather than expecting an error.

- [ ] **Step 3: Run conformance on both engines, then the full suite, then STOP for review**

Add `sql_share_store_conforms_on_sqlite` and `_on_postgres`.

---

## Task 6: The SQL state store, and deleting the in-memory ones

**Files:**
- Create: `apps/backend/src/stores/state.rs`
- Modify: `apps/backend/migrations/0001_init.sql`, `apps/backend/src/stores/mod.rs`, `apps/backend/src/actor.rs`, `apps/backend/src/provisioning.rs`
- Test: `apps/backend/tests/store_conformance.rs`

**Interfaces:**
- Consumes: `run_state_store_suite` (Task 2).
- Produces: `pub struct SqlStateStore { pool: AnyPool }`. After this task the `InMemory*` types no longer exist.

- [ ] **Step 1: Add the table**

```sql
CREATE TABLE IF NOT EXISTS protocol_state (
    secret_id TEXT NOT NULL,
    key_kind  INTEGER NOT NULL,
    key_id    TEXT NOT NULL,
    item      TEXT NOT NULL,   -- serde_json of StateItemRecord
    PRIMARY KEY (secret_id, key_kind, key_id)
);
```

- [ ] **Step 2: Implement using the SDK's record types**

`StateItem` has no serde. Use the SDK's own helpers: `StateItemRecord::from(&item)` to persist and `record.into_item()` to restore (`protocol/types/state_record.rs:138` and `:301`), and `StateKeyRecord::from(&key)` (`:46`) to derive the key columns. `into_item` returns `Result<StateItem, String>`; a row that fails to convert is corrupt — log and skip, exactly as for channels.

The SDK documents `save` as a **full-replacement upsert**, not a merge, so an upsert on the primary key is the correct and complete implementation.

- [ ] **Step 3: Switch protocol construction to the SQL stores**

`build_protocol` in `apps/backend/src/actor.rs` constructs `InMemoryChannelStore::default()` and friends. It now needs a pool. Thread `pool: AnyPool` through `ProtocolConfig` — it already carries `http_client`, so a pool sits naturally beside it — and construct `SqlChannelStore::new(config.pool.clone())` and the rest.

`rebuild_with_stores` moves the live stores across and does not construct new ones, so it needs no change beyond compiling against the new types. Verify that.

- [ ] **Step 4: Delete the in-memory stores**

Remove `InMemoryChannelStore`, `InMemorySecretStore`, `InMemoryShareStore`, `InMemoryUserSecretStore` and `InMemoryStateStore` from `apps/backend/src/stores/mod.rs`, and delete their conformance tests — **but only those**. The five `run_*_suite` functions stay: they are now exercised solely by the SQL implementations, which is the point.

Verify nothing still references them:

Run: `grep -rn "InMemory" apps/backend/src apps/backend/tests`
Expected: no output.

- [ ] **Step 5: Run everything**

Run: `cargo test --manifest-path apps/backend/Cargo.toml`
Expected: all pass. Report the count and explain any reduction — deleting the in-memory conformance tests legitimately removes 5.

- [ ] **Step 6: STOP for review**

This is the task where the application first genuinely runs on a database. Report anything that behaved differently from the in-memory implementation, however small.

---

## Task 7: Registries on the database, and the uniformity constraint

**Files:**
- Modify: `apps/backend/src/state.rs`, `apps/backend/src/provisioning.rs`, `apps/backend/src/actor.rs`, `apps/backend/migrations/0001_init.sql`
- Test: `apps/backend/tests/uniformity.rs` (create)

**Interfaces:**
- Consumes: the pool from Task 1.
- Produces: an `AppState` whose actor registry and disabled-actor set are database-backed.

- [ ] **Step 1: Add the actor tables**

```sql
CREATE TABLE IF NOT EXISTS actors (
    id            TEXT PRIMARY KEY,   -- UUID
    name          TEXT NOT NULL,
    transport_uri TEXT NOT NULL,
    secret_id     TEXT NOT NULL,
    created_seq   INTEGER NOT NULL    -- preserves registration order
);

CREATE TABLE IF NOT EXISTS actor_flags (
    actor_id TEXT NOT NULL,
    flag     TEXT NOT NULL,           -- e.g. 'disabled'
    PRIMARY KEY (actor_id, flag)
);
```

**There is deliberately no `role` column.** The spec's uniformity constraint forbids any column that distinguishes a provisioned actor from a real one, and `role` is exactly that distinction. Roles remain a runtime concept: the helper node's actors are helpers because that node provisions them, not because a row says so. If a query turns out to need the role, that is a signal to reconsider the query — report it rather than adding the column.

`created_seq` exists because the registry's insertion order is load-bearing: the frontend renders the roster as a list and selects participants by index, and an unordered container reshuffles the UI on every poll.

- [ ] **Step 2: Move the registry**

Replace `AppState`'s `actors: Arc<ActorRegistry>` and `disabled_helpers: Arc<DashMap<Uuid, ()>>` with database access. Keep `actor_inboxes` and `browser_receivers` **in memory** — an `mpsc::Sender` and a `Mutex<Receiver>` are process-local handles that cannot be serialised, and a restart legitimately invalidates them.

Say plainly in your report which pieces of `AppState` remain in memory and why. That list is what plan 4 needs when it splits this into two nodes.

`ensure_helpers`'s count-and-create must stay atomic — it was a single registry lock and must become a single transaction, or two browser contexts setting up simultaneously can each fill an empty pool.

- [ ] **Step 3: Write the uniformity test**

Create `apps/backend/tests/uniformity.rs`:

```rust
//! The spec's uniformity constraint, as a test rather than a convention:
//! "No table, column or key may distinguish a provisioned actor from a real
//! one." A design that needs to mark an actor as a bot is a design that is
//! special-casing the protocol.

#[tokio::test]
async fn no_column_names_an_actor_kind() {
    let pool = migrated_sqlite().await;

    let columns: Vec<String> = sqlx::query_scalar(
        "SELECT p.name FROM sqlite_master m
         JOIN pragma_table_info(m.name) p
         WHERE m.type = 'table' AND m.name NOT LIKE '\\_sqlx%' ESCAPE '\\'",
    )
    .fetch_all(&pool)
    .await
    .expect("introspect schema");

    let forbidden = ["is_bot", "provisioned", "is_helper", "actor_kind", "role", "is_replica"];
    for column in &columns {
        let lowered = column.to_lowercase();
        assert!(
            !forbidden.iter().any(|f| lowered == *f),
            "column `{column}` distinguishes an actor kind, which the spec forbids"
        );
    }
    assert!(!columns.is_empty(), "introspection returned nothing — the query is wrong, not the schema");
}
```

The final assertion matters: an introspection query that silently returns nothing would make this test pass against any schema at all. That failure mode has occurred repeatedly in this project.

- [ ] **Step 4: Write the indistinguishability test**

The column check is necessary but weak — it would pass a schema that encoded the distinction in a value rather than a name. Add a second test that pairs the same helper with two different owners and asserts the resulting rows are structurally identical apart from ids:

Drive **two pairings against the same helper** — one standing in for the bundled owner, one for a third party — then compare what landed in `channels`. `apps/backend/tests/helper_auto_confirm.rs` already drives a complete pairing against a real router and is the pattern to follow; reuse its setup rather than inventing a second one.

The assertions that make this test meaningful:

```rust
    // Same helper, two different owner secrets.
    let rows_a: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT kind, channel_id, replica_id FROM channels WHERE secret_id = ?",
    )
    .bind(owner_a_secret.to_string())
    .fetch_all(&pool)
    .await
    .expect("query owner A's channels");

    let rows_b: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT kind, channel_id, replica_id FROM channels WHERE secret_id = ?",
    )
    .bind(owner_b_secret.to_string())
    .fetch_all(&pool)
    .await
    .expect("query owner B's channels");

    assert!(!rows_a.is_empty(), "the pairing must actually have written a row");
    assert_eq!(rows_a.len(), rows_b.len(), "both owners produce the same number of rows");

    // The decisive one: identical in every dimension except the ids
    // themselves. If anything recorded which owner was the bundled one, the
    // `kind` or the populated-column shape would differ here.
    let shape = |r: &(String, String, Option<String>)| (r.0.clone(), r.2.is_some());
    let mut shapes_a: Vec<_> = rows_a.iter().map(shape).collect();
    let mut shapes_b: Vec<_> = rows_b.iter().map(shape).collect();
    shapes_a.sort();
    shapes_b.sort();
    assert_eq!(shapes_a, shapes_b, "rows must not encode which owner was bundled");
```

If driving two genuine pairings proves impractical inside one integration test, drive the store layer directly with two different `secret_id`s and say so in your report — but the `!rows_a.is_empty()` assertion is not optional either way, because without it the whole test passes vacuously against an empty table.

- [ ] **Step 5: Close the inherited `LoadSharedKeyMsg` follow-up**

While in `actor.rs`: `Handler<LoadSharedKeyMsg>` still resolves via `take_own()`, the own-instance assumption plan 2 fixed for the fingerprint handlers. Resolve the owning instance by channel, mirroring `ChannelStatusMsg`. Add a test that a replica-mode channel's shared key is retrievable, and verify it fails without the fix.

- [ ] **Step 6: Run everything, then STOP for review**

Run the backend suite and report which parts of `AppState` remain in memory.

---

## Task 8: Supervision and restart recovery

**Files:**
- Modify: `apps/backend/src/actor.rs`, `apps/backend/src/provisioning.rs`
- Test: `apps/backend/tests/supervision.rs` (create)

**Interfaces:**
- Consumes: everything above — this task is only meaningful because state now survives.
- Produces: helper actors started under `actix::Supervisor`.

- [ ] **Step 1: Implement `Supervised`**

`ProvisionedActor` currently starts via `start_in_arbiter`. Implement `actix::Supervised` with a `restarting()` hook that rebuilds its protocol instances from the database, and start it with `Supervisor::start_in_arbiter`.

The instance map is the thing to rebuild: on restart the actor knows its own `secret_id` and can re-derive its instances from the stores, because every store is partitioned by `secret_id`. Read `instances.rs` before designing this — the channel index is reconciled from the stores, so restart recovery and the existing reconcile path should share a mechanism rather than growing a second one.

- [ ] **Step 2: Write the restart-recovery test**

Create `apps/backend/tests/supervision.rs`. Drive a helper to a state with real durable content — a completed pairing with at least one stored share — then force the actor to restart and assert the channel and the share are both still there and the actor still functions.

**This test is the entire justification for the plan.** If it cannot be made to fail when persistence is removed, it proves nothing. Verify it: point the protocol construction back at fresh empty stores, observe the test fail, restore, observe it pass, and report both halves.

- [ ] **Step 3: Confirm fault isolation**

Add a test that one helper panicking does not take down the node or any other helper: spawn two, panic one, assert the other still answers a message.

- [ ] **Step 4: Run everything, then STOP for review**

---

## Task 9: The same principle on the owner side — an audit

**Files:**
- Audit: `apps/web/src/stores.ts`, `apps/web/src/localData.ts`, `apps/web/src/ownerPersistence.ts`
- Modify: only if the audit finds a violation

**Interfaces:**
- Consumes: nothing. This task is independent of Tasks 1-8 and could run first.
- Produces: a written finding, and a fix only if one is warranted.

The spec applies the uniformity principle to the browser too (spec:336-350): *"the owner's DeRec stores must be generic protocol-shaped implementations, not reference-app specific. A developer should be able to lift them into their own app unchanged."*

The spec also records the expected answer — `apps/web/src/stores.ts` already satisfies this, with keys shaped `derec:<ns>:<secretId>:<record>:<…>` carrying no reference-app concepts — so **this is an audit, and "no change needed" is a perfectly good outcome.** Do not manufacture a refactor to look busy.

- [ ] **Step 1: Establish what is in the `derec:` namespace**

Run: `grep -rn "derec:" apps/web/src | grep -v "\.test\." | head -40`

For each writer, decide: is this DeRec protocol state, or is it reference-app UI state? The test is the spec's own: could a developer lift this file into their own DeRec app unchanged, or does it encode concepts only this reference app has (owner wizard progress, toast state, tab selection, provisioned-pool bookkeeping)?

- [ ] **Step 2: Establish what reference-app state is stored, and where**

Read `localData.ts` and `ownerPersistence.ts`. Confirm their keys live **outside** the `derec:` namespace. Note that `ownerPersistence.ts` already documents partitioning under `derec:owner:{ownerId}:{secretId}:…` — determine whether that is protocol state (legitimate) or app state that has leaked into the protocol namespace (a violation).

- [ ] **Step 3: Report, and fix only a genuine violation**

Write the finding either way. If everything is clean, say so with the evidence that shows it — a list of the namespaces and what writes each. If something has leaked, move it out of the `derec:` namespace, run `npx tsc -b && npx vitest run`, and confirm 344 passing.

A key move is a breaking change for existing browser state: if you move one, say plainly in your report that a user's existing local data will not be found under the new key, and whether that matters for a reference app whose state is disposable.

- [ ] **Step 4: STOP for review**

## Definition of Done

- [ ] `cargo test` passes in `apps/backend`; report the final count
- [ ] `cargo build` emits no new warnings
- [ ] The five conformance suites pass against the SQL stores on **SQLite**
- [ ] The same suites pass against **Postgres** when `TEST_DATABASE_URL` is set
- [ ] `grep -rn "InMemory" apps/backend/src apps/backend/tests` returns nothing
- [ ] `grep -rn "DashMap" apps/backend/src` returns only the in-memory inbox maps, with a comment saying why each is not persisted
- [ ] No schema column names an actor kind, enforced by a test that fails on an empty introspection result
- [ ] A helper actor restarts under supervision and recovers its channels and shares, proven by a test verified to fail without persistence
- [ ] **No HTTP API change** anywhere in the plan
- [ ] No frontend change from Tasks 1-8; any `apps/web` diff comes from Task 9's audit and is justified in its report
- [ ] Playwright still passes at 39/39

## Notes for the next plan

Plan 4 splits the process into two nodes. It inherits: one schema both nodes use, a store layer that never learns an actor's role, and an explicit list (from Task 7's report) of what remains in memory and therefore cannot be shared between nodes.
