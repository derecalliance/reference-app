use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use derec_proto::SenderKind;
use serde::{Deserialize, Serialize};
use tracing::info;
use uuid::Uuid;

use crate::state::AppState;

// ── DTOs ─────────────────────────────────────────────────────────────────────

/// Mirrors the FE's ContactMessage serialization format: binary fields are
/// base64url-encoded so the payload is JSON/QR-safe.
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

#[derive(Debug, Serialize)]
pub struct PairResponse {
    pub channel_id: String,
}

// ── Conversions ──────────────────────────────────────────────────────────────

fn contact_to_dto(c: &derec_proto::ContactMessage) -> ContactMessageDto {
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

fn dto_to_contact(dto: &ContactMessageDto) -> derec_proto::ContactMessage {
    derec_proto::ContactMessage {
        channel_id: dto.channel_id.parse::<u64>().unwrap_or(0),
        nonce: dto.nonce.parse::<u64>().unwrap_or(0),
        transport_protocol: Some(derec_proto::TransportProtocol {
            uri: dto.transport_protocol.uri.clone(),
            protocol: 0, // HTTPS
        }),
        mlkem_encapsulation_key: URL_SAFE_NO_PAD
            .decode(&dto.mlkem_encapsulation_key)
            .unwrap_or_default(),
        ecies_public_key: URL_SAFE_NO_PAD
            .decode(&dto.ecies_public_key)
            .unwrap_or_default(),
        ..Default::default()
    }
}

/// Request body for channel association (recovery flow).
#[derive(Debug, Deserialize)]
pub struct AssociateChannelRequest {
    pub old_channel_id: String,
    pub new_channel_id: String,
}

#[derive(Debug, Serialize)]
pub struct AssociateChannelResponse {
    pub migrated_shares: usize,
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/// POST /sessions/:session_id/helpers/:helper_id/create-contact
///
/// Creates a DeRec contact message for this helper, generating a fresh
/// KEM/ECIES key pair. Returns the contact in the same JSON format used by
/// the frontend (binary fields base64url-encoded).
pub async fn create_contact(
    State(state): State<Arc<AppState>>,
    Path((session_id, helper_id)): Path<(Uuid, Uuid)>,
) -> Response {
    if !state.sessions.contains_key(&session_id) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        )
            .into_response();
    }

    let protocol_lock = match state.helper_protocols.get(&helper_id) {
        Some(p) => p.value().clone(),
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "helper protocol not found" })),
            )
                .into_response();
        }
    };

    // Protocol trait futures are not Send; drive them on the current thread.
    let result = tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(async {
            let mut protocol = protocol_lock.lock().await;
            protocol.create_contact(None).await
        })
    });

    match result {
        Ok(contact) => {
            let dto = contact_to_dto(&contact);
            info!(
                session_id = %session_id,
                helper_id = %helper_id,
                channel_id = %dto.channel_id,
                "helper contact created"
            );
            (StatusCode::OK, Json(dto)).into_response()
        }
        Err(e) => {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("create_contact failed: {e}") })),
            )
                .into_response()
        }
    }
}

/// POST /sessions/:session_id/helpers/:helper_id/pair
///
/// Initiates pairing from the helper side with an external owner's contact.
/// The request body is a `ContactMessageDto` (same JSON format as the QR payload).
pub async fn pair(
    State(state): State<Arc<AppState>>,
    Path((session_id, helper_id)): Path<(Uuid, Uuid)>,
    Json(dto): Json<ContactMessageDto>,
) -> Response {
    if !state.sessions.contains_key(&session_id) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        )
            .into_response();
    }

    let protocol_lock = match state.helper_protocols.get(&helper_id) {
        Some(p) => p.value().clone(),
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "helper protocol not found" })),
            )
                .into_response();
        }
    };

    let contact = dto_to_contact(&dto);

    // Protocol trait futures are not Send; drive them on the current thread.
    let result = tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(async {
            let mut protocol = protocol_lock.lock().await;
            protocol.start_pairing(SenderKind::Helper, contact).await
        })
    });

    match result {
        Ok(channel_id) => {
            info!(
                session_id = %session_id,
                helper_id = %helper_id,
                channel_id = channel_id,
                "helper pairing initiated"
            );
            (StatusCode::OK, Json(PairResponse { channel_id: channel_id.to_string() })).into_response()
        }
        Err(e) => {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("start_pairing failed: {e}") })),
            )
                .into_response()
        }
    }
}

/// POST /sessions/:session_id/helpers/:helper_id/associate-channel
///
/// Associates a new recovery channel_id with an old channel_id on this helper.
/// Copies share and secret entries so the helper can respond to discovery and
/// recovery requests on the new channel. Old entries are preserved for inspection.
pub async fn associate_channel(
    State(state): State<Arc<AppState>>,
    Path((session_id, helper_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<AssociateChannelRequest>,
) -> Response {
    if !state.sessions.contains_key(&session_id) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        )
            .into_response();
    }

    let protocol_lock = match state.helper_protocols.get(&helper_id) {
        Some(p) => p.value().clone(),
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "helper protocol not found" })),
            )
                .into_response();
        }
    };

    let old_cid: u64 = match req.old_channel_id.parse() {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "invalid old_channel_id" })),
            )
                .into_response();
        }
    };
    let new_cid: u64 = match req.new_channel_id.parse() {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "invalid new_channel_id" })),
            )
                .into_response();
        }
    };

    let migrated_shares = {
        let mut protocol = protocol_lock.lock().await;
        let shares = protocol.share_store.associate_channel(old_cid, new_cid);
        protocol.secret_store.associate_channel(old_cid, new_cid);
        shares
    };

    // Clear the pending association and update helper_channels to the new channel.
    state.pending_associations.remove(&helper_id);
    state.helper_channels.insert(helper_id, req.new_channel_id.clone());

    info!(
        session_id = %session_id,
        helper_id = %helper_id,
        old_channel_id = old_cid,
        new_channel_id = new_cid,
        migrated_shares = migrated_shares,
        "channel association complete"
    );

    (StatusCode::OK, Json(AssociateChannelResponse { migrated_shares })).into_response()
}
