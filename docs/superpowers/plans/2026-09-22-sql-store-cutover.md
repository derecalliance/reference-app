# SQL Store Cutover Implementation Plan (Phase 4b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every actor's protocol run on the SQL stores written in Phase 4a, so channels, shares, secrets and orchestrator state live in the database rather than in process memory.

**Architecture:** The pool is threaded exactly the way `reqwest::Client` already is — as a cheap shared handle on `ProtocolConfig` and `AppState`. That keeps `build_protocol` **synchronous**: constructing a `SqlChannelStore` is wrapping a pool clone, and the only async step (opening the pool) already happens once at boot in Phase 3. `ActorProtocol` moves out of `stores.rs` into `actor.rs`, which is where it belongs and which decouples it from the in-memory stores ahead of their deletion. `test_support::app_state()` becomes `async` because a test pool comes from `db::connect`, and its callers are already async test functions.

**Tech Stack:** Rust, `sqlx` 0.8 `AnyPool`, Axum 0.8, actix 0.13, `derec-library` 0.0.4.

**Spec:** `docs/superpowers/specs/2026-09-21-docker-packaging-design.md` — "Persistence" (line 279), "Implementation order" item 4 (line 750).

## Global Constraints

- **Scope: the protocol stores only.** The `dashmap` registries on `AppState` (`actors`, `actor_inboxes`, `helper_channels`, `disabled_helpers`, `browser_participant_contacts`) stay in memory in this plan. Moving them to tables makes every registry read `async` and touches every route — that is Phase 4c. The tables for them already exist in `0001_initial.sql` and stay unused.
- **`stores.rs` is not deleted here.** It still holds the five `InMemory*` types, which nothing constructs after this plan but which `conformance`'s proving run in `tests/store_conformance.rs` still exercises. Deleting it is Phase 4c's job, once the registries are off it too.
- **Baseline entering this plan:** backend `cargo test` = **196 passing, 16 suites, 0 failures, 0 warnings**. Frontend `npx vitest run` = **408 passing**. Playwright e2e = **48 passed, 4 skipped, 0 failed**.
- **`build_protocol` must stay synchronous.** If you find yourself making it `async`, stop — the pool is a handle, not a connection, and `SqlChannelStore::new` does no I/O.
- **Every test gets its own database.** `sqlite::memory:` per fixture. Two tests sharing one database interfere, which is the exact failure Phase 4a hit on Postgres.
- **No `unwrap()` / `expect()` in production paths.** Test code may use them.
- **Do not commit `docs/`.**
- **The user commits.** Do **not** run `git commit`, `git add` or `git stash`. Each task ends with verification and the list of files it touched.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/backend/src/actor.rs` | `ProtocolConfig.pool`, `ActorProtocol` moves here, `build_protocol` builds SQL stores | modify |
| `apps/backend/src/stores.rs` | `ActorProtocol` alias removed; `InMemory*` stay | modify |
| `apps/backend/src/state.rs` | `AppState.pool`, `test_support::app_state` becomes async | modify |
| `apps/backend/src/provisioning.rs` | passes the pool into `ProtocolConfig` | modify |
| `apps/backend/src/main.rs` | hands the real pool to `AppState` | modify |
| `apps/backend/tests/common/mod.rs` | fixture pool | modify |
| `apps/backend/tests/helper_auto_confirm.rs` | fixture pool | modify |
| `apps/backend/tests/{replica_contact,reconfigure,replica_instances}.rs` | `ProtocolConfig` fixtures gain a pool | modify |
| `apps/backend/tests/{config_route,replica_contact_route,grpc_ingress}.rs` | `app_state().await` | modify |

---

## Task 1: `ActorProtocol` moves and takes SQL stores

**Files:**
- Modify: `apps/backend/src/actor.rs`
- Modify: `apps/backend/src/stores.rs`

**Interfaces:**
- Consumes: the five `Sql*` stores from Phase 4a.
- Produces: `actor::ActorProtocol` typed over the SQL stores; `ProtocolConfig.pool`.

- [ ] **Step 1: Move the alias into `actor.rs` and retype it**

Delete this block from `apps/backend/src/stores.rs` (it is at `:457`, just above `mod tests`):

```rust
pub type ActorProtocol = derec_library::protocol::DeRecProtocol<
    InMemoryChannelStore,
    InMemoryShareStore,
    InMemorySecretStore,
    InMemoryUserSecretStore,
    InMemoryStateStore,
    crate::transport::CompositeTransport,
>;
```

Add to `apps/backend/src/actor.rs`, near the top after the imports:

```rust
/// The protocol type every actor runs.
///
/// Lives here rather than in `stores.rs` because it is about what an actor
/// *is*, not about how one storage backend is written — and because the
/// in-memory stores it used to name are on their way out.
pub type ActorProtocol = derec_library::protocol::DeRecProtocol<
    crate::sql::channel::SqlChannelStore,
    crate::sql::share::SqlShareStore,
    crate::sql::secret::SqlSecretStore,
    crate::sql::user_secret::SqlUserSecretStore,
    crate::sql::state::SqlStateStore,
    crate::transport::CompositeTransport,
>;
```

**Check the generic order against the old alias** — it is channel, share, secret, user-secret, state, transport. Getting two adjacent parameters the wrong way round compiles only if their traits differ, and here they do, so a mistake will surface as a trait-bound error naming the wrong store.

- [ ] **Step 2: Give `ProtocolConfig` a pool**

In `apps/backend/src/actor.rs`, add to `ProtocolConfig` beside `http_client`:

```rust
    /// The database every store for this instance reads and writes.
    ///
    /// A handle, like `http_client` beside it — cloning shares connections
    /// rather than opening them, so an actor owning one costs nothing.
    pub pool: sqlx::AnyPool,
```

- [ ] **Step 3: Build the SQL stores**

Replace the five `with_*_store` lines in `build_protocol`:

```rust
        .with_channel_store(crate::sql::channel::SqlChannelStore::new(config.pool.clone()))
        .with_share_store(crate::sql::share::SqlShareStore::new(config.pool.clone()))
        .with_secret_store(crate::sql::secret::SqlSecretStore::new(config.pool.clone()))
        .with_user_secret_store(crate::sql::user_secret::SqlUserSecretStore::new(
            config.pool.clone(),
        ))
        .with_state_store(crate::sql::state::SqlStateStore::new(config.pool.clone()))
```

`build_protocol` keeps its signature and stays synchronous.

Remove the now-unused `InMemory*` imports from `actor.rs:49`, and remove `ActorProtocol` from that same import list since it is now defined locally.

- [ ] **Step 4: Update the two in-file fixtures**

`actor.rs:1524` builds a `ProtocolConfig`. Add a pool to it. Because these are `#[actix_rt::test]` or `#[tokio::test]` functions, the fixture can be async — but `config()` is called from several places, so give it a pool parameter instead of making it async:

```rust
    fn config(pool: sqlx::AnyPool) -> ProtocolConfig {
```

and have each caller obtain one first:

```rust
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("test pool");
        let protocol = build_protocol(&config(pool))?;
```

- [ ] **Step 5: Compile the library**

Run: `cd apps/backend && cargo build 2>&1 | grep -E "^(error|warning)" | head -20`
Expected: errors only from `provisioning.rs` and `state.rs`, which Task 2 fixes — every one of them about a missing `pool` field. If you see an error inside `actor.rs` itself, fix it before moving on.

- [ ] **Step 6: Report, do not commit**

Files touched: `apps/backend/src/actor.rs`, `apps/backend/src/stores.rs`.

---

## Task 2: The pool reaches `AppState` and provisioning

**Files:**
- Modify: `apps/backend/src/state.rs`
- Modify: `apps/backend/src/provisioning.rs`
- Modify: `apps/backend/src/main.rs`

**Interfaces:**
- Produces: `AppState.pool`, and `AppState::new` taking it.

- [ ] **Step 1: Add the field**

In `apps/backend/src/state.rs`, beside `http_client`:

```rust
    /// The database every actor's stores read and write.
    pub pool: sqlx::AnyPool,
```

- [ ] **Step 2: Take it in the constructor**

`AppState::new` gains a parameter rather than a `with_*` setter. A node whose actors have nowhere to store anything is not a usable state to construct, so this is required, not optional — unlike `config`, which has a meaningful empty value:

```rust
    pub fn new(
        base_url: impl Into<Arc<str>>,
        defaults: Defaults,
        http_client: reqwest::Client,
        arbiter: actix_rt::ArbiterHandle,
        pool: sqlx::AnyPool,
    ) -> Self {
```

and in the struct literal:

```rust
            pool,
```

- [ ] **Step 3: Pass it through provisioning**

In `apps/backend/src/provisioning.rs:48`, the `ProtocolConfig` literal gains:

```rust
        pool: state.pool.clone(),
```

**Check what `provisioned_actor`/this function actually receives** — if it takes `&AppState`, use `state.pool.clone()`; if it takes loose parameters, add a `pool: sqlx::AnyPool` parameter and pass `state.pool.clone()` at the call site. Follow the existing shape rather than reshaping the function.

- [ ] **Step 4: Hand the real pool over in `main.rs`**

`main.rs` currently holds the pool as `_pool` with a comment saying nothing reads it yet. That is no longer true — delete the binding and pass it:

```rust
    let state = Arc::new(
        AppState::new(
            base_url.as_str(),
            defaults,
            http_client,
            arbiter_handle,
            pool,
        )
        .with_config(loaded),
    );
```

Remove the `let _pool = pool;` line and the comment above it.

- [ ] **Step 5: Compile**

Run: `cd apps/backend && cargo build 2>&1 | grep -E "^(error|warning)" | head -20`
Expected: no errors, no warnings. The binary is now fully on SQL stores.

- [ ] **Step 6: Boot it and watch a real actor get provisioned**

```bash
cd apps/backend && DEREC_DATABASE_URL=/tmp/cutover.db \
  perl -e 'alarm 8; exec @ARGV' ./target/debug/derec-backend > /tmp/cutover.log 2>&1 &
sleep 4
curl -s -X POST localhost:5000/helpers -H 'content-type: application/json' \
  -d '{"name":"Alex"}' | head -c 300
```

**Note:** this machine has no `timeout`; the `perl -e 'alarm N'` form is the substitute. If a `.env` in `apps/backend` sets legacy names the boot aborts — that is the Phase 2 check working.

Then confirm the row actually landed in the database rather than in memory:

```bash
sqlite3 /tmp/cutover.db "SELECT COUNT(*) FROM channels;" 2>/dev/null || \
  echo "install sqlite3 or inspect with a follow-up test"
rm -f /tmp/cutover.db
```

Expected: the helper is created (HTTP 201 with an actor id). A count of 0 in `channels` is fine at this point — a freshly provisioned helper has no channel until it pairs. What must **not** happen is an error response or a panic in the log.

- [ ] **Step 7: Report, do not commit**

Files touched: `apps/backend/src/state.rs`, `apps/backend/src/provisioning.rs`, `apps/backend/src/main.rs`.

---

## Task 3: The test fixtures

The mechanical half. 17 `app_state()` call sites across 6 files, plus three `ProtocolConfig` fixtures and two `AppState::new` fixtures.

**Files:**
- Modify: `apps/backend/src/state.rs` (`test_support`)
- Modify: `apps/backend/tests/common/mod.rs`
- Modify: `apps/backend/tests/helper_auto_confirm.rs`
- Modify: `apps/backend/tests/{replica_contact,reconfigure,replica_instances}.rs`
- Modify: `apps/backend/tests/{config_route,replica_contact_route,grpc_ingress}.rs`

- [ ] **Step 1: Make `test_support::app_state` async**

In `apps/backend/src/state.rs`:

```rust
    /// An `AppState` wired to the arbiter of the currently running actix
    /// system, over a private in-memory database.
    ///
    /// Must be called from inside an actix runtime — `#[actix_rt::test]` or an
    /// equivalent — because there is no arbiter to hand out otherwise.
    ///
    /// Async because the pool is: `db::connect` opens it and runs migrations.
    /// Every fixture gets its *own* in-memory database, which is what keeps
    /// concurrent tests from truncating each other's rows — the failure mode
    /// the SQL store suite hit the first time it ran against a shared engine.
    pub async fn app_state() -> Arc<AppState> {
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("an in-memory database always connects");

        Arc::new(AppState::new(
            "http://localhost:5000",
            Defaults::default(),
            reqwest::Client::new(),
            actix_rt::Arbiter::current(),
            pool,
        ))
    }
```

- [ ] **Step 2: Await it everywhere**

Run: `cd apps/backend && rg -n 'app_state\(\)' src/ tests/`

Every call site that is not the definition becomes `app_state().await`. All callers are already `async fn` test bodies, so nothing else changes. Expect 16 edits across `tests/config_route.rs`, `tests/replica_contact_route.rs`, `tests/replica_contact.rs`, `tests/reconfigure.rs`, `tests/replica_instances.rs` and `tests/grpc_ingress.rs`.

Watch for helper functions that wrap it — e.g. `fn app() -> Router` in `tests/config_route.rs` and `tests/replica_contact_route.rs`. Those become `async fn app() -> Router` and their callers gain `.await` too.

- [ ] **Step 3: Give the `ProtocolConfig` fixtures a pool**

In each of `tests/replica_contact.rs:16`, `tests/reconfigure.rs:23` and `tests/replica_instances.rs:20`, change the fixture to take a pool:

```rust
fn config(secret_id: u64, pool: sqlx::AnyPool) -> ProtocolConfig {
    ProtocolConfig {
        // ... existing fields ...
        pool,
    }
}
```

and add a helper beside it so each test gets its own database:

```rust
/// A private in-memory database per test. Shared ones interfere.
async fn pool() -> sqlx::AnyPool {
    derec_backend::db::connect("sqlite::memory:")
        .await
        .expect("an in-memory database always connects")
}
```

Add `sqlx` to `[dev-dependencies]` only if the tests cannot see it — it is a normal dependency, so `sqlx::AnyPool` should already resolve in integration tests.

- [ ] **Step 4: Give the two `AppState::new` fixtures a pool**

`tests/common/mod.rs:98` and `tests/helper_auto_confirm.rs:56` construct `AppState::new` directly. Add the fifth argument, obtaining a pool the same way. If the enclosing function is sync, make it async and await it at its call sites.

- [ ] **Step 5: Compile the tests**

Run: `cd apps/backend && cargo test --no-run 2>&1 | grep -E "^error" | sort -u | head -20`
Expected: no output.

- [ ] **Step 6: Run the full suite**

Run: `cd apps/backend && cargo test 2>&1 | grep -E "^test result|FAILED" | head -25`
Expected: 16 suites, 0 `FAILED`.

**If a protocol test fails here, read it carefully before touching the store.** The SQL stores passed conformance on two engines, so a failure is more likely a fixture sharing a database, or a test that depended on in-memory ordering the conformance suite does not pin. Say which it is rather than adjusting a store to make a test pass.

- [ ] **Step 7: Report, do not commit**

---

## Task 4: Prove state actually persists

Every test so far uses `sqlite::memory:`, which dies with the pool. Nothing has yet shown that a restart recovers anything — which is the whole point of the phase.

**Files:**
- Create: `apps/backend/tests/persistence.rs`

- [ ] **Step 1: Write the test**

Create `apps/backend/tests/persistence.rs`:

```rust
//! State written by one protocol instance is readable by the next one over the
//! same database.
//!
//! Every other test in this repo uses `sqlite::memory:`, which dies with its
//! pool — so none of them can tell a store that persists from one that does
//! not. This one uses a file, drops everything, and reopens.
//!
//! It deliberately does not go through the actor or the HTTP layer: actors are
//! still held in an in-memory registry (Phase 4c moves that), so a full restart
//! would find no actor to own the recovered state. What is proven here is the
//! half this phase actually delivers — the stores.

use derec_backend::conformance::{SECRET_A, HIGH_ID};
use derec_backend::db;
use derec_backend::sql::channel::SqlChannelStore;
use derec_library::protocol::types::ChannelStatus;
use derec_library::protocol::{ChannelQuery, ChannelRecord, DeRecChannelStore, HelperChannel};
use derec_library::types::ChannelId;

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

#[tokio::test]
async fn a_channel_written_before_a_restart_is_there_after_one() {
    let dir = std::env::temp_dir().join(format!("derec-persist-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let url = db::resolve_url(&dir.join("derec.db").to_string_lossy());

    // First "process": write a channel, then drop everything.
    {
        let pool = db::connect(&url).await.expect("first connect");
        let mut store = SqlChannelStore::new(pool.clone());
        store
            .save(SECRET_A, ChannelRecord::Helper(helper_channel(HIGH_ID)))
            .await
            .expect("save");
        pool.close().await;
    }

    // Second "process": a brand new pool over the same file.
    {
        let pool = db::connect(&url).await.expect("second connect");
        let store = SqlChannelStore::new(pool.clone());

        let loaded = store
            .load(
                SECRET_A,
                ChannelQuery::Helper {
                    channel_id: ChannelId(HIGH_ID),
                },
            )
            .await
            .expect("readable")
            .expect("the channel must survive the restart");

        match loaded {
            ChannelRecord::Helper(h) => {
                assert_eq!(h.channel_id.0, HIGH_ID, "the id must survive exactly");
                assert_eq!(h.status, ChannelStatus::Paired);
            }
            ChannelRecord::Replica(_) => panic!("expected a helper record"),
        }
        pool.close().await;
    }

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn an_in_memory_database_deliberately_does_not_survive() {
    // The counterpart, so the test above is known to be measuring persistence
    // rather than something that would pass either way.
    let first = db::connect("sqlite::memory:").await.expect("connect");
    let mut store = SqlChannelStore::new(first.clone());
    store
        .save(SECRET_A, ChannelRecord::Helper(helper_channel(HIGH_ID)))
        .await
        .expect("save");
    first.close().await;

    let second = db::connect("sqlite::memory:").await.expect("connect");
    let store = SqlChannelStore::new(second.clone());

    assert!(
        store
            .load(
                SECRET_A,
                ChannelQuery::Helper {
                    channel_id: ChannelId(HIGH_ID)
                }
            )
            .await
            .expect("readable")
            .is_none(),
        "`sqlite::memory:` must forget — that is what it is for"
    );
    second.close().await;
}
```

`SECRET_A` and `HIGH_ID` are already `pub` in `conformance.rs`. If they are not, make them so rather than duplicating the constants.

- [ ] **Step 2: Run it**

Run: `cd apps/backend && cargo test --test persistence 2>&1 | tail -10`
Expected: 2 passed.

A failure on the first test means the store is not persisting — check that `save` commits its transaction. A failure on the *second* means `sqlite::memory:` is being shared between pools, which would invalidate every fixture's isolation.

- [ ] **Step 3: Full verification**

Run: `cd apps/backend && cargo test 2>&1 | grep -cE "^test result: ok"`
Expected: `17` (16 baseline + `persistence`), no `FAILED`, no warnings.

Run: `cd apps/web && npx vitest run 2>&1 | tail -3`
Expected: 408 passing.

- [ ] **Step 4: Run the end-to-end suite**

This is the one that exercises real pairing, sharing, verification and recovery against the SQL stores. It is the only check that the cutover preserved protocol behaviour.

Run: `cd apps/web && npm run test:e2e`
Expected: **48 passed, 4 skipped, 0 failed**, around 9 minutes.

On a failure, re-run that spec alone before calling it a regression — but note the SDK 0.0.4 run was clean at 48/0, so a failure here is much more likely to be the cutover than a flake. Compare against `docs/superpowers/plans/` history and say which you concluded.

- [ ] **Step 5: Report, do not commit**

---

## Definition of Done

- [ ] `cargo test` in `apps/backend`: **17 suites, ≥ 200 tests, 0 failures, 0 warnings**
- [ ] `npx vitest run`: **408 passing**
- [ ] `npm run test:e2e`: **48 passed, 0 failed**
- [ ] `build_protocol` is still **synchronous**
- [ ] `rg 'InMemory' src/` matches **only** `stores.rs` — nothing constructs them any more
- [ ] A channel written before a pool is dropped is readable by a fresh pool over the same file
- [ ] `sqlite::memory:` demonstrably does *not* persist, so the test above measures something
- [ ] Every file left **unstaged** for the user to review

## Notes for the next plan (Phase 4c)

- The `dashmap` registries move onto the tables already waiting for them. Every registry read becomes `async`, which is why it is its own phase: `state.actors` is read synchronously from most routes today.
- `stores.rs` is deleted once the registries are off it and nothing imports `InMemory*`. `tests/store_conformance.rs` goes with it; `src/conformance.rs` stays, because the SQL stores still need it.
- Phase 5 (Actix `Supervisor`) follows: actors rebuilt from the database on restart. Only then does a full `docker restart` recover a working node, which is what the image promises.
- `tests/persistence.rs` is the natural place to add the full-restart assertion once 4c and Phase 5 make one possible.
