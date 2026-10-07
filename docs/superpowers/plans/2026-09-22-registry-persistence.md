# Registry Persistence Implementation Plan (Phase 4c)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the four *data* registries off `dashmap` and onto the tables already waiting for them, so a node's actors, their channels, their disabled state and their pending contacts survive the process.

**Architecture:** Each registry becomes a small SQL-backed type in `src/registry/`, holding a pool clone exactly as the stores do. Accessors become `async`; every caller is already an async handler. Two registries deliberately do **not** move: `actor_inboxes` and `browser_receivers` hold live `actix::Addr`s and `mpsc` channel halves, which are runtime handles with no serialised form — they are rebuilt when actors are respawned, which is Phase 5. `Actor` keeps deriving `Serialize` and **not** `Deserialize`; rehydration goes through a private row type, because that asymmetry is a security property the relay depends on.

**Tech Stack:** Rust, `sqlx` 0.8 `AnyPool`, Axum 0.8, actix 0.13.

**Spec:** `docs/superpowers/specs/2026-09-21-docker-packaging-design.md` — "Implementation order" item 4 (line 750).

## Global Constraints

- **Baseline entering this plan:** backend `cargo test` = **199 passing, 17 suites, 0 failures, 0 warnings**. Frontend `npx vitest run` = **408 passing**. Playwright e2e = **48 passed, 4 skipped, 0 failed**.
- **`Actor` must not gain `Deserialize`.** `models.rs:172` documents why: the relay's allowlist trusts `Actor.transports` by exact string match, on the strength of no request body ever being able to produce an `Actor`. Rehydrate through a private row struct instead — `Transport` and `Role` both already derive `Deserialize`, so only the outer type needs the care.
- **Registration order is part of the contract.** `ActorRegistry` is a `Vec` rather than a map because the front end polls `GET /actors` and renders the result as a list; an unordered result reshuffles the roster on every poll. Order is carried by an explicit `seq` column assigned by the writer, not by `created_at` (two actors can share a second) and not by `AUTOINCREMENT`/`SERIAL` (neither is portable).
- **`actor_inboxes` and `browser_receivers` stay in memory.** They hold `Addr<ProvisionedActor>` and `mpsc` halves. If you find yourself adding a table for either, stop.
- **After a restart, actors exist in the table but have no inbox.** Nothing respawns them until Phase 5. That is the honest intermediate state; make it visible with a boot log line rather than papering over it.
- **One dialect for both engines.** Same rules as Phase 4a: no `AUTOINCREMENT`, no `SERIAL`, no `RETURNING`, no engine-specific upsert. Delete-then-insert in a transaction.
- **No `unwrap()` / `expect()` in production paths.**
- **The user commits.** Do **not** run `git commit`, `git add` or `git stash`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/backend/migrations/0001_initial.sql` | `actors` gains `seq` and `transports` | modify |
| `apps/backend/src/registry/mod.rs` | module root | **new** |
| `apps/backend/src/registry/actors.rs` | `SqlActorRegistry` | **new** |
| `apps/backend/src/registry/flags.rs` | helper channels, disabled helpers, contacts | **new** |
| `apps/backend/src/state.rs` | `AppState` holds the SQL registries | modify |
| `apps/backend/src/routes/*.rs` | `.await` on registry reads | modify |
| `apps/backend/src/main.rs` | boot log for recovered actors | modify |
| `apps/backend/tests/registry.rs` | registry behaviour, both engines | **new** |
| `apps/backend/src/stores.rs` | re-documented as the conformance control | modify |

### On deleting `stores.rs`

The spec says `stores.rs` is deleted "once nothing imports it". After this plan nothing in production does — but `tests/store_conformance.rs` still does, and that run is what makes the conformance suite worth anything: it is the control, proven against a known-good implementation before the SQL ones were written. It also earned its keep in Phase 4b, where its `linked_channels` doc comment is what identified the recovery bug.

So the in-memory stores **stay**, re-documented as the conformance control rather than as a storage backend. Deleting them would remove the only independent implementation the suite can be checked against. Raise this with the user rather than deleting unilaterally if you disagree.

---

## Task 1: `seq` and `transports` on the actors table

**Files:**
- Modify: `apps/backend/migrations/0001_initial.sql`

- [ ] **Step 1: Amend the table**

`0001_initial.sql` is unreleased, so edit it in place rather than adding `0002`. Any local `derec.db` must then be deleted — `sqlx` records a checksum per migration and refuses a modified one.

```sql
-- One flat, server-wide list of actors. `role` is owner or helper; a replica is
-- a pairing mode, not an actor kind, so it is deliberately not a role here.
--
-- `seq` carries registration order, which is part of the contract: the front
-- end polls GET /actors and renders the result as a list, so an unordered
-- result reshuffles the roster on every poll. It is assigned by the writer
-- inside the inserting transaction -- AUTOINCREMENT and SERIAL are both
-- unavailable under the portability rule, and `created_at` is too coarse
-- because two actors can share a second.
--
-- `transports` is the JSON-encoded endpoint list. `Actor` itself derives
-- Serialize but deliberately not Deserialize, so the row is read back through
-- a private row type rather than by deserialising an Actor -- see
-- `registry/actors.rs`.
CREATE TABLE actors (
    actor_id   TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('owner', 'helper')),
    name       TEXT NOT NULL,
    secret_id  TEXT NOT NULL,
    transports TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id)
);

CREATE INDEX actors_by_seq ON actors (seq);
```

- [ ] **Step 2: Clear any local database**

```bash
cd /Users/facutherock/repositories/derec/reference-app && \
  find . -name 'derec.db*' -not -path '*/node_modules/*' -delete
```

- [ ] **Step 3: Verify migrations still apply**

Run: `cd apps/backend && cargo test --test migrations 2>&1 | grep "test result"`
Expected: `test result: ok. 4 passed`

- [ ] **Step 4: Report, do not commit**

---

## Task 2: `SqlActorRegistry`

**Files:**
- Create: `apps/backend/src/registry/mod.rs`
- Create: `apps/backend/src/registry/actors.rs`
- Modify: `apps/backend/src/lib.rs`

**Interfaces:**
- Produces, mirroring today's `ActorRegistry` but `async`:
  - `pub async fn register(&self, actor: Actor) -> Result<(), RegistryError>`
  - `pub async fn get(&self, actor_id: &Uuid) -> Result<Option<Actor>, RegistryError>`
  - `pub async fn get_with_role(&self, actor_id: &Uuid, role: Role) -> Result<Result<Actor, RoleMismatch>, RegistryError>`
  - `pub async fn contains(&self, actor_id: &Uuid) -> Result<bool, RegistryError>`
  - `pub async fn all(&self) -> Result<Vec<Actor>, RegistryError>`
  - `pub async fn ensure_participants_by_mode(&self, want: TransportBreakdown, mint: F) -> Result<EnsuredParticipants, RegistryError>`

- [ ] **Step 1: Write the failing tests**

Create `apps/backend/tests/registry.rs`:

```rust
//! The actor registry, on every engine available.
//!
//! Follows `tests/sql_stores.rs`: SQLite always, Postgres when
//! `TEST_DATABASE_URL` names one, serialised by a binary-wide lock because a
//! shared Postgres would otherwise let one case truncate another's rows.

use derec_backend::db;
use derec_backend::models::{Role, Transport, TransportBreakdown, TransportMode, TransportProtocol};
use derec_backend::registry::actors::SqlActorRegistry;

fn engines() -> Vec<(&'static str, String)> {
    let mut out = vec![("sqlite", "sqlite::memory:".to_owned())];
    match std::env::var("TEST_DATABASE_URL") {
        Ok(url) if !url.trim().is_empty() => out.push(("postgres", url)),
        _ => eprintln!("SKIPPED postgres: set TEST_DATABASE_URL to run on it too."),
    }
    out
}

async fn on_every_engine<F, Fut>(body: F)
where
    F: Fn(sqlx::AnyPool) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;

    for (label, url) in engines() {
        let pool = db::connect(&url)
            .await
            .unwrap_or_else(|e| panic!("{label}: connect failed: {e}"));
        sqlx::query("DELETE FROM actors")
            .execute(&pool)
            .await
            .expect("clear actors");
        eprintln!("running against {label}");
        body(pool).await;
    }
}

fn actor(name: &str, role: Role) -> derec_backend::models::Actor {
    derec_backend::provisioning::provisioned_actor(
        role,
        name,
        "http://localhost:5000",
        "localhost:50051",
        TransportMode::Http,
    )
}

#[tokio::test]
async fn registration_order_is_preserved() {
    // The front end polls GET /actors and renders a list; an unordered result
    // reshuffles the roster on every poll.
    on_every_engine(|pool| async move {
        let registry = SqlActorRegistry::new(pool);
        for name in ["first", "second", "third"] {
            registry
                .register(actor(name, Role::Helper))
                .await
                .expect("register");
        }

        let names: Vec<String> = registry
            .all()
            .await
            .expect("readable")
            .into_iter()
            .map(|a| a.name)
            .collect();
        assert_eq!(names, vec!["first", "second", "third"]);
    })
    .await;
}

#[tokio::test]
async fn an_actor_round_trips_with_its_endpoints() {
    on_every_engine(|pool| async move {
        let registry = SqlActorRegistry::new(pool);
        let original = actor("Alex", Role::Helper);
        registry
            .register(original.clone())
            .await
            .expect("register");

        let loaded = registry
            .get(&original.id)
            .await
            .expect("readable")
            .expect("the actor is there");

        assert_eq!(loaded.id, original.id);
        assert_eq!(loaded.name, original.name);
        assert_eq!(loaded.role, original.role);
        assert_eq!(loaded.secret_id, original.secret_id);
        assert_eq!(
            loaded.transports, original.transports,
            "the endpoint list is what the relay allowlist matches on"
        );
        assert_eq!(loaded.transport, original.transport);
    })
    .await;
}

#[tokio::test]
async fn a_role_mismatch_is_distinguishable_from_an_absence() {
    // Callers map these onto different status codes.
    on_every_engine(|pool| async move {
        let registry = SqlActorRegistry::new(pool);
        let helper = actor("Alex", Role::Helper);
        registry.register(helper.clone()).await.expect("register");

        let wrong = registry
            .get_with_role(&helper.id, Role::Owner)
            .await
            .expect("readable");
        assert!(matches!(
            wrong,
            Err(derec_backend::state::RoleMismatch::WrongRole { .. })
        ));

        let absent = registry
            .get_with_role(&uuid::Uuid::new_v4(), Role::Helper)
            .await
            .expect("readable");
        assert!(matches!(
            absent,
            Err(derec_backend::state::RoleMismatch::NotFound)
        ));
    })
    .await;
}

#[tokio::test]
async fn ensure_creates_only_the_shortfall() {
    on_every_engine(|pool| async move {
        let registry = SqlActorRegistry::new(pool);
        let want = TransportBreakdown { http: 3, grpc: 0, both: 0 };

        let first = registry
            .ensure_participants_by_mode(want, |taken, _pool_index, _mode| {
                actor(&format!("h{taken}"), Role::Helper)
            })
            .await
            .expect("ensure");
        assert_eq!(first.created.len(), 3);
        assert_eq!(first.participants.len(), 3);

        // Asking again creates nothing.
        let second = registry
            .ensure_participants_by_mode(want, |taken, _pool_index, _mode| {
                actor(&format!("x{taken}"), Role::Helper)
            })
            .await
            .expect("ensure");
        assert!(
            second.created.is_empty(),
            "the pool is already at the target; nothing to create"
        );
        assert_eq!(second.participants.len(), 3);
    })
    .await;
}

#[tokio::test]
async fn asking_for_fewer_removes_nothing() {
    // Another owner may be paired with one.
    on_every_engine(|pool| async move {
        let registry = SqlActorRegistry::new(pool);
        registry
            .ensure_participants_by_mode(
                TransportBreakdown { http: 3, grpc: 0, both: 0 },
                |taken, _p, _m| actor(&format!("h{taken}"), Role::Helper),
            )
            .await
            .expect("ensure");

        let fewer = registry
            .ensure_participants_by_mode(
                TransportBreakdown { http: 1, grpc: 0, both: 0 },
                |taken, _p, _m| actor(&format!("y{taken}"), Role::Helper),
            )
            .await
            .expect("ensure");

        assert!(fewer.created.is_empty());
        assert_eq!(fewer.participants.len(), 3, "nothing is removed");
    })
    .await;
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/backend && cargo test --test registry 2>&1 | tail -6`
Expected: a compile error naming `SqlActorRegistry`.

- [ ] **Step 3: Implement**

Create `apps/backend/src/registry/mod.rs`:

```rust
//! The node's registries, backed by SQL.
//!
//! These replace the `dashmap`s that used to live on `AppState`. Two registries
//! deliberately did **not** move: `actor_inboxes` and `browser_receivers` hold
//! `actix::Addr`s and `mpsc` channel halves, which are live runtime handles
//! with no serialised form. They are rebuilt when actors are respawned.

pub mod actors;
pub mod flags;

/// Why a registry operation failed.
///
/// One variant: every failure here is the database being unreachable or a row
/// being unreadable, and a caller can do nothing different about either.
#[derive(Debug, thiserror::Error)]
#[error("registry backend error")]
pub struct RegistryError(#[source] pub Box<dyn std::error::Error + Send + Sync + 'static>);

impl RegistryError {
    pub fn new<E: std::error::Error + Send + Sync + 'static>(e: E) -> Self {
        Self(Box::new(e))
    }
}
```

Create `apps/backend/src/registry/actors.rs`. The shape mirrors `state::ActorRegistry` method for method; only the storage and the `async` change:

```rust
//! The server-wide actor list.
//!
//! One flat registry: the app runs as a single local node that developers point
//! browser contexts at, so there is no grouping above this.

use serde::Deserialize;
use uuid::Uuid;

use super::RegistryError;
use crate::models::{Actor, Role, Transport, TransportBreakdown, TransportMode, TransportProtocol};
use crate::state::{EnsuredParticipants, RoleMismatch};

pub struct SqlActorRegistry {
    pool: sqlx::AnyPool,
    /// Serialises `ensure_participants_by_mode` within this process.
    ///
    /// The count-and-create must be atomic so two browser contexts setting up
    /// at the same moment cannot each fill an empty pool — the guarantee the
    /// old `RwLock` gave. A transaction alone does not provide it portably:
    /// on Postgres two concurrent transactions can both count zero before
    /// either inserts. This restores exactly the previous guarantee — one
    /// process — and no more. When node separation lands, this needs a
    /// database-level lock instead, and that is the moment to add one.
    ensure_lock: tokio::sync::Mutex<()>,
}

/// A row as stored. Read back into an [`Actor`] by hand.
///
/// `Actor` derives `Serialize` but deliberately **not** `Deserialize`: the
/// relay's allowlist trusts `Actor.transports` by exact string match, on the
/// strength of no request body being able to produce an `Actor` (see
/// `models.rs`). Deriving `Deserialize` to make rehydration convenient would
/// retire that guarantee for a convenience. This type carries the burden
/// instead — it is private, constructed only from a database row.
#[derive(Deserialize)]
struct ActorRow {
    actor_id: String,
    role: String,
    name: String,
    secret_id: String,
    transports: String,
}

fn role_text(role: Role) -> &'static str {
    match role {
        Role::Owner => "owner",
        Role::Helper => "helper",
    }
}

fn role_of(text: &str) -> Result<Role, RegistryError> {
    match text {
        "owner" => Ok(Role::Owner),
        "helper" => Ok(Role::Helper),
        other => Err(RegistryError(
            format!("unknown role in actors table: {other:?}").into(),
        )),
    }
}

/// Rebuild an `Actor` from its columns.
fn to_actor(
    (actor_id, role, name, secret_id, transports): (String, String, String, String, String),
) -> Result<Actor, RegistryError> {
    let transports: Vec<Transport> =
        serde_json::from_str(&transports).map_err(RegistryError::new)?;
    let transport = transports
        .first()
        .cloned()
        .ok_or_else(|| RegistryError("an actor row names no endpoint".to_owned().into()))?;

    Ok(Actor {
        id: actor_id.parse().map_err(RegistryError::new)?,
        role: role_of(&role)?,
        name,
        transport,
        transports,
        secret_id,
    })
}

const SELECT_COLUMNS: &str = "actor_id, role, name, secret_id, transports";

impl SqlActorRegistry {
    pub fn new(pool: sqlx::AnyPool) -> Self {
        Self {
            pool,
            ensure_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub async fn register(&self, actor: Actor) -> Result<(), RegistryError> {
        let mut tx = self.pool.begin().await.map_err(RegistryError::new)?;
        insert_actor(&mut tx, &actor).await?;
        tx.commit().await.map_err(RegistryError::new)?;
        Ok(())
    }

    pub async fn get(&self, actor_id: &Uuid) -> Result<Option<Actor>, RegistryError> {
        let row: Option<(String, String, String, String, String)> =
            sqlx::query_as(&format!("SELECT {SELECT_COLUMNS} FROM actors WHERE actor_id = $1"))
                .bind(actor_id.to_string())
                .fetch_optional(&self.pool)
                .await
                .map_err(RegistryError::new)?;

        row.map(to_actor).transpose()
    }

    /// The actor with this id, but only if it holds `role`.
    ///
    /// The inner `Result` distinguishes "no such actor" from "wrong kind of
    /// actor" so callers can map them onto different status codes; the outer
    /// one is the database failing.
    pub async fn get_with_role(
        &self,
        actor_id: &Uuid,
        role: Role,
    ) -> Result<Result<Actor, RoleMismatch>, RegistryError> {
        Ok(match self.get(actor_id).await? {
            None => Err(RoleMismatch::NotFound),
            Some(actor) if actor.role == role => Ok(actor),
            Some(actor) => Err(RoleMismatch::WrongRole { actual: actor.role }),
        })
    }

    pub async fn contains(&self, actor_id: &Uuid) -> Result<bool, RegistryError> {
        Ok(self.get(actor_id).await?.is_some())
    }

    /// Snapshot of the whole roster, in registration order.
    pub async fn all(&self) -> Result<Vec<Actor>, RegistryError> {
        let rows: Vec<(String, String, String, String, String)> =
            sqlx::query_as(&format!("SELECT {SELECT_COLUMNS} FROM actors ORDER BY seq"))
                .fetch_all(&self.pool)
                .await
                .map_err(RegistryError::new)?;

        rows.into_iter().map(to_actor).collect()
    }

    /// Bring the pool up to a target composition, creating only the per-mode
    /// shortfall.
    ///
    /// Asking for fewer of a mode than exist removes nothing: another owner may
    /// be paired with one.
    ///
    /// `mint` receives `taken` (this call's creation order across every mode)
    /// and `pool_index` (the helper's position in the whole pool as it is
    /// added), matching the two documented on `routes::helpers::helper_name`.
    pub async fn ensure_participants_by_mode<F>(
        &self,
        want: TransportBreakdown,
        mut mint: F,
    ) -> Result<EnsuredParticipants, RegistryError>
    where
        F: FnMut(usize, usize, TransportMode) -> Actor,
    {
        // Held across the whole count-and-create; see the field's doc.
        let _guard = self.ensure_lock.lock().await;

        let mut tx = self.pool.begin().await.map_err(RegistryError::new)?;

        let existing = fetch_all_in(&mut tx).await?;
        let mut helpers: Vec<Actor> = existing
            .into_iter()
            .filter(|a| a.role == Role::Helper)
            .collect();

        let mut created = Vec::new();
        let mut taken = 0usize;

        for (mode, target) in want.modes() {
            let have = helpers.iter().filter(|a| mode_of(a) == mode).count();
            for _ in have..target {
                let pool_index = helpers.len();
                let actor = mint(taken, pool_index, mode);
                insert_actor(&mut tx, &actor).await?;
                helpers.push(actor.clone());
                created.push(actor);
                taken += 1;
            }
        }

        tx.commit().await.map_err(RegistryError::new)?;

        Ok(EnsuredParticipants { created, participants: helpers })
    }
}

/// Insert one actor, assigning the next `seq` inside the caller's transaction.
///
/// `MAX(seq) + 1` rather than `AUTOINCREMENT`/`SERIAL`, neither of which is
/// portable. Safe inside the transaction because every writer takes it.
async fn insert_actor(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    actor: &Actor,
) -> Result<(), RegistryError> {
    let transports = serde_json::to_string(&actor.transports).map_err(RegistryError::new)?;

    let (next,): (i64,) = sqlx::query_as("SELECT COALESCE(MAX(seq), 0) + 1 FROM actors")
        .fetch_one(&mut **tx)
        .await
        .map_err(RegistryError::new)?;

    sqlx::query(
        "INSERT INTO actors (actor_id, seq, role, name, secret_id, transports, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(actor.id.to_string())
    .bind(next)
    .bind(role_text(actor.role))
    .bind(&actor.name)
    .bind(&actor.secret_id)
    .bind(&transports)
    // Wall-clock, for a human reading rows. Ordering uses `seq`.
    .bind(next)
    .execute(&mut **tx)
    .await
    .map_err(RegistryError::new)?;

    Ok(())
}

async fn fetch_all_in(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
) -> Result<Vec<Actor>, RegistryError> {
    let rows: Vec<(String, String, String, String, String)> =
        sqlx::query_as(&format!("SELECT {SELECT_COLUMNS} FROM actors ORDER BY seq"))
            .fetch_all(&mut **tx)
            .await
            .map_err(RegistryError::new)?;

    rows.into_iter().map(to_actor).collect()
}

/// Which mode an actor's advertised endpoints correspond to.
///
/// Duplicated from `state.rs` rather than shared, because that copy goes away
/// with the old registry. Fold them together if the old one survives.
fn mode_of(actor: &Actor) -> TransportMode {
    let has_grpc = actor
        .transports
        .iter()
        .any(|t| t.protocol == TransportProtocol::Grpc);
    let has_http = actor
        .transports
        .iter()
        .any(|t| t.protocol == TransportProtocol::Https);
    match (has_grpc, has_http) {
        (true, true) => TransportMode::Both,
        (true, false) => TransportMode::Grpc,
        _ => TransportMode::Http,
    }
}
```

Add to `apps/backend/src/lib.rs`:

```rust
pub mod registry;
```

`ActorRow` is declared above but the queries read tuples; delete the struct if it stays unused rather than leaving it — a `#[derive(Deserialize)]` on an unused type is exactly the kind of thing that later reads as "Actor is deserialisable after all".

- [ ] **Step 4: Run the tests**

Run: `cd apps/backend && cargo test --test registry 2>&1 | grep -E "test result|FAILED"`
Expected: 5 passed.

- [ ] **Step 5: Report, do not commit**

---

## Task 3: The three flag registries

`helper_channels`, `disabled_helpers` and `browser_participant_contacts` are small key-value maps with tables already waiting (`actor_channels`, `disabled_helpers`, `participant_contacts`).

**Files:**
- Create: `apps/backend/src/registry/flags.rs`
- Modify: `apps/backend/tests/registry.rs`

**Interfaces:**
- `pub struct HelperChannels { pool }` — `push(actor, channel)`, `get(actor) -> Vec<String>`
- `pub struct DisabledHelpers { pool }` — `set(actor, bool)`, `is_disabled(actor) -> bool`
- `pub struct ParticipantContacts { pool }` — `put(actor, contact)`, `take(actor) -> Option<String>`

- [ ] **Step 1: Read the current call sites first**

Run: `cd apps/backend && rg -n 'helper_channels|disabled_helpers|browser_participant_contacts' src/`

Match each method to what the callers actually do — whether a contact is *taken* (removed on read) or merely read, whether pushing a channel de-duplicates. Implement the observed behaviour, not this plan's guess at it. Write the assertion for whichever it is.

- [ ] **Step 2: Implement with tests in the same shape as Task 2**

Each type holds a pool clone; each method is one statement. Append a case per type to `tests/registry.rs`, running on every engine, asserting: absent-before-write, round-trip, and per-actor isolation (actor A's channels are not actor B's).

- [ ] **Step 3: Run**

Run: `cd apps/backend && cargo test --test registry 2>&1 | grep -E "test result|FAILED"`
Expected: all pass.

- [ ] **Step 4: Report, do not commit**

---

## Task 4: Wire them into `AppState`

**Files:**
- Modify: `apps/backend/src/state.rs`
- Modify: `apps/backend/src/routes/*.rs`
- Modify: `apps/backend/src/main.rs`

- [ ] **Step 1: Swap the fields**

In `AppState`, replace the four data registries with the SQL types, keeping `actor_inboxes` and `browser_receivers` exactly as they are:

```rust
    pub actors: Arc<crate::registry::actors::SqlActorRegistry>,
    pub helper_channels: Arc<crate::registry::flags::HelperChannels>,
    pub disabled_helpers: Arc<crate::registry::flags::DisabledHelpers>,
    pub browser_participant_contacts: Arc<crate::registry::flags::ParticipantContacts>,

    /// Live delivery handles, not data: an `Addr` and an `mpsc` sender have no
    /// serialised form. Rebuilt when actors are respawned (Phase 5), which is
    /// why a restart currently leaves persisted actors without an inbox.
    pub actor_inboxes: Arc<DashMap<Uuid, ActorInbox>>,
    pub browser_receivers: Arc<DashMap<Uuid, Arc<Mutex<mpsc::UnboundedReceiver<Vec<u8>>>>>>,
```

Construct them in `AppState::new` from the pool it already takes.

- [ ] **Step 2: Await at every call site, mapping errors**

Every registry read in `src/routes/` becomes `.await`. These handlers return HTTP responses, so a `RegistryError` maps to `500` — follow whatever the file already does for internal failures rather than introducing a new shape.

Run: `cd apps/backend && cargo build 2>&1 | grep -E '^error' | head -20` and work the list down.

- [ ] **Step 3: Say what a restart recovered**

In `main.rs`, after the pool opens:

```rust
    match state.actors.all().await {
        Ok(actors) if !actors.is_empty() => info!(
            count = actors.len(),
            "actors recovered from the database; they are not respawned yet, so \
             they will not answer until supervision lands"
        ),
        Ok(_) => {}
        Err(e) => warn!(error = %e, "could not read the actor registry at boot"),
    }
```

This is the honest intermediate state: the rows survive, the actors do not run. Saying so at boot beats a developer finding an actor listed that never answers.

- [ ] **Step 4: Full suite**

Run: `cd apps/backend && cargo test 2>&1 | grep -E "^test result|FAILED" | head -25`
Expected: every suite passing. Fixtures that built an `AppState` already pass a pool, so most need no change beyond `.await`.

- [ ] **Step 5: Report, do not commit**

---

## Task 5: Re-document `stores.rs` and verify end to end

**Files:**
- Modify: `apps/backend/src/stores.rs`

- [ ] **Step 1: Re-state what the in-memory stores are for**

Replace the module doc:

```rust
//! In-memory implementations of the derec-library store traits, kept as the
//! **conformance control**.
//!
//! Nothing in production constructs these any more — every actor runs on the
//! SQL stores in `crate::sql`. They stay because `tests/store_conformance.rs`
//! runs the conformance suite against them, and a suite that has only ever run
//! against the implementation it was written from is not evidence of anything.
//! Having a second, independent implementation is what makes the suite's
//! assertions checkable.
//!
//! They have already earned it: the `linked_channels` contract documented
//! below — the start node is included, so an unlinked channel returns itself —
//! is what identified a recovery bug in the SQL store that every unit test and
//! both engines' conformance runs had passed.
//!
//! Every store is partitioned by `secret_id`. Note that the SQL stores are
//! additionally keyed by `actor_id`, because a shared database needs a
//! discriminator these do not: see `migrations/0001_initial.sql`.
```

- [ ] **Step 2: Confirm nothing in production imports them**

Run: `cd apps/backend && rg -n 'InMemory' src/ --glob '!src/stores.rs'`
Expected: no output.

- [ ] **Step 3: Full verification**

Run: `cd apps/backend && cargo test 2>&1 | grep -cE "^test result: ok"` — expected 18, no `FAILED`, no warnings.
Run: `cd apps/web && npx vitest run` — expected 408.
Run: `cd apps/web && npm run test:e2e` — expected **48 passed, 4 skipped, 0 failed**.

**The e2e run is the one that matters.** Every defect in Phase 4b that unit tests and two-engine conformance missed was caught here. If a spec fails, read `test-results/**/error-context.md` before forming a hypothesis — that is what identified the `linked_channels` bug, after a wrong guess had already cost a full run.

- [ ] **Step 4: Report, do not commit**

---

## Definition of Done

- [ ] `cargo test` in `apps/backend`: **18 suites, ≥ 210 tests, 0 failures, 0 warnings**
- [ ] `npx vitest run`: **408 passing**
- [ ] `npm run test:e2e`: **48 passed, 0 failed**
- [ ] The registry suite passes on **Postgres** as well, demonstrated with no `SKIPPED` line
- [ ] `GET /actors` returns actors in registration order
- [ ] `Actor` still derives `Serialize` and **not** `Deserialize`
- [ ] `actor_inboxes` and `browser_receivers` are still `DashMap`s
- [ ] Boot reports how many actors were recovered
- [ ] Every file left **unstaged**

## Notes for the next plan (Phase 5 — supervision)

- Actors now survive in the table but nothing respawns them. Phase 5 puts them under an Actix `Supervisor` and rebuilds each from its row plus its `ProtocolConfig`, which is what finally makes `docker restart` recover a working node.
- Respawning repopulates `actor_inboxes`, so the gap this plan documents closes there.
- The `mailbox` table is still unused. Browser inboxes are `mpsc` queues, so undelivered messages do not survive a restart; persisting them is worth doing only once actors respawn to drain them.
- After Phase 5, `tests/persistence.rs` can finally assert a *full* restart rather than a store-level one.
