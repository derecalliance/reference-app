// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! `POST /derec/relay` through the real router: where it delivers, what it
//! refuses and says about it, and how large a message it carries.
//!
//! Nothing listens anywhere here, and only one test dials (a refused port).
//! Every delivery that succeeds is one the relay made in-process — which is
//! the point: a target on this node, under any address it has had, never
//! needs a dial.

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use derec_backend::addresses::Listener;
use derec_backend::config::{Defaults, Loaded};
use derec_backend::debug::{Carrier, Direction, Outcome};
use derec_backend::models::{Role, TransportMode, UnpairAck};
use derec_backend::state::AppState;
use prost::Message as _;
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

/// A node moved to a LAN address and republished: it advertised
/// `localhost:9090` for gRPC and `http://localhost:8080` before, and listens
/// on neither now.
async fn moved_node(grpc_enabled: bool, relay_allowed_hosts: &str) -> (Arc<AppState>, Router) {
    let mut loaded = Loaded::default();
    loaded.settings.server.relay_allowed_hosts = relay_allowed_hosts.to_owned();
    let state = Arc::new(
        AppState::new(
            "http://192.168.0.28:5600",
            Defaults {
                grpc_enabled,
                grpc_port: 50651,
                ..Defaults::default()
            },
            reqwest::Client::new(),
            actix_rt::Arbiter::current(),
            derec_backend::db::connect("sqlite::memory:")
                .await
                .expect("an in-memory database always connects"),
        )
        .with_config(loaded),
    );
    for (listener, address) in [
        (Listener::Grpc, "localhost:9090"),
        (Listener::Http, "http://localhost:8080"),
    ] {
        state
            .addresses
            .remember(&state.pool, listener, address)
            .await
            .expect("the database is writable");
    }
    let router = derec_backend::build_router(state.clone());
    (state, router)
}

/// A browser owner on this node, as `POST /owners` registers one.
async fn browser_owner(state: &AppState) -> Uuid {
    let owner = derec_backend::provisioning::provisioned_actor(
        Role::Owner,
        "Alice",
        "http://localhost:8080",
        "localhost:9090",
        TransportMode::Http,
    );
    state
        .actors
        .register(
            owner.clone(),
            derec_backend::registry::actors::ActorSettings {
                replica_id: rand::random(),
                timeout_secs: 300,
                unpair_ack: UnpairAck::Required,
            },
        )
        .await
        .expect("the registry is writable");
    derec_backend::provisioning::register_browser_actor(state, owner.id);
    owner.id
}

/// An envelope on `channel_id`, padded with `body` bytes of payload.
fn envelope(channel_id: u64, body: usize) -> Vec<u8> {
    derec_proto::DeRecMessage {
        channel_id,
        message: vec![7u8; body],
        ..Default::default()
    }
    .encode_to_vec()
}

async fn relay(router: &Router, body: Value) -> (StatusCode, Value) {
    let request = Request::post("/derec/relay")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("request builds");
    let response = router.clone().oneshot(request).await.expect("infallible");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("readable");
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// The relay's own outbound events, oldest first.
fn relay_events(state: &AppState) -> Vec<derec_backend::debug::Event> {
    state
        .events
        .since(0, usize::MAX)
        .events
        .into_iter()
        .filter(|e| {
            e.direction == Direction::Outbound
                && matches!(e.carrier, Carrier::GrpcViaRelay | Carrier::HttpViaRelay)
        })
        .collect()
}

#[actix_rt::test]
async fn a_grpc_address_this_node_no_longer_listens_on_is_delivered_locally() {
    // The QA case: the old public gRPC port is gone after a republish. It used
    // to be refused as an unknown target, or accepted and then dialled into
    // nothing (502).
    let (state, router) = moved_node(true, "").await;
    let owner = browser_owner(&state).await;
    let requester = browser_owner(&state).await;
    state.channel_router.pin(4242, owner);

    let wire = envelope(4242, 16);
    let (status, body) = relay(
        &router,
        json!({
            "uri": "grpc://localhost:9090",
            "data": URL_SAFE_NO_PAD.encode(&wire),
            "actor_id": requester,
        }),
    )
    .await;

    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    assert_eq!(
        state.mailboxes.drain(&owner).await.expect("readable"),
        vec![wire],
        "the channel's holder on this node receives it"
    );
    let events = relay_events(&state);
    let last = events.last().expect("the relay recorded what it did");
    assert_eq!(last.outcome, Outcome::Delivered);
    assert_eq!(
        last.actor_id,
        Some(requester),
        "attributed to the owner that asked"
    );
    assert!(last.detail.contains("without a dial"), "{}", last.detail);
}

#[actix_rt::test]
async fn an_http_address_this_node_advertised_before_reaches_the_actor_it_names() {
    let (state, router) = moved_node(true, "").await;
    let owner = browser_owner(&state).await;

    let wire = envelope(77, 16);
    let (status, body) = relay(
        &router,
        json!({
            "uri": format!("http://localhost:8080/derec/{owner}"),
            "data": URL_SAFE_NO_PAD.encode(&wire),
        }),
    )
    .await;

    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    assert_eq!(state.mailboxes.drain(&owner).await.expect("readable"), vec![wire]);
}

#[actix_rt::test]
async fn another_node_is_refused_with_the_setting_to_change_and_the_refusal_is_logged() {
    let (state, router) = moved_node(true, "").await;
    let requester = browser_owner(&state).await;

    let (status, body) = relay(
        &router,
        json!({
            "uri": "grpc://192.168.0.30:50051",
            "data": URL_SAFE_NO_PAD.encode(envelope(5, 4)),
            "actor_id": requester,
        }),
    )
    .await;

    assert_eq!(status, StatusCode::FORBIDDEN);
    let message = body["error"].as_str().expect("error shape");
    assert!(message.contains("relay_allowed_hosts"), "{message}");
    assert!(message.contains("DEREC_RELAY_ALLOWED_HOSTS"), "{message}");

    let events = relay_events(&state);
    let refused = events.last().expect("a refusal is recorded, not silent");
    assert_eq!(refused.outcome, Outcome::Refused);
    assert_eq!(refused.actor_id, Some(requester));
    assert_eq!(refused.channel_id.as_deref(), Some("5"));
    assert!(refused.detail.contains("relay_allowed_hosts"), "{}", refused.detail);
}

#[actix_rt::test]
async fn an_allowed_node_is_dialled() {
    // Nothing listens on port 1, so the dial itself fails — the point is that
    // it was attempted (502) rather than refused (403).
    let (state, router) = moved_node(true, "127.0.0.1:1").await;

    let (status, body) = relay(
        &router,
        json!({ "uri": "grpc://127.0.0.1:1", "data": URL_SAFE_NO_PAD.encode(envelope(5, 4)) }),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
    let refused = relay_events(&state).pop().expect("recorded");
    assert!(refused.detail.contains("relay delivery failed"), "{}", refused.detail);
}

#[actix_rt::test]
async fn with_grpc_disabled_the_relay_says_so_rather_than_unknown_target() {
    let (state, router) = moved_node(false, "").await;

    let (status, body) = relay(
        &router,
        json!({ "uri": "grpc://192.168.0.28:50651", "data": URL_SAFE_NO_PAD.encode(envelope(5, 4)) }),
    )
    .await;

    assert_eq!(status, StatusCode::CONFLICT);
    let message = body["error"].as_str().expect("error shape");
    assert!(message.contains("gRPC is disabled"), "{message}");
    assert!(message.contains("DEREC_GRPC_ENABLED"), "{message}");
    assert_eq!(relay_events(&state).len(), 1, "the refusal is logged");
}

#[actix_rt::test]
async fn a_channel_nobody_here_holds_is_502_with_the_reason() {
    let (state, router) = moved_node(true, "").await;

    let (status, body) = relay(
        &router,
        json!({ "uri": "grpc://localhost:9090", "data": URL_SAFE_NO_PAD.encode(envelope(31337, 4)) }),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_GATEWAY);
    let message = body["error"].as_str().expect("error shape");
    assert!(message.contains("no actor on this node holds channel 31337"), "{message}");
    assert_eq!(relay_events(&state).len(), 1);
}

#[actix_rt::test]
async fn an_actor_id_that_names_nobody_is_400() {
    let (_, router) = moved_node(true, "").await;

    let (status, body) = relay(
        &router,
        json!({
            "uri": "grpc://localhost:9090",
            "data": URL_SAFE_NO_PAD.encode(envelope(5, 4)),
            "actor_id": Uuid::new_v4(),
        }),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
}

#[actix_rt::test]
async fn a_message_as_large_as_the_grpc_listener_accepts_can_be_relayed() {
    // Base64url inflates by a third, so the old 2 MiB JSON limit capped a
    // relayed message near 1.5 MiB while the gRPC listener takes 4 MiB.
    let (state, router) = moved_node(true, "").await;
    let owner = browser_owner(&state).await;
    state.channel_router.pin(9, owner);

    let max = derec_backend::transport::MAX_MESSAGE_BYTES;
    // The envelope's own fields take a few bytes; fill the rest.
    let wire = envelope(9, max - 16);
    assert!(wire.len() <= max && wire.len() > max - 32);

    let (status, body) = relay(
        &router,
        json!({ "uri": "grpc://localhost:9090", "data": URL_SAFE_NO_PAD.encode(&wire) }),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    assert_eq!(state.mailboxes.drain(&owner).await.expect("readable"), vec![wire]);

    let too_big = envelope(9, max + 1);
    let (status, body) = relay(
        &router,
        json!({ "uri": "grpc://localhost:9090", "data": URL_SAFE_NO_PAD.encode(&too_big) }),
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(body["error"].as_str().expect("error shape").contains("4 MiB"), "{body}");
}

#[actix_rt::test]
async fn the_http_transport_route_takes_a_message_of_the_same_size() {
    let (state, router) = moved_node(true, "").await;
    let owner = browser_owner(&state).await;

    let wire = envelope(9, 3 * 1024 * 1024);
    let request = Request::post(format!("/derec/{owner}"))
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(Body::from(wire.clone()))
        .expect("request builds");
    let response = router.clone().oneshot(request).await.expect("infallible");

    assert_eq!(response.status(), StatusCode::ACCEPTED);
    assert_eq!(state.mailboxes.drain(&owner).await.expect("readable"), vec![wire]);
}
