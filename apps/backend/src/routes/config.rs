use std::sync::Arc;

use axum::{Json, extract::State, response::IntoResponse};

use crate::{config::Defaults, state::AppState};

/// GET /config
///
/// Operator-supplied starting values for the front-end setup wizard, read from
/// the config file at boot. Defaults only — the user can override any of them,
/// and the values a node actually runs with are whatever it sends on its
/// provisioning requests.
pub async fn get(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(Defaults::clone(&state.defaults))
}
