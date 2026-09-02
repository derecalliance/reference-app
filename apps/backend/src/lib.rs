//! The reference DeRec backend, as a library.
//!
//! Everything lives here rather than in `main.rs` so integration tests under
//! `tests/` can drive the actors directly, or exercise a route through the
//! real router via [`build_router`]. `main.rs` is only the binary entry
//! point: argument-free boot and the Axum server itself.

use std::sync::Arc;

use axum::{
    Router,
    routing::{get, post},
};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

pub mod actor;
pub mod config;
pub mod envelope;
pub mod instances;
pub mod models;
pub mod provisioning;
pub mod routes;
pub mod state;
pub mod stores;

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
    Router::new()
        .route("/health", get(routes::health::handler))
        .route("/config", get(routes::config::get))
        .route("/owners", post(routes::owners::register))
        .route("/actors", get(routes::actors::list))
        .route("/actors/{actor_id}/contact", post(routes::actors::create_contact))
        .route(
            "/actors/{actor_id}/start-pairing",
            post(routes::actors::start_pairing),
        )
        // Actor-generic, unlike the replica-scoped pair below: a NoKeys pairing
        // can land on any provisioned actor, so the channel is explicit.
        .route(
            "/actors/{actor_id}/fingerprint",
            get(routes::actors::get_fingerprint),
        )
        .route(
            "/actors/{actor_id}/confirm-fingerprint",
            post(routes::actors::confirm_fingerprint),
        )
        .route("/helpers", post(routes::helpers::add))
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
        .route("/replicas", post(routes::replicas::add))
        .route(
            "/replicas/{replica_id}/fingerprint",
            get(routes::replicas::get_fingerprint),
        )
        .route(
            "/replicas/{replica_id}/confirm-fingerprint",
            post(routes::replicas::confirm_fingerprint),
        )
        .route(
            "/replicas/{replica_id}/toggle-status",
            post(routes::replicas::toggle_status),
        )
        .route("/derec/{actor_id}", post(routes::derec::deliver_message))
        .route("/derec/{actor_id}/mailbox", get(routes::derec::poll_mailbox))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state)
}
