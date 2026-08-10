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

/// Mirrors the FE's ContactMessage serialization: `u64` fields travel as
/// decimal strings (they exceed the exact range of a JavaScript number) and
/// binary fields are base64url-encoded.
///
/// Key material is optional because it is only inlined under
/// [`derec_proto::ContactMode::InlineKeys`]; `HashedKeys` carries a binding
/// hash instead, and `NoKeys` carries neither.
#[derive(Debug, Serialize, Deserialize)]
pub struct ContactMessageDto {
    pub channel_id: String,
    pub nonce: String,
    pub transport_protocol: TransportProtocolDto,
    /// `ContactMode` numeric value: 0 = INLINE_KEYS, 1 = HASHED_KEYS, 2 = NO_KEYS.
    #[serde(default)]
    pub contact_mode: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mlkem_encapsulation_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ecies_public_key: Option<String>,
    /// SHA-384 commitment over the key material; present only under `HashedKeys`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contact_binding_hash: Option<String>,
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
        contact_mode: c.contact_mode,
        mlkem_encapsulation_key: c
            .mlkem_encapsulation_key
            .as_ref()
            .map(|k| URL_SAFE_NO_PAD.encode(k)),
        ecies_public_key: c.ecies_public_key.as_ref().map(|k| URL_SAFE_NO_PAD.encode(k)),
        contact_binding_hash: c
            .contact_binding_hash
            .as_ref()
            .map(|h| URL_SAFE_NO_PAD.encode(h)),
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

// ── Operator-driven channel linking ──────────────────────────────────────────
//
// A helper decides that a newly-paired channel belongs to an owner it already
// helps. That is an *authentication* step: nothing on the wire carries a
// trustworthy identity, so the protocol cannot infer it and neither can this
// backend. A real entity would link after a KYC flow; here an operator does it
// explicitly through these endpoints.

#[derive(Debug, Deserialize)]
pub struct LinkChannelsRequest {
    /// Channel to link *from* — typically the caller's own channel with this actor.
    pub channel_id: String,
    /// Existing channel the actor already holds for the same owner.
    pub link_to_channel_id: String,
}

#[derive(Debug, Serialize)]
pub struct ListChannelsResponse {
    pub channels: Vec<crate::actor::ChannelSummary>,
}

fn provisioned_addr(
    state: &AppState,
    actor_id: &Uuid,
) -> Option<actix::Addr<crate::actor::ProvisionedActor>> {
    state.actor_inboxes.get(actor_id).and_then(|entry| match entry.value() {
        crate::state::ActorInbox::Provisioned(addr) => Some(addr.clone()),
        _ => None,
    })
}

/// GET /sessions/:session_id/participants/:participant_id/channels
///
/// Every channel this actor holds, so an operator can pick which one a newly
/// paired owner should be linked to.
pub async fn list_channels(
    State(state): State<Arc<AppState>>,
    Path((session_id, participant_id)): Path<(Uuid, Uuid)>,
) -> Response {
    if !state.sessions.contains_key(&session_id) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        )
            .into_response();
    }

    let Some(addr) = provisioned_addr(&state, &participant_id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "provisioned participant not found" })),
        )
            .into_response();
    };

    match addr.send(crate::actor::ListChannelsMsg).await {
        Ok(Ok(channels)) => (StatusCode::OK, Json(ListChannelsResponse { channels })).into_response(),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("list channels failed: {e}") })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("actor mailbox error: {e}") })),
        )
            .into_response(),
    }
}

/// POST /sessions/:session_id/participants/:participant_id/link
pub async fn link_channels(
    State(state): State<Arc<AppState>>,
    Path((session_id, participant_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<LinkChannelsRequest>,
) -> Response {
    if !state.sessions.contains_key(&session_id) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        )
            .into_response();
    }

    let (Ok(channel_id), Ok(link_to_channel_id)) =
        (req.channel_id.parse::<u64>(), req.link_to_channel_id.parse::<u64>())
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "channel ids must be decimal u64 strings" })),
        )
            .into_response();
    };

    if channel_id == link_to_channel_id {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "cannot link a channel to itself" })),
        )
            .into_response();
    }

    let Some(addr) = provisioned_addr(&state, &participant_id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "provisioned participant not found" })),
        )
            .into_response();
    };

    match addr
        .send(crate::actor::LinkChannelsMsg { channel_id, link_to_channel_id })
        .await
    {
        Ok(Ok(())) => {
            info!(
                session_id = %session_id,
                participant_id = %participant_id,
                channel_id = channel_id,
                link_to_channel_id = link_to_channel_id,
                "operator linked channels"
            );
            (StatusCode::OK, Json(serde_json::json!({ "linked": true }))).into_response()
        }
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("link failed: {e}") })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("actor mailbox error: {e}") })),
        )
            .into_response(),
    }
}
