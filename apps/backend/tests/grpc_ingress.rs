// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The gRPC listener resolves an actor from the envelope and hands the bytes
//! to the same inbox HTTP would.

use derec_backend::infrastructure::grpc::pb::de_rec_transport_server::DeRecTransport;
use derec_backend::infrastructure::grpc::GrpcIngress;
use derec_backend::models::Carrier;
use derec_backend::models::DispatchOutcome;
use derec_backend::services::ports::InboxDirectory;
use prost::Message as _;
use tonic::Request;
use uuid::Uuid;

/// Stock protocol settings for a fixture actor.
fn test_settings() -> derec_backend::models::ActorSettings {
    derec_backend::models::ActorSettings {
        replica_id: rand::random::<u64>(),
        timeout_secs: 300,
        unpair_ack: derec_backend::models::UnpairAck::Required,
    }
}

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
    let state = derec_backend::infrastructure::test_support::node().await;
    let actor_id = Uuid::new_v4();
    state.inboxes.register_browser(actor_id);
    state.channel_router.pin(4242, actor_id);

    let decoded = derec_proto::DeRecMessage::decode(envelope(4242).as_slice())
        .expect("a well-formed envelope");
    let resolved = state
        .channel_router
        .resolve(decoded.channel_id)
        .expect("the pinned channel resolves");

    assert_eq!(resolved, actor_id);
    assert_eq!(
        state
            .state
            .delivery
            .dispatch(resolved, Carrier::Grpc, envelope(4242))
            .await,
        DispatchOutcome::Delivered
    );
}

#[actix_rt::test]
async fn an_unknown_channel_resolves_to_no_actor() {
    // Refused, never guessed: guessing would hand a peer's message to an actor
    // that does not own the channel.
    let state = derec_backend::infrastructure::test_support::node().await;

    assert_eq!(state.channel_router.resolve(9999), None);
}

#[actix_rt::test]
async fn a_disabled_actor_drops_grpc_traffic_exactly_as_it_drops_http() {
    let state = derec_backend::infrastructure::test_support::node().await;
    let actor_id = Uuid::new_v4();
    state.inboxes.register_browser(actor_id);
    state
        .disabled_helpers
        .set_disabled(&actor_id, true)
        .await
        .expect("the registry is writable");

    assert_eq!(
        state
            .state
            .delivery
            .dispatch(actor_id, Carrier::Grpc, envelope(1))
            .await,
        DispatchOutcome::Dropped
    );
}

// The tests above cover the delivery service's `dispatch` and `ChannelRouter::resolve` in
// isolation. Neither exercises `GrpcIngress::send` itself, so a regression
// that swapped its match arms or dropped the re-encode would pass them
// unchanged. The tests below call `send` directly — a tonic service method is
// a plain async fn, so no socket is needed.

/// Drain whatever is waiting in `actor_id`'s browser inbox.
async fn drain(
    state: &derec_backend::infrastructure::bootstrap::Node,
    actor_id: Uuid,
) -> Vec<Vec<u8>> {
    assert!(
        (state.inboxes.kind(&actor_id) == Some(derec_backend::models::InboxKind::Browser)),
        "actor has a browser mailbox"
    );
    state
        .mailboxes
        .drain(&actor_id)
        .await
        .expect("the mailbox is readable")
}

#[actix_rt::test]
async fn send_on_a_resolvable_channel_delivers_to_the_right_inbox_and_returns_ok() {
    let state = derec_backend::infrastructure::test_support::node().await;
    let actor_id = Uuid::new_v4();
    state.inboxes.register_browser(actor_id);
    state.channel_router.pin(4242, actor_id);

    let ingress = GrpcIngress::new(state.state.delivery.clone());
    let wire = envelope(4242);
    let decoded =
        derec_proto::DeRecMessage::decode(wire.as_slice()).expect("a well-formed envelope");

    let response = ingress.send(Request::new(decoded)).await;

    assert!(response.is_ok(), "a resolvable channel must be accepted");

    let delivered = drain(&state, actor_id).await;
    assert_eq!(
        delivered,
        vec![wire],
        "the decode-then-re-encode must round-trip the envelope unchanged"
    );
}

#[actix_rt::test]
async fn send_on_an_unresolvable_channel_is_refused_and_delivers_nothing() {
    // Refused, never guessed: guessing would hand a peer's message to an
    // actor that does not own the channel.
    let state = derec_backend::infrastructure::test_support::node().await;
    let bystander = Uuid::new_v4();
    state.inboxes.register_browser(bystander);
    state.channel_router.pin(1, bystander);

    let ingress = GrpcIngress::new(state.state.delivery.clone());
    let decoded = derec_proto::DeRecMessage::decode(envelope(9999).as_slice())
        .expect("a well-formed envelope");

    let error = ingress
        .send(Request::new(decoded))
        .await
        .expect_err("an unresolvable channel must be refused");

    assert_eq!(error.code(), tonic::Code::NotFound);
    assert!(
        drain(&state, bystander).await.is_empty(),
        "an unrelated actor's inbox must not receive a misrouted message"
    );
}

use derec_backend::models::OwnTarget;
use derec_backend::models::{RelayRefusal, RelayTarget};

#[actix_rt::test]
async fn the_relay_refuses_another_node_nobody_allowed() {
    // Without this check the route is an open SSRF proxy, and this app is run
    // on laptops on shared networks.
    let state = derec_backend::infrastructure::test_support::node().await;

    assert_eq!(
        state
            .state
            .delivery
            .relay_target("grpc://evil.example:50051")
            .await,
        RelayTarget::Refused(RelayRefusal::NotAllowed)
    );
}

#[actix_rt::test]
async fn the_relay_accepts_an_endpoint_a_registered_actor_advertises() {
    // An actor stored with an address that is not this node's current one —
    // a re-advertise that could not be written — is still dialled for it.
    let state = derec_backend::infrastructure::test_support::node().await;
    let actor = derec_backend::models::Actor::mint(
        derec_backend::models::Role::Helper,
        "grpc helper",
        "http://10.9.9.9:5000",
        "10.9.9.9:50051",
        derec_backend::models::TransportMode::Grpc,
    );
    let uri = actor.transports[0].uri.clone();
    state
        .actors
        .register(actor, test_settings())
        .await
        .expect("the registry is writable");

    assert_eq!(
        state.state.delivery.relay_target(&uri).await,
        RelayTarget::Remote
    );
}

#[actix_rt::test]
async fn the_relay_dials_a_host_the_operator_allowed() {
    let mut loaded = derec_backend::models::LoadedConfig::default();
    loaded.settings.server.relay_allowed_hosts = "node-b:50051, 192.168.0.40".to_owned();
    let state = derec_backend::infrastructure::bootstrap::Node::new(
        derec_backend::models::NodeConfig::new(
            "http://192.168.0.28:5000",
            derec_backend::models::Defaults::default(),
        )
        .with_loaded(loaded),
        reqwest::Client::new(),
        actix_rt::Arbiter::current(),
        derec_backend::infrastructure::db::connect("sqlite::memory:")
            .await
            .expect("an in-memory database always connects"),
    );

    for uri in [
        "grpc://node-b:50051",
        "grpc://192.168.0.40:1234",
        "http://192.168.0.40/derec/x",
    ] {
        assert_eq!(
            state.state.delivery.relay_target(uri).await,
            RelayTarget::Remote,
            "{uri}"
        );
    }
    for uri in ["grpc://node-b:50052", "grpc://node-c:50051"] {
        assert_eq!(
            state.state.delivery.relay_target(uri).await,
            RelayTarget::Refused(RelayRefusal::NotAllowed),
            "{uri}"
        );
    }
    // Allowed or not, a shape the relay cannot dial is refused as such.
    assert_eq!(
        state
            .state
            .delivery
            .relay_target("grpc://user@node-b:50051")
            .await,
        RelayTarget::Refused(RelayRefusal::Malformed)
    );
}

/// A node whose address moved from `localhost` to a LAN address, published on
/// another gRPC port — the situation that used to strand browsers holding a
/// gRPC helper's previous address.
async fn moved_node(grpc_enabled: bool) -> derec_backend::infrastructure::bootstrap::Node {
    derec_backend::infrastructure::bootstrap::Node::new(
        derec_backend::models::NodeConfig::new(
            "http://192.168.0.28:5000",
            derec_backend::models::Defaults {
                grpc_enabled,
                grpc_port: 50051,
                ..derec_backend::models::Defaults::default()
            },
        )
        .with_public_grpc_port(8081),
        reqwest::Client::new(),
        actix_rt::Arbiter::current(),
        derec_backend::infrastructure::db::connect("sqlite::memory:")
            .await
            .expect("an in-memory database always connects"),
    )
}

const SERVED: RelayTarget = RelayTarget::Local(OwnTarget::GrpcListener { served: true });

#[actix_rt::test]
async fn the_relay_delivers_to_this_nodes_own_grpc_listener_under_any_name_it_answers_to() {
    // Nothing is registered, so only the own-address rule can admit these.
    let state = moved_node(true).await;

    for uri in [
        "grpc://localhost:50051",
        "grpc://LOCALHOST:50051",
        "grpc://127.0.0.1:50051",
        "grpc://[::1]:50051",
        "grpc://192.168.0.28:50051",
        "grpc://192.168.0.28:8081",
        "grpc://localhost:8081/",
    ] {
        assert_eq!(
            state.state.delivery.relay_target(uri).await,
            SERVED,
            "{uri} is this node"
        );
    }
}

#[actix_rt::test]
async fn an_address_this_node_advertised_before_is_still_this_node() {
    // A container republished from -p 9090:50051 to -p 8081:50051: nothing
    // listens on 9090 any more, but a browser paired before the move holds it.
    let state = moved_node(true).await;
    assert_eq!(
        state
            .state
            .delivery
            .relay_target("grpc://192.168.0.28:9090")
            .await,
        RelayTarget::Refused(RelayRefusal::NotAllowed),
        "unknown until remembered"
    );

    state
        .addresses
        .remember(derec_backend::models::Listener::Grpc, "192.168.0.28:9090")
        .await
        .expect("the database is writable");

    assert_eq!(
        state
            .state
            .delivery
            .relay_target("grpc://192.168.0.28:9090")
            .await,
        SERVED
    );
}

#[actix_rt::test]
async fn the_own_address_rule_admits_nothing_else() {
    // Another host, another port, another scheme, or a URI dressed up with
    // credentials or a path is not this node.
    let state = moved_node(true).await;

    for uri in [
        "grpc://192.168.0.29:50051",
        "grpc://evil.example:50051",
        "grpc://localhost:50052",
        "grpc://localhost",
        "http://localhost:50051",
        "grpcs://localhost:50051",
        "grpc://user@localhost:50051",
        "grpc://localhost:50051/derec.Transport/Send",
        "grpc://localhost:50051?x=1",
        "grpc://localhost.evil.example:50051",
        "not a uri",
    ] {
        let target = state.state.delivery.relay_target(uri).await;
        assert!(
            matches!(target, RelayTarget::Refused(_)),
            "{uri} must be refused, got {target:?}"
        );
    }
}

#[actix_rt::test]
async fn with_grpc_disabled_the_relay_says_so_for_this_nodes_grpc_address() {
    let state = moved_node(false).await;

    assert_eq!(
        state
            .state
            .delivery
            .relay_target("grpc://localhost:50051")
            .await,
        RelayTarget::Refused(RelayRefusal::GrpcDisabled)
    );
}

#[actix_rt::test]
async fn send_to_a_disabled_actor_returns_ok_without_delivering() {
    // The offline drop must not surface as an error to the peer: "offline" is
    // a simulation of an unreachable helper, which a real transport also
    // cannot distinguish from ordinary success.
    let state = derec_backend::infrastructure::test_support::node().await;
    let actor_id = Uuid::new_v4();
    state.inboxes.register_browser(actor_id);
    state.channel_router.pin(7, actor_id);
    state
        .disabled_helpers
        .set_disabled(&actor_id, true)
        .await
        .expect("the registry is writable");

    let ingress = GrpcIngress::new(state.state.delivery.clone());
    let decoded =
        derec_proto::DeRecMessage::decode(envelope(7).as_slice()).expect("a well-formed envelope");

    let response = ingress.send(Request::new(decoded)).await;

    assert!(
        response.is_ok(),
        "a dropped message is still an accepted call"
    );
    assert!(
        drain(&state, actor_id).await.is_empty(),
        "a disabled actor's inbox must stay empty"
    );
}

#[actix_rt::test]
async fn a_channel_held_by_two_local_actors_routes_by_the_senders_hint() {
    // Two provisioned helpers on this node pairing with each other over gRPC
    // share one channel id and one listener. The id cannot say which end a
    // message is for; the sender's hint can, because a message is never for
    // the actor that sent it.
    let state = derec_backend::infrastructure::test_support::node().await;
    let (initiator, responder) = (Uuid::new_v4(), Uuid::new_v4());
    state.inboxes.register_browser(initiator);
    state.inboxes.register_browser(responder);
    state.channel_router.pin(77, responder);
    state.channel_router.pin(77, initiator);

    let ingress = GrpcIngress::new(state.state.delivery.clone());
    let decoded = || {
        derec_proto::DeRecMessage::decode(envelope(77).as_slice()).expect("a well-formed envelope")
    };

    let mut request = Request::new(decoded());
    request.metadata_mut().insert(
        derec_backend::models::SENDER_METADATA,
        initiator
            .to_string()
            .parse()
            .expect("a uuid is valid metadata"),
    );
    ingress
        .send(request)
        .await
        .expect("the hinted call is accepted");

    assert_eq!(
        drain(&state, responder).await.len(),
        1,
        "the other end receives it"
    );
    assert!(
        drain(&state, initiator).await.is_empty(),
        "the sender must never receive its own message"
    );

    let error = ingress
        .send(Request::new(decoded()))
        .await
        .expect_err("without a hint the two ends are indistinguishable");
    assert_eq!(error.code(), tonic::Code::FailedPrecondition);
    assert!(drain(&state, initiator).await.is_empty());
    assert!(drain(&state, responder).await.is_empty());
}

/// Register an actor advertising `mode` with a browser mailbox, so what is
/// delivered to it can be read back.
async fn registered(
    state: &derec_backend::infrastructure::bootstrap::Node,
    mode: derec_backend::models::TransportMode,
) -> Uuid {
    let actor = derec_backend::models::Actor::mint(
        derec_backend::models::Role::Helper,
        "Fixture",
        &state.config.base_url,
        &state.config.grpc_authority(),
        mode,
    );
    state
        .actors
        .register(actor.clone(), test_settings())
        .await
        .expect("the registry is writable");
    state.inboxes.register_browser(actor.id);
    actor.id
}

#[actix_rt::test]
async fn a_grpc_message_reaches_the_helper_past_a_grpc_replicas_copy_of_its_channel() {
    // A replica's instance holds its source's helper channels. With both the
    // replica and the helper serving gRPC, the peer's message used to be
    // refused as ambiguous; the helper serving the channel is its recipient.
    use derec_backend::models::{Side, TransportMode};
    let state = derec_backend::infrastructure::test_support::node().await;
    let helper = registered(&state, TransportMode::Grpc).await;
    let replica = registered(&state, TransportMode::Grpc).await;
    state.channel_router.bind(5151, replica, Side::Mirror);
    state.channel_router.bind(5151, helper, Side::Endpoint);

    let ingress = GrpcIngress::new(state.state.delivery.clone());
    let decoded = derec_proto::DeRecMessage::decode(envelope(5151).as_slice())
        .expect("a well-formed envelope");

    ingress
        .send(Request::new(decoded))
        .await
        .expect("the helper takes it");

    assert_eq!(drain(&state, helper).await, vec![envelope(5151)]);
    assert!(drain(&state, replica).await.is_empty());
}

#[actix_rt::test]
async fn a_grpc_message_skips_an_http_only_replicas_copy_of_its_channel() {
    use derec_backend::models::{Side, TransportMode};
    let state = derec_backend::infrastructure::test_support::node().await;
    let helper = registered(&state, TransportMode::Grpc).await;
    let replica = registered(&state, TransportMode::Http).await;
    state.channel_router.bind(5152, replica, Side::Mirror);
    state.channel_router.bind(5152, helper, Side::Endpoint);

    let ingress = GrpcIngress::new(state.state.delivery.clone());
    let decoded = derec_proto::DeRecMessage::decode(envelope(5152).as_slice())
        .expect("a well-formed envelope");

    ingress
        .send(Request::new(decoded))
        .await
        .expect("the helper takes it");

    assert_eq!(drain(&state, helper).await, vec![envelope(5152)]);
    assert!(drain(&state, replica).await.is_empty());
}

#[actix_rt::test]
async fn a_grpc_message_on_a_channel_two_replicas_copy_is_refused_rather_than_guessed() {
    use derec_backend::models::{Side, TransportMode};
    let state = derec_backend::infrastructure::test_support::node().await;
    let first = registered(&state, TransportMode::Grpc).await;
    let second = registered(&state, TransportMode::Grpc).await;
    state.channel_router.bind(5153, first, Side::Mirror);
    state.channel_router.bind(5153, second, Side::Mirror);

    let ingress = GrpcIngress::new(state.state.delivery.clone());
    let decoded = derec_proto::DeRecMessage::decode(envelope(5153).as_slice())
        .expect("a well-formed envelope");

    let error = ingress
        .send(Request::new(decoded))
        .await
        .expect_err("two copies and no end are a tie");

    assert_eq!(error.code(), tonic::Code::FailedPrecondition);
    assert!(drain(&state, first).await.is_empty());
    assert!(drain(&state, second).await.is_empty());
}
