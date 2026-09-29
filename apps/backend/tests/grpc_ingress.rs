//! The gRPC listener resolves an actor from the envelope and hands the bytes
//! to the same inbox HTTP would.

use derec_backend::debug::Carrier;
use derec_backend::grpc::GrpcIngress;
use derec_backend::grpc::pb::de_rec_transport_server::DeRecTransport;
use derec_backend::routes::derec::{DispatchOutcome, dispatch_to_inbox};
use prost::Message as _;
use tonic::Request;
use uuid::Uuid;

/// Stock protocol settings for a fixture actor.
fn test_settings() -> derec_backend::registry::actors::ActorSettings {
    derec_backend::registry::actors::ActorSettings {
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
    let state = derec_backend::test_support::app_state().await;
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
        dispatch_to_inbox(&state, resolved, Carrier::Grpc, envelope(4242)).await,
        DispatchOutcome::Delivered
    );
}

#[actix_rt::test]
async fn an_unknown_channel_resolves_to_no_actor() {
    // Refused, never guessed: guessing would hand a peer's message to an actor
    // that does not own the channel.
    let state = derec_backend::test_support::app_state().await;

    assert_eq!(state.channel_router.resolve(9999), None);
}

#[actix_rt::test]
async fn a_disabled_actor_drops_grpc_traffic_exactly_as_it_drops_http() {
    let state = derec_backend::test_support::app_state().await;
    let actor_id = Uuid::new_v4();
    derec_backend::provisioning::register_browser_actor(&state, actor_id);
    state
        .disabled_helpers
        .set_disabled(&actor_id, true)
        .await
        .expect("the registry is writable");

    assert_eq!(
        dispatch_to_inbox(&state, actor_id, Carrier::Grpc, envelope(1)).await,
        DispatchOutcome::Dropped
    );
}

// The tests above cover `dispatch_to_inbox` and `ChannelRouter::resolve` in
// isolation. Neither exercises `GrpcIngress::send` itself, so a regression
// that swapped its match arms or dropped the re-encode would pass them
// unchanged. The tests below call `send` directly — a tonic service method is
// a plain async fn, so no socket is needed.

/// Drain whatever is waiting in `actor_id`'s browser inbox.
async fn drain(state: &derec_backend::state::AppState, actor_id: Uuid) -> Vec<Vec<u8>> {
    let receiver_lock = state
        .browser_receivers
        .get(&actor_id)
        .expect("actor has a browser mailbox");
    let mut receiver = receiver_lock.lock().await;
    let mut messages = Vec::new();
    while let Ok(msg) = receiver.try_recv() {
        messages.push(msg);
    }
    messages
}

#[actix_rt::test]
async fn send_on_a_resolvable_channel_delivers_to_the_right_inbox_and_returns_ok() {
    let state = derec_backend::test_support::app_state().await;
    let actor_id = Uuid::new_v4();
    derec_backend::provisioning::register_browser_actor(&state, actor_id);
    state.channel_router.pin(4242, actor_id);

    let ingress = GrpcIngress::new(state.clone());
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
    let state = derec_backend::test_support::app_state().await;
    let bystander = Uuid::new_v4();
    derec_backend::provisioning::register_browser_actor(&state, bystander);
    state.channel_router.pin(1, bystander);

    let ingress = GrpcIngress::new(state.clone());
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

#[actix_rt::test]
async fn the_relay_refuses_an_endpoint_no_registered_actor_advertises() {
    // Without this check the route is an open SSRF proxy, and this app is run
    // on laptops on shared networks.
    let state = derec_backend::test_support::app_state().await;

    assert!(
        !derec_backend::routes::derec::relay_target_is_known(
            &state,
            "grpc://evil.example:50051"
        )
        .await
    );
}

#[actix_rt::test]
async fn the_relay_accepts_an_endpoint_a_registered_actor_advertises() {
    let state = derec_backend::test_support::app_state().await;
    let actor = derec_backend::provisioning::provisioned_actor(
        derec_backend::models::Role::Helper,
        "grpc helper",
        "http://localhost:5000",
        "localhost:50051",
        derec_backend::models::TransportMode::Grpc,
    );
    let uri = actor.transports[0].uri.clone();
    state
        .actors
        .register(actor, test_settings())
        .await
        .expect("the registry is writable");

    assert!(derec_backend::routes::derec::relay_target_is_known(&state, &uri).await);
}

#[actix_rt::test]
async fn send_to_a_disabled_actor_returns_ok_without_delivering() {
    // The offline drop must not surface as an error to the peer: "offline" is
    // a simulation of an unreachable helper, which a real transport also
    // cannot distinguish from ordinary success.
    let state = derec_backend::test_support::app_state().await;
    let actor_id = Uuid::new_v4();
    derec_backend::provisioning::register_browser_actor(&state, actor_id);
    state.channel_router.pin(7, actor_id);
    state
        .disabled_helpers
        .set_disabled(&actor_id, true)
        .await
        .expect("the registry is writable");

    let ingress = GrpcIngress::new(state.clone());
    let decoded = derec_proto::DeRecMessage::decode(envelope(7).as_slice())
        .expect("a well-formed envelope");

    let response = ingress.send(Request::new(decoded)).await;

    assert!(response.is_ok(), "a dropped message is still an accepted call");
    assert!(
        drain(&state, actor_id).await.is_empty(),
        "a disabled actor's inbox must stay empty"
    );
}
