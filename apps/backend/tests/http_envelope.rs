// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The wire contract every route shares, driven through the assembled router:
//! the `/api/v1` prefix, the success and error envelopes, the request id, the
//! DeRec transport's unchanged success shapes, and how the API and the static
//! UI divide the paths between them.

use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    body::Body,
    http::{header, HeaderMap, Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use derec_backend::infrastructure::bootstrap::Node;
use derec_backend::models::{Defaults, LoadedConfig, NodeConfig};
use prost::Message;
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

// ── Fixtures ────────────────────────────────────────────────────────────────

async fn node_with(defaults: Defaults, loaded: LoadedConfig) -> Arc<Node> {
    let pool = derec_backend::infrastructure::db::connect("sqlite::memory:")
        .await
        .expect("an in-memory database always connects");
    Arc::new(Node::new(
        NodeConfig::new("http://localhost:5000", defaults).with_loaded(loaded),
        reqwest::Client::new(),
        actix_rt::Arbiter::current(),
        pool,
    ))
}

async fn app() -> Router {
    let node = derec_backend::infrastructure::test_support::node().await;
    derec_backend::infrastructure::server::build_router(node.state.clone())
}

struct Answer {
    status: StatusCode,
    headers: HeaderMap,
    bytes: Vec<u8>,
}

impl Answer {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.bytes)
            .unwrap_or_else(|_| panic!("not JSON: {}", String::from_utf8_lossy(&self.bytes)))
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    /// The error envelope's code, after checking the envelope is whole.
    fn error_code(&self) -> String {
        let body = self.json();
        assert!(
            self.header("content-type")
                .is_some_and(|t| t.starts_with("application/json")),
            "errors are JSON"
        );
        assert!(
            body.get("result").is_none(),
            "an error carries no result: {body}"
        );
        assert!(body["error"]["message"].is_string(), "no message: {body}");
        assert_rfc3339(&body["timestamp"]);
        assert_eq!(
            body["request_id"].as_str(),
            self.header("x-request-id"),
            "the body and the header name the same request"
        );
        body["error"]["code"].as_str().expect("a code").to_owned()
    }
}

async fn send(router: &Router, request: Request<Body>) -> Answer {
    let response = router
        .clone()
        .oneshot(request)
        .await
        .expect("router is infallible");
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body readable")
        .to_vec();
    Answer {
        status,
        headers,
        bytes,
    }
}

fn get(uri: &str) -> Request<Body> {
    Request::get(uri)
        .body(Body::empty())
        .expect("request builds")
}

fn post_json(uri: &str, body: &str) -> Request<Body> {
    Request::post(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_owned()))
        .expect("request builds")
}

fn assert_rfc3339(value: &Value) {
    let text = value
        .as_str()
        .unwrap_or_else(|| panic!("no timestamp: {value}"));
    // `2026-10-07T12:00:00.000Z`: UTC, with milliseconds.
    assert_eq!(text.len(), 24, "{text}");
    assert_eq!(&text[4..5], "-", "{text}");
    assert_eq!(&text[10..11], "T", "{text}");
    assert!(text.ends_with('Z'), "{text}");
}

async fn register_owner(router: &Router) -> Uuid {
    let answer = send(router, post_json("/api/v1/owners", r#"{"name":"Alice"}"#)).await;
    assert_eq!(answer.status, StatusCode::CREATED);
    answer.json()["result"]["id"]
        .as_str()
        .and_then(|id| id.parse().ok())
        .expect("an id")
}

// ── Success envelope ────────────────────────────────────────────────────────

#[actix_rt::test]
async fn a_success_carries_result_timestamp_and_request_id() {
    let router = app().await;

    let answer = send(&router, get("/api/v1/config")).await;

    assert_eq!(answer.status, StatusCode::OK);
    let body = answer.json();
    assert_eq!(body["result"]["participant_count"], json!(7));
    assert!(body["result"]["database_ephemeral"].is_boolean());
    assert_rfc3339(&body["timestamp"]);
    let request_id = body["request_id"].as_str().expect("a request id");
    assert!(Uuid::parse_str(request_id).is_ok(), "{request_id}");
    assert_eq!(answer.header("x-request-id"), Some(request_id));
}

#[actix_rt::test]
async fn a_creation_keeps_its_201_inside_the_envelope() {
    let router = app().await;

    let answer = send(&router, post_json("/api/v1/owners", r#"{"name":"Alice"}"#)).await;

    assert_eq!(answer.status, StatusCode::CREATED);
    assert_eq!(answer.json()["result"]["name"], json!("Alice"));
}

#[actix_rt::test]
async fn a_deletion_stays_a_bodyless_204() {
    let router = app().await;
    let created = send(&router, post_json("/api/v1/helpers", r#"{"name":"Alex"}"#)).await;
    let id = created.json()["result"]["id"]
        .as_str()
        .expect("an id")
        .to_owned();

    let answer = send(
        &router,
        Request::delete(format!("/api/v1/helpers/{id}"))
            .body(Body::empty())
            .expect("request builds"),
    )
    .await;

    assert_eq!(answer.status, StatusCode::NO_CONTENT);
    assert!(answer.bytes.is_empty());
}

// ── Request id ──────────────────────────────────────────────────────────────

#[actix_rt::test]
async fn a_callers_request_id_is_echoed_in_the_header_and_the_body() {
    let router = app().await;
    let request = Request::get("/api/v1/actors")
        .header("x-request-id", "trace-42.a_b:c")
        .body(Body::empty())
        .expect("request builds");

    let answer = send(&router, request).await;

    assert_eq!(answer.header("x-request-id"), Some("trace-42.a_b:c"));
    assert_eq!(answer.json()["request_id"], json!("trace-42.a_b:c"));
}

#[actix_rt::test]
async fn an_unusable_request_id_is_replaced_with_a_fresh_uuid() {
    let router = app().await;
    let request = Request::get("/api/v1/actors")
        .header("x-request-id", "not a token")
        .body(Body::empty())
        .expect("request builds");

    let answer = send(&router, request).await;

    let echoed = answer.header("x-request-id").expect("an id is always sent");
    assert!(Uuid::parse_str(echoed).is_ok(), "{echoed}");
}

#[actix_rt::test]
async fn every_request_gets_its_own_id() {
    let router = app().await;

    let first = send(&router, get("/health")).await;
    let second = send(&router, get("/health")).await;

    assert_ne!(first.header("x-request-id"), second.header("x-request-id"));
}

#[actix_rt::test]
async fn an_error_names_the_callers_request_id() {
    let router = app().await;
    let request = Request::get("/api/v1/no/such/route")
        .header("x-request-id", "abc-123")
        .body(Body::empty())
        .expect("request builds");

    let answer = send(&router, request).await;

    assert_eq!(answer.json()["request_id"], json!("abc-123"));
}

#[actix_rt::test]
async fn a_cross_origin_page_may_read_the_request_id() {
    let router = app().await;
    let request = Request::get("/api/v1/config")
        .header(header::ORIGIN, "http://elsewhere.example")
        .body(Body::empty())
        .expect("request builds");

    let answer = send(&router, request).await;

    let exposed = answer
        .header("access-control-expose-headers")
        .expect("headers are exposed");
    assert!(
        exposed.to_ascii_lowercase().contains("x-request-id"),
        "{exposed}"
    );
}

// ── Error envelope, one family at a time ────────────────────────────────────

#[actix_rt::test]
async fn an_id_that_is_not_a_uuid_is_bad_request() {
    let answer = send(&app().await, get("/api/v1/helpers/not-a-uuid/channels")).await;

    assert_eq!(answer.status, StatusCode::BAD_REQUEST);
    assert_eq!(answer.error_code(), "BAD_REQUEST");
}

#[actix_rt::test]
async fn an_unknown_actor_is_not_found() {
    let uri = format!("/api/v1/helpers/{}/channels", Uuid::new_v4());

    let answer = send(&app().await, get(&uri)).await;

    assert_eq!(answer.status, StatusCode::NOT_FOUND);
    assert_eq!(answer.error_code(), "NOT_FOUND");
}

#[actix_rt::test]
async fn a_taken_helper_name_is_a_conflict_with_its_own_code() {
    let router = app().await;
    send(&router, post_json("/api/v1/helpers", r#"{"name":"Alex"}"#)).await;

    let answer = send(&router, post_json("/api/v1/helpers", r#"{"name":"Alex"}"#)).await;

    assert_eq!(answer.status, StatusCode::CONFLICT);
    assert_eq!(answer.error_code(), "NAME_TAKEN");
}

#[actix_rt::test]
async fn a_body_of_the_wrong_shape_is_unprocessable() {
    let answer = send(&app().await, post_json("/api/v1/helpers", "[]")).await;

    assert_eq!(answer.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(answer.error_code(), "UNPROCESSABLE_ENTITY");
}

#[actix_rt::test]
async fn a_body_without_a_json_content_type_is_unsupported() {
    let request = Request::post("/api/v1/owners")
        .body(Body::from(r#"{"name":"Alice"}"#))
        .expect("request builds");

    let answer = send(&app().await, request).await;

    assert_eq!(answer.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(answer.error_code(), "UNSUPPORTED_MEDIA_TYPE");
}

#[actix_rt::test]
async fn a_body_over_the_limit_is_too_large() {
    let oversized = format!(r#"{{"name":"{}"}}"#, "x".repeat(3 * 1024 * 1024));

    let answer = send(&app().await, post_json("/api/v1/owners", &oversized)).await;

    assert_eq!(answer.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(answer.error_code(), "PAYLOAD_TOO_LARGE");
}

#[actix_rt::test]
async fn relaying_to_a_node_not_on_the_allowlist_is_forbidden() {
    let data = URL_SAFE_NO_PAD.encode(envelope(5));
    let body = json!({ "uri": "grpc://192.168.0.30:50051", "data": data }).to_string();

    let answer = send(&app().await, post_json("/derec/relay", &body)).await;

    assert_eq!(answer.status, StatusCode::FORBIDDEN);
    assert_eq!(answer.error_code(), "FORBIDDEN");
}

#[actix_rt::test]
async fn a_switched_off_relay_is_unavailable_with_its_own_code() {
    let node = node_with(
        Defaults {
            grpc_relay_enabled: false,
            ..Defaults::default()
        },
        LoadedConfig::default(),
    )
    .await;
    let router = derec_backend::infrastructure::server::build_router(node.state.clone());
    let data = URL_SAFE_NO_PAD.encode(envelope(5));
    let body = json!({ "uri": "grpc://localhost:50051", "data": data }).to_string();

    let answer = send(&router, post_json("/derec/relay", &body)).await;

    assert_eq!(answer.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(answer.error_code(), "RELAY_DISABLED");
}

// ── Fallbacks ───────────────────────────────────────────────────────────────

#[actix_rt::test]
async fn an_unknown_api_path_is_a_json_not_found() {
    let answer = send(&app().await, get("/api/v1/no/such/route")).await;

    assert_eq!(answer.status, StatusCode::NOT_FOUND);
    assert_eq!(answer.error_code(), "NOT_FOUND");
}

#[actix_rt::test]
async fn a_wrong_method_on_an_api_path_is_a_json_405_that_still_says_what_is_allowed() {
    let request = Request::delete("/api/v1/actors")
        .body(Body::empty())
        .expect("request builds");

    let answer = send(&app().await, request).await;

    assert_eq!(answer.status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(answer.error_code(), "METHOD_NOT_ALLOWED");
    assert!(answer
        .header("allow")
        .is_some_and(|allow| allow.contains("GET")));
}

#[actix_rt::test]
async fn the_api_is_only_served_under_its_prefix() {
    let answer = send(&app().await, get("/actors")).await;

    assert_eq!(answer.status, StatusCode::NOT_FOUND);
    assert_eq!(answer.error_code(), "NOT_FOUND");
}

// ── The DeRec transport and the health probe ────────────────────────────────

#[actix_rt::test]
async fn the_health_probe_stays_an_empty_200() {
    let answer = send(&app().await, get("/health")).await;

    assert_eq!(answer.status, StatusCode::OK);
    assert!(answer.bytes.is_empty());
}

#[actix_rt::test]
async fn a_delivered_message_is_an_empty_202_and_the_mailbox_keeps_its_own_shape() {
    let router = app().await;
    let owner = register_owner(&router).await;
    let wire = envelope(9);

    let delivered = send(
        &router,
        Request::post(format!("/derec/{owner}"))
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .body(Body::from(wire.clone()))
            .expect("request builds"),
    )
    .await;
    assert_eq!(delivered.status, StatusCode::ACCEPTED);
    assert!(delivered.bytes.is_empty());

    let polled = send(&router, get(&format!("/derec/{owner}/mailbox"))).await;

    assert_eq!(polled.status, StatusCode::OK);
    let expected = json!({ "messages": [{ "data": URL_SAFE_NO_PAD.encode(&wire) }] });
    assert_eq!(
        polled.bytes,
        serde_json::to_vec(&expected).expect("serializes")
    );
}

#[actix_rt::test]
async fn a_relayed_message_is_an_empty_202() {
    let router = app().await;
    let owner = register_owner(&router).await;
    let data = URL_SAFE_NO_PAD.encode(envelope(9));
    let body = json!({ "uri": format!("http://localhost:5000/derec/{owner}"), "data": data });

    let answer = send(&router, post_json("/derec/relay", &body.to_string())).await;

    assert_eq!(answer.status, StatusCode::ACCEPTED);
    assert!(answer.bytes.is_empty());
}

#[actix_rt::test]
async fn a_transport_refusal_uses_the_error_envelope() {
    let uri = format!("/derec/{}/mailbox", Uuid::new_v4());

    let answer = send(&app().await, get(&uri)).await;

    assert_eq!(answer.status, StatusCode::NOT_FOUND);
    assert_eq!(answer.error_code(), "NOT_FOUND");
}

// ── Alongside the static UI ─────────────────────────────────────────────────

fn static_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("derec-envelope-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("create static dir");
    std::fs::write(
        dir.join("index.html"),
        "<!doctype html><title>DeRec</title>",
    )
    .expect("write index.html");
    dir
}

#[actix_rt::test]
async fn with_a_static_ui_the_page_is_served_and_the_api_namespace_still_answers_json() {
    let dir = static_dir();
    let mut loaded = LoadedConfig::default();
    loaded.settings.server.static_dir = dir.to_string_lossy().into_owned();
    let node = node_with(Defaults::default(), loaded).await;
    let router = derec_backend::infrastructure::server::build_router(node.state.clone());

    let page = send(&router, get("/")).await;
    assert_eq!(page.status, StatusCode::OK);
    assert!(page
        .header("content-type")
        .is_some_and(|t| t.starts_with("text/html")));

    let missing = send(&router, get("/api/v1/no/such/route")).await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert_eq!(missing.error_code(), "NOT_FOUND");

    let wrong_method = send(
        &router,
        Request::delete("/api/v1/actors")
            .body(Body::empty())
            .expect("request builds"),
    )
    .await;
    assert_eq!(wrong_method.status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(wrong_method.error_code(), "METHOD_NOT_ALLOWED");

    let _ = std::fs::remove_dir_all(&dir);
}

/// A DeRec envelope on `channel_id` with a few bytes of payload.
fn envelope(channel_id: u64) -> Vec<u8> {
    derec_proto::DeRecMessage {
        channel_id,
        message: vec![7u8; 4],
        ..Default::default()
    }
    .encode_to_vec()
}
