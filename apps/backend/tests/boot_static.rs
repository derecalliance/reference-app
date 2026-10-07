// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The built front end, as the image serves it: from the same origin as the
//! API, with cache headers that fit Vite's hashed file names, compressed, and
//! never in the way of an API route.
//!
//! Drives the real `derec_backend::build_router` with `static_dir` pointed at a
//! throwaway directory, the same way `config_route.rs` drives it with none.

use std::path::PathBuf;
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
    response::Response,
};
use derec_backend::models::{Defaults, LoadedConfig};
use derec_backend::infrastructure::bootstrap::Node;
use tower::ServiceExt;

/// Big enough that the compression layer, which skips tiny bodies, engages.
fn index_html() -> String {
    format!(
        "<!doctype html><html><head><title>DeRec</title></head><body>{}</body></html>",
        "<p>reference app</p>".repeat(200)
    )
}

/// A directory shaped like `npm run build` output: `index.html` at the root,
/// content-hashed bundles under `assets/`.
fn static_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("derec-static-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("assets")).expect("create static dir");
    std::fs::write(dir.join("index.html"), index_html()).expect("write index.html");
    std::fs::write(
        dir.join("assets").join("index-DwvWaRbk.js"),
        "console.log('derec');".repeat(100),
    )
    .expect("write asset");
    dir
}

async fn app(dir: &std::path::Path) -> Router {
    let pool = derec_backend::infrastructure::db::connect("sqlite::memory:")
        .await
        .expect("an in-memory database always connects");

    let mut loaded = LoadedConfig::default();
    loaded.settings.server.static_dir = dir.to_string_lossy().into_owned();

    let state = Node::new(
        derec_backend::models::NodeConfig::new("http://localhost:5000", Defaults::default()).with_loaded(loaded),
        reqwest::Client::new(),
        actix_rt::Arbiter::current(),
        pool,
    );

    derec_backend::infrastructure::server::build_router(state.state.clone())
}

async fn get(router: &Router, path: &str, accept_encoding: Option<&str>) -> Response {
    let mut request = Request::get(path);
    if let Some(encoding) = accept_encoding {
        request = request.header(header::ACCEPT_ENCODING, encoding);
    }
    router
        .clone()
        .oneshot(request.body(Body::empty()).expect("request builds"))
        .await
        .expect("router is infallible")
}

fn cache_control(response: &Response) -> Option<&str> {
    response
        .headers()
        .get(header::CACHE_CONTROL)
        .and_then(|value| value.to_str().ok())
}

// `actix_rt::test`, not `tokio::test`: `Node` needs a running arbiter,
// which the plain Tokio runtime does not provide.
#[actix_rt::test]
async fn index_html_is_revalidated_on_every_load() {
    let dir = static_dir();
    let router = app(&dir).await;

    for path in ["/", "/index.html"] {
        let response = get(&router, path, None).await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        // Otherwise a browser keeps running the previous build after an image
        // upgrade, because index.html is what names the current bundles.
        assert_eq!(cache_control(&response), Some("no-cache"), "{path}");
    }

    let _ = std::fs::remove_dir_all(&dir);
}

#[actix_rt::test]
async fn hashed_assets_are_cached_for_good() {
    let dir = static_dir();
    let router = app(&dir).await;

    let response = get(&router, "/assets/index-DwvWaRbk.js", None).await;

    assert_eq!(response.status(), StatusCode::OK);
    let policy = cache_control(&response).expect("a cache policy");
    assert!(policy.contains("immutable"), "{policy}");
    assert!(policy.contains("max-age=31536000"), "{policy}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[actix_rt::test]
async fn static_files_are_compressed_when_the_client_accepts_it() {
    let dir = static_dir();
    let router = app(&dir).await;

    let response = get(&router, "/index.html", Some("gzip")).await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get(header::CONTENT_ENCODING)
            .and_then(|value| value.to_str().ok()),
        Some("gzip")
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[actix_rt::test]
async fn api_routes_are_not_shadowed_or_rewritten_by_the_static_fallback() {
    let dir = static_dir();
    let router = app(&dir).await;

    // The fallback only answers what no route matched; the API keeps its own
    // responses, uncompressed and without the static cache policy.
    for path in ["/health", "/api/v1/config"] {
        let response = get(&router, path, Some("gzip, br")).await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert!(cache_control(&response).is_none(), "{path}");
        assert!(
            response.headers().get(header::CONTENT_ENCODING).is_none(),
            "{path}"
        );
    }

    let _ = std::fs::remove_dir_all(&dir);
}

#[actix_rt::test]
async fn a_missing_static_file_is_a_plain_404() {
    let dir = static_dir();
    let router = app(&dir).await;

    let response = get(&router, "/assets/does-not-exist.js", None).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    // A 404 must not be cached as if it were a hashed asset.
    assert!(cache_control(&response).is_none());

    let _ = std::fs::remove_dir_all(&dir);
}
