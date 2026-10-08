// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! A second replica admitted to a group keeps receiving mirrors.
//!
//! A browser-style source pairs two provisioned helpers as replica
//! destinations, one after the other, and then publishes. Both members must
//! acknowledge the publish.
//!
//! The admission handover used to make this racy. The source's first sync to a
//! joiner travels on the joiner's ephemeral pairing channel and hands it the
//! group channel and key; the joiner hydrates, moves onto the group channel and
//! drops the ephemeral one at once. Up to the unreleased 0.0.7 builds the source
//! only moved the joiner's row when the joiner's acknowledgement came back, so a
//! publish dispatched in between went to the ephemeral channel and was lost.
//! The released SDK 0.0.7 moves the joiner onto the group channel as soon as
//! the source sends the handover, which these tests pin.
//!
//! Driven over real HTTP against `build_router`, as `helper_auto_confirm.rs`
//! does: the actors' transport is `HttpTransport`, and the owner's mailbox is
//! drained by `pump`, standing in for the front end's poll loop.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use actix::prelude::*;
use derec_backend::infrastructure::actors::protocol::{
    build_protocol, ActorProtocol, ProtocolConfig,
};
use derec_backend::infrastructure::actors::provisioned::{
    ChannelStatusMsg, CreateContactMsg, EnsureReplicaInstanceMsg, InstanceForChannelMsg,
    ProvisionedActor,
};
use derec_backend::infrastructure::bootstrap::Node;
use derec_backend::models::Actor;
use derec_backend::models::Defaults;
use derec_backend::models::{Role, TransportMode, UnpairAck};
use derec_backend::services::ports::{ActorGateway, InboxDirectory};
use derec_library::protocol::types::{ReplicaFilter, UserSecret};
use derec_library::protocol::{
    ChannelStatus, DeRecChannelStore, DeRecEvent, DeRecFlow, DeRecUserSecretStore,
};
use derec_library::types::ChannelId;
use uuid::Uuid;

const TIMEOUT_SECS: u32 = 300;
const POLL_ATTEMPTS: usize = 400;
const POLL_INTERVAL: Duration = Duration::from_millis(50);

fn test_settings() -> derec_backend::models::ActorSettings {
    derec_backend::models::ActorSettings {
        replica_id: rand::random::<u64>(),
        timeout_secs: TIMEOUT_SECS,
        unpair_ack: UnpairAck::Required,
    }
}

async fn serve() -> Arc<Node> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("an ephemeral port is available");
    let port = listener.local_addr().expect("listener is bound").port();

    let state = Arc::new(Node::new(
        derec_backend::models::NodeConfig::new(
            format!("http://127.0.0.1:{port}"),
            Defaults::default(),
        ),
        reqwest::Client::new(),
        actix_rt::Arbiter::current(),
        derec_backend::infrastructure::db::connect("sqlite::memory:")
            .await
            .expect("an in-memory database always connects"),
    ));

    let router = derec_backend::infrastructure::server::build_router(state.state.clone());
    actix_rt::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    state
}

async fn spawn_helper(state: &Arc<Node>, name: &str) -> Addr<ProvisionedActor> {
    let actor = Actor::mint(
        Role::Helper,
        name,
        &state.config.base_url,
        &state.config.grpc_authority(),
        TransportMode::Http,
    );
    state
        .actors
        .register(actor.clone(), test_settings())
        .await
        .expect("the registry is writable");
    state
        .runtime
        .spawn(&actor, &test_settings())
        .expect("the actor starts");

    state
        .inboxes
        .provisioned(&actor.id)
        .expect("spawning registers an inbox")
}

/// The source: a browser-managed owner with a replica id, driven directly the
/// way the front end drives its WASM protocol.
struct Source {
    id: Uuid,
    secret_id: u64,
    replica_id: u64,
    protocol: ActorProtocol,
    /// Every event the source's protocol has emitted, in order.
    events: Vec<DeRecEvent>,
}

async fn register_source(state: &Arc<Node>) -> Source {
    let actor = Actor::mint(
        Role::Owner,
        "Alice",
        &state.config.base_url,
        &state.config.grpc_authority(),
        TransportMode::Http,
    );
    let secret_id: u64 = actor.secret_id.parse().expect("secret id is a u64");
    let replica_id: u64 = rand::random();
    state
        .actors
        .register(actor.clone(), test_settings())
        .await
        .expect("the registry is writable");
    state.inboxes.register_browser(actor.id);

    let config = ProtocolConfig {
        secret_id,
        own_transports: actor.transports.clone(),
        communication_info: HashMap::from([("name".to_owned(), "Alice".to_owned())]),
        timeout_secs: TIMEOUT_SECS,
        unpair_ack: UnpairAck::Required,
        threshold: 2,
        replica_id: Some(replica_id),
        http_client: state.http_client.clone(),
        pool: state.pool.clone(),
        actor_id: actor.id,
        local_delivery: None,
    };

    Source {
        id: actor.id,
        secret_id,
        replica_id,
        protocol: build_protocol(&config).expect("the source's protocol builds"),
        events: Vec::new(),
    }
}

/// Drain the source's mailbox into its protocol, as the front end's poll loop
/// does.
async fn pump(state: &Node, source: &mut Source) {
    let messages = state
        .mailboxes
        .drain(&source.id)
        .await
        .expect("the mailbox is readable");
    for bytes in messages {
        let events = source
            .protocol
            .process(&bytes)
            .await
            .expect("the source processes a member's message");
        source.events.extend(events);
    }
}

/// Pump until `done` holds over the events seen so far.
async fn pump_until(
    state: &Node,
    source: &mut Source,
    what: &str,
    done: impl Fn(&[DeRecEvent]) -> bool,
) {
    for _ in 0..POLL_ATTEMPTS {
        pump(state, source).await;
        if done(&source.events) {
            return;
        }
        actix_rt::time::sleep(POLL_INTERVAL).await;
    }
    panic!("timed out waiting for {what}");
}

fn acked(events: &[DeRecEvent], replica_id: u64, version: u32) -> bool {
    events.iter().any(|e| {
        matches!(e, DeRecEvent::ReplicaSecretAcked { from_replica_id, version: v, .. }
            if *from_replica_id == replica_id && *v == version)
    })
}

/// The highest version any member has acknowledged from `replica_id`.
fn latest_ack(events: &[DeRecEvent], replica_id: u64) -> Option<u32> {
    events
        .iter()
        .filter_map(|e| match e {
            DeRecEvent::ReplicaSecretAcked {
                from_replica_id,
                version,
                ..
            } if *from_replica_id == replica_id => Some(*version),
            _ => None,
        })
        .max()
}

/// The admitted member: its replica id and the long-term pairing channel.
struct Member {
    replica_id: u64,
    pairing_channel: u64,
}

/// Pair `helper` as a replica destination of `source` and confirm both sides,
/// which publishes the current snapshot to it. Returns without waiting for
/// that publish to be acknowledged.
async fn admit(state: &Node, source: &mut Source, helper: &Addr<ProvisionedActor>) -> Member {
    helper
        .send(EnsureReplicaInstanceMsg {
            owner_secret_id: source.secret_id,
        })
        .await
        .expect("the helper actor is alive")
        .expect("the replica instance is created");
    let contact = helper
        .send(CreateContactMsg {
            contact_mode: derec_proto::ContactMode::InlineKeys,
            nonce: None,
            replica_for_owner_secret: Some(source.secret_id),
            attempt: 0,
        })
        .await
        .expect("the helper actor is alive")
        .expect("the replica instance mints a contact");
    let pairing_id = ChannelId(contact.channel_id);

    let events = source
        .protocol
        .start(DeRecFlow::Pairing {
            kind: derec_proto::SenderKind::ReplicaSource,
            contact,
            peer_communication_info: HashMap::new(),
        })
        .await
        .expect("the source starts a replica pairing");
    source.events.extend(events);

    let completed = |events: &[DeRecEvent]| {
        events.iter().find_map(|e| match e {
            DeRecEvent::PairingCompleted {
                channel_id,
                pairing_channel_id,
                ..
            } if *pairing_channel_id == pairing_id => Some(*channel_id),
            _ => None,
        })
    };
    pump_until(state, source, "the pairing to complete", |e| {
        completed(e).is_some()
    })
    .await;
    let channel = completed(&source.events).expect("checked above");
    let replica_id = source
        .events
        .iter()
        .find_map(|e| match e {
            DeRecEvent::ReplicaPaired {
                channel_id,
                peer_replica_id,
            } if *channel_id == channel => Some(*peer_replica_id),
            _ => None,
        })
        .expect("a replica pairing reports the peer's replica id");

    // The helper auto-confirms its own side; a destination still `Pending`
    // drops the source's sync, so wait for it before confirming here.
    let mut status = None;
    for _ in 0..POLL_ATTEMPTS {
        status = helper
            .send(ChannelStatusMsg {
                channel_id: channel.0,
            })
            .await
            .expect("the helper actor is alive");
        if status == Some(ChannelStatus::Paired) {
            break;
        }
        actix_rt::time::sleep(POLL_INTERVAL).await;
    }
    assert_eq!(
        status,
        Some(ChannelStatus::Paired),
        "the helper confirms its side"
    );

    let fingerprint = source
        .protocol
        .get_fingerprint(channel)
        .await
        .expect("a completed pairing has a fingerprint");
    assert!(
        source
            .protocol
            .verify_fingerprint(channel, &fingerprint)
            .await
            .expect("the source confirms its side"),
        "the source's own code matches"
    );

    Member {
        replica_id,
        pairing_channel: channel.0,
    }
}

/// The channel the source's own row names — the group's channel.
async fn group_channel(source: &Source) -> u64 {
    let members = source
        .protocol
        .channel_store
        .replicas(source.secret_id, ReplicaFilter::default())
        .await
        .expect("the channel store is readable");
    let own = source.replica_id;
    members
        .iter()
        .find(|m| m.replica_id.0 == own)
        .map(|m| m.channel_id.0)
        .expect("the source holds its own row")
}

/// The channel the source has recorded for `member`.
async fn channel_of(source: &Source, member: &Member) -> u64 {
    let members = source
        .protocol
        .channel_store
        .replicas(source.secret_id, ReplicaFilter::default())
        .await
        .expect("the channel store is readable");
    members
        .iter()
        .find(|m| m.replica_id.0 == member.replica_id)
        .map(|m| m.channel_id.0)
        .expect("the member has a row")
}

/// Publish a secret and return the version the round carries.
async fn protect(source: &mut Source) -> u32 {
    let events = source
        .protocol
        .start(DeRecFlow::ProtectSecret {
            secrets: vec![UserSecret {
                id: b"passphrase".to_vec(),
                name: "Passphrase".to_owned(),
                data: b"hunter2".to_vec(),
            }],
            description: None,
        })
        .await
        .expect("the source publishes");
    source.events.extend(events);
    source
        .protocol
        .user_secret_store
        .load_latest(source.secret_id)
        .await
        .expect("the user-secret store is readable")
        .expect("a publish records its snapshot")
        .version
}

async fn routes(helper: &Addr<ProvisionedActor>, channel_id: u64) -> bool {
    helper
        .send(InstanceForChannelMsg { channel_id })
        .await
        .expect("the helper actor is alive")
        .is_some()
}

/// Control: once the source has read the joiner's first acknowledgement, the
/// joiner's row sits on the group channel and the next publish reaches it.
#[actix_rt::test]
async fn a_publish_after_the_joiners_handover_reaches_every_member() {
    let state = serve().await;
    let alex = spawn_helper(&state, "Alex").await;
    let richard = spawn_helper(&state, "Richard").await;
    let mut source = register_source(&state).await;

    let first = admit(&state, &mut source, &alex).await;
    pump_until(
        &state,
        &mut source,
        "the first member's catch-up ack",
        |e| latest_ack(e, first.replica_id).is_some(),
    )
    .await;

    let second = admit(&state, &mut source, &richard).await;
    pump_until(
        &state,
        &mut source,
        "the second member's catch-up ack",
        |e| latest_ack(e, second.replica_id).is_some(),
    )
    .await;
    let group = group_channel(&source).await;
    assert_eq!(
        group, first.pairing_channel,
        "the group stays on the first member's channel"
    );
    assert_eq!(
        channel_of(&source, &second).await,
        group,
        "the joiner's row moved onto it"
    );

    let version = protect(&mut source).await;
    pump_until(
        &state,
        &mut source,
        "both members to acknowledge the publish",
        |e| acked(e, first.replica_id, version) && acked(e, second.replica_id, version),
    )
    .await;
}

/// The ordering that used to lose a version: a publish dispatched before the
/// source has read the joiner's first acknowledgement — what the app does when
/// the user protects right after admitting a replica.
///
/// The joiner drops its pairing channel's key the moment it hydrates, so the
/// source must already address it on the group channel by then. SDK 0.0.7
/// moves the joiner's row when it sends the handover, not when the
/// acknowledgement lands.
#[actix_rt::test]
async fn a_publish_during_the_joiners_handover_reaches_every_member() {
    let state = serve().await;
    let alex = spawn_helper(&state, "Alex").await;
    let richard = spawn_helper(&state, "Richard").await;
    let mut source = register_source(&state).await;

    let first = admit(&state, &mut source, &alex).await;
    pump_until(
        &state,
        &mut source,
        "the first member's catch-up ack",
        |e| latest_ack(e, first.replica_id).is_some(),
    )
    .await;

    let second = admit(&state, &mut source, &richard).await;
    let group = group_channel(&source).await;
    assert_eq!(
        group, first.pairing_channel,
        "the group stays on the first member's channel"
    );

    // Let the joiner hydrate from the catch-up sync, without the source
    // reading its acknowledgement.
    for _ in 0..POLL_ATTEMPTS {
        if routes(&richard, group).await {
            break;
        }
        actix_rt::time::sleep(POLL_INTERVAL).await;
    }
    assert!(
        routes(&richard, group).await,
        "the joiner hydrated onto the group channel"
    );
    assert!(
        !routes(&richard, second.pairing_channel).await,
        "the joiner no longer holds its pairing channel"
    );
    assert_eq!(
        channel_of(&source, &second).await,
        group,
        "the source already addresses the joiner on the group channel"
    );

    let version = protect(&mut source).await;
    pump_until(
        &state,
        &mut source,
        "both members to acknowledge the publish",
        |e| acked(e, first.replica_id, version) && acked(e, second.replica_id, version),
    )
    .await;
}
