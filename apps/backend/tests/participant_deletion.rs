// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Deleting a provisioned participant must leave nothing behind.
//!
//! "Completely, as if they never existed" is a claim about eleven tables, an
//! actor and three in-memory maps — and the failure mode that matters is the
//! partial one. A participant whose registry row is gone but whose channels
//! still sit in `channels` is invisible in the UI while still resolvable over
//! gRPC by channel id, and comes back into the pool count on the next restart.
//!
//! So these tests seed a row in *every* table keyed by `actor_id`, not just the
//! ones provisioning happens to populate, and assert the lot is gone. A new
//! actor-scoped table added without being added to the deletion list fails the
//! last test here rather than shipping as a leak.
//!
//! Driven through the real `build_router` with `tower::ServiceExt::oneshot`,
//! following `config_route.rs`.

use std::sync::Arc;

use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use derec_backend::infrastructure::bootstrap::Node;
use serde_json::{json, Value};
use tower::ServiceExt;

/// Every table keyed by `actor_id`, with a minimal valid row for each.
///
/// Kept here rather than imported from the deletion module on purpose: this is
/// the independent statement of what "everything" means, so a table dropped
/// from the production list still fails a test.
fn seed_rows(actor: &str) -> Vec<(&'static str, String)> {
    vec![
        (
            "channels",
            format!(
                "INSERT INTO channels (actor_id, secret_id, kind, entity_id, channel_id, record) \
             VALUES ('{actor}', '1', 'helper', 'e1', 'c1', '{{}}')"
            ),
        ),
        (
            "channel_links",
            format!(
                "INSERT INTO channel_links (actor_id, secret_id, channel_id, linked_id) \
             VALUES ('{actor}', '1', 'c1', 'c2')"
            ),
        ),
        (
            "secrets",
            format!(
                "INSERT INTO secrets (actor_id, secret_id, channel_id, kind, value) \
             VALUES ('{actor}', '1', 'c1', 'shared_key', 'v')"
            ),
        ),
        (
            "user_secrets",
            format!(
                "INSERT INTO user_secrets (actor_id, secret_id, payload) \
             VALUES ('{actor}', '1', 'p')"
            ),
        ),
        (
            "shares",
            format!(
            "INSERT INTO shares (actor_id, secret_id, channel_id, version, share_secret_id, bytes) \
             VALUES ('{actor}', '1', 'c1', 1, '9', 'b')"),
        ),
        (
            "sharing_rounds",
            format!(
                "INSERT INTO sharing_rounds (actor_id, secret_id, version, committed) \
             VALUES ('{actor}', '1', 1, 1)"
            ),
        ),
        (
            "state_items",
            format!(
                "INSERT INTO state_items (actor_id, secret_id, state_key, kind, item) \
             VALUES ('{actor}', '1', 'k', 'kind', 'i')"
            ),
        ),
        (
            "actor_channels",
            format!("INSERT INTO actor_channels (actor_id, channel_id) VALUES ('{actor}', 'c1')"),
        ),
        (
            "disabled_helpers",
            format!("INSERT INTO disabled_helpers (actor_id) VALUES ('{actor}')"),
        ),
        (
            "participant_contacts",
            format!("INSERT INTO participant_contacts (actor_id, contact) VALUES ('{actor}', 'c')"),
        ),
        (
            "mailbox",
            format!("INSERT INTO mailbox (actor_id, seq, payload) VALUES ('{actor}', 1, 'p')"),
        ),
    ]
}

async fn send(router: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(request)
        .await
        .expect("router is infallible");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body readable");
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    // Success answers travel in the envelope; these tests read its result.
    let body = match body {
        Value::Object(mut fields) if fields.contains_key("result") => {
            fields.remove("result").unwrap_or(Value::Null)
        }
        other => other,
    };
    (status, body)
}

/// Provision one helper and return its id.
async fn provision(router: &Router, name: &str) -> String {
    let (status, body) = send(
        router,
        Request::post("/api/v1/helpers")
            .header("content-type", "application/json")
            .body(Body::from(json!({ "name": name }).to_string()))
            .expect("request builds"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "provisioning failed: {body}");
    body["id"]
        .as_str()
        .unwrap_or_else(|| panic!("no id in {body}"))
        .to_owned()
}

async fn row_count(state: &Arc<Node>, table: &str, actor: &str) -> i64 {
    let sql = format!("SELECT COUNT(*) FROM {table} WHERE actor_id = '{actor}'");
    sqlx::query_scalar(&sql)
        .fetch_one(&state.pool)
        .await
        .unwrap_or_else(|e| panic!("counting {table}: {e}"))
}

// `actix_rt::test`, not `tokio::test`: provisioning spawns an actix actor, and
// `test_support::node()` needs an arbiter to spawn it on.
#[actix_rt::test]
async fn deleting_a_participant_removes_it_from_the_roster() {
    let state = derec_backend::infrastructure::test_support::node().await;
    let router = derec_backend::infrastructure::server::build_router(state.state.clone());

    let helper_id = provision(&router, "Alex").await;

    let (_, before) = send(
        &router,
        Request::get("/api/v1/actors").body(Body::empty()).unwrap(),
    )
    .await;
    assert!(
        before["actors"]
            .as_array()
            .is_some_and(|a| a.iter().any(|x| x["id"] == helper_id.as_str())),
        "provisioned helper should be listed first: {before}"
    );

    let (status, _) = send(
        &router,
        Request::delete(format!("/api/v1/helpers/{helper_id}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (_, after) = send(
        &router,
        Request::get("/api/v1/actors").body(Body::empty()).unwrap(),
    )
    .await;
    assert!(
        after["actors"]
            .as_array()
            .is_some_and(|a| a.iter().all(|x| x["id"] != helper_id.as_str())),
        "deleted helper is still listed: {after}"
    );
}

#[actix_rt::test]
async fn deleting_a_participant_erases_every_actor_scoped_table() {
    let state = derec_backend::infrastructure::test_support::node().await;
    let router = derec_backend::infrastructure::server::build_router(state.state.clone());

    let helper_id = provision(&router, "Alex").await;

    // Seed every table, so this covers the ones a bare provisioning never
    // touches — those are exactly the ones a deletion is likely to forget.
    for (table, sql) in seed_rows(&helper_id) {
        sqlx::query(&sql)
            .execute(&state.pool)
            .await
            .unwrap_or_else(|e| panic!("seeding {table}: {e}"));
    }

    let (status, _) = send(
        &router,
        Request::delete(format!("/api/v1/helpers/{helper_id}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    for (table, _) in seed_rows(&helper_id) {
        assert_eq!(
            row_count(&state, table, &helper_id).await,
            0,
            "{table} still holds rows for the deleted participant"
        );
    }
    assert_eq!(
        row_count(&state, "actors", &helper_id).await,
        0,
        "the registry row survived"
    );
}

#[actix_rt::test]
async fn deleting_a_participant_drops_its_live_handles() {
    let state = derec_backend::infrastructure::test_support::node().await;
    let router = derec_backend::infrastructure::server::build_router(state.state.clone());

    let helper_id = provision(&router, "Alex").await;
    let uuid: uuid::Uuid = helper_id.parse().expect("helper id is a uuid");
    assert!(
        state.inboxes.contains(&uuid),
        "a provisioned helper should have an inbox"
    );

    send(
        &router,
        Request::delete(format!("/api/v1/helpers/{helper_id}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;

    // Without this, messages keep being routed to an actor whose data is gone.
    assert!(
        !state.inboxes.contains(&uuid),
        "the inbox outlived the participant"
    );
    assert!(
        state.helper_channels.get(&uuid).is_none(),
        "the channel index outlived the participant"
    );
}

#[actix_rt::test]
async fn deleting_an_unknown_participant_is_not_found() {
    let router = derec_backend::infrastructure::server::build_router(
        derec_backend::infrastructure::test_support::node()
            .await
            .state
            .clone(),
    );
    let unknown = uuid::Uuid::new_v4();

    let (status, _) = send(
        &router,
        Request::delete(format!("/api/v1/helpers/{unknown}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[actix_rt::test]
async fn deleting_the_same_participant_twice_is_not_found_the_second_time() {
    let router = derec_backend::infrastructure::server::build_router(
        derec_backend::infrastructure::test_support::node()
            .await
            .state
            .clone(),
    );
    let helper_id = provision(&router, "Alex").await;

    let path = format!("/api/v1/helpers/{helper_id}");
    let (first, _) = send(&router, Request::delete(&path).body(Body::empty()).unwrap()).await;
    let (second, _) = send(&router, Request::delete(&path).body(Body::empty()).unwrap()).await;

    assert_eq!(first, StatusCode::NO_CONTENT);
    // Not an error state worth special-casing, but it must not report success
    // for something it did not do.
    assert_eq!(second, StatusCode::NOT_FOUND);
}
