// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! An actor's transport delivers to this node's own actors in-process, under
//! any address the node has had, and dials everything else as before.
//!
//! Nothing listens anywhere in these tests: a delivery that succeeds can only
//! have been made locally.

use std::sync::Arc;

use derec_backend::infrastructure::bootstrap::Node;
use derec_backend::infrastructure::transport::{CompositeTransport, GrpcTransport, HttpTransport};
use derec_backend::models::Defaults;
use derec_backend::models::{Listener, Side};
use derec_backend::services::ports::InboxDirectory;
use derec_library::protocol::DeRecTransport as _;
use prost::Message as _;
use uuid::Uuid;

async fn node() -> Arc<Node> {
    let state = Arc::new(Node::new(
        derec_backend::models::NodeConfig::new(
            "http://192.168.0.28:5600",
            Defaults {
                grpc_port: 50651,
                ..Defaults::default()
            },
        ),
        reqwest::Client::new(),
        actix_rt::Arbiter::current(),
        derec_backend::infrastructure::db::connect("sqlite::memory:")
            .await
            .expect("an in-memory database always connects"),
    ));
    // What the node advertised before a republish; nothing listens there now.
    for (listener, address) in [
        (Listener::Http, "http://localhost:8080"),
        (Listener::Grpc, "localhost:9090"),
    ] {
        state
            .addresses
            .remember(listener, address)
            .await
            .expect("the database is writable");
    }
    state
}

/// The transport an actor `sender` on `node` sends with.
fn transport_of(node: &Arc<Node>, sender: Uuid) -> CompositeTransport {
    CompositeTransport::new(
        HttpTransport::new(reqwest::Client::new()),
        GrpcTransport::for_actor(sender),
    )
    .delivering_locally_on(Arc::clone(&node.local_delivery))
}

fn endpoint(uri: &str, protocol: derec_proto::Protocol) -> derec_proto::TransportProtocol {
    derec_proto::TransportProtocol {
        uri: uri.to_owned(),
        protocol: protocol as i32,
    }
}

fn envelope(channel_id: u64) -> Vec<u8> {
    derec_proto::DeRecMessage {
        channel_id,
        ..Default::default()
    }
    .encode_to_vec()
}

fn browser_actor(state: &Node) -> Uuid {
    let id = Uuid::new_v4();
    state.inboxes.register_browser(id);
    id
}

#[actix_rt::test]
async fn an_old_http_address_of_a_same_node_actor_is_delivered_without_a_dial() {
    let state = node().await;
    let owner = browser_actor(&state);

    transport_of(&state, Uuid::new_v4())
        .send(
            &[endpoint(
                &format!("http://localhost:8080/derec/{owner}"),
                derec_proto::Protocol::Https,
            )],
            envelope(5),
        )
        .await
        .expect("delivered locally, although nothing listens on 8080");

    assert_eq!(
        state.mailboxes.drain(&owner).await.expect("readable"),
        vec![envelope(5)]
    );
}

#[actix_rt::test]
async fn an_old_grpc_address_routes_by_channel_and_never_back_to_the_sender() {
    // Both ends of a pairing on this node hold the channel; the sender's own
    // claim is excluded exactly as the gRPC listener excludes it.
    let state = node().await;
    let (sender, recipient) = (browser_actor(&state), browser_actor(&state));
    state.channel_router.pin(77, sender);
    state.channel_router.pin(77, recipient);

    transport_of(&state, sender)
        .send(
            &[endpoint(
                "grpc://localhost:9090",
                derec_proto::Protocol::Grpc,
            )],
            envelope(77),
        )
        .await
        .expect("delivered locally");

    assert_eq!(
        state
            .mailboxes
            .drain(&recipient)
            .await
            .expect("readable")
            .len(),
        1
    );
    assert!(state
        .mailboxes
        .drain(&sender)
        .await
        .expect("readable")
        .is_empty());
}

#[actix_rt::test]
async fn another_node_is_still_dialled() {
    // Port 1 refuses: the send fails, which it could not if it had been
    // short-circuited into this node.
    let state = node().await;
    let owner = browser_actor(&state);

    let outcome = transport_of(&state, Uuid::new_v4())
        .send(
            &[endpoint(
                &format!("http://127.0.0.1:1/derec/{owner}"),
                derec_proto::Protocol::Https,
            )],
            envelope(5),
        )
        .await;

    assert!(outcome.is_err());
    assert!(state
        .mailboxes
        .drain(&owner)
        .await
        .expect("readable")
        .is_empty());
}

#[actix_rt::test]
async fn a_full_mailbox_here_fails_over_to_the_next_endpoint_rather_than_dialling_itself() {
    let state = node().await;
    let (full, spare) = (browser_actor(&state), browser_actor(&state));
    for _ in 0..derec_backend::repositories::mailboxes::MAX_QUEUED_MESSAGES {
        state.mailboxes.enqueue(&full, &[1]).await.expect("room");
    }

    transport_of(&state, Uuid::new_v4())
        .send(
            &[
                endpoint(
                    &format!("http://localhost:8080/derec/{full}"),
                    derec_proto::Protocol::Https,
                ),
                endpoint(
                    &format!("http://localhost:8080/derec/{spare}"),
                    derec_proto::Protocol::Https,
                ),
            ],
            envelope(5),
        )
        .await
        .expect("the second endpoint takes it");

    assert_eq!(
        state.mailboxes.drain(&spare).await.expect("readable").len(),
        1
    );
}

/// Register an actor advertising `mode` and give it a mailbox, so whatever is
/// delivered to it can be read back.
async fn registered_actor(state: &Node, mode: derec_backend::models::TransportMode) -> Uuid {
    let actor = derec_backend::models::Actor::mint(
        derec_backend::models::Role::Helper,
        "Fixture",
        &state.config.base_url,
        &state.config.grpc_authority(),
        mode,
    );
    state
        .actors
        .register(
            actor.clone(),
            derec_backend::models::ActorSettings {
                replica_id: rand::random(),
                timeout_secs: 300,
                unpair_ack: derec_backend::models::UnpairAck::Required,
            },
        )
        .await
        .expect("the registry is writable");
    state.inboxes.register_browser(actor.id);
    actor.id
}

#[actix_rt::test]
async fn a_relayed_grpc_message_skips_an_http_only_claimant_of_its_channel() {
    // A replica's instance holds copies of the source's helper channels, so an
    // HTTP-only replica claims the same id as the gRPC helper serving it. The
    // source's own message to that helper — relayed, since a browser cannot
    // dial gRPC — is the helper's: nobody dials the replica over gRPC.
    let state = node().await;
    let source = browser_actor(&state);
    let helper = registered_actor(&state, derec_backend::models::TransportMode::Both).await;
    let replica = registered_actor(&state, derec_backend::models::TransportMode::Http).await;
    state.channel_router.bind(88, helper, Side::Endpoint);
    state.channel_router.bind(88, replica, Side::Mirror);

    transport_of(&state, source)
        .send(
            &[endpoint(
                "grpc://localhost:9090",
                derec_proto::Protocol::Grpc,
            )],
            envelope(88),
        )
        .await
        .expect("delivered to the gRPC helper");

    assert_eq!(
        state.mailboxes.drain(&helper).await.expect("readable"),
        vec![envelope(88)]
    );
    assert!(state
        .mailboxes
        .drain(&replica)
        .await
        .expect("readable")
        .is_empty());
}

#[actix_rt::test]
async fn an_http_only_end_of_a_channel_is_skipped_on_a_grpc_address() {
    // Two ends of one channel here, one of which nobody dials over gRPC.
    let state = node().await;
    let source = browser_actor(&state);
    let grpc = registered_actor(&state, derec_backend::models::TransportMode::Grpc).await;
    let http_only = registered_actor(&state, derec_backend::models::TransportMode::Http).await;
    state.channel_router.bind(87, grpc, Side::Endpoint);
    state.channel_router.bind(87, http_only, Side::Endpoint);

    transport_of(&state, source)
        .send(
            &[endpoint(
                "grpc://localhost:9090",
                derec_proto::Protocol::Grpc,
            )],
            envelope(87),
        )
        .await
        .expect("delivered to the gRPC end");

    assert_eq!(
        state.mailboxes.drain(&grpc).await.expect("readable"),
        vec![envelope(87)]
    );
    assert!(state
        .mailboxes
        .drain(&http_only)
        .await
        .expect("readable")
        .is_empty());
}

#[actix_rt::test]
async fn a_grpc_replicas_copy_of_a_channel_does_not_shadow_the_helper_serving_it() {
    // The replica can be dialled over gRPC too, so setting HTTP-only claimants
    // aside leaves both; the side each claims from is what tells them apart.
    let state = node().await;
    let source = browser_actor(&state);
    let helper = registered_actor(&state, derec_backend::models::TransportMode::Grpc).await;
    let replica = registered_actor(&state, derec_backend::models::TransportMode::Grpc).await;
    state.channel_router.bind(90, replica, Side::Mirror);
    state.channel_router.bind(90, helper, Side::Endpoint);

    transport_of(&state, source)
        .send(
            &[endpoint(
                "grpc://localhost:9090",
                derec_proto::Protocol::Grpc,
            )],
            envelope(90),
        )
        .await
        .expect("delivered to the helper");

    assert_eq!(
        state.mailboxes.drain(&helper).await.expect("readable"),
        vec![envelope(90)]
    );
    assert!(state
        .mailboxes
        .drain(&replica)
        .await
        .expect("readable")
        .is_empty());

    // The helper's own reply on the channel is never for the helper: the
    // replica's copy is what is left.
    transport_of(&state, helper)
        .send(
            &[endpoint(
                "grpc://localhost:9090",
                derec_proto::Protocol::Grpc,
            )],
            envelope(90),
        )
        .await
        .expect("delivered to the replica");

    assert_eq!(
        state.mailboxes.drain(&replica).await.expect("readable"),
        vec![envelope(90)]
    );
    assert!(state
        .mailboxes
        .drain(&helper)
        .await
        .expect("readable")
        .is_empty());
}

#[actix_rt::test]
async fn a_channel_two_grpc_actors_claim_is_still_refused_without_a_sender() {
    // Narrowing by transport only removes claimants nobody could have dialled;
    // two that both serve gRPC stay a tie, and a tie is refused, not guessed.
    let state = node().await;
    let source = browser_actor(&state);
    let first = registered_actor(&state, derec_backend::models::TransportMode::Grpc).await;
    let second = registered_actor(&state, derec_backend::models::TransportMode::Grpc).await;
    state.channel_router.bind(89, first, Side::Endpoint);
    state.channel_router.bind(89, second, Side::Endpoint);

    let outcome = transport_of(&state, source)
        .send(
            &[endpoint(
                "grpc://localhost:9090",
                derec_proto::Protocol::Grpc,
            )],
            envelope(89),
        )
        .await;

    assert!(outcome.is_err());
    assert!(state
        .mailboxes
        .drain(&first)
        .await
        .expect("readable")
        .is_empty());
    assert!(state
        .mailboxes
        .drain(&second)
        .await
        .expect("readable")
        .is_empty());
}
