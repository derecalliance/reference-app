//! A helper promotes its own side of a fingerprint-gated pairing.
//!
//! Every replica pairing and every `NoKeys` pairing completes `Pending` on both
//! sides, and only `verify_fingerprint` promotes a side. Fingerprint comparison
//! is an owner-side affordance — the actors on this server are unattended
//! fixtures with no operator to read a code back — so a helper that waited for
//! an external confirmation would wait forever. These tests assert the
//! **status the helper's channel store records**, not merely that nothing
//! errored: a helper that answers happily while its channel sits `Pending`
//! carries no shares and ignores inbound traffic, which is precisely the silent
//! failure this behaviour exists to remove.
//!
//! Driven over real HTTP against `build_router`, because the actors' transport
//! is `HttpTransport` and the responder aborts the handshake if its reply
//! cannot be delivered — a stubbed transport would not exercise the path that
//! emits `PairingCompleted` at all.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use actix::prelude::*;
use derec_backend::actor::{
    ChannelStatusMsg, CreateContactMsg, EnsureReplicaInstanceMsg, InstanceForChannelMsg,
    PendingChannelIdsMsg, ProtocolConfig, ProvisionedActor, build_protocol,
};
use derec_backend::config::Defaults;
use derec_backend::models::{Role, UnpairAck};
use derec_backend::provisioning::{provisioned_actor, register_browser_actor, spawn_provisioned};
use derec_backend::state::{ActorInbox, AppState};
use derec_backend::stores::ActorProtocol;
use derec_library::protocol::{
    ChannelQuery, ChannelRecord, ChannelStatus, DeRecChannelStore, DeRecFlow,
};
use derec_library::types::ChannelId;
use uuid::Uuid;

const TIMEOUT_SECS: u32 = 300;

/// Long enough to cover the actor's 0.5-3s inbound delay on each of the up to
/// three legs a `NoKeys` handshake takes, plus the auto-confirmation behind it.
const POLL_ATTEMPTS: usize = 400;
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Bring up the real router on an ephemeral port and return an `AppState` whose
/// `base_url` points at it, so every actor minted from it gets a transport URI
/// its peers can actually post to.
async fn serve() -> Arc<AppState> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("an ephemeral port is available");
    let port = listener.local_addr().expect("listener is bound").port();

    let state = Arc::new(AppState::new(
        format!("http://127.0.0.1:{port}"),
        Defaults::default(),
        reqwest::Client::new(),
        actix_rt::Arbiter::current(),
    ));

    let router = derec_backend::build_router(state.clone());
    actix_rt::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    state
}

/// Provision a hosted helper exactly as `POST /helpers` does.
fn spawn_helper(state: &Arc<AppState>, name: &str) -> (Uuid, Addr<ProvisionedActor>) {
    spawn_actor(state, Role::Helper, name)
}

fn spawn_actor(state: &Arc<AppState>, role: Role, name: &str) -> (Uuid, Addr<ProvisionedActor>) {
    let actor = provisioned_actor(role, name, &state.base_url);
    state.actors.register(actor.clone());
    spawn_provisioned(state, &actor, TIMEOUT_SECS, UnpairAck::Required);

    let addr = match state
        .actor_inboxes
        .get(&actor.id)
        .expect("spawning registers an inbox")
        .value()
    {
        ActorInbox::Provisioned(addr) => addr.clone(),
        ActorInbox::Browser(_) => panic!("this actor must be backend-managed"),
    };

    (actor.id, addr)
}

/// The counterparty: a browser-managed owner, driven directly from the test the
/// way the front end drives its WASM protocol.
struct Owner {
    id: Uuid,
    secret_id: u64,
    protocol: ActorProtocol,
}

fn register_owner(state: &Arc<AppState>, name: &str) -> Owner {
    build_owner(state, name, true)
}

/// An owner the helper's replies cannot reach.
///
/// The actor is minted with a real transport URI but is never registered, so
/// `deliver_message` answers `404` and `HttpTransport::send` turns that into an
/// error. See `the_tick_backstop_confirms_a_channel_the_event_path_missed` for
/// why a test wants that.
fn register_unreachable_owner(state: &Arc<AppState>, name: &str) -> Owner {
    build_owner(state, name, false)
}

fn build_owner(state: &Arc<AppState>, name: &str, reachable: bool) -> Owner {
    let actor = provisioned_actor(Role::Owner, name, &state.base_url);
    let secret_id: u64 = actor.secret_id.parse().expect("secret id is a u64");
    if reachable {
        state.actors.register(actor.clone());
        // A browser inbox, so the helper's replies are buffered rather than
        // handed to an in-process actor. `pump` below drains it, standing in
        // for the front end's poll loop.
        register_browser_actor(state, actor.id);
    }

    let config = ProtocolConfig {
        secret_id,
        transport_uri: actor.transport.uri.clone(),
        communication_info: HashMap::from([("name".to_owned(), name.to_owned())]),
        timeout_secs: TIMEOUT_SECS,
        unpair_ack: UnpairAck::Required,
        threshold: 2,
        keep_versions_count: 3,
        replica_id: Some(rand::random()),
        http_client: state.http_client.clone(),
    };

    Owner {
        id: actor.id,
        secret_id,
        protocol: build_protocol(&config).expect("the owner's protocol builds"),
    }
}

/// Drain the owner's mailbox into its protocol, as the front end's poll loop
/// does. A no-op when the mailbox is empty.
async fn pump(state: &AppState, owner: &mut Owner) {
    let Some(receiver) = state
        .browser_receivers
        .get(&owner.id)
        .map(|entry| entry.value().clone())
    else {
        return;
    };

    let mut receiver = receiver.lock().await;
    while let Ok(bytes) = receiver.try_recv() {
        owner
            .protocol
            .process(&bytes)
            .await
            .expect("the owner processes the helper's reply");
    }
}

/// The helper records every completed pairing's long-term channel id in
/// `helper_channels`, which is the first externally visible sign the handshake
/// landed on that side. Waits for it and returns it.
async fn await_helper_channel(state: &AppState, helper_id: Uuid, owner: &mut Owner) -> u64 {
    for _ in 0..POLL_ATTEMPTS {
        pump(state, owner).await;
        if let Some(channel_id) = state
            .helper_channels
            .get(&helper_id)
            .and_then(|entry| entry.first().cloned())
        {
            return channel_id.parse().expect("channel id is a u64");
        }
        actix_rt::time::sleep(POLL_INTERVAL).await;
    }
    panic!("the helper never completed the pairing handshake");
}

/// Wait until the actor reports exactly one channel awaiting confirmation, and
/// return its id.
///
/// A replica-mode pairing persists a `ReplicaMember`, not a `HelperChannel`, so
/// `ListChannelsMsg` cannot see it — and the long-term id is minted inside the
/// library, so a test that never receives the completion event has no other way
/// to name the channel it is asserting on.
async fn await_one_pending_channel(actor: &Addr<ProvisionedActor>) -> u64 {
    for _ in 0..POLL_ATTEMPTS {
        let pending = actor
            .send(PendingChannelIdsMsg)
            .await
            .expect("the actor is alive");
        match pending.as_slice() {
            [channel_id] => return *channel_id,
            [] => {}
            more => panic!("expected one pending channel, found {}", more.len()),
        }
        actix_rt::time::sleep(POLL_INTERVAL).await;
    }
    panic!("the responder never persisted a pending channel");
}

/// Poll the helper's own view of the channel until it reaches `want`, returning
/// whatever it last reported so a failure can say what it actually saw.
async fn await_helper_status(
    state: &AppState,
    helper: &Addr<ProvisionedActor>,
    owner: &mut Owner,
    channel_id: u64,
    want: ChannelStatus,
) -> Option<ChannelStatus> {
    let mut last = None;
    for _ in 0..POLL_ATTEMPTS {
        pump(state, owner).await;
        last = helper
            .send(ChannelStatusMsg { channel_id })
            .await
            .expect("the helper actor is alive");
        if last == Some(want) {
            return last;
        }
        actix_rt::time::sleep(POLL_INTERVAL).await;
    }
    last
}

/// The owner's own status for the channel, read straight from its channel
/// store — the side a human is still expected to confirm.
///
/// Consults both record kinds for the same reason the backend does: a
/// helper-mode pairing leaves the owner a helper-channel row, while a
/// replica-mode one leaves it a group-member row. A `Pending` on either wins.
async fn owner_status(owner: &Owner, channel_id: u64) -> Option<ChannelStatus> {
    let channel_id = ChannelId(channel_id);
    let mut statuses: Vec<ChannelStatus> = Vec::new();

    let record = owner
        .protocol
        .channel_store
        .load(owner.secret_id, ChannelQuery::Helper { channel_id })
        .await
        .expect("the in-memory channel store is readable");
    if let Some(ChannelRecord::Helper(helper)) = record {
        statuses.push(helper.status);
    }

    let members = owner
        .protocol
        .channel_store
        .replicas(owner.secret_id)
        .await
        .expect("the in-memory channel store is readable");
    statuses.extend(
        members
            .iter()
            .filter(|m| m.channel_id == channel_id)
            .map(|m| m.status),
    );

    if statuses.contains(&ChannelStatus::Pending) {
        return Some(ChannelStatus::Pending);
    }
    statuses.first().copied()
}

#[actix_rt::test]
async fn a_replica_mode_pairing_is_confirmed_on_the_helpers_replica_instance() {
    // The motivating case. A replica-mode channel lives on the instance bound
    // to the *owner's* secret, not on the helper's own, and only that instance
    // holds the channel's shared key. Confirming against the own instance —
    // what `take_own()` would do — derives a fingerprint from a protocol that
    // has never heard of the channel, and the channel stays `Pending` forever.
    let state = serve().await;
    let (helper_id, helper) = spawn_helper(&state, "Alex");
    let mut owner = register_owner(&state, "Alice");

    helper
        .send(EnsureReplicaInstanceMsg { owner_secret_id: owner.secret_id })
        .await
        .expect("the helper actor is alive")
        .expect("the replica instance is created");

    let contact = helper
        .send(CreateContactMsg {
            contact_mode: derec_proto::ContactMode::InlineKeys,
            nonce: None,
            replica_for_owner_secret: Some(owner.secret_id),
        })
        .await
        .expect("the helper actor is alive")
        .expect("the replica instance mints a contact");

    owner
        .protocol
        .start(DeRecFlow::Pairing {
            kind: derec_proto::SenderKind::ReplicaSource,
            contact,
            peer_communication_info: HashMap::from([("name".to_owned(), "Alex".to_owned())]),
        })
        .await
        .expect("the owner starts a replica pairing");

    let channel_id = await_helper_channel(&state, helper_id, &mut owner).await;

    assert_eq!(
        helper
            .send(InstanceForChannelMsg { channel_id })
            .await
            .expect("the helper actor is alive"),
        Some(owner.secret_id),
        "the channel must belong to the replica instance — if it belonged to \
         the helper's own instance this test would not be exercising the \
         instance-targeting requirement at all"
    );

    let status =
        await_helper_status(&state, &helper, &mut owner, channel_id, ChannelStatus::Paired).await;

    assert_eq!(
        status,
        Some(ChannelStatus::Paired),
        "the helper must promote its own side of a replica pairing with no \
         external confirmation call; nothing in this test ever sends one"
    );

    // Give the owner every chance to reach the same state before asserting it
    // has not: the helper is `Paired` above, so anything the owner still needs
    // has already been sent.
    for _ in 0..20 {
        pump(&state, &mut owner).await;
        actix_rt::time::sleep(POLL_INTERVAL).await;
    }

    assert_eq!(
        owner_status(&owner, channel_id).await,
        Some(ChannelStatus::Pending),
        "the owner side must stay Pending until a human confirms it — \
         auto-confirmation is helper behaviour and must not reach across the \
         channel"
    );
}

#[actix_rt::test]
async fn a_no_keys_pairing_is_confirmed_by_the_helper_but_not_by_the_owner() {
    // `NoKeys` gates a plain helper pairing on the same fingerprint check, on
    // the helper's *own* instance this time. The second assertion is the one
    // that keeps auto-confirmation honest: it is helper behaviour only, and the
    // owner still has to compare codes and confirm.
    let state = serve().await;
    let (helper_id, helper) = spawn_helper(&state, "Alex");
    let mut owner = register_owner(&state, "Alice");

    let contact = helper
        .send(CreateContactMsg {
            contact_mode: derec_proto::ContactMode::NoKeys,
            nonce: None,
            replica_for_owner_secret: None,
        })
        .await
        .expect("the helper actor is alive")
        .expect("the helper mints a contact");

    owner
        .protocol
        .start(DeRecFlow::Pairing {
            kind: derec_proto::SenderKind::Owner,
            contact,
            peer_communication_info: HashMap::from([("name".to_owned(), "Alex".to_owned())]),
        })
        .await
        .expect("the owner starts a NoKeys pairing");

    let channel_id = await_helper_channel(&state, helper_id, &mut owner).await;

    let status =
        await_helper_status(&state, &helper, &mut owner, channel_id, ChannelStatus::Paired).await;

    assert_eq!(
        status,
        Some(ChannelStatus::Paired),
        "the helper must promote its own side of a NoKeys pairing with no \
         external confirmation call"
    );

    // Give the owner every chance to reach the same state before asserting it
    // has not: the helper is `Paired` above, so anything the owner still needs
    // has already been sent.
    for _ in 0..20 {
        pump(&state, &mut owner).await;
        actix_rt::time::sleep(POLL_INTERVAL).await;
    }

    assert_eq!(
        owner_status(&owner, channel_id).await,
        Some(ChannelStatus::Pending),
        "the owner side must stay Pending until a human confirms it — a helper \
         auto-confirming on the owner's behalf would remove the only \
         fingerprint comparison that models something real"
    );
}

#[actix_rt::test]
async fn the_tick_backstop_confirms_a_channel_the_event_path_missed() {
    // `PairingCompleted` is the fast path, but it is a single self-notify with
    // a ~2s retry budget: if the instance stays borrowed past it, or the
    // confirmation fails on a transient error, nothing tries again and the
    // channel sits `Pending` until the hour-long expiry sweep. The tick is the
    // backstop, and this pins it.
    //
    // Producing a `Pending` channel the event path never saw is what makes the
    // test possible, and the library hands it over: on the responder side
    // `accept` persists the channel record *before* it sends its `PairResponse`
    // and propagates a send failure with `?`. So an owner whose endpoint answers
    // 404 leaves the helper holding a fully formed `Pending` channel while
    // `process()` returns `Err` — and `ProcessDelayed` skips `handle_events`
    // entirely on `Err`, so no notify is ever posted. That is the real shape of
    // the gap, not a stub of it.
    //
    // Replica mode over an `InlineKeys` contact, because that is the only
    // fingerprint-gated pairing with a single inbound leg at the responder: the
    // failing send is therefore the handshake's *last* step, after the record
    // exists. A `NoKeys` pairing would fail on its earlier `PrePair` leg, before
    // any channel is persisted, and produce nothing to sweep.
    let state = serve().await;
    let (helper_id, helper) = spawn_helper(&state, "Alex");
    let mut owner = register_unreachable_owner(&state, "Alice");

    helper
        .send(EnsureReplicaInstanceMsg { owner_secret_id: owner.secret_id })
        .await
        .expect("the helper actor is alive")
        .expect("the replica instance is created");

    let contact = helper
        .send(CreateContactMsg {
            contact_mode: derec_proto::ContactMode::InlineKeys,
            nonce: None,
            replica_for_owner_secret: Some(owner.secret_id),
        })
        .await
        .expect("the helper actor is alive")
        .expect("the replica instance mints a contact");

    owner
        .protocol
        .start(DeRecFlow::Pairing {
            kind: derec_proto::SenderKind::ReplicaSource,
            contact,
            peer_communication_info: HashMap::from([("name".to_owned(), "Alex".to_owned())]),
        })
        .await
        .expect("the owner starts a replica pairing");

    let channel_id = await_one_pending_channel(&helper).await;

    // The premise, asserted rather than assumed: `helper_channels` is written by
    // `handle_events`, which `ProcessDelayed` skips when `process()` returns
    // `Err`. An empty index is proof the event path never ran, and so that no
    // auto-confirm notify was ever posted for this channel.
    assert!(
        state.helper_channels.get(&helper_id).is_none(),
        "this test is only meaningful if the completion event was missed; the \
         helper recorded the channel, so the fast path ran after all"
    );

    let status =
        await_helper_status(&state, &helper, &mut owner, channel_id, ChannelStatus::Paired).await;

    assert_eq!(
        status,
        Some(ChannelStatus::Paired),
        "the tick must sweep a channel left Pending by a missed completion \
         event and confirm it; with no backstop nothing else ever will"
    );
    assert!(
        helper
            .send(PendingChannelIdsMsg)
            .await
            .expect("the helper actor is alive")
            .is_empty(),
        "the sweep must leave nothing behind"
    );
}
