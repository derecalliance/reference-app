// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The reference DeRec backend, as a library.
//!
//! Everything lives here rather than in `main.rs` so integration tests under
//! `tests/` can drive the actors directly, or exercise a route through the
//! real router via [`build_router`]. `main.rs` is only the binary entry
//! point: argument-free boot and the Axum server itself.

use std::sync::Arc;

use axum::{
    Router,
    extract::{DefaultBodyLimit, Request},
    handler::HandlerWithoutStateExt,
    http::{HeaderValue, header},
    middleware::{self, Next},
    response::Response,
    routing::{delete, get, patch, post},
};
use tower_http::{
    compression::CompressionLayer, cors::CorsLayer, services::ServeDir, trace::TraceLayer,
};

pub mod actor;
pub mod addresses;
pub mod deletion;
pub mod config;
/// Behaviour every store implementation must have. Lives in the library, not
/// in `tests/`, so the SQL stores can run the identical assertions once they
/// exist — and so it survives the deletion of `stores.rs`.
pub mod conformance;
pub mod db;
pub mod debug;
pub mod envelope;
pub mod grpc;
pub mod instances;
pub mod local;
pub mod models;
pub mod provisioning;
pub mod recovery;
pub mod registry;
pub mod routing;
pub mod routes;
pub mod sql;
pub mod state;
pub mod stores;
pub mod timestamp;
pub mod transport;

use state::AppState;

/// Fixtures for integration tests, re-exported at the crate root so `tests/`
/// reaches them as `derec_backend::test_support`.
pub use state::test_support;

/// Assemble the full route table over `state`.
///
/// Shared by the binary (`main.rs`, serving real traffic) and by integration
/// tests that want to exercise a handler through the actual HTTP layer
/// (query parsing, routing, middleware) rather than by calling it directly.
pub fn build_router(state: Arc<AppState>) -> Router {
    let router = Router::new()
        .route("/health", get(routes::health::handler))
        .route("/config", get(routes::config::get))
        // The debug surface. Unauthenticated by design: this app ships as a
        // developer's local container and exposing its internals is the point.
        .route("/debug/config", get(routes::debug::config))
        .route("/debug/state", get(routes::debug::state))
        .route("/debug/events", get(routes::debug::events))
        .route("/owners", post(routes::owners::register))
        .route("/owners/{owner_id}", patch(routes::owners::rename))
        .route("/actors", get(routes::actors::list))
        .route("/actors/{actor_id}/contact", post(routes::actors::create_contact))
        .route(
            "/actors/{actor_id}/start-pairing",
            post(routes::actors::start_pairing),
        )
        // A NoKeys pairing — and every replica-mode pairing — can land on any
        // provisioned actor and on any of its channels, so the channel these
        // act on is named explicitly rather than inferred from the actor. The
        // actor resolves which of its protocol instances holds that channel,
        // so a replica-mode channel (which lives on the mirrored owner's
        // instance, not the actor's own) is served like any other.
        .route(
            "/actors/{actor_id}/fingerprint",
            get(routes::actors::get_fingerprint),
        )
        .route(
            "/actors/{actor_id}/confirm-fingerprint",
            post(routes::actors::confirm_fingerprint),
        )
        .route("/helpers", post(routes::helpers::add))
        .route("/helpers/{helper_id}", delete(routes::helpers::delete))
        .route("/helpers/ensure", post(routes::helpers::ensure))
        .route(
            "/helpers/{helper_id}/toggle-status",
            post(routes::helpers::toggle_status),
        )
        .route(
            "/helpers/{helper_id}/channels",
            get(routes::helpers::list_channels),
        )
        .route(
            "/helpers/{helper_id}/link",
            post(routes::helpers::link_channels),
        )
        .route(
            "/helpers/{helper_id}/browser-contact",
            post(routes::helpers::post_browser_contact)
                .get(routes::helpers::get_browser_contact),
        )
        // Registered ahead of `/derec/{actor_id}` so `relay` is matched
        // literally rather than parsed as that segment's UUID.
        //
        // Both carry a DeRec message, so both take the largest one this node
        // accepts on any transport — the gRPC listener's 4 MiB — rather than
        // Axum's 2 MiB default. The relay's JSON body is larger again by the
        // base64url encoding of that message.
        .route(
            "/derec/relay",
            post(routes::derec::relay)
                .layer(DefaultBodyLimit::max(routes::derec::RELAY_BODY_LIMIT)),
        )
        .route(
            "/derec/{actor_id}",
            post(routes::derec::deliver_message)
                .layer(DefaultBodyLimit::max(transport::MAX_MESSAGE_BYTES)),
        )
        .route("/derec/{actor_id}/mailbox", get(routes::derec::poll_mailbox))
        // One error shape everywhere, including for what no handler sees. Both
        // come after every route: `method_not_allowed_fallback` applies only to
        // routes already registered.
        .fallback(routes::api_error::route_not_found)
        .method_not_allowed_fallback(routes::api_error::method_not_allowed)
        .layer(TraceLayer::new_for_http())
        // Private Network Access: a page on a public origin calling this node
        // on localhost or the LAN preflights with
        // `Access-Control-Request-Private-Network`, and Chrome blocks the call
        // unless the preflight answers it.
        .layer(CorsLayer::permissive().allow_private_network(true));

    // Serve the built front end from the same origin, when there is one to
    // serve. Unset — the ordinary `cargo run` plus Vite dev loop, and every
    // integration test — leaves behaviour byte-identical to having no fallback
    // at all; the image's built-in default is `/app/static`.
    //
    // A fallback introduces no ambiguity here because every route above is an
    // explicit path, and a fallback only answers what no route matched — so it
    // cannot shadow the API. It replaces the JSON 404 above, which is why the
    // file service ends in that same 404. There is no SPA rewrite because the
    // app routes by hash (`#/vault/<id>`), which never reaches the server.
    let router = match state.config.settings.server.static_dir.as_str() {
        "" => router,
        dir => router.fallback_service(static_files(dir)),
    };

    router.with_state(state)
}

/// Long enough to be "forever" to a browser: a year, the conventional ceiling.
const IMMUTABLE_ASSET_CACHE: &str = "public, max-age=31536000, immutable";

/// The built front end, compressed and with cache headers that fit how Vite
/// names its output.
///
/// Its own router so the compression and caching layers wrap only the static
/// files, never an API response: the mailbox poll and the debug endpoints are
/// read by code that expects them exactly as the handlers wrote them.
fn static_files(dir: &str) -> Router {
    Router::new()
        .fallback_service(
            ServeDir::new(dir)
                .call_fallback_on_method_not_allowed(true)
                .not_found_service(routes::api_error::route_not_found.into_service()),
        )
        .layer(middleware::from_fn(cache_control))
        // gzip and brotli, negotiated from `Accept-Encoding`. The WASM bundle
        // is most of the page weight and compresses to roughly a third.
        .layer(CompressionLayer::new())
}

/// Set `Cache-Control` by what kind of file was served.
///
/// Everything under `/assets/` carries a content hash in its name, so a given
/// URL never changes content and can be cached for good. Everything else —
/// `index.html` above all, which names the current hashes — must be
/// revalidated on every load, or a browser keeps running a stale build after
/// an image upgrade. `no-cache` still lets it reuse its copy on a `304`, which
/// `ServeDir` answers from the file's modification time.
async fn cache_control(request: Request, next: Next) -> Response {
    let hashed = request.uri().path().starts_with("/assets/");
    let mut response = next.run(request).await;

    if response.status().is_success() || response.status().is_redirection() {
        let policy = if hashed {
            IMMUTABLE_ASSET_CACHE
        } else {
            "no-cache"
        };
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static(policy));
    }
    response
}
