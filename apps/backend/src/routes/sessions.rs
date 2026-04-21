use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use tokio::sync::Mutex;
use tracing::info;
use uuid::Uuid;

use crate::{
    models::{Actor, ActorWithStatus, CreateSessionRequest, CreateSessionResponse, GetSessionResponse, Role, Session, Transport, TransportProtocol},
    state::AppState,
    stores::{HttpTransport, InMemoryContactStore, InMemorySecretStore, InMemoryShareStore},
};

pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateSessionRequest>,
) -> impl IntoResponse {
    let session_id = Uuid::new_v4();

    let caller = provisioned_actor(req.role.clone(), &req.name, session_id, &state.base_url);

    let mut actors: Vec<Actor> = vec![caller];

    // When the caller is a Helper, provision a virtual Owner backed by the relay.
    if req.role == Role::Helper {
        actors.push(provisioned_actor(Role::Owner, "Owner", session_id, &state.base_url));
    }

    // Provision the requested number of additional Helpers.
    for i in 1..=req.additional_helpers {
        let helper = provisioned_actor(
            Role::Helper,
            &format!("Helper-{i}"),
            session_id,
            &state.base_url,
        );

        // Create a backend-managed protocol instance for this helper.
        let transport = HttpTransport::new(state.http_client.clone());
        let own_transport = derec_proto::TransportProtocol {
            uri: helper.transport.uri.clone(),
            protocol: 0, // HTTPS
        };
        let protocol = derec_library::protocol::DeRecProtocol::new(
            InMemoryContactStore::default(),
            InMemoryShareStore::default(),
            InMemorySecretStore::default(),
            transport,
            own_transport,
        );
        state
            .helper_protocols
            .insert(helper.id, Arc::new(Mutex::new(protocol)));

        actors.push(helper);
    }

    let session = Session {
        _id: session_id,
        actors: actors.clone(),
    };

    state.sessions.insert(session_id, session);

    info!(
        session_id = %session_id,
        role = ?req.role,
        actor_count = actors.len(),
        "session created"
    );

    (
        StatusCode::CREATED,
        Json(CreateSessionResponse {
            session_id,
            actors,
        }),
    )
}

/// DELETE /sessions/:session_id/pending-associations
///
/// Clears all pending recovery associations for the session.
/// Called by the frontend when the user exits recovery mode.
pub async fn clear_pending_associations(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<Uuid>,
) -> Response {
    let session = match state.sessions.get(&session_id) {
        Some(s) => s.value().clone(),
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "session not found" })),
            )
                .into_response();
        }
    };

    let mut cleared = 0usize;
    for actor in &session.actors {
        if state.pending_associations.remove(&actor.id).is_some() {
            cleared += 1;
        }
    }

    info!(session_id = %session_id, cleared, "pending associations cleared");

    (StatusCode::OK, Json(serde_json::json!({ "cleared": cleared }))).into_response()
}

/// GET /sessions/:session_id
///
/// Returns the session's actors so any client can reconstruct a working session
/// from just the session ID (cross-browser / cross-device resume).
pub async fn get(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<Uuid>,
) -> Response {
    match state.sessions.get(&session_id) {
        Some(entry) => {
            let session = entry.value();
            let actors = session
                .actors
                .iter()
                .map(|a| {
                    let channel_id = state.helper_channels.get(&a.id).map(|v| v.value().clone());
                    let pending_recovery_channel_id = state.pending_associations.get(&a.id).map(|v| v.value().clone());
                    ActorWithStatus { actor: a.clone(), channel_id, pending_recovery_channel_id }
                })
                .collect();

            (StatusCode::OK, Json(GetSessionResponse { session_id, actors })).into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        )
            .into_response(),
    }
}

/// Build a backend-provisioned actor whose transport URI points at this relay.
fn provisioned_actor(role: Role, name: &str, session_id: Uuid, base_url: &str) -> Actor {
    let actor_id = Uuid::new_v4();
    let role_segment = match role {
        Role::Owner => "owners",
        Role::Helper => "helpers",
    };
    Actor {
        id: actor_id,
        role,
        name: name.to_owned(),
        transport: Transport {
            protocol: TransportProtocol::Https,
            uri: format!("{base_url}/derec/sessions/{session_id}/{role_segment}/{actor_id}"),
        },
    }
}
