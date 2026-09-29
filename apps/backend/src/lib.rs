//! The reference DeRec backend, as a library.
//!
//! Everything lives here rather than in `main.rs` so integration tests under
//! `tests/` can drive the actors directly, or exercise a route through the
//! real router via [`build_router`]. `main.rs` is only the binary entry
//! point: argument-free boot and the Axum server itself.

use std::sync::Arc;

use axum::{
    Router,
    routing::{delete, get, post},
};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

pub mod actor;
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
pub mod models;
pub mod provisioning;
pub mod recovery;
pub mod registry;
pub mod routing;
pub mod routes;
pub mod sql;
pub mod state;
pub mod stores;
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
        .route("/derec/relay", post(routes::derec::relay))
        .route("/derec/{actor_id}", post(routes::derec::deliver_message))
        .route("/derec/{actor_id}/mailbox", get(routes::derec::poll_mailbox))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive());

    // Serve the built front end from the same origin, when there is one to
    // serve. Unset — the ordinary `cargo run` plus Vite dev loop, and every
    // integration test — leaves behaviour byte-identical to having no fallback
    // at all; the image sets it to `/app/static`.
    //
    // A fallback introduces no ambiguity here because every route above is an
    // explicit path, and there is no SPA rewrite because the app has no
    // client-side routes: every screen lives at the base path.
    let router = match state.config.settings.server.static_dir.as_str() {
        "" => router,
        dir => router.fallback_service(tower_http::services::ServeDir::new(dir)),
    };

    router.with_state(state)
}
