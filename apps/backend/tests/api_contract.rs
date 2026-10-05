// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The HTTP contract a client — or an agent reading `openapi.yaml` — relies on:
//! one error shape everywhere, the status each refusal is documented with, and
//! request validation at the boundary.
//!
//! Driven through the real `build_router` with `tower::ServiceExt::oneshot`,
//! following `participant_deletion.rs`.

use std::sync::Arc;

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
    Router,
};
use derec_backend::state::AppState;
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

async fn app() -> (Arc<AppState>, Router) {
    let state = derec_backend::test_support::app_state().await;
    let router = derec_backend::build_router(state.clone());
    (state, router)
}

/// Send a request; answer the status, the `Content-Type`, and the body parsed
/// as JSON (`Null` when it is not JSON).
async fn send(router: &Router, request: Request<Body>) -> (StatusCode, String, Value) {
    let response = router
        .clone()
        .oneshot(request)
        .await
        .expect("router is infallible");
    let status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body readable");
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, content_type, body)
}

fn post_json(uri: &str, body: &str) -> Request<Body> {
    Request::post(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_owned()))
        .expect("request builds")
}

/// The shared error shape: a JSON object whose `error` is a sentence that
/// names no Rust type.
fn assert_error_shape(content_type: &str, body: &Value) {
    assert!(
        content_type.starts_with("application/json"),
        "errors must be JSON, got `{content_type}`"
    );
    let message = body["error"]
        .as_str()
        .unwrap_or_else(|| panic!("no `error` string in {body}"));
    for leak in [
        "Request",
        "Dto",
        "struct ",
        "UUID parsing failed",
        "Failed to deserialize",
    ] {
        assert!(
            !message.contains(leak),
            "the message leaks an implementation detail (`{leak}`): {message}"
        );
    }
}

async fn provision(router: &Router, body: Value) -> String {
    let (status, _, body) = send(router, post_json("/helpers", &body.to_string())).await;
    assert_eq!(status, StatusCode::CREATED, "provisioning failed: {body}");
    body["id"].as_str().expect("id present").to_owned()
}

async fn register_owner(router: &Router, name: &str) -> String {
    let (status, _, body) = send(
        router,
        post_json("/owners", &json!({ "name": name }).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "registering failed: {body}");
    body["id"].as_str().expect("id present").to_owned()
}

// ── Extractor rejections ────────────────────────────────────────────────────

#[actix_rt::test]
async fn a_body_of_the_wrong_shape_is_422_in_the_shared_shape() {
    let (_, router) = app().await;

    let (status, content_type, body) = send(&router, post_json("/helpers", "[]")).await;

    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_error_shape(&content_type, &body);
}

#[actix_rt::test]
async fn a_body_that_is_not_json_is_400_in_the_shared_shape() {
    let (_, router) = app().await;

    let (status, content_type, body) = send(&router, post_json("/helpers", "{nope")).await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_error_shape(&content_type, &body);
}

#[actix_rt::test]
async fn a_missing_content_type_is_415_in_the_shared_shape() {
    let (_, router) = app().await;

    let request = Request::post("/helpers")
        .body(Body::from(r#"{"name":"Alex"}"#))
        .expect("request builds");
    let (status, content_type, body) = send(&router, request).await;

    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_error_shape(&content_type, &body);
}

#[actix_rt::test]
async fn a_path_id_that_is_not_a_uuid_is_400_in_the_shared_shape() {
    let (_, router) = app().await;

    let request = Request::delete("/helpers/not-a-uuid")
        .body(Body::empty())
        .expect("request builds");
    let (status, content_type, body) = send(&router, request).await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_error_shape(&content_type, &body);
}

#[actix_rt::test]
async fn a_body_over_the_limit_is_413_in_the_shared_shape() {
    let (_, router) = app().await;
    // Axum's default body limit is 2 MiB.
    let oversized = format!(r#"{{"name":"{}"}}"#, "x".repeat(3 * 1024 * 1024));

    let (status, content_type, body) = send(&router, post_json("/owners", &oversized)).await;

    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_error_shape(&content_type, &body);
}

// ── Name and settings validation ────────────────────────────────────────────

#[actix_rt::test]
async fn owner_and_helper_names_are_trimmed_required_and_bounded() {
    let (_, router) = app().await;

    for (uri, name) in [
        ("/owners", "".to_owned()),
        ("/owners", "   ".to_owned()),
        ("/owners", "x".repeat(65)),
        ("/helpers", "".to_owned()),
        ("/helpers", "x".repeat(65)),
    ] {
        let (status, content_type, body) = send(
            &router,
            post_json(uri, &json!({ "name": name }).to_string()),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{uri} accepted {:?}",
            name.len()
        );
        assert_error_shape(&content_type, &body);
    }

    let (status, _, body) = send(
        &router,
        post_json("/owners", &json!({ "name": "  Alice  " }).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["name"], "Alice", "names are stored trimmed");
}

#[actix_rt::test]
async fn a_zero_protocol_timeout_is_refused() {
    // As a replay window, zero refuses every inbound message: an actor that
    // pairs with nothing and never says why.
    let (_, router) = app().await;

    for (uri, body) in [
        (
            "/helpers",
            json!({ "name": "Alex", "protocol_timeout_secs": 0 }),
        ),
        (
            "/helpers/ensure",
            json!({ "total": 1, "protocol_timeout_secs": 0 }),
        ),
    ] {
        let (status, content_type, body) = send(&router, post_json(uri, &body.to_string())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
        assert_error_shape(&content_type, &body);
    }
}

// ── Mailboxes ───────────────────────────────────────────────────────────────

#[actix_rt::test]
async fn polling_an_unknown_actors_mailbox_is_404() {
    let (_, router) = app().await;

    let request = Request::get(format!("/derec/{}/mailbox", Uuid::new_v4()))
        .body(Body::empty())
        .expect("request builds");
    let (status, content_type, body) = send(&router, request).await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_error_shape(&content_type, &body);
}

#[actix_rt::test]
async fn claiming_an_owner_keeps_the_mail_that_queued_for_it() {
    // The recovery flow claims an existing owner precisely to receive what its
    // helpers send to the old address. Re-registering used to replace the
    // queue, dropping exactly those messages.
    let (_, router) = app().await;
    let owner = register_owner(&router, "Alice").await;

    let message = vec![0x20, 0x07]; // field 4 (channelId), varint 7
    let request = Request::post(format!("/derec/{owner}"))
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(Body::from(message.clone()))
        .expect("request builds");
    let (status, _, _) = send(&router, request).await;
    assert_eq!(status, StatusCode::ACCEPTED);

    let (status, _, _) = send(
        &router,
        post_json(
            "/owners",
            &json!({ "name": "Alice", "claim_actor_id": owner }).to_string(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let request = Request::get(format!("/derec/{owner}/mailbox"))
        .body(Body::empty())
        .expect("request builds");
    let (status, _, body) = send(&router, request).await;
    assert_eq!(status, StatusCode::OK);
    let messages = body["messages"].as_array().expect("messages array");
    assert_eq!(
        messages.len(),
        1,
        "the queued message must survive the claim: {body}"
    );
}

#[actix_rt::test]
async fn a_full_mailbox_refuses_new_mail_and_keeps_the_old() {
    let (state, router) = app().await;
    let owner: Uuid = register_owner(&router, "Alice")
        .await
        .parse()
        .expect("uuid");

    for _ in 0..derec_backend::registry::mailbox::MAX_QUEUED_MESSAGES {
        state
            .mailboxes
            .enqueue(&owner, &[0x20, 0x07])
            .await
            .expect("within the cap");
    }

    let request = Request::post(format!("/derec/{owner}"))
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(Body::from(vec![0x20, 0x08]))
        .expect("request builds");
    let (status, content_type, body) = send(&router, request).await;

    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_error_shape(&content_type, &body);
    assert_eq!(
        state.mailboxes.len(&owner).await.expect("readable"),
        derec_backend::registry::mailbox::MAX_QUEUED_MESSAGES as usize,
        "nothing already queued may be evicted to make room"
    );
}

// ── Relay ───────────────────────────────────────────────────────────────────

#[actix_rt::test]
async fn relaying_empty_data_is_400_not_502() {
    let (_, router) = app().await;
    // The relay only dials an endpoint some actor advertises; this one does.
    provision(
        &router,
        json!({ "name": "Grace", "transport_mode": "grpc" }),
    )
    .await;
    let uri = "grpc://localhost:50051";

    let (status, content_type, body) = send(
        &router,
        post_json(
            "/derec/relay",
            &json!({ "uri": uri, "data": "" }).to_string(),
        ),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_error_shape(&content_type, &body);
}

// ── Channels a helper does not hold ─────────────────────────────────────────

#[actix_rt::test]
async fn linking_a_channel_the_helper_does_not_hold_is_404() {
    let (_, router) = app().await;
    let helper = provision(&router, json!({ "name": "Alex" })).await;

    let (status, content_type, body) = send(
        &router,
        post_json(
            &format!("/helpers/{helper}/link"),
            &json!({ "channel_id": "1", "link_to_channel_id": "2" }).to_string(),
        ),
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_error_shape(&content_type, &body);
}

#[actix_rt::test]
async fn a_fingerprint_for_a_channel_the_actor_does_not_hold_is_404() {
    let (_, router) = app().await;
    let helper = provision(&router, json!({ "name": "Alex" })).await;

    let request = Request::get(format!("/actors/{helper}/fingerprint?channel_id=12345"))
        .body(Body::empty())
        .expect("request builds");
    let (status, content_type, body) = send(&router, request).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_error_shape(&content_type, &body);

    let (status, content_type, body) = send(
        &router,
        post_json(
            &format!("/actors/{helper}/confirm-fingerprint"),
            &json!({ "channel_id": "12345", "fingerprint": "0000-0000" }).to_string(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_error_shape(&content_type, &body);
}

// ── start-pairing contact validation ────────────────────────────────────────

#[actix_rt::test]
async fn a_contact_naming_no_endpoint_is_400() {
    let (_, router) = app().await;
    let helper = provision(&router, json!({ "name": "Alex" })).await;

    let (status, content_type, body) = send(
        &router,
        post_json(
            &format!("/actors/{helper}/start-pairing"),
            &json!({ "channel_id": "1", "nonce": "2" }).to_string(),
        ),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_error_shape(&content_type, &body);
}

#[actix_rt::test]
async fn a_contact_the_sdk_refuses_is_400_not_500() {
    // Inline-keys mode with no keys in it: well-formed JSON, invalid contact.
    let (_, router) = app().await;
    let helper = provision(&router, json!({ "name": "Alex" })).await;

    let contact = json!({
        "channel_id": "1",
        "nonce": "2",
        "contact_mode": 0,
        "supported_transports": [{ "uri": "http://localhost:5000/derec/x", "protocol": "https" }]
    });
    let (status, content_type, body) = send(
        &router,
        post_json(
            &format!("/actors/{helper}/start-pairing"),
            &contact.to_string(),
        ),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_error_shape(&content_type, &body);
}

#[actix_rt::test]
async fn a_failed_start_pairing_leaves_no_route_behind() {
    // The pin is taken before the request goes out, so it must be taken back
    // when the flow does not start — or it lingers, claiming a channel id
    // another actor may own.
    let (state, router) = app().await;
    let helper = provision(
        &router,
        json!({ "name": "Grace", "transport_mode": "grpc" }),
    )
    .await;

    let contact = json!({
        "channel_id": "4242",
        "nonce": "2",
        "contact_mode": 0,
        "supported_transports": [{ "uri": "grpc://localhost:1", "protocol": "grpc" }]
    });
    let (status, _, _) = send(
        &router,
        post_json(
            &format!("/actors/{helper}/start-pairing"),
            &contact.to_string(),
        ),
    )
    .await;

    assert!(!status.is_success(), "a contact with no keys must not pair");
    assert_eq!(state.channel_router.resolve(4242), None);
}

// ── Toggle status ───────────────────────────────────────────────────────────

#[actix_rt::test]
async fn toggle_status_without_a_body_toggles_and_with_one_sets() {
    let (_, router) = app().await;
    let helper = provision(&router, json!({ "name": "Alex" })).await;
    let uri = format!("/helpers/{helper}/toggle-status");

    let bare = Request::post(&uri)
        .body(Body::empty())
        .expect("request builds");
    let (status, _, body) = send(&router, bare).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["disabled"], true, "no body toggles from enabled");

    let (status, _, body) = send(&router, post_json(&uri, r#"{"disabled":true}"#)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["disabled"], true, "a body sets rather than toggles");

    let (status, content_type, body) = send(&router, post_json(&uri, "")).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a JSON content type needs a body"
    );
    assert_error_shape(&content_type, &body);
}

// ── Browser contacts ────────────────────────────────────────────────────────

#[actix_rt::test]
async fn a_browser_contact_round_trips_as_json() {
    let (_, router) = app().await;
    let owner = register_owner(&router, "Bob").await;
    let uri = format!("/helpers/{owner}/browser-contact");

    let missing = Request::get(&uri)
        .body(Body::empty())
        .expect("request builds");
    let (status, content_type, body) = send(&router, missing).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_error_shape(&content_type, &body);

    let (status, _, _) = send(&router, post_json(&uri, "not json")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let contact = json!({ "channel_id": "1", "nonce": "2" });
    let (status, _, _) = send(&router, post_json(&uri, &contact.to_string())).await;
    assert_eq!(status, StatusCode::OK);

    let fetch = Request::get(&uri)
        .body(Body::empty())
        .expect("request builds");
    let (status, content_type, body) = send(&router, fetch).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        content_type.starts_with("application/json"),
        "{content_type}"
    );
    assert_eq!(body, contact);
}

// ── Roster ──────────────────────────────────────────────────────────────────

#[actix_rt::test]
async fn the_roster_prefers_a_paired_channel_over_a_newer_pending_one() {
    // A helper paired with one owner and pending with another used to show
    // whichever the index listed last — which changed across a restart.
    use derec_library::protocol::types::ChannelStatus;
    use derec_library::protocol::{ChannelRecord, DeRecChannelStore, HelperChannel};
    use derec_library::types::ChannelId;

    let (state, router) = app().await;
    let helper = provision(&router, json!({ "name": "Alex" })).await;
    let helper_id: Uuid = helper.parse().expect("uuid");

    let record = |channel_id: u64, status: ChannelStatus, created_at: u64| {
        ChannelRecord::Helper(HelperChannel {
            channel_id: ChannelId(channel_id),
            transports: vec![derec_proto::TransportProtocol {
                uri: "http://localhost:5000/derec/x".to_owned(),
                protocol: derec_proto::Protocol::Https as i32,
            }],
            communication_info: Default::default(),
            peer_role: derec_proto::SenderKind::Owner,
            status,
            created_at,
        })
    };
    let mut store =
        derec_backend::sql::channel::SqlChannelStore::new(state.pool.clone(), helper.clone());
    store
        .save(1, record(100, ChannelStatus::Paired, 10))
        .await
        .expect("save");
    store
        .save(1, record(200, ChannelStatus::Pending, 20))
        .await
        .expect("save");
    // The index in the order that used to pick the pending one.
    state
        .helper_channels
        .insert(helper_id, vec!["100".to_owned(), "200".to_owned()]);

    let request = Request::get("/actors")
        .body(Body::empty())
        .expect("request builds");
    let (_, _, body) = send(&router, request).await;
    let row = body["actors"]
        .as_array()
        .and_then(|a| a.iter().find(|x| x["id"] == helper.as_str()))
        .unwrap_or_else(|| panic!("helper missing from {body}"));

    assert_eq!(row["channel_id"], "100");
}

// ── Owner rename ────────────────────────────────────────────────────────────

fn patch_json(uri: &str, body: &str) -> Request<Body> {
    Request::patch(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_owned()))
        .expect("request builds")
}

async fn roster(router: &Router) -> Vec<Value> {
    let request = Request::get("/actors")
        .body(Body::empty())
        .expect("request builds");
    let (status, _, body) = send(router, request).await;
    assert_eq!(status, StatusCode::OK);
    body["actors"]
        .as_array()
        .expect("actors is an array")
        .clone()
}

fn entry<'a>(roster: &'a [Value], id: &str) -> &'a Value {
    roster
        .iter()
        .find(|a| a["id"] == id)
        .unwrap_or_else(|| panic!("{id} is not in the roster"))
}

#[actix_rt::test]
async fn renaming_an_owner_stores_the_trimmed_name_and_the_roster_and_claim_show_it() {
    let (_, router) = app().await;
    let owner = register_owner(&router, "Alice").await;

    let (status, _, body) = send(
        &router,
        patch_json(
            &format!("/owners/{owner}"),
            &json!({ "name": "  Alicia " }).to_string(),
        ),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({ "id": owner, "name": "Alicia" }));
    assert_eq!(entry(&roster(&router).await, &owner)["name"], "Alicia");

    let (status, _, claimed) = send(
        &router,
        post_json(
            "/owners",
            &json!({ "name": "ignored", "claim_actor_id": owner }).to_string(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        claimed["name"], "Alicia",
        "a claim hands back the stored name"
    );
}

#[actix_rt::test]
async fn renaming_an_actor_that_is_not_an_owner_is_404() {
    let (_, router) = app().await;
    let helper = provision(&router, json!({ "name": "Alex" })).await;

    for id in [helper.clone(), Uuid::new_v4().to_string()] {
        let (status, content_type, body) = send(
            &router,
            patch_json(
                &format!("/owners/{id}"),
                &json!({ "name": "Bob" }).to_string(),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{id}: {body}");
        assert_error_shape(&content_type, &body);
    }

    assert_eq!(
        entry(&roster(&router).await, &helper)["name"],
        "Alex",
        "a helper must not be renamed through the owner route"
    );
}

#[actix_rt::test]
async fn an_invalid_new_owner_name_is_refused_in_the_shared_shape() {
    let (_, router) = app().await;
    let owner = register_owner(&router, "Alice").await;
    let uri = format!("/owners/{owner}");

    for name in [
        "".to_owned(),
        "   ".to_owned(),
        "x".repeat(65),
        "bad\u{7}name".to_owned(),
    ] {
        let (status, content_type, body) = send(
            &router,
            patch_json(&uri, &json!({ "name": name }).to_string()),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "accepted {name:?}");
        assert_error_shape(&content_type, &body);
    }

    let (status, content_type, body) = send(&router, patch_json(&uri, r#"{"nom":"x"}"#)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_error_shape(&content_type, &body);

    assert_eq!(entry(&roster(&router).await, &owner)["name"], "Alice");
}

// ── Mailbox liveness on the roster ──────────────────────────────────────────

#[actix_rt::test]
async fn a_browser_owner_reports_when_it_last_polled_and_a_helper_reports_nothing() {
    let (_, router) = app().await;
    let owner = register_owner(&router, "Alice").await;
    let helper = provision(&router, json!({ "name": "Alex" })).await;

    let before = roster(&router).await;
    assert_eq!(
        entry(&before, &owner).get("last_polled_at"),
        Some(&Value::Null),
        "a browser owner that has not polled carries an explicit null"
    );
    assert_eq!(
        entry(&before, &helper).get("last_polled_at"),
        None,
        "nothing polls on a provisioned helper's behalf"
    );

    let request = Request::get(format!("/derec/{owner}/mailbox"))
        .body(Body::empty())
        .expect("request builds");
    let (status, _, _) = send(&router, request).await;
    assert_eq!(status, StatusCode::OK);

    let after = roster(&router).await;
    let polled = entry(&after, &owner)["last_polled_at"]
        .as_str()
        .expect("a poll leaves a timestamp")
        .to_owned();
    // `YYYY-MM-DDTHH:MM:SS.mmmZ`, and recent: the year is this one's.
    assert_eq!(polled.len(), 24, "{polled}");
    assert!(
        polled.ends_with('Z') && polled.as_bytes()[10] == b'T',
        "{polled}"
    );
    let year: u64 = polled[..4].parse().expect("a numeric year");
    assert!(year >= 2026, "{polled}");
}

// ── Helper names ────────────────────────────────────────────────────────────

#[actix_rt::test]
async fn a_second_helper_with_the_same_name_is_409_and_not_created() {
    let (_, router) = app().await;
    provision(&router, json!({ "name": "Alex" })).await;

    for name in ["Alex", " alex "] {
        let (status, content_type, body) = send(
            &router,
            post_json("/helpers", &json!({ "name": name }).to_string()),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::CONFLICT,
            "{name:?} was accepted: {body}"
        );
        assert_error_shape(&content_type, &body);
        assert!(
            body["error"]
                .as_str()
                .unwrap_or_default()
                .contains("already exists"),
            "{body}"
        );
    }

    let helpers = roster(&router)
        .await
        .into_iter()
        .filter(|a| a["role"] == "helper")
        .count();
    assert_eq!(
        helpers, 1,
        "the refused requests must not have left a helper behind"
    );
}

#[actix_rt::test]
async fn ensure_never_mints_a_name_the_pool_already_has() {
    let (_, router) = app().await;
    provision(&router, json!({ "name": "Alex" })).await;
    provision(&router, json!({ "name": "Participant 3" })).await;

    // Offers a name the pool holds, a duplicate of it, and runs short: the
    // created helpers must take free names only.
    let (status, _, body) = send(
        &router,
        post_json(
            "/helpers/ensure",
            &json!({ "total": 5, "names": ["Alex", "alex", "Richard"] }).to_string(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["created"], 3);

    let mut names: Vec<String> = body["helpers"]
        .as_array()
        .expect("helpers is an array")
        .iter()
        .map(|h| h["name"].as_str().expect("a name").to_lowercase())
        .collect();
    let total = names.len();
    names.sort();
    names.dedup();
    assert_eq!(names.len(), total, "every helper name is unique: {names:?}");
    assert!(names.contains(&"richard".to_owned()), "{names:?}");
}

#[actix_rt::test]
async fn an_ensure_total_past_the_pool_limit_names_the_limit() {
    // It used to surface serde's own sentence, column number and all.
    let (state, router) = app().await;

    let (status, content_type, body) = send(
        &router,
        post_json("/helpers/ensure", &json!({ "total": 300 }).to_string()),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_error_shape(&content_type, &body);
    assert_eq!(body["error"], "total must be at most 255 (got 300)");
    assert!(
        state.actors.all().await.expect("readable").is_empty(),
        "nothing is created"
    );
}
