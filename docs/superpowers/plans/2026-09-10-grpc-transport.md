# gRPC Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve and dial gRPC alongside HTTPS so provisioned helpers can advertise HTTP only, gRPC only, or both, and messages cross between the two transports in both directions.

**Architecture:** One tonic listener for the whole backend process resolves the target actor from the cleartext `channel_id` on the `DeRecMessage` envelope, via a two-tier index mirroring `InstanceMap`. Outbound, a `CompositeTransport` dispatches each of a peer's advertised endpoints by its protocol discriminant and fails over in the peer's order. Browsers cannot speak gRPC, so the backend exposes a relay route that dials on their behalf.

**Tech Stack:** Rust, Axum 0.8, tonic 0.14.6, actix 0.13, React 19 + TypeScript, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-10-grpc-transport-design.md`

## Global Constraints

- `derec-library` and `derec-proto` are **0.0.3**, consumed from the sibling `../lib-derec` checkout via path deps (backend) and a `file:` dep (web). Do not change that wiring.
- `tonic = "0.14.6"`, `tonic-prost = "0.14.6"`, `tonic-prost-build = "0.14.6"` — the versions the library's own `smoke-tests/grpc` uses. Matching them keeps one `DeRecMessage` in the build.
- **Plaintext `grpc://` only.** `grpcs://` is out of scope: default `tonic` has no TLS backend. Loopback plaintext is already the posture for `http://` here, under `with_unsafe_connection`.
- A `Both` helper advertises **`[grpc, http]`**. The order is an arbitrary fixed app preference and carries no protocol meaning.
- `Actor` keeps `transport` (the first entry) alongside the new `transports`.
- Config keys are **wizard prefills**, never backend policy. A provisioning request that omits the transport mode gets **HTTP**.
- An unrecognised channel is refused, never guessed.
- The repo is not rustfmt-clean; do not run `cargo fmt` across files you did not otherwise touch.
- Run Rust commands as `rtk proxy cargo …` to get unfiltered output.

---

## File Structure

**Created:**
- `apps/backend/build.rs` — compiles `derectransport.proto` against the sibling checkout.
- `apps/backend/src/routing.rs` — `ChannelRouter`, the two-tier `channel_id → actor_id` index. Pure data structure.
- `apps/backend/src/grpc.rs` — the tonic service impl and its `serve` entry point.
- `apps/backend/src/transport.rs` — `GrpcTransport`, `CompositeTransport`. Moved out of `stores.rs`, which is already 700 lines of store impls.
- `apps/backend/tests/grpc_ingress.rs` — integration tests for the listener.
- `apps/backend/tests/multi_endpoint.rs` — the `Both`-helper channel-record assertions.
- `apps/web/e2e/grpc.spec.ts` — the e2e matrix.

**Modified:**
- `apps/backend/Cargo.toml`, `src/lib.rs`, `src/main.rs`, `src/config.rs`, `src/models.rs`, `src/state.rs`, `src/provisioning.rs`, `src/actor.rs`, `src/stores.rs`, `src/routes/derec.rs`, `src/routes/actors.rs`, `src/routes/helpers.rs`, `src/routes/mod.rs`, `config.example.toml`
- `apps/web/src/api.ts`, `src/config.ts`, `src/stores.ts`, `src/derecApi.ts`, `src/SetupWizard.tsx`, `src/OwnerPage.tsx`

---

## Task 1: `ChannelRouter`

The server-wide `channel_id → actor_id` index. Pure data structure with no protocol logic, so it is testable on its own before anything consumes it.

**Files:**
- Create: `apps/backend/src/routing.rs`
- Modify: `apps/backend/src/lib.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: `ChannelRouter::{new, pin, rotate, remove, resolve}`; `pin(&self, channel_id: u64, actor_id: Uuid)`, `rotate(&self, transient: u64, long_term: u64, actor_id: Uuid)`, `remove(&self, channel_id: u64)`, `resolve(&self, channel_id: u64) -> Option<Uuid>`.

- [ ] **Step 1: Write the failing tests**

Create `apps/backend/src/routing.rs` with only the test module and a stub:

```rust
//! Server-wide `channel_id` → actor index, for gRPC ingress.
//!
//! HTTP carries the actor in its path (`/derec/<uuid>`), so it never consults
//! this. gRPC has no path to carry one — tonic builds the request URI from the
//! endpoint authority plus the fixed method path — so an inbound `Send` is
//! resolved from the cleartext `channel_id` on the envelope instead.
//!
//! Two tiers, mirroring [`crate::instances::InstanceMap`] one level up:
//!
//! - **bound** — written when a pairing completes, keyed on the long-term id
//!   both sides rotated to. The steady state.
//! - **pinned** — written when a channel exists only in memory: a contact this
//!   backend just minted, or a peer's contact this backend is about to pair
//!   against. Either way the *first* inbound message arrives on an id no
//!   channel store has seen, so nothing derived from a store can route it.
//!
//! An unrecognised channel is refused, never guessed. Guessing would hand a
//! peer's message to an actor that does not own it.

use dashmap::DashMap;
use uuid::Uuid;

#[derive(Default)]
pub struct ChannelRouter {
    bound: DashMap<u64, Uuid>,
    pinned: DashMap<u64, Uuid>,
}

impl ChannelRouter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn pin(&self, _channel_id: u64, _actor_id: Uuid) {
        unimplemented!()
    }

    pub fn rotate(&self, _transient: u64, _long_term: u64, _actor_id: Uuid) {
        unimplemented!()
    }

    pub fn remove(&self, _channel_id: u64) {
        unimplemented!()
    }

    pub fn resolve(&self, _channel_id: u64) -> Option<Uuid> {
        unimplemented!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actor() -> Uuid {
        Uuid::new_v4()
    }

    #[test]
    fn a_pinned_channel_resolves() {
        // The case a store-derived index cannot cover: a freshly minted
        // contact, whose id the first inbound PairRequest carries.
        let router = ChannelRouter::new();
        let a = actor();

        router.pin(100, a);

        assert_eq!(router.resolve(100), Some(a));
    }

    #[test]
    fn an_unknown_channel_resolves_to_nothing() {
        let router = ChannelRouter::new();

        assert_eq!(router.resolve(999), None);
    }

    #[test]
    fn rotating_binds_the_long_term_id_and_drops_the_transient_one() {
        // The handshake atomically rotates off the transient id and the
        // library refuses traffic on it from then on, so leaving it resolvable
        // would keep a dead route alive.
        let router = ChannelRouter::new();
        let a = actor();
        router.pin(100, a);

        router.rotate(100, 200, a);

        assert_eq!(router.resolve(200), Some(a), "long-term id must route");
        assert_eq!(router.resolve(100), None, "transient id must stop routing");
    }

    #[test]
    fn rotating_a_channel_that_was_never_pinned_still_binds() {
        // The responder side of a pairing this backend did not initiate: no
        // pin was ever taken, but the completed channel must still route.
        let router = ChannelRouter::new();
        let a = actor();

        router.rotate(100, 200, a);

        assert_eq!(router.resolve(200), Some(a));
    }

    #[test]
    fn removing_drops_both_tiers() {
        let router = ChannelRouter::new();
        let a = actor();
        router.pin(100, a);
        router.rotate(100, 200, a);

        router.remove(200);
        router.remove(100);

        assert_eq!(router.resolve(200), None);
        assert_eq!(router.resolve(100), None);
    }

    #[test]
    fn a_bound_channel_wins_over_a_stale_pin_on_the_same_id() {
        // Defensive: if the same id were ever both pinned and bound, the
        // store-derived answer is the authoritative one.
        let router = ChannelRouter::new();
        let stale = actor();
        let current = actor();
        router.pin(100, stale);
        router.rotate(999, 100, current);

        assert_eq!(router.resolve(100), Some(current));
    }

    #[test]
    fn two_actors_keep_separate_channels() {
        let router = ChannelRouter::new();
        let (a, b) = (actor(), actor());

        router.pin(100, a);
        router.pin(200, b);

        assert_eq!(router.resolve(100), Some(a));
        assert_eq!(router.resolve(200), Some(b));
    }
}
```

Register the module in `apps/backend/src/lib.rs` alongside the existing `pub mod` lines:

```rust
pub mod routing;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/backend && rtk proxy cargo test --lib routing`
Expected: FAIL — every test panics with `not implemented`.

- [ ] **Step 3: Implement**

Replace the four stub bodies:

```rust
    /// Route `channel_id` to `actor_id` before any store knows about it.
    pub fn pin(&self, channel_id: u64, actor_id: Uuid) {
        self.pinned.insert(channel_id, actor_id);
    }

    /// Move a completed pairing onto its long-term id.
    ///
    /// The transient id is dropped from both tiers: the library refuses
    /// traffic on it from here on, so a route for it can only misdeliver.
    pub fn rotate(&self, transient: u64, long_term: u64, actor_id: Uuid) {
        self.pinned.remove(&transient);
        self.bound.remove(&transient);
        self.bound.insert(long_term, actor_id);
    }

    /// Forget a channel entirely — teardown, unpair, or a pairing that never
    /// completed.
    pub fn remove(&self, channel_id: u64) {
        self.pinned.remove(&channel_id);
        self.bound.remove(&channel_id);
    }

    /// The actor that owns `channel_id`, or `None` if this server has no
    /// route for it.
    ///
    /// `bound` is consulted first: it is store-derived and authoritative, and
    /// a pin is only ever a placeholder for a channel no store has seen yet.
    pub fn resolve(&self, channel_id: u64) -> Option<Uuid> {
        self.bound
            .get(&channel_id)
            .or_else(|| self.pinned.get(&channel_id))
            .map(|entry| *entry.value())
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/backend && rtk proxy cargo test --lib routing`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routing.rs apps/backend/src/lib.rs
git commit -m "feat(backend): add the server-wide channel router for gRPC ingress"
```

---

## Task 2: Wire the router into the actor lifecycle

The router is useless until something populates it. Three write points: a contact this backend mints, a contact this backend pairs against, and a completed pairing.

**Files:**
- Modify: `apps/backend/src/state.rs` (add the field to `AppState` and `AppState::new`)
- Modify: `apps/backend/src/actor.rs` (`handle_events`, the `PairingCompleted` arm around line 368)
- Modify: `apps/backend/src/routes/actors.rs` (the `CreateContactMsg` response path, and the pair-against-a-contact path around line 370)

**Interfaces:**
- Consumes: `ChannelRouter::{pin, rotate, remove, resolve}` from Task 1.
- Produces: `AppState.channel_router: Arc<ChannelRouter>`.

- [ ] **Step 1: Add the field**

In `apps/backend/src/state.rs`, add to `AppState`:

```rust
    /// `channel_id` → actor, for gRPC ingress only. See [`crate::routing`].
    pub channel_router: Arc<crate::routing::ChannelRouter>,
```

and to `AppState::new`'s initialiser:

```rust
            channel_router: Arc::new(crate::routing::ChannelRouter::new()),
```

- [ ] **Step 2: Write the failing test**

Add to `apps/backend/tests/replica_contact_route.rs` (it already drives the contact route through a real router):

```rust
#[actix_rt::test]
async fn minting_a_contact_pins_its_channel_for_grpc_ingress() {
    // gRPC has no path to carry an actor id, so the first inbound message on a
    // freshly minted contact can only be routed by its channel id — and no
    // channel store has seen that id yet.
    let (state, actor_id) = provisioned_helper().await;

    let contact = mint_contact(&state, actor_id).await;
    let channel_id: u64 = contact.channel_id.parse().expect("decimal channel id");

    assert_eq!(
        state.channel_router.resolve(channel_id),
        Some(actor_id),
        "a minted contact must be routable before any store knows it"
    );
}
```

Reuse whatever `provisioned_helper()` / `mint_contact()` helpers that file already defines; if it names them differently, use its names rather than adding duplicates.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/backend && rtk proxy cargo test --test replica_contact_route minting_a_contact_pins`
Expected: FAIL — `resolve` returns `None`.

- [ ] **Step 4: Pin at both mint points**

In `apps/backend/src/routes/actors.rs`, immediately after a `CreateContactMsg` returns a contact successfully, pin it:

```rust
    state.channel_router.pin(contact.channel_id, actor_id);
```

And in the handler that builds a `derec_proto::ContactMessage` to pair *against* (the one modified during the 0.0.3 migration, around line 370), pin the peer's channel id to the actor that will pair on it, immediately before `addr.send(StartFlowMsg { flow })`:

```rust
    // The response arrives on the id the *peer* minted, so this actor must be
    // routable on it before the request goes out.
    state.channel_router.pin(channel_id, actor_id);
```

- [ ] **Step 5: Rotate on pairing completion**

In `apps/backend/src/actor.rs`, in the `DeRecEvent::PairingCompleted` arm, beside the existing `self.instances.unpin_channel(pairing_channel_id.0);`:

```rust
                    // The per-instance index above routes *within* this actor;
                    // this one routes *to* it, and only gRPC ingress reads it.
                    self.state.channel_router.rotate(
                        pairing_channel_id.0,
                        channel_id.0,
                        self.actor_id,
                    );
```

- [ ] **Step 6: Drop the route on teardown**

Still in `apps/backend/src/actor.rs`, in the arm that already prunes `helper_channels` (around line 505), add beside it:

```rust
                    self.state.channel_router.remove(cid_u64);
```

where `cid_u64` is that arm's channel id as a `u64`. If the arm only has the id as a `String`, parse it there rather than changing the surrounding code:

```rust
                    if let Ok(cid_u64) = cid.parse::<u64>() {
                        self.state.channel_router.remove(cid_u64);
                    }
```

- [ ] **Step 7: Run the tests**

Run: `cd apps/backend && rtk proxy cargo test`
Expected: PASS — the new test plus all 87 pre-existing ones.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/state.rs apps/backend/src/actor.rs apps/backend/src/routes/actors.rs apps/backend/tests/replica_contact_route.rs
git commit -m "feat(backend): populate the channel router at mint, pair and teardown"
```

---

## Task 3: The gRPC listener

**Files:**
- Create: `apps/backend/build.rs`, `apps/backend/src/grpc.rs`, `apps/backend/tests/grpc_ingress.rs`
- Modify: `apps/backend/Cargo.toml`, `apps/backend/src/lib.rs`, `apps/backend/src/main.rs`, `apps/backend/src/config.rs`, `apps/backend/config.example.toml`
- Modify: `apps/backend/src/routes/derec.rs` (extract the dispatch so both transports share it)

**Interfaces:**
- Consumes: `AppState.channel_router`, `ChannelRouter::resolve`.
- Produces: `crate::grpc::serve(state: Arc<AppState>, port: u16) -> impl Future<Output = ()>`; `crate::routes::derec::dispatch_to_inbox(state: &AppState, actor_id: Uuid, bytes: Vec<u8>) -> DispatchOutcome`; `enum DispatchOutcome { Delivered, Dropped, NoInbox }`.

- [ ] **Step 1: Add the dependencies**

In `apps/backend/Cargo.toml`, under `[dependencies]`:

```toml
# gRPC transport. Versions match the library's own `smoke-tests/grpc`, which
# keeps one `DeRecMessage` in the build rather than a duplicate definition.
tonic = "0.14.6"
tonic-prost = "0.14.6"

[build-dependencies]
tonic-prost-build = "0.14.6"
```

- [ ] **Step 2: Add the build script**

Create `apps/backend/build.rs`:

```rust
//! Generate the `DeRecTransport` gRPC service from the sibling `lib-derec`
//! checkout.
//!
//! `extern_path` maps the proto package onto `derec_proto` so the generated
//! service speaks the exact `DeRecMessage` the library hands `DeRecTransport`,
//! with no re-encode across a duplicate definition. This is the recipe the
//! library's own `smoke-tests/grpc` uses.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto_root = "../../../lib-derec/protobufs";
    println!("cargo:rerun-if-changed={proto_root}/grpc/derectransport.proto");
    println!("cargo:rerun-if-changed={proto_root}/protobufs/derecmessage.proto");

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

- [ ] **Step 3: Extract the shared inbox dispatch**

`deliver_message` in `apps/backend/src/routes/derec.rs` currently inlines the offline check and the inbox match. gRPC needs identical behaviour, so lift it. Add to that file:

```rust
/// What happened to a message handed to an actor's inbox.
#[derive(Debug, PartialEq, Eq)]
pub enum DispatchOutcome {
    Delivered,
    /// The actor is simulating offline; the message is discarded, not queued.
    Dropped,
    NoInbox,
}

/// Hand raw wire bytes to an actor's inbox.
///
/// Shared by both transports so a suspended helper drops gRPC traffic exactly
/// as it drops HTTP, and so a browser actor receives over gRPC without knowing
/// that is what happened.
pub fn dispatch_to_inbox(state: &AppState, actor_id: Uuid, bytes: Vec<u8>) -> DispatchOutcome {
    if state.disabled_helpers.contains_key(&actor_id) {
        info!(actor_id = %actor_id, bytes = bytes.len(), "message dropped — actor is offline");
        return DispatchOutcome::Dropped;
    }

    match state.actor_inboxes.get(&actor_id) {
        Some(entry) => {
            let len = bytes.len();
            match entry.value() {
                ActorInbox::Browser(tx) => {
                    let _ = tx.send(bytes);
                }
                ActorInbox::Provisioned(addr) => {
                    addr.do_send(IncomingMessage(bytes));
                }
            }
            info!(actor_id = %actor_id, bytes = len, "message delivered to inbox");
            DispatchOutcome::Delivered
        }
        None => DispatchOutcome::NoInbox,
    }
}
```

Then rewrite the tail of `deliver_message` to use it, preserving its current status codes exactly:

```rust
    match dispatch_to_inbox(&state, actor_id, body.to_vec()) {
        DispatchOutcome::Delivered | DispatchOutcome::Dropped => {
            StatusCode::ACCEPTED.into_response()
        }
        DispatchOutcome::NoInbox => not_found("actor inbox not found"),
    }
```

- [ ] **Step 4: Write the failing integration test**

Create `apps/backend/tests/grpc_ingress.rs`:

```rust
//! The gRPC listener resolves an actor from the envelope and hands the bytes
//! to the same inbox HTTP would.

use std::sync::Arc;

use derec_backend::routes::derec::{DispatchOutcome, dispatch_to_inbox};
use derec_backend::state::AppState;
use prost::Message as _;
use uuid::Uuid;

/// An envelope carrying nothing but the cleartext `channel_id` the router
/// reads. The body is irrelevant here — routing happens before decryption.
fn envelope(channel_id: u64) -> Vec<u8> {
    let msg = derec_proto::DeRecMessage {
        channel_id,
        ..Default::default()
    };
    msg.encode_to_vec()
}

#[actix_rt::test]
async fn an_envelope_routes_to_the_actor_its_channel_is_pinned_to() {
    let state = derec_backend::test_support::app_state();
    let actor_id = Uuid::new_v4();
    derec_backend::provisioning::register_browser_actor(&state, actor_id);
    state.channel_router.pin(4242, actor_id);

    let decoded = derec_proto::DeRecMessage::decode(envelope(4242).as_slice())
        .expect("a well-formed envelope");
    let resolved = state
        .channel_router
        .resolve(decoded.channel_id)
        .expect("the pinned channel resolves");

    assert_eq!(resolved, actor_id);
    assert_eq!(
        dispatch_to_inbox(&state, resolved, envelope(4242)),
        DispatchOutcome::Delivered
    );
}

#[actix_rt::test]
async fn an_unknown_channel_resolves_to_no_actor() {
    // Refused, never guessed: guessing would hand a peer's message to an actor
    // that does not own the channel.
    let state = derec_backend::test_support::app_state();

    assert_eq!(state.channel_router.resolve(9999), None);
}

#[actix_rt::test]
async fn a_disabled_actor_drops_grpc_traffic_exactly_as_it_drops_http() {
    let state = derec_backend::test_support::app_state();
    let actor_id = Uuid::new_v4();
    derec_backend::provisioning::register_browser_actor(&state, actor_id);
    state.disabled_helpers.insert(actor_id, ());

    assert_eq!(
        dispatch_to_inbox(&state, actor_id, envelope(1)),
        DispatchOutcome::Dropped
    );
}

// Silences an unused-import warning when the file grows no further.
#[allow(dead_code)]
fn _state_type_is_used(_: &Arc<AppState>) {}
```

- [ ] **Step 5: Run it to verify it fails**

Run: `cd apps/backend && rtk proxy cargo test --test grpc_ingress`
Expected: FAIL to compile — `dispatch_to_inbox` and `DispatchOutcome` are not yet public, or `channel_router` is missing. If Step 3 is already done, the failure is only on visibility: make `pub mod derec;` items reachable and re-run.

- [ ] **Step 6: Implement the service**

Create `apps/backend/src/grpc.rs`:

```rust
//! The gRPC ingress listener.
//!
//! One listener serves the whole process. gRPC has no path segment to carry an
//! actor id — tonic builds the request URI from the endpoint authority plus the
//! fixed method path — so the target actor is resolved from the cleartext
//! `channel_id` on the envelope. See [`crate::routing`].

use std::sync::Arc;

use tonic::{Request, Response, Status};
use tracing::{error, info};

use crate::routes::derec::{DispatchOutcome, dispatch_to_inbox};
use crate::state::AppState;

pub mod pb {
    tonic::include_proto!("org.derecalliance.derec.protobuf");
}

use pb::de_rec_transport_server::{DeRecTransport, DeRecTransportServer};

pub struct GrpcIngress {
    state: Arc<AppState>,
}

#[tonic::async_trait]
impl DeRecTransport for GrpcIngress {
    async fn send(
        &self,
        request: Request<derec_proto::DeRecMessage>,
    ) -> Result<Response<()>, Status> {
        let envelope = request.into_inner();
        let channel_id = envelope.channel_id;

        let Some(actor_id) = self.state.channel_router.resolve(channel_id) else {
            // Refused rather than guessed. A wrong guess delivers a peer's
            // message to an actor that does not own the channel.
            return Err(Status::not_found(format!(
                "no actor holds channel {channel_id}"
            )));
        };

        // Re-encode rather than pass the decoded message on: every inbox in
        // this app takes wire bytes, because that is what
        // `DeRecProtocol::process` takes.
        let bytes = prost::Message::encode_to_vec(&envelope);

        match dispatch_to_inbox(&self.state, actor_id, bytes) {
            // A dropped message is still an accepted call: "offline" is a
            // simulation of an unreachable peer, and the peer's transport
            // should see the same success it sees over HTTP.
            DispatchOutcome::Delivered | DispatchOutcome::Dropped => Ok(Response::new(())),
            DispatchOutcome::NoInbox => Err(Status::not_found("actor inbox not found")),
        }
    }
}

/// Serve gRPC ingress until the process ends.
pub async fn serve(state: Arc<AppState>, port: u16) {
    let addr = match format!("0.0.0.0:{port}").parse() {
        Ok(addr) => addr,
        Err(e) => {
            error!(port, error = %e, "invalid gRPC listen address; gRPC disabled");
            return;
        }
    };

    info!("gRPC transport listening on {addr}");

    if let Err(e) = tonic::transport::Server::builder()
        .add_service(DeRecTransportServer::new(GrpcIngress { state }))
        .serve(addr)
        .await
    {
        error!(error = %e, "gRPC server stopped");
    }
}
```

Register it in `apps/backend/src/lib.rs`:

```rust
pub mod grpc;
```

- [ ] **Step 7: Add the config keys**

In `apps/backend/src/config.rs`, add to the `Defaults` struct and its `Default` impl, following the shape the existing keys use:

```rust
    /// Whether to run the gRPC ingress listener at all.
    pub grpc_enabled: bool,
    /// Port for the gRPC listener.
    pub grpc_port: u16,
```

```rust
            grpc_enabled: true,
            grpc_port: 50051,
```

Add the matching optional fields to the file-parsing struct in the same module, so an omitted key falls back and an unrecognised key is still a boot error.

In `apps/backend/config.example.toml`:

```toml
# The gRPC transport listener. Provisioned helpers can advertise a `grpc://`
# endpoint only while this is running; set false to run HTTP-only.
grpc_enabled = true
grpc_port = 50051
```

- [ ] **Step 8: Start the listener**

In `apps/backend/src/main.rs`, immediately before `axum::serve(listener, app)`:

```rust
    if state.defaults.grpc_enabled {
        let grpc_state = Arc::clone(&state);
        let grpc_port = state.defaults.grpc_port;
        tokio::spawn(async move {
            derec_backend::grpc::serve(grpc_state, grpc_port).await;
        });
    }
```

`build_router` consumes `state`, so take the clone above the `let app = build_router(state);` line.

- [ ] **Step 9: Run everything**

Run: `cd apps/backend && rtk proxy cargo test`
Expected: PASS — `grpc_ingress` (3 tests) plus all pre-existing.

Run: `cd apps/backend && rtk proxy cargo check --all-targets --message-format short`
Expected: no errors, no warnings.

- [ ] **Step 10: Commit**

```bash
git add apps/backend/build.rs apps/backend/Cargo.toml apps/backend/Cargo.lock apps/backend/src/grpc.rs apps/backend/src/lib.rs apps/backend/src/main.rs apps/backend/src/config.rs apps/backend/config.example.toml apps/backend/src/routes/derec.rs apps/backend/tests/grpc_ingress.rs
git commit -m "feat(backend): serve DeRecTransport over gRPC, routed by channel id"
```

---

## Task 4: `GrpcTransport` and `CompositeTransport`

Outbound. Nothing advertises gRPC yet, so this is exercised by unit tests only.

**Files:**
- Create: `apps/backend/src/transport.rs`
- Modify: `apps/backend/src/stores.rs` (move `HttpTransport` out), `apps/backend/src/lib.rs`, `apps/backend/src/actor.rs` (`with_transport`)

**Interfaces:**
- Consumes: `crate::grpc::pb::de_rec_transport_client::DeRecTransportClient`.
- Produces: `HttpTransport::new(reqwest::Client)`, `GrpcTransport::new()`, `CompositeTransport::new(http: HttpTransport, grpc: GrpcTransport)`, `dial_uri(&str) -> String`. `ActorProtocol`'s transport parameter becomes `CompositeTransport`.

- [ ] **Step 1: Write the failing tests**

Create `apps/backend/src/transport.rs` containing the moved `HttpTransport` (cut it verbatim from `stores.rs`, including its `post` helper and doc comments) plus:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn http(uri: &str) -> TransportProtocol {
        TransportProtocol {
            uri: uri.to_owned(),
            protocol: derec_proto::Protocol::Https as i32,
        }
    }

    fn grpc(uri: &str) -> TransportProtocol {
        TransportProtocol {
            uri: uri.to_owned(),
            protocol: derec_proto::Protocol::Grpc as i32,
        }
    }

    #[test]
    fn a_grpc_uri_dials_over_plain_http2() {
        // `grpc://` is the spelling the protocol validates and advertises; the
        // wire underneath is ordinary HTTP/2, so the client needs `http://`.
        assert_eq!(dial_uri("grpc://localhost:50051"), "http://localhost:50051");
        assert_eq!(dial_uri("grpcs://a.example:443"), "https://a.example:443");
    }

    #[test]
    fn dialing_rewrites_only_the_scheme() {
        assert_eq!(
            dial_uri("grpc://localhost:50051/ignored"),
            "http://localhost:50051/ignored"
        );
    }

    #[test]
    fn endpoints_are_partitioned_by_discriminant_preserving_order() {
        // The peer's order is its preference and must survive partitioning:
        // the composite walks the list as given.
        let offered = vec![grpc("grpc://a:1"), http("http://b:2"), grpc("grpc://c:3")];

        let plan = CompositeTransport::plan(&offered);

        assert_eq!(
            plan.iter().map(|(_, e)| e.uri.as_str()).collect::<Vec<_>>(),
            vec!["grpc://a:1", "http://b:2", "grpc://c:3"]
        );
        assert_eq!(plan[0].0, Leg::Grpc);
        assert_eq!(plan[1].0, Leg::Http);
    }

    #[test]
    fn an_unknown_discriminant_is_skipped_rather_than_dialed() {
        let offered = vec![
            TransportProtocol { uri: "??://x".to_owned(), protocol: 99 },
            http("http://b:2"),
        ];

        let plan = CompositeTransport::plan(&offered);

        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].1.uri, "http://b:2");
    }

    #[test]
    fn an_empty_plan_means_nothing_was_dialable() {
        let offered = vec![TransportProtocol { uri: "??://x".to_owned(), protocol: 99 }];

        assert!(CompositeTransport::plan(&offered).is_empty());
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/backend && rtk proxy cargo test --lib transport`
Expected: FAIL to compile — `dial_uri`, `CompositeTransport`, `Leg` do not exist.

- [ ] **Step 3: Implement**

Append to `apps/backend/src/transport.rs`:

```rust
/// Rewrite a DeRec endpoint URI into the http-family URL a gRPC client dials.
///
/// `grpc://` and `grpcs://` are the spellings the protocol validates and
/// advertises; the wire underneath is ordinary HTTP/2.
///
/// `grpcs://` yields an `https://` URL that a default-features `tonic` cannot
/// dial — it is built with no TLS backend. This app is plaintext loopback and
/// does not enable one; see the spec's non-goals.
pub fn dial_uri(uri: &str) -> String {
    uri.replacen("grpcs://", "https://", 1)
        .replacen("grpc://", "http://", 1)
}

/// Delivers each envelope as one unary `DeRecTransport.Send` call.
#[derive(Clone, Default)]
pub struct GrpcTransport;

impl GrpcTransport {
    pub fn new() -> Self {
        Self
    }

    async fn call(uri: &str, message: &[u8]) -> Result<(), String> {
        let envelope = derec_proto::DeRecMessage::decode(message)
            .map_err(|e| format!("undecodable envelope: {e}"))?;
        let dial = dial_uri(uri);

        let mut client = crate::grpc::pb::de_rec_transport_client::DeRecTransportClient::connect(
            dial.clone(),
        )
        .await
        .map_err(|e| format!("connect {dial}: {e}"))?;

        client
            .send(envelope)
            .await
            .map(|_| ())
            .map_err(|e| format!("send {dial}: {e}"))
    }
}

/// Which client dials a given endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Leg {
    Http,
    Grpc,
}

/// Dials whichever transports a peer advertised.
///
/// The library filters a peer's endpoints and hands over the survivors in the
/// peer's own order, taking no view on which to use — choosing, and failing
/// over, is this transport's job. Walking the list in order is the simplest
/// useful policy and the one this reference app documents.
#[derive(Clone)]
pub struct CompositeTransport {
    http: HttpTransport,
    grpc: GrpcTransport,
}

impl CompositeTransport {
    pub fn new(http: HttpTransport, grpc: GrpcTransport) -> Self {
        Self { http, grpc }
    }

    /// Pair each endpoint with the client that can dial it, dropping any whose
    /// discriminant this app does not serve. Order is the peer's, preserved.
    pub fn plan(endpoints: &[TransportProtocol]) -> Vec<(Leg, &TransportProtocol)> {
        endpoints
            .iter()
            .filter_map(|e| match derec_proto::Protocol::try_from(e.protocol) {
                Ok(derec_proto::Protocol::Https) => Some((Leg::Http, e)),
                Ok(derec_proto::Protocol::Grpc) => Some((Leg::Grpc, e)),
                Err(_) => None,
            })
            .collect()
    }
}

impl DeRecTransport for CompositeTransport {
    fn send(&self, endpoints: &[TransportProtocol], message: Vec<u8>) -> TransportFuture<'_> {
        let plan: Vec<(Leg, String)> = Self::plan(endpoints)
            .into_iter()
            .map(|(leg, e)| (leg, e.uri.clone()))
            .collect();
        let offered = endpoints.len();
        let client = self.http.client();

        Box::pin(async move {
            if plan.is_empty() {
                tracing::error!(offered, "transport: no endpoint on a protocol this node dials");
                return Err(derec_library::Error::Invariant(
                    "transport: peer advertised no dialable endpoint",
                ));
            }

            for (leg, uri) in &plan {
                let attempt = match leg {
                    Leg::Http => HttpTransport::post(&client, uri, message.clone()).await,
                    Leg::Grpc => GrpcTransport::call(uri, &message).await,
                };
                match attempt {
                    Ok(()) => return Ok(()),
                    Err(reason) => {
                        tracing::warn!(uri = %uri, leg = ?leg, reason = %reason, "transport: endpoint failed");
                    }
                }
            }

            tracing::error!(attempted = plan.len(), "transport: every endpoint failed");
            Err(derec_library::Error::Invariant(
                "transport: no endpoint accepted the message",
            ))
        })
    }
}
```

`HttpTransport::post` and a `client()` accessor must be `pub(crate)` for the composite to call them; widen them from private and add:

```rust
    pub(crate) fn client(&self) -> reqwest::Client {
        self.client.clone()
    }
```

Add `use prost::Message as _;` to the file's imports for `DeRecMessage::decode`.

- [ ] **Step 4: Swap the actor's transport**

In `apps/backend/src/stores.rs`, change the `ActorProtocol` alias's transport parameter from `HttpTransport` to `crate::transport::CompositeTransport`, and re-export from `transport.rs` rather than defining locally.

In `apps/backend/src/actor.rs`, in `build_protocol`:

```rust
        .with_transport(CompositeTransport::new(
            HttpTransport::new(config.http_client.clone()),
            GrpcTransport::new(),
        ))
```

Register the module in `apps/backend/src/lib.rs`:

```rust
pub mod transport;
```

- [ ] **Step 5: Run**

Run: `cd apps/backend && rtk proxy cargo test`
Expected: PASS, including the 5 new transport tests.

Run: `cd apps/backend && rtk proxy cargo check --all-targets --message-format short`
Expected: no errors, no warnings.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/transport.rs apps/backend/src/stores.rs apps/backend/src/actor.rs apps/backend/src/lib.rs
git commit -m "feat(backend): dial gRPC and HTTP from one composite transport"
```

---

## Task 5: Advertised endpoints and transport modes

**Files:**
- Modify: `apps/backend/src/models.rs`, `apps/backend/src/provisioning.rs`, `apps/backend/src/actor.rs` (`ProtocolConfig`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `models::TransportProtocol::Grpc`; `models::TransportMode::{Http, Grpc, Both}` with `TransportMode::endpoints(&self, base_url: &str, grpc_authority: &str, actor_id: Uuid) -> Vec<Transport>`; `Actor.transports: Vec<Transport>`; `ProtocolConfig.own_transports: Vec<Transport>` replacing `transport_uri: String`; `provisioned_actor(role, name, base_url, grpc_authority, mode) -> Actor`.

- [ ] **Step 1: Write the failing tests**

Replace the existing `a_transport_uri_is_the_base_url_plus_the_actor_id` test in `apps/backend/src/provisioning.rs` with:

```rust
    #[test]
    fn an_http_helper_advertises_only_its_http_endpoint() {
        // The URI is what peers post to, and `deliver_message` parses the id
        // back out of it, so the two must agree on the shape.
        let actor = provisioned_actor(
            Role::Helper,
            "test",
            "http://localhost:5000",
            "localhost:50051",
            TransportMode::Http,
        );

        assert_eq!(actor.transports.len(), 1);
        assert_eq!(
            actor.transports[0].uri,
            format!("http://localhost:5000/derec/{}", actor.id)
        );
        assert_eq!(actor.transports[0].protocol, TransportProtocol::Https);
    }

    #[test]
    fn a_grpc_helper_advertises_an_authority_with_no_actor_path() {
        // gRPC has no path to carry an actor id — the id is recovered from the
        // envelope's channel id instead.
        let actor = provisioned_actor(
            Role::Helper,
            "test",
            "http://localhost:5000",
            "localhost:50051",
            TransportMode::Grpc,
        );

        assert_eq!(actor.transports.len(), 1);
        assert_eq!(actor.transports[0].uri, "grpc://localhost:50051");
        assert_eq!(actor.transports[0].protocol, TransportProtocol::Grpc);
    }

    #[test]
    fn a_both_helper_advertises_grpc_first() {
        // An arbitrary but fixed app preference: the order carries no protocol
        // meaning, and the library takes no view on which a dialer picks.
        let actor = provisioned_actor(
            Role::Helper,
            "test",
            "http://localhost:5000",
            "localhost:50051",
            TransportMode::Both,
        );

        assert_eq!(actor.transports.len(), 2);
        assert_eq!(actor.transports[0].protocol, TransportProtocol::Grpc);
        assert_eq!(actor.transports[1].protocol, TransportProtocol::Https);
    }

    #[test]
    fn the_singular_transport_mirrors_the_first_entry() {
        // Four front-end call sites read `transport.uri` as "an address for
        // this actor"; it must never disagree with the head of the list.
        let actor = provisioned_actor(
            Role::Helper,
            "test",
            "http://localhost:5000",
            "localhost:50051",
            TransportMode::Both,
        );

        assert_eq!(actor.transport, actor.transports[0]);
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/backend && rtk proxy cargo test --lib provisioning`
Expected: FAIL to compile — `TransportMode` and `Actor.transports` do not exist.

- [ ] **Step 3: Implement the model changes**

In `apps/backend/src/models.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportProtocol {
    Https,
    Grpc,
}
```

(`Transport` gains `PartialEq, Eq` so the mirror test can compare.)

```rust
/// Which transports one provisioned helper serves.
///
/// This is about what it *advertises*. Every provisioned actor dials both
/// regardless — a gRPC-only helper still answers a peer over HTTP if that is
/// what the peer advertised.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportMode {
    /// The status quo, and what an omitted mode resolves to.
    #[default]
    Http,
    Grpc,
    Both,
}

impl TransportMode {
    /// The endpoints a helper in this mode advertises, in preference order.
    ///
    /// `Both` leads with gRPC. The order is an arbitrary fixed app preference:
    /// the library hands a peer's whole list to `DeRecTransport::send` and
    /// takes no view on which entry is dialed.
    pub fn endpoints(
        &self,
        base_url: &str,
        grpc_authority: &str,
        actor_id: Uuid,
    ) -> Vec<Transport> {
        let http = Transport {
            protocol: TransportProtocol::Https,
            uri: format!("{base_url}/derec/{actor_id}"),
        };
        // No actor path: tonic builds the request URI from the authority plus
        // the fixed method path, so anything after it is dropped. The actor is
        // recovered from the envelope's channel id instead.
        let grpc = Transport {
            protocol: TransportProtocol::Grpc,
            uri: format!("grpc://{grpc_authority}"),
        };

        match self {
            TransportMode::Http => vec![http],
            TransportMode::Grpc => vec![grpc],
            TransportMode::Both => vec![grpc, http],
        }
    }
}
```

Add to `Actor`, keeping `transport`:

```rust
    /// Every endpoint this actor advertises, in preference order.
    pub transports: Vec<Transport>,
```

Document `transport` as the first entry:

```rust
    /// The first of [`Self::transports`]. Kept because several front-end call
    /// sites want "an address for this actor" and gain nothing from the list.
    pub transport: Transport,
```

- [ ] **Step 4: Implement the provisioning change**

In `apps/backend/src/provisioning.rs`:

```rust
pub fn provisioned_actor(
    role: Role,
    name: &str,
    base_url: &str,
    grpc_authority: &str,
    mode: TransportMode,
) -> Actor {
    let actor_id = Uuid::new_v4();
    let transports = mode.endpoints(base_url, grpc_authority, actor_id);
    Actor {
        id: actor_id,
        role,
        name: name.to_owned(),
        transport: transports[0].clone(),
        transports,
        secret_id: actor_secret_id().to_string(),
    }
}
```

`mode.endpoints` never returns empty, so `transports[0]` cannot panic.

- [ ] **Step 5: Thread the list into the protocol**

In `apps/backend/src/actor.rs`, replace `ProtocolConfig.transport_uri: String` with:

```rust
    /// Every endpoint this actor advertises, in preference order.
    pub own_transports: Vec<crate::models::Transport>,
```

In `configure_builder`, derive the plaintext opt-in from the whole set — any plaintext endpoint requires it:

```rust
        .with_unsafe_connection(config.own_transports.iter().any(|t| {
            t.uri.starts_with("http://") || t.uri.starts_with("grpc://")
        }))
```

In `build_protocol`:

```rust
        .with_own_transports(
            config
                .own_transports
                .iter()
                .map(|t| t.uri.as_str())
                .collect::<Vec<_>>(),
        );
```

Update `spawn_provisioned` in `provisioning.rs` to pass `own_transports: actor.transports.clone()`.

Update every remaining `transport_uri` construction site the compiler flags — `tests/reconfigure.rs`, `tests/replica_*.rs`, `src/state.rs`'s `test_support` — to build a one-element `vec![Transport { protocol: TransportProtocol::Https, uri: … }]`.

Callers of `provisioned_actor` in `routes/helpers.rs` and `routes/owners.rs` need the two new arguments. Owners are always HTTP: pass `TransportMode::Http`. Take `grpc_authority` from a new `AppState` accessor added in Task 6; until then pass `"localhost:50051"` and fix it there.

- [ ] **Step 6: Run**

Run: `cd apps/backend && rtk proxy cargo test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/models.rs apps/backend/src/provisioning.rs apps/backend/src/actor.rs apps/backend/src/state.rs apps/backend/src/routes apps/backend/tests
git commit -m "feat(backend): advertise a transport list chosen per helper"
```

---

## Task 6: Pool composition by transport mode

**Files:**
- Modify: `apps/backend/src/state.rs` (`ensure_participants`, `grpc_authority`), `apps/backend/src/models.rs` (request DTOs), `apps/backend/src/config.rs`, `apps/backend/src/routes/helpers.rs`, `apps/backend/src/routes/config.rs`, `apps/backend/config.example.toml`

**Interfaces:**
- Consumes: `TransportMode` from Task 5.
- Produces: `TransportBreakdown { http: u8, grpc: u8, both: u8 }` with `total()` and `modes()`; `ActorRegistry::ensure_participants_by_mode(&self, want: TransportBreakdown, mint: F) -> EnsuredParticipants` where `F: FnMut(usize, TransportMode) -> Actor`; `AppState::grpc_authority(&self) -> String`.

- [ ] **Step 1: Write the failing tests**

Add to the existing `mod tests` in `apps/backend/src/state.rs`:

```rust
    #[test]
    fn only_the_per_mode_shortfall_is_created() {
        // The pool is shared and the request states a target composition, not
        // a quantity to add — the existing rule, now partitioned by mode.
        let registry = ActorRegistry::default();
        registry.register(helper_with_mode(TransportMode::Http));
        registry.register(helper_with_mode(TransportMode::Http));

        let want = TransportBreakdown { http: 3, grpc: 1, both: 0 };
        let result = registry.ensure_participants_by_mode(want, |_, mode| helper_with_mode(mode));

        assert_eq!(result.created.len(), 2, "one http short, one grpc short");
        assert_eq!(result.participants.len(), 4);
    }

    #[test]
    fn asking_for_fewer_of_a_mode_than_exist_removes_nothing() {
        let registry = ActorRegistry::default();
        for _ in 0..3 {
            registry.register(helper_with_mode(TransportMode::Grpc));
        }

        let want = TransportBreakdown { http: 0, grpc: 1, both: 0 };
        let result = registry.ensure_participants_by_mode(want, |_, mode| helper_with_mode(mode));

        assert!(result.created.is_empty());
        assert_eq!(result.participants.len(), 3);
    }

    #[test]
    fn a_breakdown_reports_its_total() {
        let want = TransportBreakdown { http: 1, grpc: 2, both: 3 };

        assert_eq!(want.total(), 6);
    }

    #[test]
    fn owners_still_do_not_count_towards_the_pool() {
        let registry = ActorRegistry::default();
        registry.register(owner_actor());

        let want = TransportBreakdown { http: 1, grpc: 0, both: 0 };
        let result = registry.ensure_participants_by_mode(want, |_, mode| helper_with_mode(mode));

        assert_eq!(result.created.len(), 1);
        assert_eq!(result.participants.len(), 1);
    }
```

Add the two fixtures beside the module's existing ones:

```rust
    fn helper_with_mode(mode: TransportMode) -> Actor {
        crate::provisioning::provisioned_actor(
            Role::Helper,
            "pool",
            "http://localhost:5000",
            "localhost:50051",
            mode,
        )
    }

    fn owner_actor() -> Actor {
        crate::provisioning::provisioned_actor(
            Role::Owner,
            "owner",
            "http://localhost:5000",
            "localhost:50051",
            TransportMode::Http,
        )
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/backend && rtk proxy cargo test --lib state`
Expected: FAIL to compile — `TransportBreakdown` and `ensure_participants_by_mode` do not exist.

- [ ] **Step 3: Implement the breakdown**

In `apps/backend/src/models.rs`:

```rust
/// A target *composition* for the shared helper pool.
///
/// `EnsureHelpersRequest` states a target, not a quantity to add, so a
/// transport preference has to be expressed the same way: how many helpers of
/// each mode should exist once the call returns.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransportBreakdown {
    #[serde(default)]
    pub http: u8,
    #[serde(default)]
    pub grpc: u8,
    #[serde(default)]
    pub both: u8,
}

impl TransportBreakdown {
    pub fn total(&self) -> usize {
        self.http as usize + self.grpc as usize + self.both as usize
    }

    /// Every mode with a non-zero target, paired with that target.
    pub fn modes(&self) -> [(TransportMode, usize); 3] {
        [
            (TransportMode::Http, self.http as usize),
            (TransportMode::Grpc, self.grpc as usize),
            (TransportMode::Both, self.both as usize),
        ]
    }
}
```

Add to `AddHelperRequest`:

```rust
    /// What this helper advertises. Omitted means HTTP — today's behaviour.
    #[serde(default)]
    pub transport_mode: TransportMode,
```

Add to `EnsureHelpersRequest`:

```rust
    /// Target composition of the pool by transport. Must sum to `total`.
    /// Omitted means every helper is HTTP.
    #[serde(default)]
    pub transports: Option<TransportBreakdown>,
```

- [ ] **Step 4: Implement the partitioned shortfall**

In `apps/backend/src/state.rs`, beside `ensure_participants`:

```rust
    /// Bring the pool up to a target composition, creating only the per-mode
    /// shortfall.
    ///
    /// The whole count-and-create happens under one lock, so two browser
    /// contexts setting up at the same moment cannot each fill an empty pool.
    /// Asking for fewer of a mode than exist removes nothing: another owner
    /// may be paired with one.
    pub fn ensure_participants_by_mode<F>(
        &self,
        want: TransportBreakdown,
        mut mint: F,
    ) -> EnsuredParticipants
    where
        F: FnMut(usize, TransportMode) -> Actor,
    {
        let mut actors = self.write();
        let mut created: Vec<Actor> = Vec::new();

        for (mode, target) in want.modes() {
            let existing = actors
                .iter()
                .filter(|a| a.role == Role::Helper && mode_of(a) == mode)
                .count();
            for index in existing..target {
                let actor = mint(index, mode);
                actors.push(actor.clone());
                created.push(actor);
            }
        }

        let participants = actors
            .iter()
            .filter(|a| a.role == Role::Helper)
            .cloned()
            .collect();

        EnsuredParticipants { created, participants }
    }
```

and the classifier, which reads the mode back off what an actor advertises so no second field can drift from it:

```rust
/// Which mode an actor's advertised endpoints correspond to.
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

Add the authority accessor to `AppState`:

```rust
    /// Host and port peers dial for gRPC, derived from `base_url`'s host and
    /// the configured gRPC port so a LAN `BASE_URL` produces a LAN gRPC
    /// endpoint rather than an unreachable `localhost` one.
    pub fn grpc_authority(&self) -> String {
        let host = self
            .base_url
            .split("://")
            .nth(1)
            .and_then(|rest| rest.split('/').next())
            .and_then(|authority| authority.split(':').next())
            .unwrap_or("localhost");
        format!("{host}:{}", self.defaults.grpc_port)
    }
```

- [ ] **Step 5: Validate and use it in the route**

In `apps/backend/src/routes/helpers.rs`'s ensure handler, before touching the registry:

```rust
    let want = match req.transports {
        Some(breakdown) => {
            if breakdown.total() != req.total as usize {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": "transports must sum to total"
                    })),
                )
                    .into_response();
            }
            if !state.defaults.grpc_enabled && (breakdown.grpc > 0 || breakdown.both > 0) {
                // Not a silent downgrade: a helper advertising an endpoint
                // nothing is listening on pairs successfully and then
                // black-holes every reply.
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": "gRPC helpers requested but grpc_enabled is false"
                    })),
                )
                    .into_response();
            }
            breakdown
        }
        None => TransportBreakdown { http: req.total, grpc: 0, both: 0 },
    };
```

Then call `ensure_participants_by_mode(want, |index, mode| provisioned_actor(Role::Helper, &helper_name(&req.names, index, index), &state.base_url, &state.grpc_authority(), mode))`. Apply the same `grpc_enabled` check to `AddHelperRequest.transport_mode` in the add handler.

- [ ] **Step 6: Config and `GET /config`**

In `apps/backend/src/config.rs`, add to `RawDefaults` (it is `deny_unknown_fields`, so every new key must appear here or a config using it fails to boot):

```rust
    helper_transports: Option<crate::models::TransportBreakdown>,
    grpc_relay_enabled: Option<bool>,
```

Add to `Defaults`:

```rust
    /// Prefills the wizard's transport breakdown. Sums to `participant_count`.
    pub helper_transports: crate::models::TransportBreakdown,
    /// Whether the backend dials gRPC on a browser owner's behalf.
    pub grpc_relay_enabled: bool,
```

`grpc_enabled` and `grpc_port` were added to both structs in Task 3 §7; if that step only touched `Defaults`, add them to `RawDefaults` now.

In `Defaults::default()`:

```rust
            helper_transports: crate::models::TransportBreakdown {
                http: 7,
                grpc: 0,
                both: 0,
            },
            grpc_relay_enabled: true,
```

The literal `7` matches `participant_count`'s default. Do not compute it from `Self::default()` — that recurses.

In `Defaults::resolve`, follow the clamping rule the neighbouring thresholds use: a breakdown the file *does* state goes to `validate` as written, and an omitted one is derived from whatever `participant_count` resolved to, so writing only `participant_count = 4` does not fail on a stale total:

```rust
            helper_transports: raw.helper_transports.unwrap_or(
                crate::models::TransportBreakdown {
                    http: participant_count,
                    grpc: 0,
                    both: 0,
                },
            ),
            grpc_relay_enabled: raw
                .grpc_relay_enabled
                .unwrap_or(base.grpc_relay_enabled),
```

In `Defaults::validate`, beside the existing cross-field checks:

```rust
        if self.helper_transports.total() != self.participant_count as usize {
            return Err(format!(
                "helper_transports sums to {} but participant_count is {}",
                self.helper_transports.total(),
                self.participant_count
            ));
        }
        if !self.grpc_enabled
            && (self.helper_transports.grpc > 0 || self.helper_transports.both > 0)
        {
            return Err(
                "helper_transports asks for gRPC helpers but grpc_enabled is false".to_owned(),
            );
        }
        if self.grpc_port == 0 {
            return Err("grpc_port must be greater than 0".to_owned());
        }
```

In `apps/backend/src/routes/config.rs`, add `helper_transports`, `grpc_enabled` and `grpc_relay_enabled` to the served DTO. `Defaults` already derives `Serialize`, so if that handler serves it directly the fields appear with no further change — check before adding a mapping that duplicates it.

Append to `config.example.toml`:

```toml
# Prefills the wizard's transport breakdown. Must sum to `participant_count`.
[helper_transports]
http = 7
grpc = 0
both = 0

# Whether the backend will dial gRPC on a browser owner's behalf. A browser
# cannot speak gRPC itself. Turning this off makes a gRPC-only helper
# unreachable from a browser, which is a behaviour worth observing on purpose.
grpc_relay_enabled = true
```

- [ ] **Step 7: Run**

Run: `cd apps/backend && rtk proxy cargo test`
Expected: PASS, including `the_shipped_example_config_parses_and_validates`.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src apps/backend/config.example.toml
git commit -m "feat(backend): compose the helper pool by transport mode"
```

---

## Task 7: The browser relay

**Files:**
- Modify: `apps/backend/src/routes/derec.rs`, `apps/backend/src/routes/mod.rs`

**Interfaces:**
- Consumes: `CompositeTransport`, `AppState.actors`, `grpc_relay_enabled`.
- Produces: `POST /derec/relay` taking `{ "uri": String, "data": String }` (base64url), answering `202` / `403` / `503`.

- [ ] **Step 1: Write the failing test**

Add to `apps/backend/tests/grpc_ingress.rs`:

```rust
#[actix_rt::test]
async fn the_relay_refuses_an_endpoint_no_registered_actor_advertises() {
    // Without this check the route is an open SSRF proxy, and this app is run
    // on laptops on shared networks.
    let state = derec_backend::test_support::app_state();

    assert!(!derec_backend::routes::derec::relay_target_is_known(
        &state,
        "grpc://evil.example:50051"
    ));
}

#[actix_rt::test]
async fn the_relay_accepts_an_endpoint_a_registered_actor_advertises() {
    let state = derec_backend::test_support::app_state();
    let actor = derec_backend::provisioning::provisioned_actor(
        derec_backend::models::Role::Helper,
        "grpc helper",
        "http://localhost:5000",
        "localhost:50051",
        derec_backend::models::TransportMode::Grpc,
    );
    let uri = actor.transports[0].uri.clone();
    state.actors.register(actor);

    assert!(derec_backend::routes::derec::relay_target_is_known(&state, &uri));
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/backend && rtk proxy cargo test --test grpc_ingress relay`
Expected: FAIL to compile — `relay_target_is_known` does not exist.

- [ ] **Step 3: Implement**

Add to `apps/backend/src/routes/derec.rs`:

```rust
#[derive(Debug, Deserialize)]
pub struct RelayRequest {
    /// The endpoint to deliver to, as the peer advertised it.
    pub uri: String,
    /// Raw wire bytes, base64url-encoded — the same encoding
    /// [`MailboxMessage`] uses in the other direction.
    pub data: String,
}

/// Whether any registered actor currently advertises `uri`.
///
/// The relay exists so a browser owner can reach a gRPC peer it cannot dial
/// itself. Restricting it to advertised endpoints is what keeps it from being
/// a general-purpose proxy.
pub fn relay_target_is_known(state: &AppState, uri: &str) -> bool {
    state
        .actors
        .all()
        .iter()
        .any(|actor| actor.transports.iter().any(|t| t.uri == uri))
}

/// POST /derec/relay
///
/// Dial an endpoint on a browser owner's behalf. A browser has no HTTP/2
/// trailer access and so cannot speak gRPC; the backend already terminates
/// transport for every actor here, so performing the dial is a small extension
/// of that rather than a new role.
pub async fn relay(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RelayRequest>,
) -> Response {
    if !state.defaults.grpc_relay_enabled {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "relay disabled" })),
        )
            .into_response();
    }

    if !relay_target_is_known(&state, &req.uri) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "unknown relay target" })),
        )
            .into_response();
    }

    let Ok(bytes) = URL_SAFE_NO_PAD.decode(&req.data) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "invalid base64url payload" })),
        )
            .into_response();
    };

    let transport = crate::transport::CompositeTransport::new(
        crate::transport::HttpTransport::new(state.http_client.clone()),
        crate::transport::GrpcTransport::new(),
    );
    let endpoint = derec_proto::TransportProtocol {
        protocol: if req.uri.starts_with("grpc") {
            derec_proto::Protocol::Grpc as i32
        } else {
            derec_proto::Protocol::Https as i32
        },
        uri: req.uri.clone(),
    };

    use derec_library::protocol::DeRecTransport as _;
    match transport.send(std::slice::from_ref(&endpoint), bytes).await {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(e) => {
            tracing::error!(uri = %req.uri, error = %e, "relay delivery failed");
            (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": "relay delivery failed" })),
            )
                .into_response()
        }
    }
}
```

Add an `all()` accessor to `ActorRegistry` if it lacks one, returning `Vec<Actor>` (every accessor there returns owned data by design, so a lock is never held across an await).

Register the route in `apps/backend/src/routes/mod.rs` beside the existing `/derec/:actor_id` routes:

```rust
        .route("/derec/relay", post(derec::relay))
```

Register it **before** `/derec/{actor_id}` so `relay` is not parsed as a UUID.

- [ ] **Step 4: Run**

Run: `cd apps/backend && rtk proxy cargo test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes
git commit -m "feat(backend): relay gRPC egress for browser owners"
```

---

## Task 8: Front-end transport and DTOs

**Files:**
- Modify: `apps/web/src/api.ts`, `apps/web/src/derecApi.ts`, `apps/web/src/stores.ts`, `apps/web/src/config.ts`, `apps/web/src/OwnerPage.tsx`
- Test: `apps/web/src/stores.test.ts`

**Interfaces:**
- Consumes: `POST /derec/relay`.
- Produces: `makeTransport(sendFn, relayFn)`; `relayMessage(uri: string, message: Uint8Array): Promise<void>` in `derecApi.ts`; `BEActor.transports: TransportDto[]`.

- [ ] **Step 1: Write the failing tests**

Replace the `describe('transport', …)` block in `apps/web/src/stores.test.ts` with:

```ts
describe('transport', () => {
  const message = new TextEncoder().encode('bytes')
  const https = (uri: string) => ({ protocol: 'https', uri })
  const grpc = (uri: string) => ({ protocol: 'grpc', uri })

  it('posts directly to an http endpoint and never reaches the relay', () => {
    const posted: string[] = []
    const relayed: string[] = []
    const transport = makeTransport(
      async uri => { posted.push(uri) },
      async uri => { relayed.push(uri) },
    )

    return transport.send([https('https://a.example')], message).then(() => {
      expect(posted).toEqual(['https://a.example'])
      expect(relayed).toEqual([])
    })
  })

  it('sends a grpc endpoint through the relay, since a browser cannot dial it', async () => {
    const posted: string[] = []
    const relayed: string[] = []
    const transport = makeTransport(
      async uri => { posted.push(uri) },
      async uri => { relayed.push(uri) },
    )

    await transport.send([grpc('grpc://a.example:50051')], message)

    expect(relayed).toEqual(['grpc://a.example:50051'])
    expect(posted).toEqual([])
  })

  it('walks a mixed list in the peer order and stops at the first success', async () => {
    const attempted: string[] = []
    const transport = makeTransport(
      async uri => { attempted.push(uri) },
      async uri => { attempted.push(uri); throw new Error('relay off') },
    )

    await transport.send([grpc('grpc://a:1'), https('https://b:2')], message)

    expect(attempted).toEqual(['grpc://a:1', 'https://b:2'])
  })

  it('rejects when the relay is unavailable and grpc is all the peer offered', async () => {
    // With the relay disabled a browser owner genuinely has no way to reach a
    // grpc-only peer; the transport must say so rather than hang.
    const transport = makeTransport(
      async () => {},
      async () => { throw new Error('relay disabled') },
    )

    await expect(
      transport.send([grpc('grpc://a:1')], message),
    ).rejects.toThrow(/no endpoint accepted/)
  })

  it('rejects when the peer offered a protocol with no leg at all', async () => {
    const transport = makeTransport(async () => {}, async () => {})

    await expect(
      transport.send([{ protocol: 'quic', uri: 'quic://a:1' }], message),
    ).rejects.toThrow(/no dialable endpoint/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run src/stores.test.ts`
Expected: FAIL — `makeTransport` takes one argument.

- [ ] **Step 3: Implement**

In `apps/web/src/derecApi.ts`, beside the existing sender:

```ts
/**
 * Ask the backend to deliver a message to an endpoint this browser cannot
 * dial. A browser has no HTTP/2 trailer access and so cannot speak gRPC.
 */
export async function relayMessage(uri: string, message: Uint8Array): Promise<void> {
  const res = await request('/derec/relay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uri, data: toBase64Url(message) }),
  })
  if (!res.ok) {
    throw new Error(await errorMessage(res, `relay failed: ${res.status}`))
  }
}
```

Replace `makeTransport` in `apps/web/src/stores.ts`:

```ts
/**
 * The library hands over every endpoint the peer advertised that survived its
 * transport policy, in the peer's own order, and leaves the choice between
 * them to the application.
 *
 * HTTP endpoints are posted directly. gRPC endpoints go through the backend
 * relay: a browser cannot speak gRPC itself, and the backend already
 * terminates transport for every actor here. Anything else is skipped. The
 * first endpoint that accepts wins; the promise rejects only when none did.
 */
export function makeTransport(
  sendFn: (uri: string, message: Uint8Array) => Promise<void>,
  relayFn: (uri: string, message: Uint8Array) => Promise<void>,
) {
  return {
    async send(
      endpoints: ReadonlyArray<{ protocol: string; uri: string }>,
      message: Uint8Array,
    ): Promise<void> {
      const plan = endpoints
        .map(e => {
          const protocol = e.protocol.toLowerCase()
          if (protocol === 'https') return { uri: e.uri, deliver: sendFn }
          if (protocol === 'grpc') return { uri: e.uri, deliver: relayFn }
          return null
        })
        .filter((leg): leg is { uri: string; deliver: typeof sendFn } => leg !== null)

      if (plan.length === 0) {
        throw new Error(
          `transport: no dialable endpoint among the peer's ${endpoints.length} offer(s)`,
        )
      }

      const failures: string[] = []
      for (const leg of plan) {
        try {
          await leg.deliver(leg.uri, message)
          return
        } catch (err) {
          failures.push(`${leg.uri}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      throw new Error(`transport: no endpoint accepted the message (${failures.join('; ')})`)
    },
  }
}
```

In `apps/web/src/OwnerPage.tsx`, update the single call site:

```ts
    .withTransport(makeTransport(sendMessage, relayMessage))
```

adding `relayMessage` to the `./derecApi` import.

- [ ] **Step 4: Add the DTO fields**

In `apps/web/src/api.ts`, add to the actor DTO beside the existing `transport`:

```ts
  /** Every endpoint this actor advertises, in preference order. */
  transports: TransportDto[]
```

with `interface TransportDto { protocol: 'https' | 'grpc'; uri: string }`. Leave `transport` and its four consumers alone — it is the first entry.

In `apps/web/src/config.ts`, add `helperTransports: { http: number; grpc: number; both: number }`, `grpcEnabled: boolean` and `grpcRelayEnabled: boolean` to `ServerDefaults`, parsed from `helper_transports`, `grpc_enabled` and `grpc_relay_enabled` with the same `count(...)`-style fallbacks the file already uses.

- [ ] **Step 5: Run**

Run: `cd apps/web && npx tsc -b && npx eslint . && npx vitest run`
Expected: typecheck clean, lint clean, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): relay gRPC endpoints the browser cannot dial"
```

---

## Task 9: Wizard transport breakdown

**Files:**
- Modify: `apps/web/src/SetupWizard.tsx`, `apps/web/src/api.ts`, `apps/web/src/config.ts`
- Test: `apps/web/e2e/app.ts` (the `setUpOwner` helper)

**Interfaces:**
- Consumes: `ServerDefaults.helperTransports` from Task 8.
- Produces: `POST /helpers/ensure` body gains `transports: { http, grpc, both }`; `setUpOwner(page, { transports })` in the e2e helper.

- [ ] **Step 1: Add the balancing helper and its test**

The three counters must always sum to `participantCount`, so raising one has to
take from the others. Put that rule in a pure function rather than in the
component, and test it. Create `apps/web/src/transportMix.ts`:

```ts
/** How many helpers of each transport mode the pool should hold. */
export interface TransportMix {
  http: number
  grpc: number
  both: number
}

export type TransportModeKey = keyof TransportMix

export function totalOf(mix: TransportMix): number {
  return mix.http + mix.grpc + mix.both
}

/**
 * Set one mode's count and rebalance the others so the mix still sums to
 * `total`.
 *
 * Raising a mode takes from the largest of the other two — taking from the
 * smallest would empty it first and make the mix lopsided for no reason.
 * Lowering one gives back to `http`, the mode that needs no listener.
 */
export function rebalance(
  mix: TransportMix,
  mode: TransportModeKey,
  value: number,
  total: number,
): TransportMix {
  const next: TransportMix = { ...mix, [mode]: Math.max(0, Math.min(total, value)) }
  const others = (['http', 'grpc', 'both'] as TransportModeKey[]).filter(k => k !== mode)

  let drift = totalOf(next) - total
  while (drift > 0) {
    const donor = others.reduce((a, b) => (next[a] >= next[b] ? a : b))
    if (next[donor] === 0) break
    next[donor] -= 1
    drift -= 1
  }
  if (drift < 0) next.http -= drift

  return next
}
```

Create `apps/web/src/transportMix.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { rebalance, totalOf } from './transportMix'

describe('rebalance', () => {
  const total = 3

  it('keeps the mix summing to the participant count', () => {
    const mix = rebalance({ http: 3, grpc: 0, both: 0 }, 'grpc', 1, total)

    expect(totalOf(mix)).toBe(total)
    expect(mix.grpc).toBe(1)
  })

  it('takes from the largest other mode', () => {
    // Taking from the smallest would empty it first and skew the mix.
    const mix = rebalance({ http: 2, grpc: 1, both: 0 }, 'both', 1, total)

    expect(mix).toEqual({ http: 1, grpc: 1, both: 1 })
  })

  it('gives back to http when a mode is lowered', () => {
    const mix = rebalance({ http: 1, grpc: 1, both: 1 }, 'grpc', 0, total)

    expect(mix).toEqual({ http: 2, grpc: 0, both: 1 })
  })

  it('clamps a value beyond the total', () => {
    const mix = rebalance({ http: 3, grpc: 0, both: 0 }, 'grpc', 99, total)

    expect(mix).toEqual({ http: 0, grpc: 3, both: 0 })
  })

  it('never produces a negative count', () => {
    const mix = rebalance({ http: 0, grpc: 3, both: 0 }, 'http', -5, total)

    expect(mix.http).toBeGreaterThanOrEqual(0)
    expect(totalOf(mix)).toBe(total)
  })
})
```

Run: `cd apps/web && npx vitest run src/transportMix.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 2: Add the counters**

In `apps/web/src/SetupWizard.tsx`, beneath the existing `participant-count-section`
for "Pre-pair locally", add one section per mode. Copy that block's markup
exactly — the `participant-count-section` / `participant-count-input` /
`stepper` / `count` class names — so the rows line up with the existing ones:

```tsx
{(['grpc', 'both', 'http'] as TransportModeKey[]).map(mode => (
  <div className="participant-count-section" key={mode}>
    <span className="participant-count-section-label">
      {TRANSPORT_LABELS[mode]}
      <span className="participant-count-section-hint">
        {TRANSPORT_HINTS[mode]}
      </span>
    </span>
    <div className="participant-count-input">
      <button
        className="stepper"
        onClick={() => onChangeTransports(rebalance(transports, mode, transports[mode] - 1, participantCount))}
        disabled={transports[mode] <= 0 || (mode !== 'http' && !grpcEnabled)}
        aria-label={`Decrease ${TRANSPORT_LABELS[mode]} participants`}
      >
        −
      </button>
      <span className="count">{transports[mode]}</span>
      <button
        className="stepper"
        onClick={() => onChangeTransports(rebalance(transports, mode, transports[mode] + 1, participantCount))}
        disabled={transports[mode] >= participantCount || (mode !== 'http' && !grpcEnabled)}
        aria-label={`Increase ${TRANSPORT_LABELS[mode]} participants`}
      >
        +
      </button>
    </div>
  </div>
))}
```

with the copy as module constants beside the component:

```tsx
const TRANSPORT_LABELS: Record<TransportModeKey, string> = {
  http: 'HTTP only',
  grpc: 'gRPC only',
  both: 'Both transports',
}

const TRANSPORT_HINTS: Record<TransportModeKey, string> = {
  http: 'Reachable directly from this browser',
  grpc: 'Reached through the backend relay',
  both: 'Advertises gRPC first, HTTP as failover',
}
```

Thread `transports`, `onChangeTransports`, `participantCount` and `grpcEnabled`
through the same props path `prePairedCount` / `onChangePrePairedCount` already
use, seeding state from `defaults.helperTransports` and `defaults.grpcEnabled`
where `prePairedCount` is seeded from `defaults.prePairedCount`.

When `grpcEnabled` is false every count except `http` is pinned at zero and
both its steppers are disabled — the backend rejects such a request outright,
so offering it would be an error the user only discovers on submit.

- [ ] **Step 3: Send it**

Where the wizard already posts `prePairedCount` to `/helpers/ensure`, add:

```ts
        transports: data.transports,
```

and add the matching field to the request type in `apps/web/src/api.ts`.

- [ ] **Step 4: Extend the e2e helper**

In `apps/web/e2e/app.ts`, add an optional `transports?: TransportMix` to
`setUpOwner`'s options and drive the three counters when it is present. The
counters rebalance each other, so set them in the order `grpc`, `both`, `http`
— `http` last, because it absorbs the remainder:

```ts
  if (options.transports) {
    await setCounter(page, 'gRPC only', options.transports.grpc)
    await setCounter(page, 'Both transports', options.transports.both)
  }
```

`http` needs no explicit step: rebalancing leaves it holding whatever the other
two did not take.

- [ ] **Step 5: Run**

Run: `cd apps/web && npx tsc -b && npx eslint . && npx vitest run`
Expected: clean.

Run: `cd apps/web && ./node_modules/.bin/playwright test --reporter=line e2e/smoke.spec.ts`
Expected: PASS — the wizard still completes with the counters present.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src apps/web/e2e/app.ts
git commit -m "feat(web): choose the helper pool's transport mix in the wizard"
```

Task 8's `TransportDto` and this task's `TransportMix` are different types on
purpose: the DTO is one endpoint as it crosses the wire, the mix is a count per
mode in the wizard. Neither should be used where the other belongs.

---

## Task 10: The multi-endpoint peer assertions

What the `Both` helper exists for: proving the library records every endpoint a peer advertised and that failover uses the rest.

**Files:**
- Create: `apps/backend/tests/multi_endpoint.rs`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: nothing.

- [ ] **Step 1: Write the tests**

```rust
//! A peer advertising two endpoints must land two on the channel record, and
//! failover must use the second without rewriting what the peer advertised.

use derec_library::protocol::types::HelperFilter;
use derec_library::protocol::{ChannelQuery, ChannelRecord, DeRecChannelStore};
use derec_backend::models::{Role, TransportMode};

mod common;

#[actix_rt::test]
async fn pairing_with_a_both_helper_records_both_endpoints_in_the_advertised_order() {
    // Neither may be dropped by `admit_peer_endpoints`, and neither may be
    // collapsed by the deprecated singular-field compatibility path.
    let rig = common::owner_paired_with(TransportMode::Both).await;

    let record = rig
        .owner
        .protocol
        .channel_store
        .load(rig.secret_id, ChannelQuery::Helper { channel_id: rig.channel_id })
        .await
        .expect("the in-memory channel store is readable")
        .expect("the channel exists after pairing");

    let ChannelRecord::Helper(helper) = record else {
        panic!("a helper pairing writes a helper record");
    };

    assert_eq!(helper.transports.len(), 2, "both endpoints must survive");
    assert_eq!(
        helper.transports[0].protocol,
        derec_proto::Protocol::Grpc as i32,
        "the peer's order must be preserved verbatim"
    );
    assert_eq!(helper.transports[1].protocol, derec_proto::Protocol::Https as i32);
}

#[actix_rt::test]
async fn a_grpc_only_helper_records_exactly_one_endpoint() {
    let rig = common::owner_paired_with(TransportMode::Grpc).await;

    let ChannelRecord::Helper(helper) = rig
        .owner
        .protocol
        .channel_store
        .load(rig.secret_id, ChannelQuery::Helper { channel_id: rig.channel_id })
        .await
        .expect("readable")
        .expect("paired")
    else {
        panic!("a helper pairing writes a helper record");
    };

    assert_eq!(helper.transports.len(), 1);
    assert_eq!(helper.transports[0].protocol, derec_proto::Protocol::Grpc as i32);
}

#[actix_rt::test]
async fn failover_leaves_the_recorded_endpoints_untouched() {
    // Choosing between endpoints is the transport's business. It must not
    // rewrite the roster: the next attempt should still start at the peer's
    // first preference.
    let rig = common::owner_paired_with(TransportMode::Both).await;
    let before = common::recorded_transports(&rig).await;

    common::send_with_first_endpoint_unreachable(&rig).await;

    assert_eq!(
        common::recorded_transports(&rig).await,
        before,
        "a failover must not mutate what the peer advertised"
    );
}
```

- [ ] **Step 2: Write the fixtures**

Create `apps/backend/tests/common/mod.rs` holding `owner_paired_with(mode)`, `recorded_transports(&rig)` and `send_with_first_endpoint_unreachable(&rig)`. Build the pairing the way `tests/helper_auto_confirm.rs` already does — spawn a provisioned helper in the requested mode, mint its contact, drive `DeRecFlow::Pairing` from an owner instance, and pump both sides until `PairingCompleted`. For the unreachable case, point the helper's first advertised endpoint at a closed port before sending.

- [ ] **Step 3: Run**

Run: `cd apps/backend && rtk proxy cargo test --test multi_endpoint`
Expected: PASS, 3 tests.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/tests
git commit -m "test(backend): assert a multi-endpoint peer is recorded and failed over intact"
```

---

## Task 11: The e2e matrix

**Files:**
- Create: `apps/web/e2e/grpc.spec.ts`

**Interfaces:**
- Consumes: `setUpOwner(page, { transports })` from Task 9.
- Produces: nothing.

- [ ] **Step 1: Write the specs**

```ts
import { expect, test } from '@playwright/test'
import { setUpOwner, pairWithParticipant, protectSecret, verifyShares } from './app'

// The three configurations cover three library behaviours, not three
// transports: a peer offering only what the browser speaks, a peer offering
// only what it must reach some other way, and a peer offering a choice the
// library deliberately declines to make.

test.describe('transports', () => {
  test('an http-only helper pairs, protects and verifies', async ({ page }) => {
    await setUpOwner(page, {
      name: 'Alice',
      participants: 2,
      prePaired: 0,
      minParticipants: 2,
      transports: { http: 2, grpc: 0, both: 0 },
    })

    await pairWithParticipant(page, 0)
    await pairWithParticipant(page, 1)
    await protectSecret(page, 'grpc-matrix-http')
    await verifyShares(page)

    await expect(page.getByTestId('share-status')).toContainText('confirmed')
  })

  test('a grpc-only helper pairs through the relay', async ({ page }) => {
    // The browser cannot dial gRPC; the backend relays on its behalf. This is
    // also the HTTP-to-gRPC crossing: the request leaves over gRPC and the
    // response comes back over HTTP to the owner's mailbox.
    await setUpOwner(page, {
      name: 'Alice',
      participants: 2,
      prePaired: 0,
      minParticipants: 2,
      transports: { http: 0, grpc: 2, both: 0 },
    })

    await pairWithParticipant(page, 0)
    await pairWithParticipant(page, 1)
    await protectSecret(page, 'grpc-matrix-grpc')
    await verifyShares(page)

    await expect(page.getByTestId('share-status')).toContainText('confirmed')
  })

  test('a helper offering both endpoints pairs', async ({ page }) => {
    await setUpOwner(page, {
      name: 'Alice',
      participants: 2,
      prePaired: 0,
      minParticipants: 2,
      transports: { http: 0, grpc: 0, both: 2 },
    })

    await pairWithParticipant(page, 0)
    await pairWithParticipant(page, 1)
    await protectSecret(page, 'grpc-matrix-both')
    await verifyShares(page)

    await expect(page.getByTestId('share-status')).toContainText('confirmed')
  })

  test('with the relay off, a grpc-only helper reports no usable endpoint', async ({ page }) => {
    // The failure must surface rather than hang: a browser owner genuinely has
    // no way to reach a grpc-only peer without the relay.
    await page.route('**/derec/relay', route =>
      route.fulfill({ status: 503, body: '{"error":"relay disabled"}' }),
    )

    await setUpOwner(page, {
      name: 'Alice',
      participants: 1,
      prePaired: 0,
      minParticipants: 1,
      transports: { http: 0, grpc: 1, both: 0 },
    })

    await pairWithParticipant(page, 0).catch(() => {})

    await expect(page.getByTestId('console-panel')).toContainText(
      /no endpoint accepted|relay/i,
    )
  })
})
```

Use whatever helper names `e2e/app.ts` actually exports for pairing, protecting and verifying; if it lacks one, drive the UI the way `e2e/sharing.spec.ts` already does rather than adding an abstraction. Replace the `getByTestId` selectors with the locators the existing specs use.

- [ ] **Step 2: Run the new spec**

Run: `cd apps/web && ./node_modules/.bin/playwright test --reporter=line e2e/grpc.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 3: Run everything**

Run: `cd apps/backend && rtk proxy cargo test && rtk proxy cargo check --all-targets --message-format short`
Expected: all pass, no warnings.

Run: `cd apps/web && npx tsc -b && npx eslint . && npx vitest run`
Expected: clean.

Run: `cd apps/web && ./node_modules/.bin/playwright test --reporter=line`
Expected: the full suite, 43 pre-existing plus 4 new.

- [ ] **Step 4: Update the README**

Add a short section documenting the gRPC listener port, the three helper modes, and the relay — including that turning `grpc_relay_enabled` off is how to observe a browser owner failing to reach a gRPC-only helper.

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e README.md
git commit -m "test(e2e): cover the http/grpc/both helper matrix and the relay-off failure"
```

---

## Self-Review Notes

**Spec coverage:** ingress (T3), router (T1–T2), egress (T4), advertised endpoints (T5), pool composition (T6), config keys (T3 §7, T6 §6), relay (T7), front-end transport (T8), wizard (T9), multi-endpoint assertions (T10), e2e matrix (T11). Every spec section maps to a task.

One spec line has no task of its own: *"both survive a restart, so failover
still works after one."* It is already covered where it can actually fail. The
backend's stores are in-memory, so a restart there loses everything by design;
the front end persists channel records to `localStorage`, and
`stores.test.ts::legacy channel records::leaves a current record untouched`
already round-trips a two-endpoint record through that encoding. Task 10's
`load`-and-assert covers the backend's serde shape. No further task needed.

**Known soft spots the executor must resolve against the real code, not guess:**
- Task 2 §1 and Task 10 §2 reuse existing test fixtures whose exact names were not read while writing this plan. Use the names those files actually export.
- Task 11's selectors are placeholders for whatever `e2e/app.ts` and `e2e/sharing.spec.ts` already use.

These two are the only places where the plan says "match what is there" instead
of quoting code, and both are test scaffolding rather than behaviour. Every
other step contains the literal content.

**Type consistency, checked across tasks:** `ChannelRouter::{pin, rotate,
remove, resolve}` (T1→T2, T3); `dispatch_to_inbox` / `DispatchOutcome` (T3→T3
tests); `CompositeTransport::new(http, grpc)` (T4→T7); `HttpTransport::post`
widened to `pub(crate)` in T4 and called there; `TransportMode::endpoints(
base_url, grpc_authority, actor_id)` (T5→T6); `provisioned_actor(role, name,
base_url, grpc_authority, mode)` — five arguments everywhere it appears (T5, T6,
T7); `TransportBreakdown::{total, modes}` (T6); `ensure_participants_by_mode`
taking `FnMut(usize, TransportMode)` (T6); `makeTransport(sendFn, relayFn)` —
two arguments in T8's implementation, tests and the `OwnerPage` call site;
`rebalance(mix, mode, value, total)` (T9).
