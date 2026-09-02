# Per-Secret Protocol Instances Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each provisioned actor a map of protocol instances keyed by `secret_id`, with inbound messages routed to the owning instance by the envelope's cleartext `channel_id`.

**Architecture:** A `ProvisionedActor` currently owns exactly one `ActorProtocol`, which forces a replica to be a separate actor because a replica's instance must bind to the *owner's* `secret_id`. This plan replaces that single slot with an `InstanceMap`: one "own" instance serving all helper-role channels, plus one instance per replicated owner secret. Channel ownership is *reconciled* from each instance's own channel store after any operation that borrows it — creation, the handshake's id rotation and teardown all happen where the caller cannot observe them, so reconciliation covers all three with one mechanism. Ownership is never inferred from inbound traffic, and an unrecognised channel is dropped with a log line rather than routed to a fallback.

**Tech Stack:** Rust, Actix actors, `prost` (already a declared but unused dependency), `derec-library` 0.0.2, `derec-proto` 0.0.2.

**Spec:** `docs/superpowers/specs/2026-09-01-node-separation-admin-ui-design.md`

## Phase Roadmap

This is plan 1 of 5. Each produces working software on its own.

| # | Plan | Status |
|---|---|---|
| 1 | **Per-secret protocol instances** (this document) | in progress |
| 2 | Actor model cleanup — delete `Role::Replica`, drop role path segments, rename participants→helpers, adapt FE | not started |
| 3 | Persistence + supervision — `sqlx` (SQLite/Postgres), `Supervisor`, uniformity tests | not started |
| 4 | Node separation — two nodes, three modes, owner independence, two-entry FE | not started |
| 5 | Admin UI — auth, panels, config domains, message tap, inspection, wizard slimming | not started |

Docker packaging follows as a separate spec once 1–5 land.

**Scope of this plan:** backend-internal only. No HTTP API changes, no frontend changes. The application behaves identically when this plan completes; what changes is that replica capability no longer requires a distinct actor kind. Plan 2 consumes that to delete `Role::Replica`.

## Global Constraints

- **The protocol is immutable.** No changes to `derec-library`, `derec-proto`, the protobufs, or `../lib-derec`. `../lib-derec` is read-only reference material.
- **Verify SDK facts against the pinned published versions**, not `../lib-derec` (which is on `feature/grpc_support` and may diverge). Authoritative Rust source: `~/.cargo/registry/src/*/derec-library-0.0.2/` and `~/.cargo/registry/src/*/derec-proto-0.0.2/`.
- **No commits by the implementer.** Each task ends with a passing test run, then STOP for the user to review and commit. The user commits their own work.
- **No `unwrap()` / `expect()` in production paths.** Test code may use them.
- **No public API change in this plan.** If a task appears to require one, stop and flag it.
- `DeRecMessage` envelope field names in Rust are snake_case: `protocol_version_major`, `protocol_version_minor`, `sequence`, `channel_id`, `timestamp`, `message`, `trace_id`. There is **no** `message_type` field in 0.0.2.
- Run backend tests with `cargo test` from `apps/backend`.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/backend/src/envelope.rs` | **new** — decode a `DeRecMessage` envelope and expose its cleartext metadata. Pure functions, no actor or HTTP knowledge. |
| `apps/backend/src/instances.rs` | **new** — `InstanceMap<P>`: instances by `secret_id`, channel→secret index, borrow/restore discipline. Generic over the instance type so it is unit-testable without a real protocol. |
| `apps/backend/src/actor.rs` | **modify** — `ProvisionedActor` holds an `InstanceMap<ActorProtocol>` instead of `Option<ActorProtocol>`; routing, channel indexing, and the `Reconfigure` handler. |
| `apps/backend/src/main.rs` | **modify** — register the two new modules. |

`instances.rs` is kept separate from `actor.rs` deliberately: `actor.rs` is already 26KB, and the borrow/restore discipline is the part most worth testing in isolation.

---

## Task 1: Envelope decoding

**Files:**
- Create: `apps/backend/src/envelope.rs`
- Modify: `apps/backend/src/main.rs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `pub struct EnvelopeMeta { pub channel_id: u64, pub sequence: u32, pub trace_id: u64, pub protocol_version_major: u32, pub protocol_version_minor: u32, pub payload_len: usize }`
  - `pub fn decode(bytes: &[u8]) -> Result<EnvelopeMeta, EnvelopeError>`
  - `pub enum EnvelopeError { Malformed(prost::DecodeError) }`

- [ ] **Step 1: Register the module**

In `apps/backend/src/main.rs`, add to the module list (alphabetical, next to `mod config;`):

```rust
mod envelope;
```

- [ ] **Step 2: Write the failing tests**

Create `apps/backend/src/envelope.rs`:

```rust
//! Cleartext metadata from a `DeRecMessage` envelope.
//!
//! The envelope is not encrypted; only its `message` payload is. That makes
//! `channel_id` readable without any key material, which is what lets an actor
//! route an inbound message to the protocol instance that owns the channel.
//!
//! Message *type* is inside the encrypted payload and is deliberately not
//! available here.

use prost::Message as _;

/// Cleartext fields of a `DeRecMessage` envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvelopeMeta {
    pub channel_id: u64,
    pub sequence: u32,
    pub trace_id: u64,
    pub protocol_version_major: u32,
    pub protocol_version_minor: u32,
    /// Length of the encrypted payload, for observability. The payload itself
    /// is never retained.
    pub payload_len: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum EnvelopeError {
    #[error("malformed DeRec envelope: {0}")]
    Malformed(#[from] prost::DecodeError),
}

/// Read the cleartext metadata from an inbound envelope.
pub fn decode(bytes: &[u8]) -> Result<EnvelopeMeta, EnvelopeError> {
    let msg = derec_proto::DeRecMessage::decode(bytes)?;

    Ok(EnvelopeMeta {
        channel_id: msg.channel_id,
        sequence: msg.sequence,
        trace_id: msg.trace_id,
        protocol_version_major: msg.protocol_version_major,
        protocol_version_minor: msg.protocol_version_minor,
        payload_len: msg.message.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(channel_id: u64, sequence: u32, trace_id: u64, payload: &[u8]) -> Vec<u8> {
        let msg = derec_proto::DeRecMessage {
            protocol_version_major: 1,
            protocol_version_minor: 2,
            sequence,
            channel_id,
            timestamp: None,
            message: payload.to_vec(),
            trace_id,
        };
        let mut buf = Vec::new();
        msg.encode(&mut buf).expect("encoding a constructed message cannot fail");
        buf
    }

    #[test]
    fn reads_the_cleartext_fields() {
        let bytes = envelope(0xDEAD_BEEF, 7, 0xC0FFEE, &[1, 2, 3, 4]);

        let meta = decode(&bytes).expect("a well-formed envelope decodes");

        assert_eq!(meta.channel_id, 0xDEAD_BEEF);
        assert_eq!(meta.sequence, 7);
        assert_eq!(meta.trace_id, 0xC0FFEE);
        assert_eq!(meta.protocol_version_major, 1);
        assert_eq!(meta.protocol_version_minor, 2);
        assert_eq!(meta.payload_len, 4);
    }

    #[test]
    fn an_encrypted_payload_is_not_required_to_be_readable() {
        // The payload is ciphertext. Decoding must not care what is in it —
        // routing happens on the envelope alone.
        let bytes = envelope(42, 1, 0, &[0xFF; 64]);

        let meta = decode(&bytes).expect("ciphertext payloads decode fine");

        assert_eq!(meta.channel_id, 42);
        assert_eq!(meta.payload_len, 64);
    }

    #[test]
    fn garbage_is_rejected_rather_than_guessed_at() {
        // A byte string that is not a valid protobuf must not silently produce
        // channel 0, which would route it to whichever instance owns channel 0.
        let bytes = [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF];

        assert!(decode(&bytes).is_err());
    }

    #[test]
    fn an_empty_body_is_not_a_valid_envelope_to_route() {
        // Empty input decodes to an all-default message under proto3. Routing on
        // channel 0 would be wrong, so callers must treat channel 0 as unroutable
        // rather than relying on a decode error here.
        let meta = decode(&[]).expect("proto3 decodes empty input to defaults");
        assert_eq!(meta.channel_id, 0);
    }
}
```

- [ ] **Step 3: Run the tests and verify they fail to compile**

Run: `cargo test --manifest-path apps/backend/Cargo.toml envelope`
Expected: compile error — `mod envelope` not yet resolvable, or `thiserror` import unused. `thiserror` and `prost` are already in `Cargo.toml`, so the only expected failure is the missing module registration from Step 1 if it was skipped.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cargo test --manifest-path apps/backend/Cargo.toml envelope`
Expected: 4 tests pass.

- [ ] **Step 5: Verify `prost` is now a used dependency**

Run: `cargo build --manifest-path apps/backend/Cargo.toml 2>&1 | grep -i "unused"`
Expected: no warning naming `prost`.

- [ ] **Step 6: STOP for review**

Report: files changed, test output. The user reviews and commits.

---

## Task 2: The instance map

**Files:**
- Create: `apps/backend/src/instances.rs`
- Modify: `apps/backend/src/main.rs`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `pub struct InstanceMap<P>`
  - `pub fn new(own_secret_id: u64, own: P) -> Self`
  - `pub fn own_secret_id(&self) -> u64`
  - `pub fn insert(&mut self, secret_id: u64, instance: P)`
  - `pub fn contains(&self, secret_id: u64) -> bool`
  - `pub fn secret_ids(&self) -> Vec<u64>`
  - `pub fn reconcile(&mut self, secret_id: u64, current: &[u64])`
  - `pub fn secret_for_channel(&self, channel_id: u64) -> Option<u64>`
  - `pub fn take(&mut self, secret_id: u64) -> Option<P>`
  - `pub fn restore(&mut self, secret_id: u64, instance: P)`
  - `pub fn take_for_channel(&mut self, channel_id: u64) -> Option<(u64, P)>`

The map is generic over `P` so it can be tested without constructing a real `ActorProtocol`, which requires a live transport and stores.

- [ ] **Step 1: Register the module**

In `apps/backend/src/main.rs`, add:

```rust
mod instances;
```

- [ ] **Step 2: Write the failing tests**

Create `apps/backend/src/instances.rs`:

```rust
//! Protocol instances held by one provisioned actor, keyed by the `secret_id`
//! each is bound to.
//!
//! An actor has exactly one "own" instance, bound to the secret it protects as
//! Owner. All helper-role channels live in that instance: shares are separated
//! by `channel_id` and each carries its own Owner's `secret_id` on the record.
//!
//! Replica mode is the exception. A replica mirrors one named owner's vault and
//! the share store keys on `(secret_id, channel_id, version, replica_id)`, so a
//! replica needs an instance bound to *that owner's* secret. Hence a map rather
//! than a single slot.
//!
//! Channel ownership is recorded when a channel is **created** — a contact is
//! minted, or a pairing is initiated — never inferred from inbound traffic. An
//! unrecognised channel is an error, not a routing fallback: guessing would
//! hand a peer's message to an instance that does not own it.

use std::collections::HashMap;

pub struct InstanceMap<P> {
    /// `None` while an instance is borrowed by an in-flight async call.
    instances: HashMap<u64, Option<P>>,
    /// `channel_id` → the `secret_id` of the instance that owns it.
    channel_owner: HashMap<u64, u64>,
    own_secret_id: u64,
}

impl<P> InstanceMap<P> {
    pub fn new(own_secret_id: u64, own: P) -> Self {
        let mut instances = HashMap::new();
        instances.insert(own_secret_id, Some(own));
        Self {
            instances,
            channel_owner: HashMap::new(),
            own_secret_id,
        }
    }

    pub fn own_secret_id(&self) -> u64 {
        self.own_secret_id
    }

    pub fn insert(&mut self, secret_id: u64, instance: P) {
        self.instances.insert(secret_id, Some(instance));
    }

    pub fn contains(&self, secret_id: u64) -> bool {
        self.instances.contains_key(&secret_id)
    }

    pub fn secret_ids(&self) -> Vec<u64> {
        self.instances.keys().copied().collect()
    }

    /// Make the index match an instance's actual channels.
    ///
    /// Called after any operation that borrows an instance, because all three of
    /// creation, rotation and teardown happen where the caller cannot see them:
    /// the library creates channels inside `start()` and `process()` as well as
    /// at contact minting, and the pairing handshake atomically rotates the
    /// transient id to a long-term one without returning it. Reconciling against
    /// the instance's own channel store covers all three with one mechanism.
    ///
    /// Only this instance's bindings are touched; other instances keep theirs.
    pub fn reconcile(&mut self, secret_id: u64, current: &[u64]) {
        self.channel_owner.retain(|_, owner| *owner != secret_id);
        for channel_id in current {
            self.channel_owner.insert(*channel_id, secret_id);
        }
    }

    pub fn secret_for_channel(&self, channel_id: u64) -> Option<u64> {
        self.channel_owner.get(&channel_id).copied()
    }

    /// Borrow an instance. Returns `None` if it does not exist or is already
    /// borrowed by an in-flight call.
    pub fn take(&mut self, secret_id: u64) -> Option<P> {
        self.instances.get_mut(&secret_id)?.take()
    }

    pub fn restore(&mut self, secret_id: u64, instance: P) {
        self.instances.insert(secret_id, Some(instance));
    }

    /// Borrow the instance that owns a channel, with its `secret_id`.
    pub fn take_for_channel(&mut self, channel_id: u64) -> Option<(u64, P)> {
        let secret_id = self.secret_for_channel(channel_id)?;
        let instance = self.take(secret_id)?;
        Some((secret_id, instance))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWN: u64 = 0xA1;
    const ALICE: u64 = 0x7F;

    fn map() -> InstanceMap<&'static str> {
        InstanceMap::new(OWN, "own")
    }

    #[test]
    fn the_own_instance_is_present_from_construction() {
        let m = map();
        assert_eq!(m.own_secret_id(), OWN);
        assert!(m.contains(OWN));
    }

    #[test]
    fn a_replica_instance_coexists_with_the_own_instance() {
        let mut m = map();
        m.insert(ALICE, "alice-replica");

        assert!(m.contains(OWN));
        assert!(m.contains(ALICE));

        let mut ids = m.secret_ids();
        ids.sort_unstable();
        assert_eq!(ids, vec![ALICE, OWN]);
    }

    #[test]
    fn a_channel_routes_to_the_instance_it_was_bound_to() {
        let mut m = map();
        m.insert(ALICE, "alice-replica");
        m.reconcile(OWN, &[100]);
        m.reconcile(ALICE, &[200]);

        assert_eq!(m.take_for_channel(100), Some((OWN, "own")));
        assert_eq!(m.take_for_channel(200), Some((ALICE, "alice-replica")));
    }

    #[test]
    fn an_unknown_channel_does_not_fall_back_to_the_own_instance() {
        // The whole point of the index: guessing would hand a peer's message to
        // an instance that does not own the channel.
        let mut m = map();
        assert_eq!(m.take_for_channel(999), None);
    }

    #[test]
    fn a_borrowed_instance_cannot_be_borrowed_twice() {
        let mut m = map();
        m.reconcile(OWN, &[100]);

        assert_eq!(m.take(OWN), Some("own"));
        assert_eq!(m.take(OWN), None, "still borrowed");
        assert_eq!(m.take_for_channel(100), None, "still borrowed");
    }

    #[test]
    fn restoring_makes_an_instance_borrowable_again() {
        let mut m = map();

        let borrowed = m.take(OWN).expect("present");
        m.restore(OWN, borrowed);

        assert_eq!(m.take(OWN), Some("own"));
    }

    #[test]
    fn reconciling_binds_channels_the_instance_now_holds() {
        let mut m = map();

        m.reconcile(OWN, &[100, 101]);

        assert_eq!(m.secret_for_channel(100), Some(OWN));
        assert_eq!(m.secret_for_channel(101), Some(OWN));
    }

    #[test]
    fn reconciling_retires_the_rotated_pairing_id() {
        // The handshake rotates the transient pairing id to a long-term one and
        // the library refuses traffic on the old id afterwards. After the
        // rotation the store lists only the new id.
        let mut m = map();
        m.reconcile(OWN, &[100]);

        m.reconcile(OWN, &[101]);

        assert_eq!(m.secret_for_channel(100), None, "old id is retired");
        assert_eq!(m.secret_for_channel(101), Some(OWN));
    }

    #[test]
    fn reconciling_drops_a_torn_down_channel() {
        let mut m = map();
        m.reconcile(OWN, &[100, 101]);

        m.reconcile(OWN, &[100]);

        assert_eq!(m.secret_for_channel(101), None);
        assert_eq!(m.secret_for_channel(100), Some(OWN));
    }

    #[test]
    fn reconciling_one_instance_leaves_another_alone() {
        // The retain() sweep must be scoped by secret id, or reconciling the own
        // instance would silently unroute every replica channel.
        let mut m = map();
        m.insert(ALICE, "alice-replica");
        m.reconcile(ALICE, &[200]);

        m.reconcile(OWN, &[100]);

        assert_eq!(m.secret_for_channel(200), Some(ALICE), "untouched");
        assert_eq!(m.secret_for_channel(100), Some(OWN));
    }

    #[test]
    fn two_owners_replicated_by_one_actor_stay_separate() {
        const CAROL: u64 = 0xC3;
        let mut m = map();
        m.insert(ALICE, "alice-replica");
        m.insert(CAROL, "carol-replica");
        m.reconcile(ALICE, &[200]);
        m.reconcile(CAROL, &[300]);

        assert_eq!(m.take_for_channel(300), Some((CAROL, "carol-replica")));
        // Borrowing Carol's must not affect Alice's.
        assert_eq!(m.take_for_channel(200), Some((ALICE, "alice-replica")));
    }
}
```

- [ ] **Step 3: Run the tests and verify they pass**

Run: `cargo test --manifest-path apps/backend/Cargo.toml instances`
Expected: 11 tests pass.

- [ ] **Step 4: STOP for review**

Report: test output. The user reviews and commits.

---

## Task 3: Behaviour-preserving switch to the instance map

**Files:**
- Modify: `apps/backend/src/actor.rs:121-142` (struct and constructor), `:317-362` (`TickMsg`), `:446-480` (`ProcessDelayed`), `:482-500` (`ListChannelsMsg`), and every other handler that calls `self.protocol.take()`

**Interfaces:**
- Consumes: `InstanceMap` from Task 2.
- Produces: `ProvisionedActor` with field `instances: InstanceMap<ActorProtocol>` replacing `protocol: Option<ActorProtocol>`. Constructor signature is unchanged: `ProvisionedActor::new(protocol, actor_id, role, state)`.

This task changes no behaviour. Every existing handler keeps operating on the own instance. Routing arrives in Task 5.

- [ ] **Step 1: Change the struct and constructor**

In `apps/backend/src/actor.rs`, replace the `ProvisionedActor` struct and its `new`:

```rust
pub struct ProvisionedActor {
    /// Protocol instances by the `secret_id` each is bound to. See
    /// [`crate::instances`] for why an actor needs more than one.
    instances: crate::instances::InstanceMap<ActorProtocol>,
    actor_id: Uuid,
    role: Role,
    state: Arc<AppState>,
}

impl ProvisionedActor {
    pub fn new(
        protocol: ActorProtocol,
        actor_id: Uuid,
        role: Role,
        state: Arc<AppState>,
    ) -> Self {
        let own_secret_id = protocol.secret_id();
        Self {
            instances: crate::instances::InstanceMap::new(own_secret_id, protocol),
            actor_id,
            role,
            state,
        }
    }

    /// The instance bound to this actor's own secret — the one that serves every
    /// helper-role channel.
    fn take_own(&mut self) -> Option<ActorProtocol> {
        self.instances.take(self.instances.own_secret_id())
    }

    fn restore_own(&mut self, protocol: ActorProtocol) {
        let own = self.instances.own_secret_id();
        self.instances.restore(own, protocol);
    }
}
```

- [ ] **Step 2: Update `TickMsg` to tick every instance**

Replace the body of `Handler<TickMsg>` (`actor.rs:320`). Each instance owns its own rounds and timeouts, so all of them must advance, not just the own one:

```rust
fn handle(&mut self, _msg: TickMsg, _ctx: &mut Context<Self>) -> Self::Result {
    // Collect the instances that are free right now. One borrowed by an
    // in-flight call advances time itself; skipping it is safe because the
    // next interval picks it up.
    let mut borrowed: Vec<(u64, ActorProtocol)> = Vec::new();
    for secret_id in self.instances.secret_ids() {
        if let Some(protocol) = self.instances.take(secret_id) {
            borrowed.push((secret_id, protocol));
        }
    }

    if borrowed.is_empty() {
        return Box::pin(actix::fut::ready(()));
    }

    Box::pin(
        async move {
            let mut done = Vec::with_capacity(borrowed.len());
            for (secret_id, mut protocol) in borrowed {
                let events = protocol.tick().await;
                let swept = protocol
                    .remove_expired_channels(PENDING_CHANNEL_TTL_SECS)
                    .await;
                done.push((secret_id, protocol, events, swept));
            }
            done
        }
        .into_actor(self)
        .map(|done, actor, _ctx| {
            for (secret_id, protocol, events, swept) in done {
                actor.instances.restore(secret_id, protocol);

                if !events.is_empty() {
                    actor.handle_events(&events);
                }
                match swept {
                    Ok(removed) if !removed.is_empty() => {
                        warn!(
                            actor_id = %actor.actor_id,
                            secret_id = secret_id,
                            count = removed.len(),
                            "swept pending channels that were never confirmed"
                        );
                    }
                    Ok(_) => {}
                    Err(e) => {
                        error!(
                            actor_id = %actor.actor_id,
                            secret_id = secret_id,
                            error = %e,
                            "expired-channel sweep failed"
                        );
                    }
                }
            }
        }),
    )
}
```

- [ ] **Step 3: Update every remaining `self.protocol.take()` call site**

Search for them:

Run: `grep -n "self\.protocol" apps/backend/src/actor.rs`

For each hit, apply this mechanical substitution:

- `self.protocol.take()` → `self.take_own()`
- `actor.protocol = Some(protocol)` → `actor.restore_own(protocol)`
- `self.protocol = Some(protocol)` → `self.restore_own(protocol)`

Handlers affected: `ProcessDelayed`, `ListChannelsMsg`, `LinkChannelsMsg`, `CreateContactMsg`, `StartFlowMsg`, `LoadSharedKeyMsg`, `GetFingerprintMsg`, `VerifyFingerprintMsg`.

- [ ] **Step 4: Verify no `self.protocol` references remain**

Run: `grep -n "self\.protocol\|actor\.protocol" apps/backend/src/actor.rs`
Expected: no output.

- [ ] **Step 5: Build and run the full suite**

Run: `cargo test --manifest-path apps/backend/Cargo.toml`
Expected: everything that passed before still passes. This task is behaviour-preserving; a failure here is a regression, not an expected red.

- [ ] **Step 6: STOP for review**

Report: the `grep` output from Step 4 and the test summary. The user reviews and commits.

---

## Task 4: Reconcile the channel index

**Files:**
- Modify: `apps/backend/src/actor.rs` — add the reconcile helper, call it from `TickMsg`, `ProcessDelayed`, `CreateContactMsg`, `StartFlowMsg`

**Interfaces:**
- Consumes: `InstanceMap::reconcile` (Task 2).
- Produces:
  - `async fn channel_ids_of(protocol: &ActorProtocol, secret_id: u64) -> Vec<u64>` — every channel id an instance currently holds, helper channels and replica-group members together.

Channel creation cannot be intercepted at its call sites: the library creates channels inside `start()` and `process()` as well as when a contact is minted, and the pairing handshake rotates the transient id to a long-term one without returning it. So the index is reconciled from the instance's own channel store after any operation that borrows it.

- [ ] **Step 1: Add the enumeration helper**

Add to `apps/backend/src/actor.rs`, next to `build_protocol`:

```rust
/// Every channel id an instance currently holds.
///
/// Both halves matter: `helpers()` lists channels where this instance is one
/// side of an Owner↔Helper relationship, and `replicas()` lists replica-group
/// members. A message may arrive on either, so routing needs both.
///
/// A store read that fails yields no ids for that half rather than aborting the
/// reconcile: dropping the whole index on a transient read error would unroute
/// live channels, which is worse than a stale index that the next reconcile
/// repairs.
async fn channel_ids_of(protocol: &ActorProtocol, secret_id: u64) -> Vec<u64> {
    let mut ids = Vec::new();

    match protocol.channel_store.helpers(secret_id).await {
        Ok(channels) => ids.extend(channels.iter().map(|c| c.channel_id.0)),
        Err(e) => warn!(secret_id = secret_id, error = %e, "helper channel read failed during reconcile"),
    }

    match protocol.channel_store.replicas(secret_id).await {
        Ok(members) => ids.extend(members.iter().map(|m| m.channel_id.0)),
        Err(e) => warn!(secret_id = secret_id, error = %e, "replica member read failed during reconcile"),
    }

    ids.sort_unstable();
    ids.dedup();
    ids
}
```

- [ ] **Step 2: Reconcile after a contact is minted**

In `Handler<CreateContactMsg>`, the async block currently returns `(protocol, result)`. Collect the ids before returning, then reconcile in the continuation.

Change the async block's tail from:

```rust
                (protocol, result)
```

to:

```rust
                let channel_ids = channel_ids_of(&protocol, secret_id).await;
                (protocol, result, channel_ids)
```

and the continuation from:

```rust
            .map(|(protocol, result), actor, _ctx| {
                actor.restore_own(protocol);
                result
            }),
```

to:

```rust
            .map(move |(protocol, result, channel_ids), actor, _ctx| {
                actor.restore_own(protocol);
                actor.instances.reconcile(secret_id, &channel_ids);
                result
            }),
```

`secret_id` must be captured before the protocol is moved into the async block. If the handler does not already bind it, add `let secret_id = self.instances.own_secret_id();` at the top of `handle`.

- [ ] **Step 3: Reconcile after an initiated flow**

Apply the same three changes to `Handler<StartFlowMsg>`. This is the case that would otherwise break: `StartFlowMsg` returns `Result<Vec<DeRecEvent>, derec_library::Error>`, carrying **no** channel id, so a pairing this actor initiates would create a channel nothing ever bound — and the peer's response would be dropped as unroutable.

- [ ] **Step 4: Reconcile after processing an inbound message**

Apply the same change to `Handler<ProcessDelayed>`. This is what picks up the handshake's id rotation: after the pairing response is processed, the store lists the new long-term id and no longer lists the transient one, so `reconcile` retires the old binding and installs the new one in a single call.

- [ ] **Step 5: Reconcile every instance on tick**

In `Handler<TickMsg>`, the async block already loops over borrowed instances. Extend the tuple it collects to carry the ids:

```rust
            let mut done = Vec::with_capacity(borrowed.len());
            for (secret_id, mut protocol) in borrowed {
                let events = protocol.tick().await;
                let swept = protocol
                    .remove_expired_channels(PENDING_CHANNEL_TTL_SECS)
                    .await;
                let channel_ids = channel_ids_of(&protocol, secret_id).await;
                done.push((secret_id, protocol, events, swept, channel_ids));
            }
            done
```

and in the continuation, after `actor.instances.restore(secret_id, protocol);`:

```rust
                actor.instances.reconcile(secret_id, &channel_ids);
```

Update the destructuring pattern to the five-element tuple. The tick is the backstop: any channel a path forgot to reconcile becomes routable within one `TICK_INTERVAL` (15s) rather than never.

- [ ] **Step 6: Build**

Run: `cargo build --manifest-path apps/backend/Cargo.toml`
Expected: compiles. Routing does not consume the index until Task 5, so behaviour is unchanged.

- [ ] **Step 7: Run the full suite**

Run: `cargo test --manifest-path apps/backend/Cargo.toml`
Expected: all pass, unchanged from Task 3.

- [ ] **Step 8: STOP for review**

Report: build and test output.

---

## Task 5: Route inbound messages by channel

**Files:**
- Modify: `apps/backend/src/actor.rs` — `Handler<ProcessDelayed>`

**Interfaces:**
- Consumes: `envelope::decode` (Task 1), `InstanceMap::take_for_channel` (Task 2), the reconciled index (Task 4).
- Produces: no new public functions.

- [ ] **Step 1: Replace the handler's instance selection**

Currently `ProcessDelayed` takes the own instance unconditionally. Replace the head of `handle` — everything before the `Box::pin(async move { ... })` — with envelope-driven selection:

```rust
    fn handle(&mut self, msg: ProcessDelayed, _ctx: &mut Context<Self>) -> Self::Result {
        let bytes = msg.0;

        let meta = match crate::envelope::decode(&bytes) {
            Ok(meta) => meta,
            Err(e) => {
                error!(
                    actor_id = %self.actor_id,
                    error = %e,
                    bytes = bytes.len(),
                    "undecodable envelope; dropping message"
                );
                return Box::pin(actix::fut::ready(()));
            }
        };

        // Channel 0 is the proto3 default, so an empty or truncated body decodes
        // to it. Routing on that would hand the message to whichever instance
        // happened to hold channel 0.
        if meta.channel_id == 0 {
            error!(
                actor_id = %self.actor_id,
                bytes = bytes.len(),
                "envelope carries no channel id; dropping message"
            );
            return Box::pin(actix::fut::ready(()));
        }

        let Some((secret_id, mut protocol)) = self.instances.take_for_channel(meta.channel_id)
        else {
            error!(
                actor_id = %self.actor_id,
                channel_id = meta.channel_id,
                sequence = meta.sequence,
                trace_id = meta.trace_id,
                "no instance owns this channel, or it is borrowed; dropping message"
            );
            return Box::pin(actix::fut::ready(()));
        };
```

The rest of the handler — the async block and continuation added in Task 4 Step 4 — stays, but `restore_own(protocol)` becomes `actor.instances.restore(secret_id, protocol)` and `secret_id` is now the routed instance's rather than the own one's.

- [ ] **Step 2: Verify the own instance still receives first-contact pairings**

A peer's opening `PairRequest` arrives on the channel id carried by the contact we minted, which Task 4 Step 2 reconciled at mint time. Confirm the binding exists before the message can arrive by checking the ordering: `CreateContactMsg`'s continuation reconciles synchronously on the actor thread, and the contact only reaches the peer after that handler returns.

Run: `grep -n "reconcile" apps/backend/src/actor.rs`
Expected: four call sites — `CreateContactMsg`, `StartFlowMsg`, `ProcessDelayed`, `TickMsg`.

- [ ] **Step 3: Run the full backend suite**

Run: `cargo test --manifest-path apps/backend/Cargo.toml`
Expected: all pass.

- [ ] **Step 4: Run the end-to-end suite**

Run: `cd apps/web && npx playwright test`
Expected: passes at its pre-existing baseline. Routing is now live, so a pairing or sharing regression means the index is incomplete.

Known pre-existing flake: `pairing.spec.ts:35` intermittently fails on an owner-side mailbox poll stall. If only that test fails, re-run once before treating it as a regression. Any *other* failure is a real one.

- [ ] **Step 5: Check the logs for unrouted traffic**

During the e2e run, neither of these should appear:

```
no instance owns this channel, or it is borrowed; dropping message
undecodable envelope; dropping message
```

If the first appears, the reconcile in Task 4 is missing a path — the log line names the channel id and sequence, so match it against the flow that created it.

- [ ] **Step 6: STOP for review**

Report: test output and the log check from Step 5.

---

## Task 6: The reconfigure primitive

**Files:**
- Modify: `apps/backend/src/actor.rs` — extract a shared builder, add `ReconfigureMsg`; `apps/backend/src/provisioning.rs:74` — updated constructor call

**Interfaces:**
- Consumes: `InstanceMap::take` / `restore` / `secret_ids` (Task 2).
- Produces:
  - `pub struct ReconfigureMsg { pub timeout_secs: u32, pub unpair_ack: UnpairAck }`, `#[rtype(result = "Result<(), derec_library::Error>")]`
  - `pub struct ListInstanceSecretsMsg`, `#[rtype(result = "Vec<u64>")]` — also consumed by Task 7
  - `fn configure_builder(...)` — the builder chain shared by fresh construction and rebuild

`timeouts` and `unpair_ack` are `pub(crate)` in the SDK with no runtime setters, so changing them on a live instance means rebuilding it. The stores are `pub` fields on `DeRecProtocol` and the type has no `Drop` impl, so they move across and all durable state survives.

- [ ] **Step 1: Store the config on the actor**

```rust
pub struct ProvisionedActor {
    instances: crate::instances::InstanceMap<ActorProtocol>,
    /// The config each instance was built from, so an instance can be rebuilt
    /// with changed settings without losing its stores.
    config: ProtocolConfig,
    actor_id: Uuid,
    role: Role,
    state: Arc<AppState>,
}
```

`new` gains a `config` parameter:

```rust
    pub fn new(
        protocol: ActorProtocol,
        config: ProtocolConfig,
        actor_id: Uuid,
        role: Role,
        state: Arc<AppState>,
    ) -> Self {
        let own_secret_id = protocol.secret_id();
        Self {
            instances: crate::instances::InstanceMap::new(own_secret_id, protocol),
            config,
            actor_id,
            role,
            state,
        }
    }
```

Update the call site in `apps/backend/src/provisioning.rs:74`:

```rust
    let actor_config = config.clone();
    let addr = ProvisionedActor::start_in_arbiter(&state.arbiter, move |_ctx| {
        ProvisionedActor::new(protocol, actor_config, actor_id, role, app_state)
    });
```

- [ ] **Step 2: Extract the shared builder**

`build_protocol` and the rebuild would otherwise duplicate the entire builder chain, and a settings change applied to one and forgotten in the other is exactly the bug this invites. Replace `build_protocol` (`actor.rs:64`) with a shared builder plus two thin callers.

Keep every existing comment in the chain — they explain non-obvious choices (`with_unsafe_http` derivation, the `inbound_message` vs liveness split, `auto_respond_on_failure`) and are the reason the current code is readable:

```rust
/// The builder chain shared by fresh construction and in-place rebuild.
///
/// Stores are *not* set here: a fresh instance gets empty ones, a rebuild moves
/// the live ones across. Everything else is identical, and keeping it in one
/// place is what stops a settings change from being applied to one path and
/// forgotten in the other.
fn configure_builder<Cs, Sh, Se, Us, St, T>(
    builder: DeRecProtocolBuilder<Cs, Sh, Se, Us, St, T>,
    config: &ProtocolConfig,
) -> DeRecProtocolBuilder<Cs, Sh, Se, Us, St, T>
where
    Cs: DeRecChannelStore,
{
    let mut builder = builder
        .with_own_transport(config.transport_uri.as_str())
        // Derived, not hardcoded: serving over https turns the guardrail back
        // on by itself.
        //
        // Loopback alone is not enough. The library exempts plaintext loopback
        // only for the endpoint a node configures for *itself*; a peer's
        // endpoint may never be plaintext by default.
        .with_unsafe_http(!config.transport_uri.starts_with("https://"))
        .with_threshold(config.threshold)
        .with_keep_versions_count(config.keep_versions_count)
        .with_timeouts(Timeouts {
            // The configured "protocol timeout" is the replay window — how stale
            // an inbound envelope may be and still be accepted. The liveness
            // budgets answer a different question, so they keep the library's
            // defaults rather than inheriting it.
            inbound_message: Duration::from_secs(config.timeout_secs as u64),
            // Cleanup is driven from this actor's own tick instead, at
            // `PENDING_CHANNEL_TTL_SECS`.
            expired_channels: ExpiredChannelCleanup::Disabled,
            ..Timeouts::default()
        })
        .with_communication_info(config.communication_info.clone())
        .with_unpair_ack(config.unpair_ack.to_library())
        // These actors exist to be interoperated against, and a peer that sends
        // something this node cannot process learns nothing from silence.
        .with_auto_respond_on_failure(true)
        .with_auto_accept(AutoAcceptPolicy::all());

    if let Some(replica_id) = config.replica_id {
        builder = builder.with_replica_id(replica_id);
    }

    builder
}
```

The exact generic bounds depend on the builder's type signature. Check it first:

Run: `grep -n "pub struct DeRecProtocolBuilder" -A 12 ~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/derec-library-0.0.2/src/protocol/builder.rs`

If threading the generics proves awkward, the acceptable fallback is a macro-free duplication guarded by a single test asserting both paths produce equal settings — but try the generic form first.

`build_protocol` keeps its signature and delegates:

```rust
pub fn build_protocol(config: &ProtocolConfig) -> Result<ActorProtocol, derec_library::Error> {
    let builder = DeRecProtocolBuilder::new(config.secret_id)
        .with_channel_store(InMemoryChannelStore::default())
        .with_share_store(InMemoryShareStore::default())
        .with_secret_store(InMemorySecretStore::default())
        .with_user_secret_store(InMemoryUserSecretStore::default())
        .with_state_store(InMemoryStateStore::default())
        .with_transport(HttpTransport::new(config.http_client.clone()));

    configure_builder(builder, config).build()
}
```

- [ ] **Step 3: Add the rebuild**

```rust
/// Build a fresh instance from `config`, moving `old`'s stores into it.
///
/// This is the only reason a rebuild preserves anything: `channel_store`,
/// `share_store`, `secret_store`, `user_secret_store`, `state_store` and
/// `transport` are `pub` on `DeRecProtocol`, and the type has no `Drop` impl, so
/// they can be moved out of the old value. Channels, shares and in-flight
/// orchestrator state all survive.
fn rebuild_with_stores(
    config: &ProtocolConfig,
    old: ActorProtocol,
) -> Result<ActorProtocol, derec_library::Error> {
    let builder = DeRecProtocolBuilder::new(config.secret_id)
        .with_channel_store(old.channel_store)
        .with_share_store(old.share_store)
        .with_secret_store(old.secret_store)
        .with_user_secret_store(old.user_secret_store)
        .with_state_store(old.state_store)
        .with_transport(old.transport);

    configure_builder(builder, config).build()
}
```

- [ ] **Step 4: Add the message and handler**

```rust
/// Change protocol settings on every instance this actor holds, in place.
#[derive(Message)]
#[rtype(result = "Result<(), derec_library::Error>")]
pub struct ReconfigureMsg {
    pub timeout_secs: u32,
    pub unpair_ack: UnpairAck,
}

impl Handler<ReconfigureMsg> for ProvisionedActor {
    type Result = Result<(), derec_library::Error>;

    fn handle(&mut self, msg: ReconfigureMsg, _ctx: &mut Context<Self>) -> Self::Result {
        self.config.timeout_secs = msg.timeout_secs;
        self.config.unpair_ack = msg.unpair_ack;

        for secret_id in self.instances.secret_ids() {
            let Some(old) = self.instances.take(secret_id) else {
                // Borrowed by an in-flight call. Leaving that instance on the
                // old settings would be a silent partial apply, so report it.
                return Err(derec_library::Error::Invariant(
                    "instance borrowed during reconfigure",
                ));
            };

            let mut config = self.config.clone();
            config.secret_id = secret_id;

            let rebuilt = rebuild_with_stores(&config, old)?;
            self.instances.restore(secret_id, rebuilt);
        }

        info!(
            actor_id = %self.actor_id,
            timeout_secs = msg.timeout_secs,
            "actor reconfigured in place"
        );
        Ok(())
    }
}
```

Note the `?` on `rebuild_with_stores` leaves that instance absent from the map if it fails. That is deliberate and visible: a rebuild failure means the instance could not be reconstructed, and a half-configured instance serving traffic would be worse than an absent one whose channels log as unroutable.

Add the inspection message in the same step — the test in Step 6 needs it, and Task 7 reuses it:

```rust
/// The `secret_id` of every instance this actor holds. Test and admin
/// observability; carries no key material.
#[derive(Message)]
#[rtype(result = "Vec<u64>")]
pub struct ListInstanceSecretsMsg;

impl Handler<ListInstanceSecretsMsg> for ProvisionedActor {
    type Result = Vec<u64>;

    fn handle(&mut self, _msg: ListInstanceSecretsMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let mut ids = self.instances.secret_ids();
        ids.sort_unstable();
        ids
    }
}
```

- [ ] **Step 5: Verify the duplication is gone**

Run: `grep -c "with_auto_respond_on_failure" apps/backend/src/actor.rs`
Expected: `1`.

- [ ] **Step 6: Write the state-preservation test**

Create `apps/backend/tests/reconfigure.rs`:

```rust
//! Reconfiguring a live actor must not cost it its channels.
//!
//! The SDK exposes `timeouts` only on the builder, so the instance is rebuilt.
//! If the stores did not move across, every established pairing would silently
//! vanish — which is the failure this test exists to catch.

use std::collections::HashMap;
use std::sync::Arc;

use actix::prelude::*;
use derec_backend::actor::{
    build_protocol, ListInstanceSecretsMsg, ProtocolConfig, ProvisionedActor, ReconfigureMsg,
};
use derec_backend::models::{Role, UnpairAck};

fn config(secret_id: u64) -> ProtocolConfig {
    ProtocolConfig {
        secret_id,
        transport_uri: "http://localhost:5000/derec/participants/test".to_owned(),
        communication_info: HashMap::from([("name".to_owned(), "Alex".to_owned())]),
        timeout_secs: 300,
        unpair_ack: UnpairAck::Required,
        threshold: 2,
        keep_versions_count: 3,
        replica_id: Some(0xAB),
        http_client: reqwest::Client::new(),
    }
}

#[actix_rt::test]
async fn reconfigure_keeps_every_instance() {
    let cfg = config(0xA1);
    let protocol = build_protocol(&cfg).expect("protocol builds");
    let state = derec_backend::test_support::app_state();

    let addr = ProvisionedActor::new(protocol, cfg, uuid::Uuid::new_v4(), Role::Participant, state)
        .start();

    let before = addr.send(ListInstanceSecretsMsg).await.expect("actor alive");

    addr.send(ReconfigureMsg {
        timeout_secs: 60,
        unpair_ack: UnpairAck::NotRequired,
    })
    .await
    .expect("actor alive")
    .expect("reconfigure succeeds");

    let after = addr.send(ListInstanceSecretsMsg).await.expect("actor alive");

    assert_eq!(before, after, "no instance may be lost to a rebuild");
}
```

`derec_backend::test_support::app_state()` does not exist yet. Add it as a `#[cfg(feature = "test-support")]` or plain `pub` helper in `apps/backend/src/state.rs` that builds an `AppState` with a fresh arbiter, mirroring what `main.rs` does. The crate is currently a binary only; add a `[lib]` target to `Cargo.toml` so integration tests can import it:

```toml
[lib]
name = "derec_backend"
path = "src/lib.rs"

[[bin]]
name = "derec-backend"
path = "src/main.rs"
```

with `src/lib.rs` re-exporting the modules `main.rs` declares.

- [ ] **Step 7: Run the tests**

Run: `cargo test --manifest-path apps/backend/Cargo.toml`
Expected: all pass, including `reconfigure_keeps_every_instance`.

- [ ] **Step 8: STOP for review**

Report: the `grep -c` result, test output, and the `Cargo.toml` restructuring, which is the largest incidental change in this plan and deserves a look.

---

## Task 7: Replica instances on demand

**Files:**
- Modify: `apps/backend/src/actor.rs` — `EnsureReplicaInstanceMsg`, `CreateContactMsg`
- Modify: `apps/backend/src/routes/actors.rs:213` — pass the new field
- Create: `apps/backend/tests/replica_instances.rs`

**Interfaces:**
- Consumes: `build_protocol` (Task 6), `InstanceMap::insert` / `contains` / `secret_ids` (Task 2).
- Produces:
  - `pub struct EnsureReplicaInstanceMsg { pub owner_secret_id: u64 }`, `#[rtype(result = "Result<(), derec_library::Error>")]`
  - `CreateContactMsg` gains `pub replica_for_owner_secret: Option<u64>`

This is what makes `Role::Replica` unnecessary, so plan 2 can delete the separate actor kind.

- [ ] **Step 1: Add the ensure handler**

```rust
/// Ensure this actor holds an instance bound to `owner_secret_id`.
///
/// A replica mirrors one named owner's vault, and the share store keys on
/// `(secret_id, channel_id, version, replica_id)` — an instance under a
/// different secret would miss every lookup. Replica-mode pairing therefore
/// needs an instance bound to that owner's secret, which this creates on demand.
///
/// Idempotent: a second pairing with the same owner reuses the instance rather
/// than resetting its stores.
#[derive(Message)]
#[rtype(result = "Result<(), derec_library::Error>")]
pub struct EnsureReplicaInstanceMsg {
    pub owner_secret_id: u64,
}

impl Handler<EnsureReplicaInstanceMsg> for ProvisionedActor {
    type Result = Result<(), derec_library::Error>;

    fn handle(&mut self, msg: EnsureReplicaInstanceMsg, _ctx: &mut Context<Self>) -> Self::Result {
        if self.instances.contains(msg.owner_secret_id) {
            return Ok(());
        }

        let mut config = self.config.clone();
        config.secret_id = msg.owner_secret_id;

        let protocol = build_protocol(&config)?;
        self.instances.insert(msg.owner_secret_id, protocol);

        info!(
            actor_id = %self.actor_id,
            owner_secret_id = msg.owner_secret_id,
            "replica instance created"
        );
        Ok(())
    }
}
```

- [ ] **Step 2: Confirm the inspection message is present**

`ListInstanceSecretsMsg` was added in Task 6 Step 4; this task's tests consume it.

Run: `grep -n "pub struct ListInstanceSecretsMsg" apps/backend/src/actor.rs`
Expected: one match. If absent, Task 6 Step 4 was not completed — add it there rather than here, so the two tasks do not both define it.

- [ ] **Step 3: Let a contact be minted from a replica instance**

`CreateContactMsg` currently mints from the own instance and Task 4 reconciles against it. A replica-mode contact must be minted from — and reconciled against — the replica instance instead.

```rust
pub struct CreateContactMsg {
    pub contact_mode: derec_proto::ContactMode,
    pub nonce: Option<u64>,
    /// When set, mint from the instance bound to this owner's secret rather than
    /// from the own instance — a replica-mode pairing.
    pub replica_for_owner_secret: Option<u64>,
}
```

In the handler, replace the fixed `let secret_id = self.instances.own_secret_id();` from Task 4 Step 2 with:

```rust
        let secret_id = msg
            .replica_for_owner_secret
            .unwrap_or_else(|| self.instances.own_secret_id());

        let Some(protocol) = self.instances.take(secret_id) else {
            return Box::pin(actix::fut::ready(Err(derec_library::Error::Invariant(
                "no instance for the requested secret, or it is borrowed",
            ))));
        };
```

replacing the existing `take_own()` call. The continuation already restores and reconciles against `secret_id`, so it needs no further change beyond using `actor.instances.restore(secret_id, protocol)` instead of `restore_own`.

Update the one construction site, `apps/backend/src/routes/actors.rs:213`, to preserve today's behaviour:

```rust
    let msg = CreateContactMsg {
        contact_mode,
        nonce: query.nonce,
        replica_for_owner_secret: None,
    };
```

No HTTP route sets it in this plan; plan 2 adds the route that does.

- [ ] **Step 4: Write the integration test**

Create `apps/backend/tests/replica_instances.rs`:

```rust
//! One actor holding an own instance plus a replica instance is what removes
//! the need for a separate replica actor kind.
//!
//! Driven directly against the actor rather than over HTTP: the route that mints
//! a replica-mode contact does not exist until plan 2.

use std::collections::HashMap;

use actix::prelude::*;
use derec_backend::actor::{
    build_protocol, EnsureReplicaInstanceMsg, ListInstanceSecretsMsg, ProtocolConfig,
    ProvisionedActor,
};
use derec_backend::models::{Role, UnpairAck};

const OWN_SECRET: u64 = 0xA1;
const ALICE_SECRET: u64 = 0x7F;
const CAROL_SECRET: u64 = 0xC3;

fn config(secret_id: u64) -> ProtocolConfig {
    ProtocolConfig {
        secret_id,
        transport_uri: "http://localhost:5000/derec/participants/test".to_owned(),
        communication_info: HashMap::from([("name".to_owned(), "Alex".to_owned())]),
        timeout_secs: 300,
        unpair_ack: UnpairAck::Required,
        threshold: 2,
        keep_versions_count: 3,
        replica_id: Some(0xAB),
        http_client: reqwest::Client::new(),
    }
}

fn spawn() -> Addr<ProvisionedActor> {
    let cfg = config(OWN_SECRET);
    let protocol = build_protocol(&cfg).expect("protocol builds");
    let state = derec_backend::test_support::app_state();
    ProvisionedActor::new(protocol, cfg, uuid::Uuid::new_v4(), Role::Participant, state).start()
}

#[actix_rt::test]
async fn an_actor_starts_with_only_its_own_instance() {
    let addr = spawn();

    let secrets = addr.send(ListInstanceSecretsMsg).await.expect("actor alive");

    assert_eq!(secrets, vec![OWN_SECRET]);
}

#[actix_rt::test]
async fn a_replica_instance_is_added_alongside_the_own_instance() {
    let addr = spawn();

    addr.send(EnsureReplicaInstanceMsg { owner_secret_id: ALICE_SECRET })
        .await
        .expect("actor alive")
        .expect("instance creation succeeds");

    let secrets = addr.send(ListInstanceSecretsMsg).await.expect("actor alive");

    assert_eq!(secrets.len(), 2, "own instance plus one replica instance");
    assert!(secrets.contains(&OWN_SECRET), "own instance survives");
    assert!(secrets.contains(&ALICE_SECRET));
}

#[actix_rt::test]
async fn ensuring_the_same_owner_twice_is_a_no_op() {
    // Not merely tidiness: a second create would install a fresh instance with
    // empty stores, silently discarding the shares this replica already holds.
    let addr = spawn();

    for _ in 0..2 {
        addr.send(EnsureReplicaInstanceMsg { owner_secret_id: ALICE_SECRET })
            .await
            .expect("actor alive")
            .expect("instance creation succeeds");
    }

    let secrets = addr.send(ListInstanceSecretsMsg).await.expect("actor alive");

    assert_eq!(secrets.len(), 2, "asking twice must not add an instance");
}

#[actix_rt::test]
async fn one_actor_replicates_for_two_owners_at_once() {
    let addr = spawn();

    for owner in [ALICE_SECRET, CAROL_SECRET] {
        addr.send(EnsureReplicaInstanceMsg { owner_secret_id: owner })
            .await
            .expect("actor alive")
            .expect("instance creation succeeds");
    }

    let secrets = addr.send(ListInstanceSecretsMsg).await.expect("actor alive");

    assert_eq!(secrets.len(), 3);
    assert!(secrets.contains(&ALICE_SECRET));
    assert!(secrets.contains(&CAROL_SECRET));
}
```

- [ ] **Step 5: Run the new tests**

Run: `cargo test --manifest-path apps/backend/Cargo.toml --test replica_instances`
Expected: 4 tests pass.

- [ ] **Step 6: Run everything**

Run: `cargo test --manifest-path apps/backend/Cargo.toml`
Run: `cd apps/web && npx playwright test`
Expected: both at their pre-existing baseline. No existing flow changed behaviour.

- [ ] **Step 7: Correct the doc comments this plan makes true**

Three comments describe this design as though it already existed:

- `apps/backend/src/provisioning.rs:30-34` — "No protocol instance is created here" is wrong; the own instance *is* built eagerly. Rewrite to say the own instance is built here and replica instances are added on demand via `EnsureReplicaInstanceMsg`.
- `apps/backend/src/actor.rs:376-377` — `CreateContactMsg`'s "instantiating the protocol for that secret if this actor has not seen it before" is still not what the handler does; it selects an existing instance. Correct it to describe selection, and point at `EnsureReplicaInstanceMsg` for creation.
- `apps/backend/src/actor.rs:364-365` — `IncomingMessage`'s "Routed to the instance that owns the envelope's channel" is now accurate. Verify, no change.

- [ ] **Step 8: STOP for review**

Report: test output and the doc comment diffs.

---

## Definition of Done

- [ ] `cargo test` passes in `apps/backend`
- [ ] `npx playwright test` passes at its pre-existing baseline in `apps/web`
- [ ] No HTTP route changed shape; no frontend file modified
- [ ] `grep -n "self\.protocol" apps/backend/src/actor.rs` returns nothing
- [ ] An actor can hold an own instance plus one or more replica instances
- [ ] Inbound messages route by `channel_id`; unknown channels are dropped with a log line naming the channel, never routed to a fallback instance
- [ ] `prost` is a used dependency

## Notes for the next plan

Plan 2 deletes `Role::Replica`. It can now do so because any helper gains a replica instance via `EnsureReplicaInstanceMsg`. The pieces it will need:

- An HTTP route that mints a replica-mode contact — sets `CreateContactMsg::replica_for_owner_secret`, which this plan added but left unset by every route.
- `actor_secret_id`'s replica branch in `provisioning.rs:93` becomes dead once no actor is minted as a replica.
- `state.replica_channels`, `state.replica_confirmed`, `state.disabled_replicas` fold into their participant equivalents.
