# Supervision and Restart Recovery Implementation Plan (Phase 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a restarted process come back as the same node — the helpers it provisioned running again with the identities and settings they had, their channels and shares intact — which is the promise the image exists to make.

**Architecture:** Three per-actor protocol settings that are currently minted at spawn time (`replica_id`) or passed in from a request (`timeout_secs`, `unpair_ack`) move onto the `actors` row, because an actor rebuilt with a fresh `replica_id` is a *different member* to every replica group that already holds its id. At boot, the node reads the registry and rebuilds: a `Role::Helper` row becomes a running `ProvisionedActor`; a `Role::Owner` row gets its browser mailbox back so messages buffer until the tab reclaims it. Helper actors go under an Actix `Supervisor` so a panicking handler does not silently remove a helper for the rest of the process's life.

**Tech Stack:** Rust, actix 0.13 (`Supervisor`, `Supervised`), `sqlx` 0.8, Axum 0.8.

**Spec:** `docs/superpowers/specs/2026-09-21-docker-packaging-design.md` — "Restart recovery" (line 334), "Implementation order" item 5 (line 753).

## Global Constraints

- **Baseline entering this plan:** backend `cargo test` = **209 passing, 18 suites, 0 failures, 0 warnings**. Frontend = **408**. e2e = **48 passed, 4 skipped, 0 failed**.
- **`replica_id` must survive a restart.** It is documented as a *stable per-device* id and is the key every stored `ReplicaMember` row references. Minting a fresh one on restart silently orphans every replica-group membership this node holds — the actor comes back as a stranger. This is the single most important thing in this plan.
- **Role already carries the hosting distinction.** In production `register_browser_actor` is reached only from `POST /owners` (`Role::Owner`) and `spawn_provisioned` only from `POST /helpers` (`Role::Helper`). Recovery uses that. Do **not** add an `is_provisioned`/`managed_by` column — the uniformity constraint forbids a column that marks an actor as a fixture, and `role` is a protocol attribute that already exists.
- **Browser-run actors are not respawned as backend actors.** A `Role::Owner`'s protocol lives in the page with its own keys. Recovery gives it an inbox, nothing more; the tab reclaims it through the existing `claim_actor_id` path.
- **`helper_channels` is derived.** It is rebuilt at boot from each respawned actor's channel store, which is why Phase 4c left it in memory.
- **One dialect for both engines**; no `unwrap()`/`expect()` in production paths.
- **The user commits.** Do **not** run `git commit`, `git add` or `git stash`.

---

## Task 1: Persist the per-actor protocol settings

**Files:**
- Modify: `apps/backend/migrations/0001_initial.sql`
- Modify: `apps/backend/src/registry/actors.rs`
- Modify: `apps/backend/tests/registry.rs`

**Interfaces:**
- Produces `pub struct ActorSettings { pub replica_id: u64, pub timeout_secs: u32, pub unpair_ack: UnpairAck }`
- `register` gains a settings argument; `settings(&Uuid) -> Result<Option<ActorSettings>, RegistryError>`.

- [ ] **Step 1: Add the columns**

`0001_initial.sql` is unreleased, so edit in place and delete any local `derec.db` afterwards.

```sql
    -- Protocol settings this actor runs with, kept so a restart rebuilds the
    -- same actor rather than a new one wearing its name.
    --
    -- `replica_id` matters most: it is the stable per-device id every stored
    -- ReplicaMember row references, so an actor rebuilt with a fresh one is a
    -- stranger to every replica group that already holds its old id. Decimal
    -- TEXT, like every other u64 here.
    --
    -- The other two are behavioural: a helper provisioned with a 60-second
    -- timeout should come back with one, not silently revert to the node
    -- default. Unused for a browser-run actor, whose protocol settings live in
    -- the page.
    replica_id  TEXT NOT NULL,
    timeout_secs INTEGER NOT NULL,
    unpair_ack  TEXT NOT NULL CHECK (unpair_ack IN ('required', 'not_required')),
```

- [ ] **Step 2: Write the failing test**

Append to `tests/registry.rs`:

```rust
#[tokio::test]
async fn an_actors_protocol_settings_survive() {
    // `replica_id` is the one that matters: every stored ReplicaMember row
    // references it, so an actor rebuilt with a fresh one is a stranger to the
    // group it belonged to.
    on_every_engine(|pool| async move {
        let registry = SqlActorRegistry::new(pool);
        let helper = actor("Alex", Role::Helper);
        let settings = ActorSettings {
            replica_id: u64::MAX - 3,
            timeout_secs: 60,
            unpair_ack: UnpairAck::NotRequired,
        };

        registry
            .register(helper.clone(), settings.clone())
            .await
            .expect("register");

        let loaded = registry
            .settings(&helper.id)
            .await
            .expect("readable")
            .expect("settings are stored alongside the actor");

        assert_eq!(
            loaded.replica_id,
            u64::MAX - 3,
            "a replica id above i64::MAX must round-trip exactly"
        );
        assert_eq!(loaded.timeout_secs, 60);
        assert_eq!(loaded.unpair_ack, UnpairAck::NotRequired);
    })
    .await;
}
```

- [ ] **Step 3: Implement**

Add to `registry/actors.rs`:

```rust
/// The protocol settings an actor runs with, kept so a restart rebuilds the
/// same actor rather than a new one wearing its name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActorSettings {
    /// Stable per-device replica id. Regenerating this on restart makes the
    /// actor a stranger to every replica group holding its old id.
    pub replica_id: u64,
    pub timeout_secs: u32,
    pub unpair_ack: UnpairAck,
}
```

`register` takes `(actor, settings)` and binds the three extra columns; add `settings(&Uuid)` reading them back. Encode `unpair_ack` as `"required"`/`"not_required"` with an exhaustive match, and `replica_id` through `id_to_text`/`text_to_id` from `crate::sql`.

- [ ] **Step 4: Run**

Run: `cd apps/backend && cargo test --test registry 2>&1 | grep -E "test result|FAILED"`
Expected: all pass. Existing `register` call sites will not compile until Task 2.

- [ ] **Step 5: Report, do not commit**

---

## Task 2: `spawn_provisioned` takes the settings it should run with

**Files:**
- Modify: `apps/backend/src/provisioning.rs`
- Modify: `apps/backend/src/routes/helpers.rs`, `owners.rs`

- [ ] **Step 1: Change the signature**

`spawn_provisioned` currently mints `replica_id: Some(rand::random())` internally, which is exactly what must stop — a respawn has to use the stored one.

```rust
pub fn spawn_provisioned(state: &AppState, actor: &Actor, settings: &ActorSettings) {
```

and inside, `replica_id: Some(settings.replica_id)`, `timeout_secs: settings.timeout_secs`, `unpair_ack: settings.unpair_ack`.

- [ ] **Step 2: Mint at the route, not at the spawn**

In `routes/helpers.rs`, both call sites build the settings once, register them with the actor, and pass the same value to `spawn_provisioned`:

```rust
    let settings = ActorSettings {
        // Minted here rather than inside `spawn_provisioned`, so the value
        // that is stored is the value the actor runs with — a respawn reads it
        // back rather than inventing a new one.
        replica_id: rand::random::<u64>(),
        timeout_secs,
        unpair_ack,
    };
```

`routes/owners.rs` registers a browser-run actor, whose protocol settings live in the page. Store the node defaults so the row is well-formed, with a comment saying they are unused.

- [ ] **Step 3: Build and run the suite**

Run: `cd apps/backend && cargo test 2>&1 | grep -E "^test result|FAILED" | head -20`
Expected: all suites pass.

- [ ] **Step 4: Report, do not commit**

---

## Task 3: Rebuild the node at boot

The heart of the plan.

**Files:**
- Create: `apps/backend/src/recovery.rs`
- Modify: `apps/backend/src/lib.rs`, `apps/backend/src/main.rs`

**Interfaces:**
- `pub async fn recover(state: &Arc<AppState>) -> RecoveryReport`
- `pub struct RecoveryReport { pub helpers: usize, pub browser_actors: usize, pub channels: usize, pub failed: usize }`

- [ ] **Step 1: Implement**

Create `apps/backend/src/recovery.rs`:

```rust
//! Rebuilding the node from the database at boot.
//!
//! Persisting state is only half of a restart: rows with nothing running
//! against them are a node that lists helpers which never answer. This turns
//! the rows back into actors.
//!
//! What gets rebuilt depends on where the actor runs, which `role` already
//! records — `POST /helpers` provisions backend-run helpers, `POST /owners`
//! registers browser-run owners:
//!
//! * a `Role::Helper` becomes a running `ProvisionedActor` again, with the
//!   `replica_id` and protocol settings it had;
//! * a `Role::Owner` gets its browser mailbox back and nothing else. Its
//!   protocol lives in the page with its own keys, so there is nothing here to
//!   rebuild; the inbox means messages buffer until the tab reclaims it through
//!   the existing `claim_actor_id` path rather than being dropped as
//!   undeliverable.
//!
//! One actor failing does not stop the rest: a node that recovers nine of ten
//! helpers is better than one that recovers none, and the count is reported.

use std::sync::Arc;

use tracing::{error, info, warn};

use crate::models::Role;
use crate::provisioning::{register_browser_actor, spawn_provisioned};
use crate::state::AppState;

/// What a boot recovered.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct RecoveryReport {
    pub helpers: usize,
    pub browser_actors: usize,
    /// Entries put back into the derived `helper_channels` index.
    pub channels: usize,
    pub failed: usize,
}

pub async fn recover(state: &Arc<AppState>) -> RecoveryReport {
    let mut report = RecoveryReport::default();

    let actors = match state.actors.all().await {
        Ok(actors) => actors,
        Err(e) => {
            error!(error = %e, "could not read the actor registry; nothing recovered");
            return report;
        }
    };

    if actors.is_empty() {
        return report;
    }

    for actor in actors {
        match actor.role {
            Role::Owner => {
                // Browser-run: give it an inbox so traffic buffers, and leave
                // the protocol to the page.
                register_browser_actor(state, actor.id);
                report.browser_actors += 1;
            }
            Role::Helper => {
                let settings = match state.actors.settings(&actor.id).await {
                    Ok(Some(settings)) => settings,
                    Ok(None) => {
                        // A row without settings cannot be rebuilt faithfully,
                        // and rebuilding it with a fresh `replica_id` would be
                        // worse than leaving it down: it would answer as a
                        // member its group does not recognise.
                        warn!(
                            actor_id = %actor.id,
                            "helper has no stored protocol settings; not respawned"
                        );
                        report.failed += 1;
                        continue;
                    }
                    Err(e) => {
                        error!(actor_id = %actor.id, error = %e, "could not read settings");
                        report.failed += 1;
                        continue;
                    }
                };

                spawn_provisioned(state, &actor, &settings);
                report.helpers += 1;
            }
        }
    }

    report.channels = rebuild_channel_index(state).await;

    info!(
        helpers = report.helpers,
        browser_actors = report.browser_actors,
        channels = report.channels,
        failed = report.failed,
        "node recovered from the database"
    );

    report
}

/// Repopulate the derived `helper_channels` index from each respawned actor.
///
/// It is deliberately not persisted — every entry restates a channel the
/// actor's own channel store already holds — so this is where it comes back
/// from. Asking the actors rather than the tables keeps one source of truth.
async fn rebuild_channel_index(state: &Arc<AppState>) -> usize {
    let mut total = 0;

    let ids: Vec<uuid::Uuid> = state
        .actor_inboxes
        .iter()
        .map(|entry| *entry.key())
        .collect();

    for actor_id in ids {
        let Some(addr) = crate::routes::actors::provisioned_addr(state, &actor_id) else {
            continue;
        };
        let Ok(Ok(channels)) = addr.send(crate::actor::ListChannelsMsg).await else {
            continue;
        };

        let ids: Vec<String> = channels.into_iter().map(|c| c.channel_id).collect();
        if !ids.is_empty() {
            total += ids.len();
            state.helper_channels.insert(actor_id, ids);
        }
    }

    total
}
```

**Check `ListChannelsMsg`'s exact return type** against `actor.rs` before writing the `let Ok(Ok(..))` — it is `Result<Vec<..>, _>` inside the actix `Result`, and the element's channel-id field name must match. Follow the source.

- [ ] **Step 2: Call it at boot**

In `main.rs`, replace the "actors recovered … not respawned yet" log added in Phase 4c with the real thing, after the state is built and before serving:

```rust
    let recovered = derec_backend::recovery::recover(&state).await;
    if recovered.failed > 0 {
        warn!(
            failed = recovered.failed,
            "some actors could not be recovered; see the warnings above"
        );
    }
```

Add `pub mod recovery;` to `lib.rs`.

- [ ] **Step 3: Report, do not commit**

---

## Task 4: Supervise the helpers

**Files:**
- Modify: `apps/backend/src/actor.rs`
- Modify: `apps/backend/src/provisioning.rs`

- [ ] **Step 1: Implement `Supervised`**

A panicking handler currently stops the actor for the rest of the process's life — the helper is simply gone, and the only symptom is a peer whose messages stop being answered.

```rust
impl actix::Supervised for ProvisionedActor {
    /// Called instead of `stopped` when a handler panics.
    ///
    /// The actor value survives — actix reuses it rather than constructing a
    /// new one — so the protocol instances, their stores and the inbox binding
    /// all come back with it. Nothing to rebuild here; this exists to say so,
    /// and to make the restart visible rather than silent.
    fn restarting(&mut self, _ctx: &mut Context<Self>) {
        tracing::warn!(
            actor_id = %self.actor_id,
            "actor restarted after a panic; protocol state is retained"
        );
    }
}
```

- [ ] **Step 2: Start under a supervisor**

In `provisioning.rs`, `Supervisor::start` replaces `.start()`. Note it takes a closure receiving the context:

```rust
    let addr = actix::Supervisor::start_in_arbiter(&state.arbiter, move |_ctx| actor);
```

**Check what the current spawn actually calls** — it may already use `start_in_arbiter` because these actors run on a dedicated arbiter. Keep the arbiter behaviour and change only the supervision, and verify the closure signature against the actix version in `Cargo.lock` rather than this plan.

- [ ] **Step 3: Full suite**

Run: `cd apps/backend && cargo test 2>&1 | grep -cE "^test result: ok"`
Expected: 18, no `FAILED`, no warnings.

- [ ] **Step 4: Report, do not commit**

---

## Task 5: Prove a real restart

**Files:**
- Modify: `apps/backend/tests/persistence.rs`

Until now `persistence.rs` proves a *store* survives a pool being dropped. This proves the *node* survives.

- [ ] **Step 1: Write the test**

```rust
#[actix_rt::test]
async fn a_helper_provisioned_before_a_restart_comes_back_with_its_identity() {
    // The whole point of the phase. A helper is provisioned, the "process"
    // ends, and a new state over the same database rebuilds it — with the same
    // replica_id, because every ReplicaMember row in a group references it.
    let dir = std::env::temp_dir().join(format!("derec-restart-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let url = db::resolve_url(&dir.join("derec.db").to_string_lossy());

    let (actor_id, replica_id) = {
        let pool = db::connect(&url).await.expect("connect");
        let state = /* AppState::new(..., pool) */;

        let helper = provisioned_actor(/* .. */);
        let settings = ActorSettings { replica_id: u64::MAX - 11, timeout_secs: 300,
                                       unpair_ack: UnpairAck::Required };
        state.actors.register(helper.clone(), settings.clone()).await.expect("register");
        spawn_provisioned(&state, &helper, &settings);

        (helper.id, settings.replica_id)
    };

    // A new "process" over the same database.
    {
        let pool = db::connect(&url).await.expect("reconnect");
        let state = /* AppState::new(..., pool) */;

        let report = derec_backend::recovery::recover(&state).await;
        assert_eq!(report.helpers, 1, "the helper must be respawned");
        assert_eq!(report.failed, 0);

        assert!(
            state.actor_inboxes.contains_key(&actor_id),
            "a respawned helper must have an inbox, or it cannot be reached"
        );

        let settings = state.actors.settings(&actor_id).await.expect("readable")
            .expect("settings survive");
        assert_eq!(
            settings.replica_id, replica_id,
            "the replica id must be the one it had — a fresh one makes this \
             actor a stranger to every group holding its old id"
        );
    }

    std::fs::remove_dir_all(&dir).ok();
}
```

Fill the `AppState::new` calls from `test_support::app_state`'s shape, passing the file-backed pool rather than an in-memory one. `#[actix_rt::test]`, because spawning needs an arbiter.

- [ ] **Step 2: Run**

Run: `cd apps/backend && cargo test --test persistence 2>&1 | grep -E "test result|FAILED"`
Expected: 3 passed.

- [ ] **Step 3: Full verification**

Run: `cd apps/backend && cargo test 2>&1 | grep -cE "^test result: ok"` — 18, no failures, no warnings.
Run: `cd apps/web && npx vitest run` — 408.
Run: `cd apps/web && npm run test:e2e` — **48 passed, 4 skipped, 0 failed**.

**The e2e run is the one that matters.** Every defect in phases 4b and 4c that unit tests and two-engine conformance missed was caught there. Read `test-results/**/error-context.md` before forming a hypothesis if anything fails.

- [ ] **Step 4: Report, do not commit**

---

## Definition of Done

- [ ] `cargo test`: **18 suites, ≥ 215 tests, 0 failures, 0 warnings**
- [ ] `npx vitest run`: **408**
- [ ] `npm run test:e2e`: **48 passed, 0 failed**
- [ ] A helper provisioned before a restart is running after one, **with the same `replica_id`**
- [ ] A browser-run owner gets its inbox back, and is **not** respawned as a backend actor
- [ ] `helper_channels` is rebuilt from the actors, not from a table
- [ ] Boot reports what it recovered, and what it could not
- [ ] No `is_provisioned`-style column was added
- [ ] Every file left **unstaged**

## Notes for the next plan (Phases 6–8 — the image)

- `ServeDir` fallback behind `server.static_dir`; SIGTERM joined to the existing SIGINT arm — `docker stop` currently waits the full timeout and is then SIGKILLed, which now closes a pool mid-write.
- `VITE_API_SAME_ORIGIN` in `resolveApiBase()`, so a page served on `:8080` calls `:8080` rather than the derived `:5000`.
- The Dockerfile: three stages, `VOLUME /var/lib/derec`, non-root user, entrypoint reconciling bind-mount ownership, healthcheck on `/health`. The image sets `DEREC_DATABASE_URL=/var/lib/derec/derec.db` — the code default is deliberately the locally-usable `derec.db`.
- The `mailbox` table is still unused: browser inboxes are `mpsc` queues, so undelivered messages do not survive a restart. Now that owners get their inbox back at boot, persisting the queue behind it is a coherent next step rather than a loose end.
