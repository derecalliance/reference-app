// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! A replica's copies of its source's helper channels never shadow the helper
//! serving them in the server-wide channel router.
//!
//! A browser-style source pairs one provisioned helper in the ordinary helper
//! role and a second as a replica destination, then publishes. The replica
//! hydrates the source's roster — the owner's view of the helper channel
//! included — so both actors hold the helper channel's id. The router must
//! know the helper is that channel's end and the replica only holds a copy.
//!
//! Driven over real HTTP against `build_router`, as
//! `replica_second_admission.rs` does.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use actix::prelude::*;
use derec_backend::infrastructure::actors::protocol::{
    build_protocol, ActorProtocol, ProtocolConfig,
};
use derec_backend::infrastructure::actors::provisioned::{
    ChannelStatusMsg, CreateContactMsg, EnsureReplicaInstanceMsg, ProvisionedActor,
};
use derec_backend::infrastructure::bootstrap::Node;
use derec_backend::models::{
    Actor, Defaults, Resolution, Role, Side, Tier, TransportMode, UnpairAck,
};
use derec_backend::services::ports::{ActorGateway, InboxDirectory};
use derec_library::protocol::types::UserSecret;
use derec_library::protocol::{ChannelStatus, DeRecEvent, DeRecFlow, DeRecUserSecretStore as _};
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

async fn spawn_helper(state: &Arc<Node>, name: &str) -> (Uuid, Addr<ProvisionedActor>) {
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

    let addr = state
        .inboxes
        .provisioned(&actor.id)
        .expect("spawning registers an inbox");
    (actor.id, addr)
}

/// The source: a browser-managed owner with a replica id, driven directly the
/// way the front end drives its WASM protocol.
struct Source {
    id: Uuid,
    secret_id: u64,
    protocol: ActorProtocol,
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
        replica_id: Some(rand::random()),
        http_client: state.http_client.clone(),
        pool: state.pool.clone(),
        actor_id: actor.id,
        local_delivery: None,
    };

    Source {
        id: actor.id,
        secret_id,
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
            .expect("the source processes a peer's message");
        source.events.extend(events);
    }
}

/// Pump until `found` picks something out of the events seen so far.
async fn pump_for<T>(
    state: &Node,
    source: &mut Source,
    what: &str,
    found: impl Fn(&[DeRecEvent]) -> Option<T>,
) -> T {
    for _ in 0..POLL_ATTEMPTS {
        pump(state, source).await;
        if let Some(value) = found(&source.events) {
            return value;
        }
        actix_rt::time::sleep(POLL_INTERVAL).await;
    }
    panic!("timed out waiting for {what}");
}

/// Pair `helper` with `source` and wait for the long-term channel id. A
/// replica-mode pairing goes to the helper's instance for the source's secret.
async fn pair(
    state: &Node,
    source: &mut Source,
    helper: &Addr<ProvisionedActor>,
    replica: bool,
) -> u64 {
    if replica {
        helper
            .send(EnsureReplicaInstanceMsg {
                owner_secret_id: source.secret_id,
            })
            .await
            .expect("the helper actor is alive")
            .expect("the replica instance is created");
    }
    let contact = helper
        .send(CreateContactMsg {
            contact_mode: derec_proto::ContactMode::InlineKeys,
            nonce: None,
            replica_for_owner_secret: replica.then_some(source.secret_id),
            attempt: 0,
        })
        .await
        .expect("the helper actor is alive")
        .expect("the helper mints a contact");
    let pairing_id = ChannelId(contact.channel_id);

    let kind = if replica {
        derec_proto::SenderKind::ReplicaSource
    } else {
        derec_proto::SenderKind::Owner
    };
    let events = source
        .protocol
        .start(DeRecFlow::Pairing {
            kind,
            contact,
            peer_communication_info: HashMap::new(),
        })
        .await
        .expect("the source starts a pairing");
    source.events.extend(events);

    pump_for(state, source, "the pairing to complete", |events| {
        events.iter().find_map(|e| match e {
            DeRecEvent::PairingCompleted {
                channel_id,
                pairing_channel_id,
                ..
            } if *pairing_channel_id == pairing_id => Some(channel_id.0),
            _ => None,
        })
    })
    .await
}

/// Wait for `helper` to confirm its side, then confirm the source's, as the
/// owner-side dialog does for a channel the library leaves `Pending`.
async fn confirm(source: &mut Source, helper: &Addr<ProvisionedActor>, channel_id: u64) {
    let mut status = None;
    for _ in 0..POLL_ATTEMPTS {
        status = helper
            .send(ChannelStatusMsg { channel_id })
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

    let channel = ChannelId(channel_id);
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

#[actix_rt::test]
async fn a_replicas_copy_of_a_helper_channel_routes_to_the_helper() {
    let state = serve().await;
    let (bob_id, bob) = spawn_helper(&state, "Bob").await;
    let (alex_id, alex) = spawn_helper(&state, "Alex").await;
    let mut source = register_source(&state).await;

    let helper_channel = pair(&state, &mut source, &bob, false).await;
    let replica_channel = pair(&state, &mut source, &alex, true).await;
    confirm(&mut source, &alex, replica_channel).await;

    let version = protect(&mut source).await;
    pump_for(
        &state,
        &mut source,
        "the replica to acknowledge the publish",
        |events| {
            events
            .iter()
            .any(|e| {
                matches!(e, DeRecEvent::ReplicaSecretAcked { version: v, .. } if *v == version)
            })
            .then_some(())
        },
    )
    .await;

    // The replica reconciles after processing what it hydrated; wait for the
    // copy to reach the router rather than assuming the order.
    let claim_of = |actor_id: Uuid| {
        state
            .channel_router
            .routes()
            .into_iter()
            .find(|r| r.channel_id == helper_channel && r.actor_id == actor_id)
    };
    for _ in 0..POLL_ATTEMPTS {
        if claim_of(alex_id).is_some() {
            break;
        }
        actix_rt::time::sleep(POLL_INTERVAL).await;
    }

    let bob_claim = claim_of(bob_id).expect("the helper claims its channel");
    let alex_claim = claim_of(alex_id).expect("the replica holds a copy of it");
    assert_eq!(
        (bob_claim.tier, bob_claim.side),
        (Tier::Bound, Side::Endpoint)
    );
    assert_eq!(
        (alex_claim.tier, alex_claim.side),
        (Tier::Bound, Side::Mirror),
        "the hydrated copy is the source's view, not a channel the replica is an end of"
    );
    assert_eq!(
        state.channel_router.resolve_from(helper_channel, None),
        Resolution::Actor(bob_id),
        "a peer's message on the helper channel is the helper's"
    );

    // The replica's own channel with the source is one it is an end of.
    let group_claim = state
        .channel_router
        .routes()
        .into_iter()
        .find(|r| r.actor_id == alex_id && r.side == Side::Endpoint);
    assert!(
        group_claim.is_some(),
        "the replica's group channel stays an endpoint: {:?}",
        state.channel_router.routes()
    );
}
