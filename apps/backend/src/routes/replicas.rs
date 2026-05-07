use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use derec_library::protocol::DeRecFlow;
use derec_proto::SenderKind;
use tracing::info;
use uuid::Uuid;

use serde::{Deserialize, Serialize};

use crate::{
    actor::{CreateContactMsg, GetFingerprintMsg, StartFlowMsg, VerifyFingerprintMsg},
    routes::participants::{ContactMessageDto, PairResponse, SetStatusRequest, ToggleStatusResponse, contact_to_dto, dto_to_contact},
    state::{ActorInbox, AppState},
};

// ── Helpers ────────────────────────────────────────────────────────────────

fn get_provisioned_addr(state: &AppState, actor_id: &Uuid) -> Option<actix::Addr<crate::actor::ProvisionedActor>> {
    state.actor_inboxes.get(actor_id).and_then(|entry| {
        match entry.value() {
            ActorInbox::Provisioned(addr) => Some(addr.clone()),
            _ => None,
        }
    })
}

// ── Handlers ────────────────────────────────────────────────────────────────

/// POST /sessions/:session_id/replicas/:replica_id/create-contact
pub async fn create_contact(
    State(state): State<Arc<AppState>>,
    Path((session_id, replica_id)): Path<(Uuid, Uuid)>,
) -> Response {
    if !state.sessions.contains_key(&session_id) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        )
            .into_response();
    }

    let addr = match get_provisioned_addr(&state, &replica_id) {
        Some(a) => a,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "replica not found" })),
            )
                .into_response();
        }
    };

    match addr.send(CreateContactMsg).await {
        Ok(Ok(contact)) => {
            let dto = contact_to_dto(&contact);
            info!(
                session_id = %session_id,
                replica_id = %replica_id,
                channel_id = %dto.channel_id,
                "replica contact created"
            );
            (StatusCode::OK, Json(dto)).into_response()
        }
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("create_contact failed: {e}") })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("actor mailbox error: {e}") })),
        )
            .into_response(),
    }
}

/// POST /sessions/:session_id/replicas/:replica_id/pair
pub async fn pair(
    State(state): State<Arc<AppState>>,
    Path((session_id, replica_id)): Path<(Uuid, Uuid)>,
    Json(dto): Json<ContactMessageDto>,
) -> Response {
    if !state.sessions.contains_key(&session_id) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        )
            .into_response();
    }

    let addr = match get_provisioned_addr(&state, &replica_id) {
        Some(a) => a,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "replica not found" })),
            )
                .into_response();
        }
    };

    let contact = dto_to_contact(&dto);

    match addr.send(StartFlowMsg(DeRecFlow::Pairing {
        kind: SenderKind::Replica,
        contact,
        name: None,
    })).await {
        Ok(Ok(Some(channel_id))) => {
            info!(
                session_id = %session_id,
                replica_id = %replica_id,
                channel_id = channel_id,
                "replica pairing initiated"
            );
            (StatusCode::OK, Json(PairResponse { channel_id: channel_id.to_string() })).into_response()
        }
        Ok(Ok(None)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "pairing did not return a channel_id" })),
        )
            .into_response(),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("start failed: {e}") })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("actor mailbox error: {e}") })),
        )
            .into_response(),
    }
}

/// POST /sessions/:session_id/replicas/:replica_id/toggle-status
pub async fn toggle_status(
    State(state): State<Arc<AppState>>,
    Path((session_id, replica_id)): Path<(Uuid, Uuid)>,
    body: Option<Json<SetStatusRequest>>,
) -> Response {
    if !state.sessions.contains_key(&session_id) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        )
            .into_response();
    }

    if !state.actor_inboxes.contains_key(&replica_id) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "replica not found" })),
        )
            .into_response();
    }

    let want_disabled = match body {
        Some(Json(req)) => req.disabled,
        None => !state.disabled_replicas.contains_key(&replica_id),
    };

    if want_disabled {
        state.disabled_replicas.insert(replica_id, ());
    } else {
        state.disabled_replicas.remove(&replica_id);
    }

    info!(
        session_id = %session_id,
        replica_id = %replica_id,
        disabled = want_disabled,
        "replica status updated"
    );

    (StatusCode::OK, Json(ToggleStatusResponse { disabled: want_disabled })).into_response()
}

// ── Fingerprint confirmation ────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct GetFingerprintResponse {
    pub fingerprint: String,
}

#[derive(Debug, Deserialize)]
pub struct ConfirmFingerprintRequest {
    pub channel_id: String,
    pub fingerprint: String,
}

/// GET /sessions/:session_id/replicas/:replica_id/fingerprint
///
/// Returns the fingerprint for the replica's paired channel.
/// The fingerprint is a 16-digit decimal string formatted as `XXXX-XXXX-XXXX-XXXX`,
/// derived from the channel's shared key via SHA-256.
pub async fn get_fingerprint(
    State(state): State<Arc<AppState>>,
    Path((session_id, replica_id)): Path<(Uuid, Uuid)>,
) -> Response {
    if !state.sessions.contains_key(&session_id) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        )
            .into_response();
    }

    let addr = match get_provisioned_addr(&state, &replica_id) {
        Some(a) => a,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "replica not found" })),
            )
                .into_response();
        }
    };

    let channel_id_str = match state.replica_channels.get(&replica_id).and_then(|v| v.value().last().cloned()) {
        Some(cid) => cid,
        None => {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({ "error": "replica not yet paired" })),
            )
                .into_response();
        }
    };

    let channel_id: u64 = match channel_id_str.parse() {
        Ok(cid) => cid,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "invalid channel ID" })),
            )
                .into_response();
        }
    };

    match addr.send(GetFingerprintMsg(channel_id)).await {
        Ok(Ok(fingerprint)) => {
            info!(
                session_id = %session_id,
                replica_id = %replica_id,
                channel_id = %channel_id_str,
                "replica fingerprint retrieved"
            );
            (StatusCode::OK, Json(GetFingerprintResponse { fingerprint })).into_response()
        }
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("get_fingerprint failed: {e}") })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("actor mailbox error: {e}") })),
        )
            .into_response(),
    }
}

/// POST /sessions/:session_id/replicas/:replica_id/confirm-fingerprint
///
/// Verifies the provided fingerprint matches the one derived from the channel's
/// shared key. If it matches, marks the replica as confirmed.
pub async fn confirm_fingerprint(
    State(state): State<Arc<AppState>>,
    Path((session_id, replica_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<ConfirmFingerprintRequest>,
) -> Response {
    if !state.sessions.contains_key(&session_id) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        )
            .into_response();
    }

    let addr = match get_provisioned_addr(&state, &replica_id) {
        Some(a) => a,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "replica not found" })),
            )
                .into_response();
        }
    };

    let stored_channel_id = match state.replica_channels.get(&replica_id).and_then(|v| v.value().last().cloned()) {
        Some(cid) => cid,
        None => {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({ "error": "replica not yet paired" })),
            )
                .into_response();
        }
    };

    if req.channel_id != stored_channel_id {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "channel_id mismatch" })),
        )
            .into_response();
    }

    let channel_id: u64 = match stored_channel_id.parse() {
        Ok(cid) => cid,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "invalid channel ID" })),
            )
                .into_response();
        }
    };

    match addr.send(VerifyFingerprintMsg { channel_id, fingerprint: req.fingerprint.clone() }).await {
        Ok(Ok(true)) => {
            state.replica_confirmed.insert(replica_id, ());
            info!(
                session_id = %session_id,
                replica_id = %replica_id,
                channel_id = %stored_channel_id,
                "replica fingerprint confirmed"
            );
            (StatusCode::OK, Json(serde_json::json!({ "confirmed": true }))).into_response()
        }
        Ok(Ok(false)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "fingerprint mismatch" })),
        )
            .into_response(),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("verify_fingerprint failed: {e}") })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("actor mailbox error: {e}") })),
        )
            .into_response(),
    }
}
