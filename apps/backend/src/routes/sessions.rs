use std::sync::Arc;

use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::IntoResponse,
};
use tracing::info;
use uuid::Uuid;

use crate::{
    models::{Actor, CreateSessionRequest, CreateSessionResponse, Role, Session, Transport, TransportProtocol},
    state::AppState,
};

pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateSessionRequest>,
) -> impl IntoResponse {
    let session_id = Uuid::new_v4();

    let caller = Actor {
        id: Uuid::new_v4(),
        role: req.role.clone(),
        name: req.name.clone(),
        transport: req.transport,
    };

    let mut actors: Vec<Actor> = vec![caller];

    // When the caller is a Helper, provision a virtual Owner backed by the relay.
    if req.role == Role::Helper {
        actors.push(provisioned_actor(Role::Owner, "Owner", session_id, &state.base_url));
    }

    // Provision the requested number of additional Helpers.
    for i in 1..=req.additional_helpers {
        actors.push(provisioned_actor(
            Role::Helper,
            &format!("Helper-{i}"),
            session_id,
            &state.base_url,
        ));
    }

    let session = Session {
        id: session_id,
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

/// Build a backend-provisioned actor whose transport URI points at this relay.
fn provisioned_actor(role: Role, name: &str, session_id: Uuid, base_url: &str) -> Actor {
    let actor_id = Uuid::new_v4();
    Actor {
        id: actor_id,
        role,
        name: name.to_owned(),
        transport: Transport {
            protocol: TransportProtocol::Https,
            uri: format!("{base_url}/sessions/{session_id}/actors/{actor_id}"),
        },
    }
}
