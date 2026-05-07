use std::sync::Arc;

use axum::{
    routing::{delete, get, post},
    Router,
};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing::info;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

mod actor;
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

    // Start an Actix system on a background thread. This provides the runtime
    // that Actix actors need (!Send). The arbiter handle is used to spawn
    // provisioned actors from Axum handlers.
    let shutdown = Arc::new(tokio::sync::Notify::new());
    let (arbiter_handle, arbiter_stopper) = {
        let shutdown = Arc::clone(&shutdown);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let system = actix_rt::System::new();
            system.block_on(async {
                let arbiter = actix_rt::Arbiter::new();
                let handle = arbiter.handle();
                tx.send((handle, arbiter)).expect("failed to send arbiter handle");
                // Keep the system alive until main() signals shutdown.
                shutdown.notified().await;
            });
        });
        rx.recv().expect("failed to receive arbiter handle")
    };

    let state = Arc::new(AppState::new(base_url.as_str(), http_client, arbiter_handle));

    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .expect("failed to bind to port");

    info!("server listening on {}", listener.local_addr().unwrap());
    info!("base URL: {base_url}");

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
            info!("shutting down");
        })
        .await
        .expect("server error");

    arbiter_stopper.stop();
    shutdown.notify_one();
}

fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(routes::health::handler))
        .route("/sessions", post(routes::sessions::create))
        .route("/sessions/{session_id}", get(routes::sessions::get))
        .route(
            "/sessions/{session_id}/participants",
            post(routes::sessions::add_participant),
        )
        .route(
            "/sessions/{session_id}/join",
            post(routes::sessions::join),
        )
        .route(
            "/sessions/{session_id}/pending-associations",
            delete(routes::sessions::clear_pending_associations),
        )
        // ── DeRec protocol transport endpoints ────────────────────────────────
        .route(
            "/derec/sessions/{session_id}/{role}/{actor_id}",
            post(routes::derec::deliver_message),
        )
        .route(
            "/derec/sessions/{session_id}/{role}/{actor_id}/mailbox",
            get(routes::derec::poll_mailbox),
        )
        // ── Participant control endpoints ─────────────────────────────────────────
        .route(
            "/sessions/{session_id}/participants/{participant_id}/create-contact",
            post(routes::participants::create_contact),
        )
        .route(
            "/sessions/{session_id}/participants/{participant_id}/pair",
            post(routes::participants::pair),
        )
        .route(
            "/sessions/{session_id}/participants/{participant_id}/associate-channel",
            post(routes::participants::associate_channel),
        )
        .route(
            "/sessions/{session_id}/participants/{participant_id}/toggle-status",
            post(routes::participants::toggle_status),
        )
        // ── Browser-managed participant contact signaling ─────────────────────
        .route(
            "/sessions/{session_id}/participants/{participant_id}/browser-contact",
            post(routes::sessions::post_browser_contact).get(routes::sessions::get_browser_contact),
        )
        // ── Replica control endpoints ───────────────────────────────────────
        .route(
            "/sessions/{session_id}/replicas",
            post(routes::sessions::add_replica),
        )
        .route(
            "/sessions/{session_id}/replicas/{replica_id}/create-contact",
            post(routes::replicas::create_contact),
        )
        .route(
            "/sessions/{session_id}/replicas/{replica_id}/pair",
            post(routes::replicas::pair),
        )
        .route(
            "/sessions/{session_id}/replicas/{replica_id}/toggle-status",
            post(routes::replicas::toggle_status),
        )
        .route(
            "/sessions/{session_id}/replicas/{replica_id}/fingerprint",
            get(routes::replicas::get_fingerprint),
        )
        .route(
            "/sessions/{session_id}/replicas/{replica_id}/confirm-fingerprint",
            post(routes::replicas::confirm_fingerprint),
        )
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state)
}
