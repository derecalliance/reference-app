use std::sync::Arc;

use axum::{
    routing::{delete, get, post},
    Router,
};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing::info;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

mod models;
mod routes;
mod state;
mod stores;

use state::AppState;

#[tokio::main]
async fn main() {
    dotenv::dotenv().ok();

    tracing_subscriber::registry()
        .with(fmt::layer())
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let base_url = std::env::var("BASE_URL").unwrap_or_else(|_| "http://localhost".to_owned());
    let port = std::env::var("PORT").unwrap_or_else(|_| "5000".to_owned());
    let base_url = format!("{base_url}:{port}");

    let http_client = reqwest::Client::new();
    let state = Arc::new(AppState::new(base_url.as_str(), http_client));

    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .expect("failed to bind to port 3000");

    info!("server listening on {}", listener.local_addr().unwrap());
    info!("base URL: {base_url}");

    axum::serve(listener, app).await.expect("server error");
}

fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(routes::health::handler))
        .route("/sessions", post(routes::sessions::create))
        .route("/sessions/{session_id}", get(routes::sessions::get))
        .route(
            "/sessions/{session_id}/pending-associations",
            delete(routes::sessions::clear_pending_associations),
        )
        // ── DeRec protocol transport endpoints ────────────────────────────────
        // These paths carry raw protobuf-encoded DeRec wire messages:
        //   - POST …/{actor_id}        → deliver a binary message to an actor's mailbox
        //   - GET  …/{actor_id}/mailbox → drain and return pending messages (base64url)
        // Role must be "owners" or "helpers".
        .route(
            "/derec/sessions/{session_id}/{role}/{actor_id}",
            post(routes::derec::deliver_message),
        )
        .route(
            "/derec/sessions/{session_id}/{role}/{actor_id}/mailbox",
            get(routes::derec::poll_mailbox),
        )
        // ── Helper control endpoints ─────────────────────────────────────────
        .route(
            "/sessions/{session_id}/helpers/{helper_id}/create-contact",
            post(routes::helpers::create_contact),
        )
        .route(
            "/sessions/{session_id}/helpers/{helper_id}/pair",
            post(routes::helpers::pair),
        )
        .route(
            "/sessions/{session_id}/helpers/{helper_id}/associate-channel",
            post(routes::helpers::associate_channel),
        )
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state)
}
