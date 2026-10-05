// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{Json, extract::State, response::IntoResponse};
use serde::Serialize;

use crate::{config::Defaults, state::AppState};

/// What `GET /config` returns: the operator's defaults, plus the facts about
/// this node the front end cannot work out for itself.
///
/// `Defaults` is flattened rather than nested so the payload stays the flat
/// object the front end already decodes.
#[derive(Debug, Serialize)]
pub struct ConfigResponse {
    #[serde(flatten)]
    defaults: Defaults,
    /// True when this node's database is in-memory, so everything is lost when
    /// the process stops.
    ///
    /// Derived from the resolved database URL rather than stored in `Defaults`:
    /// it is not something an operator sets, it is a consequence of what they
    /// set. The front end surfaces it so a developer learns this before losing a
    /// vault to it rather than afterwards; the boot log says the same thing for
    /// whoever is reading `docker logs` instead.
    database_ephemeral: bool,
}

/// GET /config
///
/// Operator-supplied starting values for the front-end setup wizard, read from
/// the config file at boot. Defaults only — the user can override any of them,
/// and the values a node actually runs with are whatever it sends on its
/// provisioning requests.
pub async fn get(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(ConfigResponse {
        defaults: Defaults::clone(&state.defaults),
        database_ephemeral: crate::db::is_ephemeral(&state.config.settings.server.database_url),
    })
}
