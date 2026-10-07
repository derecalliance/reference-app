# SQL Stores Implementation Plan (Phase 4a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write the five `DeRecStore` implementations backed by `sqlx`, each proven by the existing conformance suite on SQLite *and*, opt-in, on Postgres — without wiring any of them into the running app.

**Architecture:** One module per store under `apps/backend/src/sql/`, each a thin struct holding an `AnyPool` clone. Every store serialises the SDK's own types rather than inventing DTOs: `ChannelRecord` and `SecretValue` through serde (enabled by the `serde` feature in Phase 3), `StateItem` through the SDK's `StateItemRecord`/`StateKeyRecord`, and `UserSecrets` through a backend-local row type that prost-encodes its non-serde parts. `Share` maps straight to columns. Nothing in `actor.rs` or `state.rs` changes: `build_protocol` still constructs the in-memory stores at the end of this plan, and `stores.rs` is untouched. That cutover is Phase 4b.

**Tech Stack:** Rust, `sqlx` 0.8 over `AnyPool` (SQLite + Postgres), `derec-library` 0.0.4 with `serde`, `prost` 0.14, `base64` 0.22, `serde_json`.

**Spec:** `docs/superpowers/specs/2026-09-21-docker-packaging-design.md` — "Persistence" (line 279) and "Implementation order" item 4 (line 750).

## Global Constraints

- **Phase 4a only — no cutover.** `build_protocol` (`actor.rs:137`) keeps constructing `InMemory*` stores. `ActorProtocol` (`stores.rs:457`) keeps naming them. `stores.rs` is **not** deleted and **not** edited. If you are editing `actor.rs`, you have left this plan.
- **Baseline entering this plan:** backend `cargo test` = **184 passing, 15 suites, 0 failures, 0 warnings**. Frontend `npx vitest run` = **408 passing**. Every task must leave both at or above these numbers.
- **The conformance suite is the specification.** `src/conformance.rs` already exists and was demonstrated to fail when partitioning was broken. Do **not** edit it to accommodate a SQL store. If a store cannot pass an assertion, the store is wrong — or the assertion describes something the protocol does not require, in which case say so and stop rather than weakening it.
- **Every `u64` id is decimal-encoded `TEXT`.** Use the shared `id_to_text` / `text_to_id` helpers from Task 1 — never `as i64`.
- **Binary is base64 `TEXT`.** Never a blob type.
- **One SQL dialect for both engines.** No `INSERT OR REPLACE`, no `ON CONFLICT ... DO UPDATE` with engine-specific syntax, no `RETURNING`, no backticks. Upsert is delete-then-insert inside a transaction (see Task 1).
- **`AnyPool` binds only `AnyValue` types.** `i64`, `f64`, `String`, `bool`, `Vec<u8>`. There is no `u64` binding and no `u32` binding — bind counts and versions as `i64` and convert.
- **No `unwrap()` / `expect()` in production paths.** Store methods return `Result`; map every failure to the matching `*StoreError::Backend`. Test code may use them.
- **The uniformity constraint.** No column or code path distinguishes a provisioned actor from a real one.
- **Do not commit `docs/`.** 
- **The user commits.** Do **not** run `git commit`, `git add` or `git stash`. Each task ends with a verification step and the list of files it touched; the user reviews and commits.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/backend/src/sql/mod.rs` | module root, shared helpers, upsert pattern | **new** |
| `apps/backend/src/sql/channel.rs` | `SqlChannelStore` | **new** |
| `apps/backend/src/sql/secret.rs` | `SqlSecretStore` | **new** |
| `apps/backend/src/sql/share.rs` | `SqlShareStore` | **new** |
| `apps/backend/src/sql/user_secret.rs` | `SqlUserSecretStore` | **new** |
| `apps/backend/src/sql/state.rs` | `SqlStateStore` | **new** |
| `apps/backend/src/lib.rs` | `pub mod sql;` | modify |
| `apps/backend/src/conformance.rs` | engine-parameterised runner | modify |
| `apps/backend/tests/sql_stores.rs` | the five stores on SQLite + opt-in Postgres | **new** |
| `apps/backend/Cargo.toml` | `base64` is already a dependency — verify only | verify |

One file per store rather than one `sql.rs`: each is 100–200 lines of query plus its serialisation decisions, they change independently, and Phase 4b deletes `stores.rs` but touches none of these.

---

## Task 1: The SQL module and its shared helpers

Everything the five stores need in common: id encoding, base64, error mapping, and the one upsert shape that works on both engines.

**Files:**
- Create: `apps/backend/src/sql/mod.rs`
- Modify: `apps/backend/src/lib.rs`

**Interfaces:**
- Consumes: `db::connect` from Phase 3.
- Produces:
  - `pub fn id_to_text(id: u64) -> String`
  - `pub fn text_to_id(text: &str) -> Result<u64, ParseIdError>`
  - `pub fn to_base64(bytes: &[u8]) -> String`
  - `pub fn from_base64(text: &str) -> Result<Vec<u8>, base64::DecodeError>`
  - Tasks 2–6 use all four.

- [ ] **Step 1: Confirm `base64` is available**

Run: `cd apps/backend && rg -n '^base64' Cargo.toml`
Expected: `base64 = "0.22"`. It is already a dependency — do not add it again.

- [ ] **Step 2: Write the failing tests**

Create `apps/backend/src/sql/mod.rs`:

```rust
//! SQL-backed implementations of the SDK store traits.
//!
//! One struct per store, each holding a clone of the process `AnyPool`. The
//! pool is itself a handle — cloning is cheap and every clone shares the same
//! connections — so an actor owning its stores costs nothing beyond the struct.
//!
//! # Why the queries look repetitive
//!
//! One dialect has to run on SQLite and Postgres unmodified. That rules out
//! `INSERT OR REPLACE` (SQLite only), `ON CONFLICT DO UPDATE` with differing
//! syntax, and `RETURNING`. Upsert is therefore `DELETE` then `INSERT` inside a
//! transaction, which both engines accept and which matches the in-memory
//! stores' `HashMap::insert` semantics exactly.
//!
//! # Why ids are strings
//!
//! Every `secret_id`, `channel_id` and `replica_id` is a `u64`. `AnyPool` binds
//! `i64` and has no unsigned type, and an `i64` bit-cast makes ordering and
//! equality wrong above `i64::MAX` while staying invisible below it. They are
//! decimal-encoded `TEXT` instead — the same decision the HTTP layer already
//! made for `Actor::secret_id`.

pub mod channel;
pub mod secret;
pub mod share;
pub mod state;
pub mod user_secret;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_above_i64_max_round_trips_exactly() {
        // The whole reason ids are TEXT. Bit-cast to i64 this comes back
        // negative; decimal-encoded it comes back itself.
        let id = u64::MAX - 7;

        assert_eq!(text_to_id(&id_to_text(id)).expect("parses"), id);
    }

    #[test]
    fn ordinary_ids_round_trip_too() {
        for id in [0u64, 1, 5000, u64::MAX] {
            assert_eq!(text_to_id(&id_to_text(id)).expect("parses"), id, "id {id}");
        }
    }

    #[test]
    fn a_non_numeric_id_is_an_error_rather_than_a_silent_zero() {
        // A row whose id column has been corrupted must surface, not decode to
        // secret 0 and quietly read another partition.
        assert!(text_to_id("").is_err());
        assert!(text_to_id("not-a-number").is_err());
        assert!(text_to_id("-1").is_err());
    }

    #[test]
    fn binary_round_trips_through_base64_including_edge_bytes() {
        for bytes in [
            vec![],
            vec![0x00],
            vec![0xff],
            vec![0x00, 0xff, 0x00, 0xff],
            (0u8..=255).collect::<Vec<u8>>(),
        ] {
            assert_eq!(
                from_base64(&to_base64(&bytes)).expect("decodes"),
                bytes,
                "failed for {} bytes",
                bytes.len()
            );
        }
    }

    #[test]
    fn malformed_base64_is_an_error() {
        assert!(from_base64("!!!not base64!!!").is_err());
    }
}
```

Add to `apps/backend/src/lib.rs`, beside `pub mod db;`:

```rust
pub mod sql;
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd apps/backend && cargo test --lib sql 2>&1 | tail -10`
Expected: compile errors — the helpers and the five submodules do not exist.

Create the five submodule files as empty placeholders so the module tree resolves; each task below fills one in:

```bash
cd apps/backend/src/sql && touch channel.rs secret.rs share.rs state.rs user_secret.rs
```

Re-run: still fails on the four missing helpers. That is the state to implement against.

- [ ] **Step 4: Implement the helpers**

Add to `apps/backend/src/sql/mod.rs`, above `mod tests`:

```rust
use base64::Engine as _;

/// Decimal-encode a `u64` id for a `TEXT` column.
pub fn id_to_text(id: u64) -> String {
    id.to_string()
}

/// Why an id column could not be read back.
#[derive(Debug, thiserror::Error)]
#[error("{value:?} is not a valid id")]
pub struct ParseIdError {
    value: String,
}

/// Read a `u64` id back out of a `TEXT` column.
///
/// An error rather than a default: a corrupted id that decoded to `0` would
/// silently read another partition, which is the one failure mode the
/// partitioning assertions in the conformance suite exist to catch.
pub fn text_to_id(text: &str) -> Result<u64, ParseIdError> {
    text.parse::<u64>().map_err(|_| ParseIdError {
        value: text.to_owned(),
    })
}

/// Encode binary for a `TEXT` column.
pub fn to_base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Decode binary from a `TEXT` column.
pub fn from_base64(text: &str) -> Result<Vec<u8>, base64::DecodeError> {
    base64::engine::general_purpose::STANDARD.decode(text)
}
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/backend && cargo test --lib sql 2>&1 | grep "test result"`
Expected: `test result: ok. 5 passed`

- [ ] **Step 6: Full suite**

Run: `cd apps/backend && cargo test 2>&1 | grep -cE "^test result: ok"`
Expected: `15`, no `FAILED`, no warnings.

- [ ] **Step 7: Report, do not commit**

Files touched: `apps/backend/src/sql/mod.rs`, the five empty submodule files, `apps/backend/src/lib.rs`.

---

## Task 2: Engine-parameterised conformance

Before any store exists, teach the test harness to run the suite against a given pool, on SQLite always and Postgres when asked. Every store task below plugs into this.

**Files:**
- Create: `apps/backend/tests/sql_stores.rs`

**Interfaces:**
- Consumes: `db::connect`, `conformance::*` .
- Produces: the harness Tasks 3–7 add cases to.

- [ ] **Step 1: Write the harness with one failing case**

Create `apps/backend/tests/sql_stores.rs`:

```rust
//! The conformance suite against the SQL stores, on every engine available.
//!
//! SQLite always — it is compiled into the binary, so it needs no service.
//! Postgres only when `TEST_DATABASE_URL` names a reachable database, and it
//! prints a skip otherwise: nobody should need a Postgres running to work on
//! this repo. That is the same bargain `tests/proto_drift.rs` already makes.
//!
//! Each case gets a *fresh* database. The conformance functions assume an empty
//! store and leave it dirty, so sharing one would make results depend on order.

use derec_backend::conformance;
use derec_backend::db;
use derec_backend::sql::{
    channel::SqlChannelStore, secret::SqlSecretStore, share::SqlShareStore,
    state::SqlStateStore, user_secret::SqlUserSecretStore,
};
use derec_library::protocol::StateItem;
use derec_library::types::ChannelId;

/// A distinct `PendingVerification` item per `n` — the same factory
/// `tests/store_conformance.rs` uses against the in-memory stores, so both
/// engines and both implementations are judged on identical input.
fn state_item(n: u64) -> StateItem {
    StateItem::PendingVerification {
        channel_id: ChannelId(n),
        request: derec_proto::VerifyShareRequestMessage::default(),
    }
}

/// Every engine this run can reach.
///
/// Returns `(label, url)`. SQLite in-memory is always present; the pool is
/// capped at one connection for it, which `db::connect` handles.
fn engines() -> Vec<(&'static str, String)> {
    let mut out = vec![("sqlite", "sqlite::memory:".to_owned())];

    match std::env::var("TEST_DATABASE_URL") {
        Ok(url) if !url.trim().is_empty() => out.push(("postgres", url)),
        _ => eprintln!(
            "SKIPPED postgres: set TEST_DATABASE_URL to a reachable database to \
             run the suite on it as well."
        ),
    }
    out
}

/// Run `body` against a fresh pool for every reachable engine.
///
/// Postgres keeps its tables between runs, so each case drops and re-applies
/// the schema; SQLite in-memory is fresh by construction and the drop is a
/// harmless no-op on a database that has just been created.
async fn on_every_engine<F, Fut>(body: F)
where
    F: Fn(sqlx::AnyPool) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    for (label, url) in engines() {
        let pool = db::connect(&url)
            .await
            .unwrap_or_else(|e| panic!("{label}: connect failed: {e}"));

        reset(&pool).await;

        eprintln!("running against {label}");
        body(pool).await;
    }
}

/// Empty every table, so one engine's leftovers cannot pass another's run.
async fn reset(pool: &sqlx::AnyPool) {
    for table in [
        "channels",
        "channel_links",
        "secrets",
        "user_secrets",
        "shares",
        "state_items",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("clearing {table}: {e}"));
    }
}

#[tokio::test]
async fn the_sql_channel_store_conforms() {
    on_every_engine(|pool| async move {
        let mut store = SqlChannelStore::new(pool);
        conformance::channel_store_conforms(&mut store).await;
    })
    .await;
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/backend && cargo test --test sql_stores 2>&1 | tail -10`
Expected: a compile error naming `SqlChannelStore` — it does not exist yet. That is Task 3.

- [ ] **Step 3: Report, do not commit**

Files touched: `apps/backend/tests/sql_stores.rs`. It does not compile until Task 3 lands; that is expected and is why the two tasks are adjacent.

---

## Task 3: `SqlChannelStore`

The largest of the five: two record kinds in one table, plus the bidirectional link graph.

**Files:**
- Modify: `apps/backend/src/sql/channel.rs`

**Interfaces:**
- Consumes: the helpers from Task 1, the harness from Task 2.
- Produces: `pub struct SqlChannelStore` with `pub fn new(pool: sqlx::AnyPool) -> Self`.

- [ ] **Step 1: Implement**

Write `apps/backend/src/sql/channel.rs`:

```rust
//! `DeRecChannelStore` over SQL.
//!
//! Helper channels and replica-group members share the `channels` table,
//! discriminated by `kind` and keyed by `entity_id`: a helper by its
//! `channel_id`, a member by its `replica_id` alone. That asymmetry is not an
//! optimisation — a member moves between channels during an admission handover
//! while remaining the same member, so a key requiring both to match would lose
//! the row exactly when that move needs to be observed.
//!
//! The record itself is stored as serialised `ChannelRecord`, which derives
//! serde behind the library's `serde` feature. The library owns that shape and
//! versions it (`CHANNEL_RECORD_SCHEMA_VERSION`), so decomposing it into
//! columns here would be this app inventing a schema the SDK already has.

use derec_library::protocol::types::{HelperFilter, ReplicaFilter};
use derec_library::protocol::{
    ChannelQuery, ChannelRecord, ChannelStoreError, ChannelStoreFuture, DeRecChannelStore,
    HelperChannel, ReplicaMember,
};
use derec_library::types::ChannelId;

use super::{id_to_text, text_to_id};

/// Boxes any error into the `Backend` variant the trait expects.
fn backend<E: std::error::Error + Send + Sync + 'static>(e: E) -> ChannelStoreError {
    ChannelStoreError::Backend(Box::new(e))
}

const KIND_HELPER: &str = "helper";
const KIND_REPLICA: &str = "replica";

pub struct SqlChannelStore {
    pool: sqlx::AnyPool,
}

impl SqlChannelStore {
    pub fn new(pool: sqlx::AnyPool) -> Self {
        Self { pool }
    }
}

/// The `(kind, entity_id, channel_id)` a record is keyed and filed under.
fn key_of(record: &ChannelRecord) -> (&'static str, String, String) {
    match record {
        ChannelRecord::Helper(h) => (
            KIND_HELPER,
            id_to_text(h.channel_id.0),
            id_to_text(h.channel_id.0),
        ),
        ChannelRecord::Replica(m) => (
            KIND_REPLICA,
            id_to_text(m.replica_id.0),
            id_to_text(m.channel_id.0),
        ),
    }
}

/// The `(kind, entity_id)` a query selects.
fn key_of_query(query: &ChannelQuery) -> (&'static str, String) {
    match query {
        ChannelQuery::Helper { channel_id } => (KIND_HELPER, id_to_text(channel_id.0)),
        // Keyed by `replica_id` alone — `channel_id` is context, not key.
        ChannelQuery::Replica { replica_id, .. } => (KIND_REPLICA, id_to_text(replica_id.0)),
    }
}

impl DeRecChannelStore for SqlChannelStore {
    fn load(
        &self,
        secret_id: u64,
        query: ChannelQuery,
    ) -> ChannelStoreFuture<'_, Option<ChannelRecord>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let (kind, entity) = key_of_query(&query);

        Box::pin(async move {
            let row: Option<(String,)> = sqlx::query_as(
                "SELECT record FROM channels \
                 WHERE secret_id = $1 AND kind = $2 AND entity_id = $3",
            )
            .bind(secret)
            .bind(kind)
            .bind(entity)
            .fetch_optional(&pool)
            .await
            .map_err(backend)?;

            match row {
                Some((json,)) => {
                    let record: ChannelRecord = serde_json::from_str(&json).map_err(backend)?;
                    Ok(Some(record))
                }
                None => Ok(None),
            }
        })
    }

    fn save(&mut self, secret_id: u64, record: ChannelRecord) -> ChannelStoreFuture<'_, ()> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let (kind, entity, channel) = key_of(&record);

        Box::pin(async move {
            let json = serde_json::to_string(&record).map_err(backend)?;

            // Delete-then-insert rather than an upsert: it is the one shape
            // both engines accept unmodified, and it matches the in-memory
            // store's `HashMap::insert` — replace in place, never duplicate.
            let mut tx = pool.begin().await.map_err(backend)?;

            sqlx::query(
                "DELETE FROM channels WHERE secret_id = $1 AND kind = $2 AND entity_id = $3",
            )
            .bind(&secret)
            .bind(kind)
            .bind(&entity)
            .execute(&mut *tx)
            .await
            .map_err(backend)?;

            sqlx::query(
                "INSERT INTO channels (secret_id, kind, entity_id, channel_id, record) \
                 VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(&secret)
            .bind(kind)
            .bind(&entity)
            .bind(&channel)
            .bind(&json)
            .execute(&mut *tx)
            .await
            .map_err(backend)?;

            tx.commit().await.map_err(backend)?;
            Ok(())
        })
    }

    fn remove(&mut self, secret_id: u64, query: ChannelQuery) -> ChannelStoreFuture<'_, bool> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let (kind, entity) = key_of_query(&query);

        Box::pin(async move {
            let result = sqlx::query(
                "DELETE FROM channels WHERE secret_id = $1 AND kind = $2 AND entity_id = $3",
            )
            .bind(secret)
            .bind(kind)
            .bind(entity)
            .execute(&pool)
            .await
            .map_err(backend)?;

            // The trait reports whether anything was removed, which the
            // protocol uses to distinguish a teardown from a no-op.
            Ok(result.rows_affected() > 0)
        })
    }

    fn helpers(
        &self,
        secret_id: u64,
        filter: HelperFilter,
    ) -> ChannelStoreFuture<'_, Vec<HelperChannel>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);

        Box::pin(async move {
            let rows: Vec<(String,)> =
                sqlx::query_as("SELECT record FROM channels WHERE secret_id = $1 AND kind = $2")
                    .bind(secret)
                    .bind(KIND_HELPER)
                    .fetch_all(&pool)
                    .await
                    .map_err(backend)?;

            let mut out = Vec::with_capacity(rows.len());
            for (json,) in rows {
                match serde_json::from_str::<ChannelRecord>(&json).map_err(backend)? {
                    ChannelRecord::Helper(h) => out.push(h),
                    // A replica record filed under kind 'helper' is a bug in
                    // this store, not data to skip quietly.
                    ChannelRecord::Replica(_) => {
                        return Err(ChannelStoreError::Backend(
                            "replica record stored under kind 'helper'".into(),
                        ));
                    }
                }
            }

            // The library narrows a listing with a filter and does *not*
            // re-apply it to the result, so a store that ignored it would hand
            // the protocol rows it asked to be spared.
            out.retain(|h| filter.matches(&h.channel_id, h.status, &h.peer_role));
            Ok(out)
        })
    }

    fn replicas(
        &self,
        secret_id: u64,
        filter: ReplicaFilter,
    ) -> ChannelStoreFuture<'_, Vec<ReplicaMember>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);

        Box::pin(async move {
            // Ordered by the member id so a successor choice is reproducible
            // across runs — the in-memory store uses a `BTreeMap` for the same
            // reason, and an unordered scan would reintroduce the variance it
            // was chosen to remove.
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT record FROM channels \
                 WHERE secret_id = $1 AND kind = $2 ORDER BY entity_id",
            )
            .bind(secret)
            .bind(KIND_REPLICA)
            .fetch_all(&pool)
            .await
            .map_err(backend)?;

            let mut out = Vec::with_capacity(rows.len());
            for (json,) in rows {
                match serde_json::from_str::<ChannelRecord>(&json).map_err(backend)? {
                    ChannelRecord::Replica(m) => out.push(m),
                    ChannelRecord::Helper(_) => {
                        return Err(ChannelStoreError::Backend(
                            "helper record stored under kind 'replica'".into(),
                        ));
                    }
                }
            }

            // `ORDER BY entity_id` is lexicographic on TEXT, so re-sort
            // numerically: '9' sorts after '10' as text but before it as a
            // number, and the in-memory `BTreeMap<u64>` orders numerically.
            out.sort_by_key(|m| m.replica_id.0);

            out.retain(|m| filter.matches(&m.replica_id, m.status, &m.role));
            Ok(out)
        })
    }

    fn link_channel(
        &mut self,
        secret_id: u64,
        a: ChannelId,
        b: ChannelId,
    ) -> ChannelStoreFuture<'_, ()> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let (a, b) = (id_to_text(a.0), id_to_text(b.0));

        Box::pin(async move {
            // Both directions, so `linked_channels` can start from either end.
            let mut tx = pool.begin().await.map_err(backend)?;

            for (from, to) in [(&a, &b), (&b, &a)] {
                sqlx::query(
                    "DELETE FROM channel_links \
                     WHERE secret_id = $1 AND channel_id = $2 AND linked_id = $3",
                )
                .bind(&secret)
                .bind(from)
                .bind(to)
                .execute(&mut *tx)
                .await
                .map_err(backend)?;

                sqlx::query(
                    "INSERT INTO channel_links (secret_id, channel_id, linked_id) \
                     VALUES ($1, $2, $3)",
                )
                .bind(&secret)
                .bind(from)
                .bind(to)
                .execute(&mut *tx)
                .await
                .map_err(backend)?;
            }

            tx.commit().await.map_err(backend)?;
            Ok(())
        })
    }

    fn linked_channels(
        &self,
        secret_id: u64,
        channel_id: ChannelId,
    ) -> ChannelStoreFuture<'_, Vec<ChannelId>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let start = id_to_text(channel_id.0);

        Box::pin(async move {
            // A BFS over the link graph, matching the in-memory store: links
            // are transitive, so a channel linked to one that is linked to a
            // third reaches all of them. Done here rather than in SQL because a
            // recursive CTE is not portable across both engines in one
            // spelling.
            let mut seen = std::collections::HashSet::new();
            let mut queue = std::collections::VecDeque::new();
            let mut out = Vec::new();

            seen.insert(start.clone());
            queue.push_back(start);

            while let Some(current) = queue.pop_front() {
                let rows: Vec<(String,)> = sqlx::query_as(
                    "SELECT linked_id FROM channel_links \
                     WHERE secret_id = $1 AND channel_id = $2",
                )
                .bind(&secret)
                .bind(&current)
                .fetch_all(&pool)
                .await
                .map_err(backend)?;

                for (linked,) in rows {
                    if seen.insert(linked.clone()) {
                        out.push(text_to_id(&linked).map_err(backend)?);
                        queue.push_back(linked);
                    }
                }
            }

            out.sort_unstable();
            Ok(out.into_iter().map(ChannelId).collect())
        })
    }
}
```

- [ ] **Step 2: Run the conformance case**

Run: `cd apps/backend && cargo test --test sql_stores 2>&1 | tail -15`
Expected: `the_sql_channel_store_conforms` passes, and the run prints
`running against sqlite` plus `SKIPPED postgres: ...` unless `TEST_DATABASE_URL` is set.

If it fails on "channels must be partitioned by secret_id", a query is missing its `secret_id = $1`. If it fails on the duplicate assertion, the delete-then-insert is not in one transaction.

- [ ] **Step 3: Report, do not commit**

Files touched: `apps/backend/src/sql/channel.rs`.

---

## Task 4: `SqlSecretStore`

**Files:**
- Modify: `apps/backend/src/sql/secret.rs`
- Modify: `apps/backend/tests/sql_stores.rs` (add the case)

**Interfaces:**
- Produces: `pub struct SqlSecretStore` with `pub fn new(pool: sqlx::AnyPool) -> Self`.

- [ ] **Step 1: Implement**

Write `apps/backend/src/sql/secret.rs`:

```rust
//! `DeRecSecretStore` over SQL.
//!
//! Keyed by `(secret_id, channel_id, kind)`. `save` takes no `kind` — it is
//! derived from the `SecretValue` variant, which is what keeps a shared key and
//! a pairing secret on the same channel from overwriting one another.
//!
//! `SecretValue` derives serde behind the library's `serde` feature, so the
//! value is stored as the library's own shape rather than a DTO this app
//! invents.

use derec_library::protocol::{
    DeRecSecretStore, SecretKind, SecretStoreError, SecretStoreFuture, SecretValue,
};
use derec_library::types::ChannelId;

use super::id_to_text;

fn backend<E: std::error::Error + Send + Sync + 'static>(e: E) -> SecretStoreError {
    SecretStoreError::Backend(Box::new(e))
}

/// The `kind` column value for a variant. Written out rather than derived from
/// the discriminant so the rows stay readable to a developer with `sqlite3`.
fn kind_text(kind: SecretKind) -> &'static str {
    match kind {
        SecretKind::SharedKey => "shared_key",
        SecretKind::PairingSecret => "pairing_secret",
        SecretKind::PairingContact => "pairing_contact",
    }
}

/// The `kind` a value will be filed under.
fn kind_of(value: &SecretValue) -> SecretKind {
    match value {
        SecretValue::SharedKey(_) => SecretKind::SharedKey,
        SecretValue::PairingSecret(_) => SecretKind::PairingSecret,
        SecretValue::PairingContact(_) => SecretKind::PairingContact,
    }
}

pub struct SqlSecretStore {
    pool: sqlx::AnyPool,
}

impl SqlSecretStore {
    pub fn new(pool: sqlx::AnyPool) -> Self {
        Self { pool }
    }
}

impl DeRecSecretStore for SqlSecretStore {
    fn load(
        &self,
        secret_id: u64,
        channel_id: ChannelId,
        kind: SecretKind,
    ) -> SecretStoreFuture<'_, Option<SecretValue>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let channel = id_to_text(channel_id.0);
        let kind = kind_text(kind);

        Box::pin(async move {
            let row: Option<(String,)> = sqlx::query_as(
                "SELECT value FROM secrets \
                 WHERE secret_id = $1 AND channel_id = $2 AND kind = $3",
            )
            .bind(secret)
            .bind(channel)
            .bind(kind)
            .fetch_optional(&pool)
            .await
            .map_err(backend)?;

            match row {
                Some((json,)) => Ok(Some(serde_json::from_str(&json).map_err(backend)?)),
                None => Ok(None),
            }
        })
    }

    fn save(
        &mut self,
        secret_id: u64,
        channel_id: ChannelId,
        value: SecretValue,
    ) -> SecretStoreFuture<'_, ()> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let channel = id_to_text(channel_id.0);
        let kind = kind_text(kind_of(&value));

        Box::pin(async move {
            let json = serde_json::to_string(&value).map_err(backend)?;

            let mut tx = pool.begin().await.map_err(backend)?;

            sqlx::query(
                "DELETE FROM secrets WHERE secret_id = $1 AND channel_id = $2 AND kind = $3",
            )
            .bind(&secret)
            .bind(&channel)
            .bind(kind)
            .execute(&mut *tx)
            .await
            .map_err(backend)?;

            sqlx::query(
                "INSERT INTO secrets (secret_id, channel_id, kind, value) \
                 VALUES ($1, $2, $3, $4)",
            )
            .bind(&secret)
            .bind(&channel)
            .bind(kind)
            .bind(&json)
            .execute(&mut *tx)
            .await
            .map_err(backend)?;

            tx.commit().await.map_err(backend)?;
            Ok(())
        })
    }

    fn remove(
        &mut self,
        secret_id: u64,
        channel_id: ChannelId,
        kind: SecretKind,
    ) -> SecretStoreFuture<'_, ()> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let channel = id_to_text(channel_id.0);
        let kind = kind_text(kind);

        Box::pin(async move {
            sqlx::query(
                "DELETE FROM secrets WHERE secret_id = $1 AND channel_id = $2 AND kind = $3",
            )
            .bind(secret)
            .bind(channel)
            .bind(kind)
            .execute(&pool)
            .await
            .map_err(backend)?;

            // Idempotent by contract: removing an absent secret is not an error.
            Ok(())
        })
    }
}
```

`DeRecSecretStore` also declares `load_many`, which carries the one piece of
behaviour in this store that is not a plain lookup — `MissingPolicy`. Add it to
the same `impl`:

```rust
    fn load_many(
        &self,
        secret_id: u64,
        channel_ids: &[ChannelId],
        kind: SecretKind,
        missing_policy: MissingPolicy,
    ) -> SecretStoreFuture<'_, Vec<(ChannelId, SecretValue)>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let kind_col = kind_text(kind);
        // Copied out of the borrowed slice: the future outlives the call. The
        // request order is preserved because the protocol pairs the result
        // against the channels it asked for.
        let wanted: Vec<ChannelId> = channel_ids.to_vec();

        Box::pin(async move {
            let mut found = Vec::with_capacity(wanted.len());
            let mut missing = Vec::new();

            // One query per channel rather than an `IN` list: the result has to
            // distinguish present from absent per channel to honour
            // `MissingPolicy`, and these lists are the size of a helper set.
            for cid in &wanted {
                let row: Option<(String,)> = sqlx::query_as(
                    "SELECT value FROM secrets \
                     WHERE secret_id = $1 AND channel_id = $2 AND kind = $3",
                )
                .bind(&secret)
                .bind(id_to_text(cid.0))
                .bind(kind_col)
                .fetch_optional(&pool)
                .await
                .map_err(backend)?;

                match row {
                    Some((json,)) => {
                        found.push((*cid, serde_json::from_str(&json).map_err(backend)?))
                    }
                    None => missing.push(cid.0),
                }
            }

            // `Fail` is not decoration: the caller uses it to refuse a round
            // rather than silently proceed with a short set of helpers.
            match missing_policy {
                MissingPolicy::Skip => Ok(found),
                MissingPolicy::Fail if missing.is_empty() => Ok(found),
                MissingPolicy::Fail => Err(SecretStoreError::MissingEntries {
                    kind,
                    channel_ids: missing,
                }),
            }
        })
    }
```

Add `MissingPolicy` to the `derec_library::protocol` import list.

- [ ] **Step 2: Add the conformance case**

Append to `apps/backend/tests/sql_stores.rs`:

```rust
#[tokio::test]
async fn the_sql_secret_store_conforms() {
    on_every_engine(|pool| async move {
        let mut store = SqlSecretStore::new(pool);
        conformance::secret_store_conforms(&mut store).await;
    })
    .await;
}
```

- [ ] **Step 3: Run it**

Run: `cd apps/backend && cargo test --test sql_stores 2>&1 | grep -E "test result|FAILED"`
Expected: 2 passed.

- [ ] **Step 4: Report, do not commit**

Files touched: `apps/backend/src/sql/secret.rs`, `apps/backend/tests/sql_stores.rs`.

---

## Task 5: `SqlShareStore`

**Files:**
- Modify: `apps/backend/src/sql/share.rs`
- Modify: `apps/backend/tests/sql_stores.rs`

**Interfaces:**
- Produces: `pub struct SqlShareStore` with `pub fn new(pool: sqlx::AnyPool) -> Self`.

- [ ] **Step 1: Implement**

Write `apps/backend/src/sql/share.rs`. `Share` has public scalar fields (`secret_id: u64`, `version: u32`, `bytes: Vec<u8>`) and maps straight to columns; the channel comes from the method argument. Key is `(secret_id, channel_id, version)` — there is **no** replica column, because `save` takes no replica.

```rust
//! `DeRecShareStore` over SQL.
//!
//! `bytes` is base64 `TEXT` rather than a blob type, which neither engine
//! spells the same way. `version` is bound as `i64` because `AnyPool` has no
//! `u32` binding, and converted back on read.

use derec_library::protocol::{DeRecShareStore, Share, ShareStoreError, ShareStoreFuture};
use derec_library::types::ChannelId;

use super::{from_base64, id_to_text, to_base64};

fn backend<E: std::error::Error + Send + Sync + 'static>(e: E) -> ShareStoreError {
    ShareStoreError::Backend(Box::new(e))
}

pub struct SqlShareStore {
    pool: sqlx::AnyPool,
}

impl SqlShareStore {
    pub fn new(pool: sqlx::AnyPool) -> Self {
        Self { pool }
    }
}

/// Turn `(version, bytes)` rows into `Share`s for `secret_id`.
fn to_shares(secret_id: u64, rows: Vec<(i64, String)>) -> Result<Vec<Share>, ShareStoreError> {
    rows.into_iter()
        .map(|(version, encoded)| {
            Ok(Share {
                secret_id,
                // Stored from a u32 and never written any other way, so a
                // value outside u32 means the row was written by something
                // else — an error rather than a truncating cast.
                version: u32::try_from(version).map_err(backend)?,
                bytes: from_base64(&encoded).map_err(backend)?,
            })
        })
        .collect()
}

impl DeRecShareStore for SqlShareStore {
    fn load(
        &self,
        secret_id: u64,
        channel_id: ChannelId,
        versions: &[u32],
    ) -> ShareStoreFuture<'_, Vec<Share>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let channel = id_to_text(channel_id.0);
        // Copied out of the borrowed slice: the future outlives the call.
        let versions: Vec<i64> = versions.iter().map(|v| i64::from(*v)).collect();

        Box::pin(async move {
            // An empty filter means "every version", matching the in-memory
            // store — not "no versions", which an `IN ()` would mean.
            let rows: Vec<(i64, String)> = if versions.is_empty() {
                sqlx::query_as(
                    "SELECT version, bytes FROM shares WHERE secret_id = $1 AND channel_id = $2",
                )
                .bind(&secret)
                .bind(&channel)
                .fetch_all(&pool)
                .await
                .map_err(backend)?
            } else {
                // Built rather than bound as an array: `AnyPool` has no array
                // binding, and the values are `i64`s this function produced,
                // never operator input.
                let list = versions
                    .iter()
                    .map(|v| v.to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                sqlx::query_as(&format!(
                    "SELECT version, bytes FROM shares \
                     WHERE secret_id = $1 AND channel_id = $2 AND version IN ({list})"
                ))
                .bind(&secret)
                .bind(&channel)
                .fetch_all(&pool)
                .await
                .map_err(backend)?
            };

            to_shares(secret_id, rows)
        })
    }

    fn latest_version(&self, secret_id: u64) -> ShareStoreFuture<'_, Option<u32>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);

        Box::pin(async move {
            // MAX over no rows is NULL on both engines, which arrives as None.
            let row: Option<(Option<i64>,)> =
                sqlx::query_as("SELECT MAX(version) FROM shares WHERE secret_id = $1")
                    .bind(secret)
                    .fetch_optional(&pool)
                    .await
                    .map_err(backend)?;

            match row.and_then(|(max,)| max) {
                Some(v) => Ok(Some(u32::try_from(v).map_err(backend)?)),
                None => Ok(None),
            }
        })
    }

    fn save(
        &mut self,
        secret_id: u64,
        channel_id: ChannelId,
        share: Share,
    ) -> ShareStoreFuture<'_, ()> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let channel = id_to_text(channel_id.0);
        let version = i64::from(share.version);
        let bytes = to_base64(&share.bytes);

        Box::pin(async move {
            let mut tx = pool.begin().await.map_err(backend)?;

            sqlx::query(
                "DELETE FROM shares WHERE secret_id = $1 AND channel_id = $2 AND version = $3",
            )
            .bind(&secret)
            .bind(&channel)
            .bind(version)
            .execute(&mut *tx)
            .await
            .map_err(backend)?;

            sqlx::query(
                "INSERT INTO shares (secret_id, channel_id, version, bytes) \
                 VALUES ($1, $2, $3, $4)",
            )
            .bind(&secret)
            .bind(&channel)
            .bind(version)
            .bind(&bytes)
            .execute(&mut *tx)
            .await
            .map_err(backend)?;

            tx.commit().await.map_err(backend)?;
            Ok(())
        })
    }

    fn remove_channel(
        &mut self,
        secret_id: u64,
        channel_id: ChannelId,
    ) -> ShareStoreFuture<'_, ()> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let channel = id_to_text(channel_id.0);

        Box::pin(async move {
            // Every version for the channel. Idempotent; the unpair flow calls
            // it on teardown.
            sqlx::query("DELETE FROM shares WHERE secret_id = $1 AND channel_id = $2")
                .bind(secret)
                .bind(channel)
                .execute(&pool)
                .await
                .map_err(backend)?;
            Ok(())
        })
    }
}
```

`load_many` and `load_all` both take a `&[ChannelId]`. Add them to the same
`impl`, sharing one helper so the three read paths cannot drift:

```rust
/// Render a list of ids as a SQL `IN` list.
///
/// Built rather than bound: `AnyPool` has no array binding. Every value is an
/// id this process encoded, never operator input.
fn in_list(ids: &[String]) -> String {
    ids.iter()
        .map(|id| format!("'{id}'"))
        .collect::<Vec<_>>()
        .join(", ")
}
```

```rust
    fn load_many(
        &self,
        secret_id: u64,
        channel_ids: &[ChannelId],
        versions: &[u32],
    ) -> ShareStoreFuture<'_, Vec<Share>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let channels: Vec<String> = channel_ids.iter().map(|c| id_to_text(c.0)).collect();
        let versions: Vec<i64> = versions.iter().map(|v| i64::from(*v)).collect();

        Box::pin(async move {
            // No channels means no rows — unlike an empty *version* list,
            // which means "every version". The asymmetry matches the
            // in-memory store: it intersects with the channel set, and the
            // empty set intersects to nothing.
            if channels.is_empty() {
                return Ok(Vec::new());
            }

            let channel_list = in_list(&channels);
            let sql = if versions.is_empty() {
                format!(
                    "SELECT version, bytes FROM shares \
                     WHERE secret_id = $1 AND channel_id IN ({channel_list})"
                )
            } else {
                let version_list = versions
                    .iter()
                    .map(|v| v.to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(
                    "SELECT version, bytes FROM shares \
                     WHERE secret_id = $1 AND channel_id IN ({channel_list}) \
                     AND version IN ({version_list})"
                )
            };

            let rows: Vec<(i64, String)> = sqlx::query_as(&sql)
                .bind(&secret)
                .fetch_all(&pool)
                .await
                .map_err(backend)?;

            to_shares(secret_id, rows)
        })
    }

    fn load_all(
        &self,
        secret_id: u64,
        channel_ids: &[ChannelId],
    ) -> ShareStoreFuture<'_, Vec<Share>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let channels: Vec<String> = channel_ids.iter().map(|c| id_to_text(c.0)).collect();

        Box::pin(async move {
            if channels.is_empty() {
                return Ok(Vec::new());
            }

            let channel_list = in_list(&channels);
            let rows: Vec<(i64, String)> = sqlx::query_as(&format!(
                "SELECT version, bytes FROM shares \
                 WHERE secret_id = $1 AND channel_id IN ({channel_list})"
            ))
            .bind(&secret)
            .fetch_all(&pool)
            .await
            .map_err(backend)?;

            to_shares(secret_id, rows)
        })
    }
```

- [ ] **Step 2: Add the conformance case**

```rust
#[tokio::test]
async fn the_sql_share_store_conforms() {
    on_every_engine(|pool| async move {
        let mut store = SqlShareStore::new(pool);
        conformance::share_store_conforms(&mut store).await;
    })
    .await;
}
```

- [ ] **Step 3: Run it**

Run: `cd apps/backend && cargo test --test sql_stores 2>&1 | grep -E "test result|FAILED"`
Expected: 3 passed. The suite's `0xff, 0x00` assertion is what proves the base64 round trip.

- [ ] **Step 4: Report, do not commit**

Files touched: `apps/backend/src/sql/share.rs`, `apps/backend/tests/sql_stores.rs`.

---

## Task 6: `SqlUserSecretStore`

**The one store with a real serialisation decision.** `UserSecrets` derives only `Clone, Debug, PartialEq` — **no serde at all**. Its `secrets: Vec<UserSecret>` and `replicas: Option<Replicas>` are `prost::Message`s.

The SDK's own WASM adapter (`interop/wasm/protocol/stores.rs:816`) hand-maps the fields and **silently drops `replicas`**. Do not copy that. `replicas` is the Owner-side cached replica composite that lets a publish resume without re-deriving share material — dropping it in a store whose entire purpose is surviving a restart would defeat the point. Encode all four fields.

**Files:**
- Modify: `apps/backend/src/sql/user_secret.rs`
- Modify: `apps/backend/tests/sql_stores.rs`

**Interfaces:**
- Produces: `pub struct SqlUserSecretStore` with `pub fn new(pool: sqlx::AnyPool) -> Self`.

- [ ] **Step 1: Write the failing round-trip test**

Add to `apps/backend/src/sql/user_secret.rs` a `mod tests` proving the row type is lossless, before the store exists:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use derec_library::protocol::UserSecrets;

    #[test]
    fn every_field_survives_the_row_encoding_including_replicas() {
        // The SDK's WASM adapter drops `replicas`; this one must not. Without
        // it an Owner cannot resume a publish after a restart without
        // re-deriving share material — which is the thing persistence is for.
        let original = UserSecrets {
            version: 9,
            secrets: vec![derec_library::protocol::UserSecret {
                id: vec![1, 2, 3],
                name: "a name".to_owned(),
                data: vec![0xff, 0x00],
            }],
            description: Some("a description".to_owned()),
            replicas: None,
        };

        let row = UserSecretsRow::from_secrets(&original).expect("encodes");
        let back = row.into_secrets().expect("decodes");

        assert_eq!(back.version, original.version);
        assert_eq!(back.description, original.description);
        assert_eq!(back.secrets.len(), 1);
        assert_eq!(back.secrets[0].name, "a name");
        assert_eq!(
            back.secrets[0].data,
            vec![0xff, 0x00],
            "binary must survive exactly"
        );
    }

    #[test]
    fn an_empty_snapshot_round_trips() {
        let original = UserSecrets {
            version: 0,
            secrets: Vec::new(),
            description: None,
            replicas: None,
        };

        let back = UserSecretsRow::from_secrets(&original)
            .expect("encodes")
            .into_secrets()
            .expect("decodes");

        assert_eq!(back.version, 0);
        assert!(back.secrets.is_empty());
        assert_eq!(back.description, None);
    }
}
```

**Before writing this test, confirm `UserSecret`'s field names** — read `derec-library-0.0.4/src/protocol/types/secret/model.rs:81`. It is a prost message with `id`, `name` and `data`; if the spelling differs, follow the source, not this plan.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/backend && cargo test --lib sql::user_secret 2>&1 | tail -8`
Expected: `cannot find type 'UserSecretsRow'`.

- [ ] **Step 3: Implement the row type and the store**

```rust
//! `DeRecUserSecretStore` over SQL.
//!
//! `UserSecrets` has no serde of its own — unlike `ChannelRecord` and
//! `SecretValue` — and its `secrets` and `replicas` fields are prost messages.
//! So the payload is a small local row type: the scalars directly, the prost
//! parts encoded and base64'd.
//!
//! This deliberately differs from the SDK's WASM adapter, which hand-maps the
//! fields and drops `replicas`. That field is the Owner-side cached replica
//! composite; losing it across a restart forces a re-derivation of share
//! material, which is exactly the cost persistence exists to avoid.

use derec_library::protocol::{
    DeRecUserSecretStore, Replicas, ShareStoreError, ShareStoreFuture, UserSecret, UserSecrets,
};
use prost::Message as _;
use serde::{Deserialize, Serialize};

use super::{from_base64, id_to_text, to_base64};

fn backend<E: std::error::Error + Send + Sync + 'static>(e: E) -> ShareStoreError {
    ShareStoreError::Backend(Box::new(e))
}

/// The stored shape of a `UserSecrets`.
///
/// Prost parts are base64 of their encoded bytes; the scalars are themselves.
#[derive(Serialize, Deserialize)]
struct UserSecretsRow {
    version: u32,
    description: Option<String>,
    secrets: Vec<String>,
    replicas: Option<String>,
}

impl UserSecretsRow {
    fn from_secrets(value: &UserSecrets) -> Result<Self, ShareStoreError> {
        Ok(Self {
            version: value.version,
            description: value.description.clone(),
            secrets: value
                .secrets
                .iter()
                .map(|s| to_base64(&s.encode_to_vec()))
                .collect(),
            replicas: value.replicas.as_ref().map(|r| to_base64(&r.encode_to_vec())),
        })
    }

    fn into_secrets(self) -> Result<UserSecrets, ShareStoreError> {
        let mut secrets = Vec::with_capacity(self.secrets.len());
        for encoded in &self.secrets {
            let bytes = from_base64(encoded).map_err(backend)?;
            secrets.push(UserSecret::decode(bytes.as_slice()).map_err(backend)?);
        }

        let replicas = match &self.replicas {
            Some(encoded) => {
                let bytes = from_base64(encoded).map_err(backend)?;
                Some(Replicas::decode(bytes.as_slice()).map_err(backend)?)
            }
            None => None,
        };

        Ok(UserSecrets {
            version: self.version,
            secrets,
            description: self.description,
            replicas,
        })
    }
}

pub struct SqlUserSecretStore {
    pool: sqlx::AnyPool,
}

impl SqlUserSecretStore {
    pub fn new(pool: sqlx::AnyPool) -> Self {
        Self { pool }
    }
}

impl DeRecUserSecretStore for SqlUserSecretStore {
    fn load_latest(&self, secret_id: u64) -> ShareStoreFuture<'_, Option<UserSecrets>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);

        Box::pin(async move {
            let row: Option<(String,)> =
                sqlx::query_as("SELECT payload FROM user_secrets WHERE secret_id = $1")
                    .bind(secret)
                    .fetch_optional(&pool)
                    .await
                    .map_err(backend)?;

            match row {
                Some((json,)) => {
                    let row: UserSecretsRow = serde_json::from_str(&json).map_err(backend)?;
                    Ok(Some(row.into_secrets()?))
                }
                None => Ok(None),
            }
        })
    }

    fn save_latest(&mut self, secret_id: u64, value: UserSecrets) -> ShareStoreFuture<'_, ()> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);

        Box::pin(async move {
            let json =
                serde_json::to_string(&UserSecretsRow::from_secrets(&value)?).map_err(backend)?;

            // Replace, never accumulate: there is one current snapshot per
            // secret, which is what "latest" means.
            let mut tx = pool.begin().await.map_err(backend)?;

            sqlx::query("DELETE FROM user_secrets WHERE secret_id = $1")
                .bind(&secret)
                .execute(&mut *tx)
                .await
                .map_err(backend)?;

            sqlx::query("INSERT INTO user_secrets (secret_id, payload) VALUES ($1, $2)")
                .bind(&secret)
                .bind(&json)
                .execute(&mut *tx)
                .await
                .map_err(backend)?;

            tx.commit().await.map_err(backend)?;
            Ok(())
        })
    }

    fn remove(&mut self, secret_id: u64) -> ShareStoreFuture<'_, ()> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);

        Box::pin(async move {
            sqlx::query("DELETE FROM user_secrets WHERE secret_id = $1")
                .bind(secret)
                .execute(&pool)
                .await
                .map_err(backend)?;
            Ok(())
        })
    }
}
```

**If `Replicas` and `UserSecret` are not re-exported from `derec_library::protocol`,** import them from `derec_library::protocol::types` — `types/mod.rs:28` re-exports both.

- [ ] **Step 4: Run the unit tests and the conformance case**

Add to `apps/backend/tests/sql_stores.rs`:

```rust
#[tokio::test]
async fn the_sql_user_secret_store_conforms() {
    on_every_engine(|pool| async move {
        let mut store = SqlUserSecretStore::new(pool);
        conformance::user_secret_store_conforms(&mut store).await;
    })
    .await;
}
```

Run: `cd apps/backend && cargo test --lib sql::user_secret 2>&1 | grep "test result"`
Expected: 2 passed.

Run: `cd apps/backend && cargo test --test sql_stores 2>&1 | grep -E "test result|FAILED"`
Expected: 4 passed.

- [ ] **Step 5: Report, do not commit**

Files touched: `apps/backend/src/sql/user_secret.rs`, `apps/backend/tests/sql_stores.rs`.

---

## Task 7: `SqlStateStore`

**Files:**
- Modify: `apps/backend/src/sql/state.rs`
- Modify: `apps/backend/tests/sql_stores.rs`

**Interfaces:**
- Produces: `pub struct SqlStateStore` with `pub fn new(pool: sqlx::AnyPool) -> Self`.

- [ ] **Step 1: Implement**

`StateItem` has no serde and round-trips through the SDK's `StateItemRecord`; the key round-trips through `StateKeyRecord`. This is the pattern the SDK's own WASM adapter uses (`interop/wasm/protocol/stores.rs:1020`): `StateItemRecord::from(&item)` out, `record.into_item()` back.

```rust
//! `DeRecStateStore` over SQL.
//!
//! `StateItem` has no serde of its own, so it round-trips through the SDK's
//! `StateItemRecord` — the same route the library's own WASM store adapter
//! takes, which is what makes this the endorsed path rather than a workaround.
//! The key is the serialised `StateKeyRecord`; `kind` is denormalised beside it
//! so `load_all` can filter without deserialising every row.

use derec_library::protocol::types::{StateItemRecord, StateKeyRecord};
use derec_library::protocol::{
    DeRecStateStore, StateItem, StateKey, StateKind, StateStoreError, StateStoreFuture,
};

use super::id_to_text;

fn backend<E: std::error::Error + Send + Sync + 'static>(e: E) -> StateStoreError {
    StateStoreError::Backend(Box::new(e))
}

/// A message-only backend error, for the conversions that report a `String`.
fn backend_msg(message: impl Into<String>) -> StateStoreError {
    StateStoreError::Backend(message.into().into())
}

/// The `state_key` column value for a key.
fn key_text(key: &StateKey) -> Result<String, StateStoreError> {
    serde_json::to_string(&StateKeyRecord::from(key)).map_err(backend)
}

/// The `kind` column value. Written out rather than a discriminant so a
/// developer reading rows with `sqlite3` can tell what they are looking at.
///
/// Exhaustive on purpose, with no catch-all arm: if the SDK adds a variant,
/// this must fail to compile rather than file the new kind under a wrong
/// string and make `load_all` silently return the wrong set. `StateKind` is
/// `Copy`, so it is taken by value.
fn kind_text(kind: StateKind) -> &'static str {
    match kind {
        StateKind::PendingVerification => "pending_verification",
        StateKind::PendingRecovery => "pending_recovery",
        StateKind::PendingUnpair => "pending_unpair",
        StateKind::SharingRound => "sharing_round",
        StateKind::PendingReplicaDiscovery => "pending_replica_discovery",
    }
}

pub struct SqlStateStore {
    pool: sqlx::AnyPool,
}

impl SqlStateStore {
    pub fn new(pool: sqlx::AnyPool) -> Self {
        Self { pool }
    }
}

impl DeRecStateStore for SqlStateStore {
    fn save(&mut self, secret_id: u64, item: StateItem) -> StateStoreFuture<'_, ()> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);

        Box::pin(async move {
            // The key comes from the item, never from an argument.
            let key = item.key();
            let key_col = key_text(&key)?;
            let kind_col = kind_text(key.kind());
            let payload =
                serde_json::to_string(&StateItemRecord::from(&item)).map_err(backend)?;

            let mut tx = pool.begin().await.map_err(backend)?;

            sqlx::query("DELETE FROM state_items WHERE secret_id = $1 AND state_key = $2")
                .bind(&secret)
                .bind(&key_col)
                .execute(&mut *tx)
                .await
                .map_err(backend)?;

            sqlx::query(
                "INSERT INTO state_items (secret_id, state_key, kind, item) \
                 VALUES ($1, $2, $3, $4)",
            )
            .bind(&secret)
            .bind(&key_col)
            .bind(kind_col)
            .bind(&payload)
            .execute(&mut *tx)
            .await
            .map_err(backend)?;

            tx.commit().await.map_err(backend)?;
            Ok(())
        })
    }

    fn load(&self, secret_id: u64, key: StateKey) -> StateStoreFuture<'_, Option<StateItem>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);

        Box::pin(async move {
            let key_col = key_text(&key)?;

            let row: Option<(String,)> = sqlx::query_as(
                "SELECT item FROM state_items WHERE secret_id = $1 AND state_key = $2",
            )
            .bind(secret)
            .bind(key_col)
            .fetch_optional(&pool)
            .await
            .map_err(backend)?;

            match row {
                Some((json,)) => {
                    let record: StateItemRecord =
                        serde_json::from_str(&json).map_err(backend)?;
                    Ok(Some(record.into_item().map_err(backend_msg)?))
                }
                None => Ok(None),
            }
        })
    }

    fn remove(&mut self, secret_id: u64, key: StateKey) -> StateStoreFuture<'_, bool> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);

        Box::pin(async move {
            let key_col = key_text(&key)?;

            let result =
                sqlx::query("DELETE FROM state_items WHERE secret_id = $1 AND state_key = $2")
                    .bind(secret)
                    .bind(key_col)
                    .execute(&pool)
                    .await
                    .map_err(backend)?;

            Ok(result.rows_affected() > 0)
        })
    }

    fn load_all(&self, secret_id: u64, kind: StateKind) -> StateStoreFuture<'_, Vec<StateItem>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let kind_col = kind_text(kind);

        Box::pin(async move {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT item FROM state_items WHERE secret_id = $1 AND kind = $2",
            )
            .bind(secret)
            .bind(kind_col)
            .fetch_all(&pool)
            .await
            .map_err(backend)?;

            let mut out = Vec::with_capacity(rows.len());
            for (json,) in rows {
                let record: StateItemRecord = serde_json::from_str(&json).map_err(backend)?;
                out.push(record.into_item().map_err(backend_msg)?);
            }
            Ok(out)
        })
    }
}
```

Both facts above are verified against the 0.0.4 source: `into_item(self) -> Result<StateItem, String>` (`state_record.rs:301`), which is why `backend_msg` takes a `String` — and `StateKind` has exactly the five variants listed (`types/mod.rs:1078`), deriving `Debug, Clone, Copy, PartialEq, Eq, Hash`.

- [ ] **Step 2: Add the conformance case**

```rust
#[tokio::test]
async fn the_sql_state_store_conforms() {
    on_every_engine(|pool| async move {
        let mut store = SqlStateStore::new(pool);
        conformance::state_store_conforms(&mut store, state_item).await;
    })
    .await;
}
```

- [ ] **Step 3: Run the whole SQL suite**

Run: `cd apps/backend && cargo test --test sql_stores 2>&1 | grep -E "test result|FAILED|SKIPPED"`
Expected: `test result: ok. 5 passed`, plus the Postgres skip line.

- [ ] **Step 4: Report, do not commit**

Files touched: `apps/backend/src/sql/state.rs`, `apps/backend/tests/sql_stores.rs`.

---

## Task 8: Prove it on Postgres

The suite has only run on SQLite so far. Until it runs on Postgres, "portable" is an assertion rather than a result.

- [ ] **Step 1: Start a Postgres**

```bash
docker run --rm -d --name derec-pg \
  -e POSTGRES_PASSWORD=derec -e POSTGRES_DB=derec \
  -p 55432:5432 postgres:16-alpine
```

If Docker is unavailable, say so and stop — do not claim Postgres coverage that did not run.

- [ ] **Step 2: Run the suite against it**

```bash
cd apps/backend && TEST_DATABASE_URL=postgres://postgres:derec@localhost:55432/derec \
  cargo test --test sql_stores 2>&1 | tail -20
```

Expected: every case prints both `running against sqlite` and `running against postgres`, and all 5 pass. **No `SKIPPED postgres` line may appear.**

Likely failures and what they mean:
- `syntax error at or near` — a SQLite-ism reached the shared dialect. Fix the query, not the engine.
- `relation "channels" does not exist` — migrations did not run; `db::connect` runs them, so check the URL reached it.
- a partitioning assertion — `reset` did not clear a previous run's rows.

- [ ] **Step 3: Stop it**

```bash
docker stop derec-pg
```

- [ ] **Step 4: Confirm the skip path still works**

Run: `cd apps/backend && cargo test --test sql_stores 2>&1 | grep -E "SKIPPED|test result"`
Expected: the skip line is back and all 5 still pass — a developer without Docker is not blocked.

- [ ] **Step 5: Full suite**

Run: `cd apps/backend && cargo test 2>&1 | grep -cE "^test result: ok"`
Expected: `16` (15 baseline + `sql_stores`), no `FAILED`, no warnings.

- [ ] **Step 6: Report, do not commit**

---

## Definition of Done

- [ ] `cargo test` in `apps/backend`: **16 suites, ≥ 200 tests, 0 failures, 0 warnings**
- [ ] `npx vitest run` in `apps/web`: **408 passing** (unchanged — this plan touches no frontend code)
- [ ] All five stores pass the conformance suite on SQLite
- [ ] All five pass it on **Postgres**, demonstrated in a run with no `SKIPPED postgres` line
- [ ] Without `TEST_DATABASE_URL`, the suite still passes and prints the skip
- [ ] `UserSecrets` round-trips **including `replicas`**, unlike the SDK's WASM adapter
- [ ] No `as i64` on any id anywhere in `src/sql/`
- [ ] `src/stores.rs` and `src/actor.rs` are **unchanged** — verify with `git diff --stat src/stores.rs src/actor.rs`, expected: no output
- [ ] Every file left **unstaged** for the user to review

## Notes for the next plan (Phase 4b — the cutover)

- `build_protocol` (`actor.rs:137`) gains a pool and constructs the `Sql*` stores; `ActorProtocol` (`stores.rs:457`) is retyped. `rebuild_with_stores` keeps working unchanged — the stores are pool handles, so moving them between instances is still just a move.
- The pool must reach `AppState` (the `with_config` pattern at `state.rs` is the model) and then every actor construction site.
- `test_support::app_state()` is synchronous and used by most route tests; giving actors SQL stores means it needs a pool. Deciding how — an in-memory pool built per fixture, or keeping fixtures on the in-memory stores — is the first decision of 4b and the one that determines how much churn it carries.
- The dashmap registries (`actors`, `actor_channels`, `disabled_helpers`, `participant_contacts`, `mailbox`) move onto the tables that already exist for them in `0001_initial.sql`.
- `stores.rs` is deleted once nothing imports it. `conformance.rs` must survive — it lives in `src/`, not beside the in-memory stores, for exactly this reason.
- Phase 5 (Actix `Supervisor`) follows, since restart recovery is only worth having once there is state to recover.
