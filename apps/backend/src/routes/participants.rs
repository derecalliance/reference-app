use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use tracing::info;
use uuid::Uuid;

use crate::state::AppState;

/// Mirrors the FE's ContactMessage serialization: binary fields are base64url-encoded for JSON transport.
#[derive(Debug, Serialize, Deserialize)]
pub struct ContactMessageDto {
    pub channel_id: String,
    pub nonce: String,
    pub transport_protocol: TransportProtocolDto,
    pub mlkem_encapsulation_key: String,
    pub ecies_public_key: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TransportProtocolDto {
    pub uri: String,
    pub protocol: String,
}

pub fn contact_to_dto(c: &derec_proto::ContactMessage) -> ContactMessageDto {
    let tp = c.transport_protocol.as_ref();
    ContactMessageDto {
        channel_id: c.channel_id.to_string(),
        nonce: c.nonce.to_string(),
        transport_protocol: TransportProtocolDto {
            uri: tp.map(|t| t.uri.clone()).unwrap_or_default(),
            protocol: String::from("https"),
        },
        mlkem_encapsulation_key: URL_SAFE_NO_PAD.encode(&c.mlkem_encapsulation_key),
        ecies_public_key: URL_SAFE_NO_PAD.encode(&c.ecies_public_key),
    }
}

#[derive(Debug, Deserialize)]
pub struct SetStatusRequest {
    pub disabled: bool,
}

#[derive(Debug, Serialize)]
pub struct ToggleStatusResponse {
    pub disabled: bool,
}

/// POST /sessions/:session_id/participants/:participant_id/toggle-status
pub async fn toggle_status(
    State(state): State<Arc<AppState>>,
    Path((session_id, participant_id)): Path<(Uuid, Uuid)>,
    body: Option<Json<SetStatusRequest>>,
) -> Response {
    if !state.sessions.contains_key(&session_id) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        )
            .into_response();
    }

    if !state.actor_inboxes.contains_key(&participant_id) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "participant not found" })),
        )
            .into_response();
    }

    let want_disabled = match body {
        Some(Json(req)) => req.disabled,
        None => !state.disabled_participants.contains_key(&participant_id),
    };

    if want_disabled {
        state.disabled_participants.insert(participant_id, ());
    } else {
        state.disabled_participants.remove(&participant_id);
    }

    info!(
        session_id = %session_id,
        participant_id = %participant_id,
        disabled = want_disabled,
        "participant status updated"
    );

    (StatusCode::OK, Json(ToggleStatusResponse { disabled: want_disabled })).into_response()
}
