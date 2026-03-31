use std::sync::Arc;

use axum::{
    Router,
    routing::{get, post},
};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing::info;
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

mod models;
mod routes;
mod state;

use state::AppState;

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(fmt::layer())
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let base_url = std::env::var("BASE_URL")
        .unwrap_or_else(|_| "http://localhost:3000".to_owned());

    let state = Arc::new(AppState::new(base_url.as_str()));

    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000")
        .await
        .expect("failed to bind to port 3000");

    info!("server listening on {}", listener.local_addr().unwrap());
    info!("base URL: {base_url}");

    axum::serve(listener, app)
        .await
        .expect("server error");
}

fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(routes::health::handler))
        .route("/sessions", post(routes::sessions::create))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state)
}
