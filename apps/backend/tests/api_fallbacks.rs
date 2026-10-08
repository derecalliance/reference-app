// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! What no route handles still answers in the API's error envelope.
//!
//! These depend on `build_router` registering
//! `handlers::errors::route_not_found` as its fallbacks and
//! `handlers::errors::method_not_allowed` as its method-not-allowed fallbacks;
//! without them Axum answers both with an empty body.

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
};
use serde_json::Value;
use tower::ServiceExt;

async fn send(request: Request<Body>) -> (StatusCode, Option<String>, Value) {
    let router = derec_backend::infrastructure::server::build_router(
        derec_backend::infrastructure::test_support::node()
            .await
            .state
            .clone(),
    );
    let response = router.oneshot(request).await.expect("router is infallible");
    let status = response.status();
    let allow = response
        .headers()
        .get(header::ALLOW)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body readable");
    (
        status,
        allow,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[actix_rt::test]
async fn an_unknown_path_is_404_in_the_shared_shape() {
    let (status, _, body) = send(
        Request::get("/no/such/route")
            .body(Body::empty())
            .expect("request builds"),
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(
        body["error"]["code"].is_string() && body["error"]["message"].is_string(),
        "expected the shared error shape, got {body}"
    );
}

#[actix_rt::test]
async fn a_wrong_method_is_405_in_the_shared_shape_and_still_says_what_is_allowed() {
    let (status, allow, body) = send(
        Request::delete("/api/v1/actors")
            .body(Body::empty())
            .expect("request builds"),
    )
    .await;

    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert!(
        body["error"]["code"].is_string() && body["error"]["message"].is_string(),
        "expected the shared error shape, got {body}"
    );
    assert!(
        allow.is_some_and(|methods| methods.contains("GET")),
        "the Allow header must survive the custom body"
    );
}
