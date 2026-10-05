// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! A peer paired with a provisioned helper keeps reaching it through two
//! disruptions that used to cut it off silently:
//!
//! - **The node's address changes.** Recovery re-advertises the helper at the
//!   new address, and the helper must then *tell* its paired peers, or they
//!   keep dialling the old one.
//! - **The helper's instance is busy.** An inbound message that finds the
//!   instance borrowed by another call must wait for it, not be dropped.
//!
//! Both are driven end to end over the real router on an ephemeral port, with
//! a browser-managed owner driven directly the way the front end drives its
//! WASM protocol — the pattern `tests/common/mod.rs` uses.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use actix::Addr;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use derec_backend::actor::{
    build_protocol, ActorProtocol, CreateContactMsg, ProtocolConfig, ProvisionedActor, ShutdownMsg,
    StartFlowMsg,
};
use derec_backend::config::Defaults;
use derec_backend::models::{Actor, Role, Transport, TransportMode, TransportProtocol, UnpairAck};
use derec_backend::provisioning::{provisioned_actor, register_browser_actor, spawn_provisioned};
use derec_backend::registry::actors::ActorSettings;
use derec_backend::sql::channel::SqlChannelStore;
use derec_backend::state::{ActorInbox, AppState};
use derec_library::protocol::types::Target;
use derec_library::protocol::{
    ChannelQuery, ChannelRecord, DeRecChannelStore, DeRecEvent, DeRecFlow,
};
use derec_library::types::ChannelId;
use uuid::Uuid;

const TIMEOUT_SECS: u32 = 300;
const POLL_ATTEMPTS: usize = 300;
const POLL_INTERVAL: Duration = Duration::from_millis(50);

fn settings() -> ActorSettings {
    ActorSettings {
        replica_id: rand::random::<u64>(),
        timeout_secs: TIMEOUT_SECS,
        unpair_ack: UnpairAck::Required,
    }
}

/// The real router on an ephemeral loopback port, over a private in-memory
/// database. gRPC is off: both tests are about HTTP endpoints, and with it off
/// recovery serves every helper over HTTP whatever it stored.
///
/// `base` builds the node's advertised address from the port it got, so a
/// test can name the same listener by a different host than its helpers were
/// created with.
async fn serve(base: impl Fn(u16) -> String) -> (Arc<AppState>, u16) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("an ephemeral port is available");
    let port = listener.local_addr().expect("listener is bound").port();

    let state = Arc::new(AppState::new(
        base(port),
        Defaults {
            grpc_enabled: false,
            ..Defaults::default()
        },
        reqwest::Client::new(),
        actix_rt::Arbiter::current(),
        derec_backend::db::connect("sqlite::memory:")
            .await
            .expect("an in-memory database always connects"),
    ));

    let router = derec_backend::build_router(state.clone());
    actix_rt::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (state, port)
}

/// Provision an HTTP helper advertising `base_url`, exactly as `POST
/// /helpers` does but with the address chosen by the test.
async fn spawn_helper(state: &AppState, base_url: &str) -> (Actor, Addr<ProvisionedActor>) {
    let helper = provisioned_actor(
        Role::Helper,
        "Alex",
        base_url,
        &state.grpc_authority(),
        TransportMode::Http,
    );
    let settings = settings();
    state
        .actors
        .register(helper.clone(), settings.clone())
        .await
        .expect("the registry is writable");
    spawn_provisioned(state, &helper, &settings).expect("the helper starts");
    let addr = provisioned(state, helper.id);
    (helper, addr)
}

fn provisioned(state: &AppState, actor_id: Uuid) -> Addr<ProvisionedActor> {
    match state
        .actor_inboxes
        .get(&actor_id)
        .expect("a running actor has an inbox")
        .value()
    {
        ActorInbox::Provisioned(addr) => addr.clone(),
        ActorInbox::Browser => panic!("this actor must be backend-managed"),
    }
}

/// A browser-managed owner advertising `transports`, with its protocol held
/// by the test.
struct Owner {
    id: Uuid,
    secret_id: u64,
    protocol: ActorProtocol,
}

async fn register_owner(state: &AppState, transport_uri: impl Fn(Uuid) -> String) -> Owner {
    let id = Uuid::new_v4();
    let secret_id = rand::random::<u64>();
    let transports = vec![Transport {
        protocol: TransportProtocol::Https,
        uri: transport_uri(id),
    }];
    let actor = Actor {
        id,
        role: Role::Owner,
        name: "Owner".to_owned(),
        transport: transports[0].clone(),
        transports: transports.clone(),
        secret_id: secret_id.to_string(),
    };
    state
        .actors
        .register(actor, settings())
        .await
        .expect("the registry is writable");
    register_browser_actor(state, id);

    let config = ProtocolConfig {
        secret_id,
        own_transports: transports,
        communication_info: HashMap::from([("name".to_owned(), "Owner".to_owned())]),
        timeout_secs: TIMEOUT_SECS,
        unpair_ack: UnpairAck::Required,
        threshold: 2,
        keep_versions_count: 3,
        replica_id: Some(rand::random()),
        http_client: state.http_client.clone(),
        pool: state.pool.clone(),
        actor_id: id,
        local_node: None,
    };

    Owner {
        id,
        secret_id,
        protocol: build_protocol(&config).expect("the owner's protocol builds"),
    }
}

/// Drain the owner's mailbox into its protocol, as the front end's poll loop
/// does, answering the events that produced.
async fn pump(state: &AppState, owner: &mut Owner) -> Vec<DeRecEvent> {
    let messages = state
        .mailboxes
        .drain(&owner.id)
        .await
        .expect("the mailbox is readable");
    let mut events = Vec::new();
    for bytes in messages {
        // A refusal here is the protocol's business, not this fixture's: the
        // assertions look at what ended up stored.
        if let Ok(more) = owner.protocol.process(&bytes).await {
            events.extend(more);
        }
    }
    events
}

/// Pair `owner` with `helper` over an `InlineKeys` contact and wait until both
/// sides hold the channel. Returns the long-term channel id.
async fn pair(state: &AppState, helper: &Addr<ProvisionedActor>, owner: &mut Owner) -> ChannelId {
    let contact = helper
        .send(CreateContactMsg {
            contact_mode: derec_proto::ContactMode::InlineKeys,
            nonce: None,
            replica_for_owner_secret: None,
            attempt: 0,
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
        .expect("the owner starts pairing");

    // The owner records the channel as soon as it starts pairing, under the
    // transient id and with no key yet; only `PairingCompleted` means the
    // handshake is done and names the id both sides rotated to.
    for _ in 0..POLL_ATTEMPTS {
        for event in pump(state, owner).await {
            if let DeRecEvent::PairingCompleted { channel_id, .. } = event {
                return channel_id;
            }
        }
        actix_rt::time::sleep(POLL_INTERVAL).await;
    }
    panic!("the pairing never completed on the owner's side");
}

/// The endpoint URIs the owner has recorded for the helper on `channel_id`.
async fn recorded_uris(owner: &Owner, channel_id: ChannelId) -> Vec<String> {
    let record = owner
        .protocol
        .channel_store
        .load(owner.secret_id, ChannelQuery::Helper { channel_id })
        .await
        .expect("the owner's channel store is readable")
        .expect("the channel exists after pairing");
    let ChannelRecord::Helper(helper) = record else {
        panic!("a helper pairing writes a helper record");
    };
    helper.transports.into_iter().map(|t| t.uri).collect()
}

#[actix_rt::test]
async fn after_the_node_moves_a_recovered_helper_tells_its_peers_the_new_address() {
    // One listener, two names for it: the helper is created advertising
    // `127.0.0.1` — the "old" address — while the node now calls itself
    // `localhost`. Both reach the same socket, so the test can watch the
    // announcement travel without standing up a second server.
    let (state, port) = serve(|port| format!("http://localhost:{port}")).await;
    let old_base = format!("http://127.0.0.1:{port}");
    let (helper, helper_addr) = spawn_helper(&state, &old_base).await;
    let base_url = state.base_url.to_string();
    let mut owner = register_owner(&state, |id| format!("{base_url}/derec/{id}")).await;

    let channel_id = pair(&state, &helper_addr, &mut owner).await;
    let old_uri = format!("{old_base}/derec/{}", helper.id);
    assert_eq!(
        recorded_uris(&owner, channel_id).await,
        vec![old_uri],
        "the owner starts out holding the helper's old address"
    );

    // The process "ends": the helper stops, as it would on shutdown, and
    // recovery rebuilds the node over the same database at its new address.
    helper_addr
        .send(ShutdownMsg)
        .await
        .expect("the helper actor is alive");
    state.actor_inboxes.remove(&helper.id);

    let report = derec_backend::recovery::recover(&state).await;
    assert_eq!(report.failed, 0);
    assert_eq!(
        report.announce,
        vec![helper.id],
        "the moved helper is queued to announce"
    );

    let summary = derec_backend::recovery::announce_new_addresses(&state, &report.announce).await;
    assert_eq!(
        summary.peers.announced, 1,
        "the one paired peer is told: {summary:?}"
    );
    assert!(summary.everyone_told(), "{summary:?}");

    let new_uri = format!("{}/derec/{}", state.base_url, helper.id);
    let mut recorded = Vec::new();
    for _ in 0..POLL_ATTEMPTS {
        pump(&state, &mut owner).await;
        recorded = recorded_uris(&owner, channel_id).await;
        if recorded == [new_uri.clone()] {
            break;
        }
        actix_rt::time::sleep(POLL_INTERVAL).await;
    }
    assert_eq!(
        recorded,
        vec![new_uri],
        "the owner must now dial the helper at the node's new address"
    );
}

/// A port nothing listens on: bound once to learn a free one, then released.
async fn dead_port() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("an ephemeral port is available");
    listener.local_addr().expect("listener is bound").port()
}

#[actix_rt::test]
async fn a_same_node_peer_at_an_address_nothing_listens_on_is_still_told() {
    // The Docker republish: the browser owner was registered while the node
    // was published on a port that is now gone. Its peers' stored copy of its
    // address names that port, and dialling it fails — which used to leave
    // every announcement to it `peers_not_told`. It is an actor on this node,
    // so it is delivered to in-process instead.
    let (state, port) = serve(|port| format!("http://localhost:{port}")).await;
    let gone = format!("http://localhost:{}", dead_port().await);
    state
        .addresses
        .remember(&state.pool, derec_backend::addresses::Listener::Http, &gone)
        .await
        .expect("the database is writable");

    let (helper, helper_addr) = spawn_helper(&state, &format!("http://127.0.0.1:{port}")).await;
    let mut owner = register_owner(&state, |id| format!("{gone}/derec/{id}")).await;

    // Pairing itself already depends on it: the helper's replies go to the
    // owner's advertised — dead — address.
    let channel_id = pair(&state, &helper_addr, &mut owner).await;

    helper_addr
        .send(ShutdownMsg)
        .await
        .expect("the helper actor is alive");
    state.actor_inboxes.remove(&helper.id);

    let report = derec_backend::recovery::recover(&state).await;
    assert_eq!(report.announce, vec![helper.id]);

    let summary = derec_backend::recovery::announce_new_addresses(&state, &report.announce).await;
    assert_eq!(summary.peers.announced, 1, "{summary:?}");
    assert!(summary.everyone_told(), "{summary:?}");

    let new_uri = format!("{}/derec/{}", state.base_url, helper.id);
    let mut recorded = Vec::new();
    for _ in 0..POLL_ATTEMPTS {
        pump(&state, &mut owner).await;
        recorded = recorded_uris(&owner, channel_id).await;
        if recorded == [new_uri.clone()] {
            break;
        }
        actix_rt::time::sleep(POLL_INTERVAL).await;
    }
    assert_eq!(recorded, vec![new_uri], "the announcement reached the owner");
}

/// How long the slow endpoint below holds each delivery, in milliseconds.
type Delay = Arc<AtomicU64>;

/// `POST /slow/{actor_id}`: hold the delivery for the current delay, then
/// queue it in that actor's mailbox. Stands in for a peer that is slow to
/// answer, which is what keeps a helper's instance borrowed in real use.
async fn slow_delivery(
    State((state, delay)): State<(Arc<AppState>, Delay)>,
    Path(actor_id): Path<Uuid>,
    body: axum::body::Bytes,
) -> StatusCode {
    tokio::time::sleep(Duration::from_millis(delay.load(Ordering::SeqCst))).await;
    match state.mailboxes.enqueue(&actor_id, &body).await {
        Ok(()) => StatusCode::ACCEPTED,
        Err(_) => StatusCode::SERVICE_UNAVAILABLE,
    }
}

#[actix_rt::test]
async fn a_message_that_finds_the_instance_busy_waits_for_it_instead_of_being_dropped() {
    let (state, port) = serve(|port| format!("http://127.0.0.1:{port}")).await;

    // The owner's address runs through the slow endpoint, so anything the
    // helper sends it holds the helper's instance for as long as `delay` says.
    let delay: Delay = Arc::new(AtomicU64::new(0));
    let slow = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("an ephemeral port is available");
    let slow_port = slow.local_addr().expect("listener is bound").port();
    let slow_router = axum::Router::new()
        .route("/slow/{actor_id}", axum::routing::post(slow_delivery))
        .with_state((state.clone(), delay.clone()));
    actix_rt::spawn(async move {
        let _ = axum::serve(slow, slow_router).await;
    });

    let (helper, helper_addr) = spawn_helper(&state, &format!("http://127.0.0.1:{port}")).await;
    let mut owner = register_owner(&state, |id| {
        format!("http://127.0.0.1:{slow_port}/slow/{id}")
    })
    .await;
    let channel_id = pair(&state, &helper_addr, &mut owner).await;

    // Borrow the helper's instance: it starts a flow whose one delivery, to
    // the owner, now takes two seconds.
    delay.store(2000, Ordering::SeqCst);
    let flow_done = Arc::new(AtomicBool::new(false));
    {
        let flow_done = flow_done.clone();
        let helper_addr = helper_addr.clone();
        actix_rt::spawn(async move {
            let _ = helper_addr
                .send(StartFlowMsg {
                    flow: DeRecFlow::UpdateChannelInfo {
                        target: Target::All,
                        communication_info: Some(HashMap::from([(
                            "name".to_owned(),
                            "Alex".to_owned(),
                        )])),
                        own_transports: Vec::new(),
                    },
                })
                .await;
            flow_done.store(true, Ordering::SeqCst);
        });
    }
    actix_rt::time::sleep(Duration::from_millis(200)).await;

    // While it is borrowed, the owner tells the helper its new name.
    owner
        .protocol
        .start(DeRecFlow::UpdateChannelInfo {
            target: Target::Single(channel_id),
            communication_info: Some(HashMap::from([(
                "name".to_owned(),
                "Renamed Owner".to_owned(),
            )])),
            own_transports: Vec::new(),
        })
        .await
        .expect("the owner's update is delivered to the helper's endpoint");
    assert!(
        !flow_done.load(Ordering::SeqCst),
        "the helper's instance must still be borrowed when the owner's message lands, \
         or this test proves nothing"
    );

    // Dropped, it never lands; waited for, the helper applies it once free.
    let store = SqlChannelStore::new(state.pool.clone(), helper.id.to_string());
    let mut peer_name = None;
    for _ in 0..POLL_ATTEMPTS {
        let records = store
            .helper_records_all_instances()
            .await
            .expect("the helper's channel store is readable");
        peer_name = records
            .iter()
            .find(|(_, record)| record.channel_id == channel_id)
            .and_then(|(_, record)| record.communication_info.get("name").cloned());
        if peer_name.as_deref() == Some("Renamed Owner") {
            break;
        }
        actix_rt::time::sleep(POLL_INTERVAL).await;
    }
    assert_eq!(
        peer_name.as_deref(),
        Some("Renamed Owner"),
        "a message that found the instance busy must be processed once it is free"
    );
}
