// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Shared fixtures for the multi-endpoint peer tests in `multi_endpoint.rs`.
//!
//! Built on the same pattern `tests/helper_auto_confirm.rs` uses — a real
//! router on an ephemeral port, a provisioned helper, an owner driven
//! directly the way the front end drives its WASM protocol — extended with a
//! real gRPC ingress listener, also on an ephemeral port, because a
//! `Grpc`/`Both` helper's advertised endpoint has to be genuinely dialable
//! for a pairing over it to complete at all.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use actix::prelude::*;
use derec_backend::infrastructure::actors::protocol::ActorProtocol;
use derec_backend::infrastructure::actors::protocol::{build_protocol, ProtocolConfig};
use derec_backend::infrastructure::actors::provisioned::{
    ChannelStatusMsg, CreateContactMsg, ProvisionedActor,
};
use derec_backend::infrastructure::bootstrap::Node;
use derec_backend::infrastructure::grpc::pb::de_rec_transport_server::DeRecTransportServer;
use derec_backend::infrastructure::grpc::GrpcIngress;
use derec_backend::models::Actor;
use derec_backend::models::Defaults;
use derec_backend::models::{Role, TransportMode, UnpairAck};
use derec_backend::services::ports::{ActorGateway, InboxDirectory};
use derec_library::protocol::types::Target;
use derec_library::protocol::{ChannelStatus, DeRecFlow};
use derec_library::types::ChannelId;
use tokio::sync::oneshot;
use tonic::transport::server::TcpIncoming;
use tonic::transport::Server;
use uuid::Uuid;

/// Stock protocol settings for a fixture actor.
fn test_settings() -> derec_backend::models::ActorSettings {
    derec_backend::models::ActorSettings {
        replica_id: rand::random::<u64>(),
        timeout_secs: TIMEOUT_SECS,
        unpair_ack: UnpairAck::Required,
    }
}

const TIMEOUT_SECS: u32 = 300;
const POLL_ATTEMPTS: usize = 400;
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// The counterparty: a browser-managed owner, driven directly from the test
/// the way the front end drives its WASM protocol.
pub struct Owner {
    id: Uuid,
    pub secret_id: u64,
    pub protocol: ActorProtocol,
}

/// Everything one test needs: a paired owner/helper channel, plus a handle to
/// shut down the peer's gRPC listener on demand. The server backing all of
/// this stays alive for as long as the axum router's serve task is running —
/// that task owns the only `Arc<Node>` this fixture needs to keep around.
pub struct Rig {
    pub owner: Owner,
    pub secret_id: u64,
    pub channel_id: ChannelId,
    grpc: GrpcHandle,
}

/// Handle to the test's standalone gRPC listener.
///
/// `close` shuts it down so a subsequent dial to the same address is
/// refused — simulating the peer's first endpoint going unreachable without
/// touching anything the pairing recorded. Shutdown is graceful
/// (`serve_with_incoming_shutdown`), so `close` also waits for the listening
/// socket to actually stop accepting before returning; without that a caller
/// racing straight into a send could still find the port briefly open.
struct GrpcHandle {
    addr: std::net::SocketAddr,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
}

impl GrpcHandle {
    async fn close(&self) {
        if let Some(tx) = self.shutdown.lock().expect("not poisoned").take() {
            let _ = tx.send(());
        }

        for _ in 0..POLL_ATTEMPTS {
            if tokio::net::TcpStream::connect(self.addr).await.is_err() {
                return;
            }
            actix_rt::time::sleep(POLL_INTERVAL).await;
        }
        panic!("the gRPC listener never stopped accepting connections");
    }
}

/// Bring up the real HTTP router and a real gRPC ingress listener, each on an
/// ephemeral port, and wire `Defaults` so `Node::grpc_authority` names
/// the live one.
async fn serve() -> (Arc<Node>, GrpcHandle) {
    let http_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("an ephemeral port is available");
    let http_port = http_listener
        .local_addr()
        .expect("listener is bound")
        .port();

    let incoming = TcpIncoming::bind("127.0.0.1:0".parse().expect("a valid socket address"))
        .expect("an ephemeral gRPC port is available");
    let grpc_addr = incoming.local_addr().expect("the gRPC listener is bound");

    let defaults = Defaults {
        grpc_enabled: true,
        grpc_port: grpc_addr.port(),
        ..Defaults::default()
    };

    let state = Arc::new(Node::new(
        derec_backend::models::NodeConfig::new(format!("http://127.0.0.1:{http_port}"), defaults),
        reqwest::Client::new(),
        actix_rt::Arbiter::current(),
        derec_backend::infrastructure::db::connect("sqlite::memory:")
            .await
            .expect("an in-memory database always connects"),
    ));

    let router = derec_backend::infrastructure::server::build_router(state.state.clone());
    actix_rt::spawn(async move {
        let _ = axum::serve(http_listener, router).await;
    });

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let grpc_state = state.clone();
    actix_rt::spawn(async move {
        let _ = Server::builder()
            .add_service(DeRecTransportServer::new(GrpcIngress::new(
                grpc_state.state.delivery.clone(),
            )))
            .serve_with_incoming_shutdown(incoming, async move {
                let _ = shutdown_rx.await;
            })
            .await;
    });

    (
        state,
        GrpcHandle {
            addr: grpc_addr,
            shutdown: Mutex::new(Some(shutdown_tx)),
        },
    )
}

/// Provision a hosted helper in the requested transport mode, exactly as
/// `POST /helpers` does.
async fn spawn_helper(state: &Arc<Node>, mode: TransportMode) -> (Uuid, Addr<ProvisionedActor>) {
    let actor = Actor::mint(
        Role::Helper,
        "Helper",
        &state.config.base_url,
        &state.config.grpc_authority(),
        mode,
    );
    state
        .actors
        .register(actor.clone(), test_settings())
        .await
        .expect("the registry is writable");
    state
        .runtime
        .spawn(&actor, &test_settings())
        .expect("the helper starts");

    let addr = state
        .inboxes
        .provisioned(&actor.id)
        .expect("spawning registers an inbox");

    (actor.id, addr)
}

/// A browser-managed owner. Always HTTP-only: these tests are about what the
/// *helper* advertises, and the owner's replies travelling over HTTP is
/// already exercised elsewhere — nothing here needs the owner itself to speak
/// gRPC.
async fn register_owner(state: &Arc<Node>) -> Owner {
    let actor = Actor::mint(
        Role::Owner,
        "Owner",
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
        communication_info: HashMap::from([("name".to_owned(), "Owner".to_owned())]),
        timeout_secs: TIMEOUT_SECS,
        unpair_ack: UnpairAck::Required,
        threshold: 2,
        replica_id: Some(rand::random()),
        http_client: state.http_client.clone(),
        pool: state.pool.clone(),
        actor_id: actor.id,
        local_delivery: None,
    };

    Owner {
        id: actor.id,
        secret_id,
        protocol: build_protocol(&config).expect("the owner's protocol builds"),
    }
}

/// Drain the owner's mailbox into its protocol, as the front end's poll loop
/// does. A no-op when the mailbox is empty.
async fn pump(state: &Node, owner: &mut Owner) {
    let messages = state
        .mailboxes
        .drain(&owner.id)
        .await
        .expect("the mailbox is readable");
    for bytes in messages {
        owner
            .protocol
            .process(&bytes)
            .await
            .expect("the owner processes the helper's reply");
    }
}

/// Poll the helper's own view of the channel until it reaches `want`.
async fn await_helper_status(
    state: &Node,
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

/// The helper records every completed pairing's long-term channel id in
/// `helper_channels`, which is the first externally visible sign the
/// handshake landed on that side. Waits for it and returns it.
async fn await_helper_channel(state: &Node, helper_id: Uuid, owner: &mut Owner) -> u64 {
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

/// Provision a helper advertising `mode`, pair a fresh owner with it over a
/// plain `NoKeys` handshake, and wait for the helper to auto-confirm —
/// exactly as `tests/helper_auto_confirm.rs`'s `NoKeys` test does. Returns a
/// `Rig` holding both sides plus enough of the server to drive a further
/// send.
///
/// `CreateContactMsg` is sent directly to the helper actor rather than
/// through `POST /actors/:id/contact`, so this pins the resulting transient
/// channel id on the gRPC router itself — the one thing that route does
/// beyond the actor call, and the only reason a `Grpc`/`Both` helper's first
/// message would otherwise go unrouted.
pub async fn owner_paired_with(mode: TransportMode) -> Rig {
    let (state, grpc) = serve().await;
    let (helper_id, helper) = spawn_helper(&state, mode).await;
    let mut owner = register_owner(&state).await;

    let contact = helper
        .send(CreateContactMsg {
            contact_mode: derec_proto::ContactMode::NoKeys,
            nonce: None,
            replica_for_owner_secret: None,
            attempt: 0,
        })
        .await
        .expect("the helper actor is alive")
        .expect("the helper mints a contact");
    state.channel_router.pin(contact.channel_id, helper_id);

    owner
        .protocol
        .start(DeRecFlow::Pairing {
            kind: derec_proto::SenderKind::Owner,
            contact,
            peer_communication_info: HashMap::from([("name".to_owned(), "Helper".to_owned())]),
        })
        .await
        .expect("the owner starts a NoKeys pairing");

    let channel_id = await_helper_channel(&state, helper_id, &mut owner).await;

    assert_eq!(
        await_helper_status(
            &state,
            &helper,
            &mut owner,
            channel_id,
            ChannelStatus::Paired
        )
        .await,
        Some(ChannelStatus::Paired),
        "the fixture is only useful once both sides have actually completed the handshake"
    );

    Rig {
        secret_id: owner.secret_id,
        channel_id: ChannelId(channel_id),
        owner,
        grpc,
    }
}

/// The transports the owner's channel store has recorded for the helper
/// side of `rig`, read back through the store — not a return value, the
/// stored record itself.
pub async fn recorded_transports(rig: &Rig) -> Vec<derec_proto::TransportProtocol> {
    use derec_library::protocol::{ChannelQuery, ChannelRecord, DeRecChannelStore};

    let record = rig
        .owner
        .protocol
        .channel_store
        .load(
            rig.secret_id,
            ChannelQuery::Helper {
                channel_id: rig.channel_id,
            },
        )
        .await
        .expect("the in-memory channel store is readable")
        .expect("the channel exists after pairing");

    let ChannelRecord::Helper(helper) = record else {
        panic!("a helper pairing writes a helper record");
    };
    helper.transports
}

/// Shut down `rig`'s gRPC listener — the address the peer's first advertised
/// endpoint names — then drive a harmless `UpdateChannelInfo` round trip
/// against the paired channel. `CompositeTransport` must fail over to the
/// second (HTTP) endpoint on its own for this to succeed; nothing here
/// rewrites what pairing recorded, since `own_transports: vec![]` leaves the
/// peer's stored set untouched.
pub async fn send_with_first_endpoint_unreachable(rig: &mut Rig) {
    rig.grpc.close().await;

    rig.owner
        .protocol
        .start(DeRecFlow::UpdateChannelInfo {
            target: Target::Single(rig.channel_id),
            communication_info: Some(HashMap::new()),
            own_transports: Vec::new(),
        })
        .await
        .expect("the send must succeed by failing over to the second endpoint");
}
