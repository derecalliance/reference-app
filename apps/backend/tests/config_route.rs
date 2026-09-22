//! `/debug/config` reports what the node was configured with and where each
//! value came from. `/config` must keep its existing shape — the front end
//! deserialises it directly, so widening it would be an API break for every
//! consumer in exchange for data only a debugging view wants.
//!
//! Follows the `replica_contact_route.rs` pattern: the real
//! `derec_backend::build_router` driven through `tower::ServiceExt::oneshot`.

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use serde_json::Value;
use tower::ServiceExt;

fn app() -> Router {
    derec_backend::build_router(derec_backend::test_support::app_state())
}

async fn get(router: &Router, path: &str) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(
            Request::get(path)
                .body(Body::empty())
                .expect("request builds"),
        )
        .await
        .expect("router is infallible");

    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body readable");

    (status, serde_json::from_slice(&bytes).expect("body is JSON"))
}

// `actix_rt::test`, not `tokio::test`: `test_support::app_state()` needs a
// running arbiter, which the plain Tokio runtime does not provide. The other
// route tests use the same attribute for the same reason.
#[actix_rt::test]
async fn debug_config_reports_values_and_origins() {
    let (status, body) = get(&app(), "/debug/config").await;
    assert_eq!(status, StatusCode::OK);

    assert!(body["settings"]["defaults"]["participant_count"].is_number());
    assert!(body["settings"]["server"]["port"].is_number());

    let origins = body["origins"].as_array().expect("origins array");
    assert_eq!(origins.len(), 16, "every setting needs an origin");

    let participant = origins
        .iter()
        .find(|o| o["path"] == "defaults.participant_count")
        .expect("participant_count origin");

    // `test_support::app_state()` loads no file and reads no environment, so
    // everything is a built-in default and no `variable` key is emitted.
    assert_eq!(participant["source"], "default");
    assert!(participant["variable"].is_null());
}

// `actix_rt::test`, not `tokio::test`: `test_support::app_state()` needs a
// running arbiter, which the plain Tokio runtime does not provide. The other
// route tests use the same attribute for the same reason.
#[actix_rt::test]
async fn plain_config_keeps_its_flat_shape() {
    let (status, body) = get(&app(), "/config").await;
    assert_eq!(status, StatusCode::OK);

    // Flat, no nesting, no provenance — the front end reads these keys directly.
    assert!(body["participant_count"].is_number());
    assert!(body["settings"].is_null());
    assert!(body["origins"].is_null());
}
