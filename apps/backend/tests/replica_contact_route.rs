// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! HTTP-level coverage for the `replica_for_owner_secret` query parameter on
//! `POST /actors/{actor_id}/contact`.
//!
//! `replica_contact.rs` exercises `CreateContactMsg` / `EnsureReplicaInstanceMsg`
//! by sending them straight to the actor, which never touches
//! `routes::actors::create_contact` — none of the query parsing, the
//! conditional `EnsureReplicaInstanceMsg` dispatch, or the 400 rejection path
//! that this task actually adds is covered by those tests. These tests drive
//! the real `derec_backend::build_router` through `tower::ServiceExt::oneshot`
//! instead, so a regression back to a hardcoded `replica_for_owner_secret: None`
//! in the handler — precisely the bug this task exists to fix — would fail
//! `cargo test`.

use std::sync::Arc;

use actix::prelude::*;
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use derec_backend::actor::{InstanceForChannelMsg, ListInstanceSecretsMsg, ProvisionedActor};
use derec_backend::state::{ActorInbox, AppState};
use serde_json::Value;
use tower::ServiceExt;
use uuid::Uuid;

/// An owner secret distinct from any actor's own (randomly assigned) secret,
/// mirroring the constant used in `replica_contact.rs`.
const ALICE_SECRET: u64 = 0x7F;

async fn app() -> (Arc<AppState>, Router) {
    let state = derec_backend::test_support::app_state().await;
    let router = derec_backend::build_router(state.clone());
    (state, router)
}

async fn body_json(response: axum::response::Response) -> Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body readable");
    serde_json::from_slice(&bytes).expect("response body is JSON")
}

/// Provision a helper through the real route and return its actor id and its
/// own `secret_id`.
async fn create_helper(router: &Router) -> (Uuid, u64) {
    create_helper_from(router, r#"{"name":"Alex"}"#).await
}

/// As [`create_helper`], advertising gRPC — the only transport whose ingress
/// routes by channel id, and so the only one a contact is pinned for.
async fn create_grpc_helper(router: &Router) -> (Uuid, u64) {
    create_helper_from(router, r#"{"name":"Grace","transport_mode":"grpc"}"#).await
}

async fn create_helper_from(router: &Router, body: &'static str) -> (Uuid, u64) {
    let response = router
        .clone()
        .oneshot(
            Request::post("/helpers")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .expect("request builds"),
        )
        .await
        .expect("router is infallible");

    assert_eq!(response.status(), StatusCode::CREATED);

    let body = body_json(response).await;
    let actor_id: Uuid = body["id"]
        .as_str()
        .expect("id present")
        .parse()
        .expect("id is a uuid");
    let secret_id: u64 = body["secret_id"]
        .as_str()
        .expect("secret_id present")
        .parse()
        .expect("secret_id is a u64");

    (actor_id, secret_id)
}

/// The same routing-index lookup an inbound envelope goes through, used here
/// purely as a read-only assertion on which instance a route-minted contact
/// actually landed in. Carries no key material.
fn provisioned_addr(state: &AppState, actor_id: Uuid) -> Addr<ProvisionedActor> {
    match state
        .actor_inboxes
        .get(&actor_id)
        .expect("actor registered")
        .value()
    {
        ActorInbox::Provisioned(addr) => addr.clone(),
        ActorInbox::Browser => panic!("expected a provisioned actor"),
    }
}

async fn post_contact(router: &Router, actor_id: Uuid, query: &str) -> axum::response::Response {
    router
        .clone()
        .oneshot(
            Request::post(format!("/actors/{actor_id}/contact?{query}"))
                .body(Body::empty())
                .expect("request builds"),
        )
        .await
        .expect("router is infallible")
}

#[actix_rt::test]
async fn a_valid_replica_for_owner_secret_mints_from_the_replica_instance() {
    let (state, router) = app().await;
    let (actor_id, _own_secret) = create_helper(&router).await;

    let response = post_contact(
        &router,
        actor_id,
        &format!("contact_mode=inline_keys&replica_for_owner_secret={ALICE_SECRET}"),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    let channel_id: u64 = body["channel_id"]
        .as_str()
        .expect("channel_id present")
        .parse()
        .expect("channel_id is a u64");

    let addr = provisioned_addr(&state, actor_id);
    let owner = addr
        .send(InstanceForChannelMsg { channel_id })
        .await
        .expect("actor alive");

    assert_eq!(
        owner,
        Some(ALICE_SECRET),
        "a contact minted with replica_for_owner_secret set must route to the \
         replica instance, not the helper's own"
    );
}

#[actix_rt::test]
async fn no_replica_for_owner_secret_still_mints_from_the_own_instance() {
    let (state, router) = app().await;
    let (actor_id, own_secret) = create_helper(&router).await;

    let response = post_contact(&router, actor_id, "contact_mode=inline_keys").await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    let channel_id: u64 = body["channel_id"]
        .as_str()
        .expect("channel_id present")
        .parse()
        .expect("channel_id is a u64");

    let addr = provisioned_addr(&state, actor_id);
    let owner = addr
        .send(InstanceForChannelMsg { channel_id })
        .await
        .expect("actor alive");
    assert_eq!(owner, Some(own_secret));

    let secrets = addr.send(ListInstanceSecretsMsg).await.expect("actor alive");
    assert_eq!(
        secrets,
        vec![own_secret],
        "an ordinary contact request through the route must not create a \
         second instance"
    );
}

#[actix_rt::test]
async fn a_malformed_replica_for_owner_secret_is_rejected() {
    let (_state, router) = app().await;
    let (actor_id, _own_secret) = create_helper(&router).await;

    let response = post_contact(
        &router,
        actor_id,
        "contact_mode=inline_keys&replica_for_owner_secret=abc",
    )
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[actix_rt::test]
async fn minting_a_contact_pins_its_channel_for_grpc_ingress() {
    // gRPC has no path to carry an actor id, so the first inbound message on a
    // freshly minted contact can only be routed by its channel id — and no
    // channel store has seen that id yet.
    let (state, router) = app().await;
    let (actor_id, _own_secret) = create_grpc_helper(&router).await;

    let response = post_contact(&router, actor_id, "contact_mode=inline_keys").await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    let channel_id: u64 = body["channel_id"]
        .as_str()
        .expect("channel_id present")
        .parse()
        .expect("decimal channel id");

    assert_eq!(
        state.channel_router.resolve(channel_id),
        Some(actor_id),
        "a minted contact must be routable before any store knows it"
    );
}

#[actix_rt::test]
async fn an_empty_replica_for_owner_secret_is_rejected_not_treated_as_absent() {
    // A client that builds `?replica_for_owner_secret=${ownerSecret}` with an
    // unpopulated value sends an empty string. Treating that as "absent"
    // would silently mint an ordinary helper contact instead of a replica
    // one — the pairing quietly becomes the wrong kind. It must be rejected
    // the same way any other malformed value is.
    let (_state, router) = app().await;
    let (actor_id, _own_secret) = create_helper(&router).await;

    let response = post_contact(
        &router,
        actor_id,
        "contact_mode=inline_keys&replica_for_owner_secret=",
    )
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[actix_rt::test]
async fn an_http_only_helpers_contact_takes_no_grpc_route() {
    // HTTP carries the actor in its path, so a pin for an actor nothing can
    // reach over gRPC would only be an unauthenticated caller growing a map.
    let (state, router) = app().await;
    let (actor_id, _own_secret) = create_helper(&router).await;

    let response = post_contact(&router, actor_id, "contact_mode=inline_keys").await;

    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        state.channel_router.routes().is_empty(),
        "an HTTP-only helper's contact must not be pinned"
    );
}

#[actix_rt::test]
async fn a_zero_or_own_replica_for_owner_secret_is_rejected() {
    // Zero is the proto3 default — a field the caller forgot to fill — and
    // the actor's own secret is not a replica of anything.
    let (_state, router) = app().await;
    let (actor_id, own_secret) = create_helper(&router).await;

    for value in ["0".to_owned(), own_secret.to_string()] {
        let response = post_contact(
            &router,
            actor_id,
            &format!("contact_mode=inline_keys&replica_for_owner_secret={value}"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "value {value}");
    }
}

#[actix_rt::test]
async fn replica_instances_per_actor_are_capped() {
    // Each distinct secret creates a persistent instance, and the route is
    // unauthenticated — so a loop over secret ids must hit a limit.
    let (_state, router) = app().await;
    let (actor_id, _own_secret) = create_helper(&router).await;

    for secret in 1..=derec_backend::actor::MAX_REPLICA_INSTANCES as u64 {
        let response = post_contact(
            &router,
            actor_id,
            &format!("contact_mode=inline_keys&replica_for_owner_secret={}", 0x1000 + secret),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK, "secret {secret} is within the cap");
    }

    let response = post_contact(
        &router,
        actor_id,
        "contact_mode=inline_keys&replica_for_owner_secret=999999",
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = body_json(response).await;
    assert!(body["error"].is_string(), "the refusal uses the shared error shape: {body}");
}
