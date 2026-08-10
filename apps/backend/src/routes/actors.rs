use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use derec_library::protocol::DeRecFlow;
use tracing::info;
use uuid::Uuid;

use crate::{
    actor::{CreateContactMsg, StartFlowMsg},
    routes::participants::{ContactMessageDto, contact_to_dto},
    state::{ActorInbox, AppState},
};
use derec_library::protocol::DeRecEvent;
use serde::Deserialize;

/// Role the caller wants a backend-managed actor to take when it initiates
/// pairing.
///
/// Pairing is bi-directional: the initiator declares its own role on the wire
/// and the responder takes the complement. Provisioned actors default to
/// Helper (their usual job), but either role can be driven for testing.
#[derive(Debug, Deserialize, Default)]
pub struct PairRoleQuery {
    #[serde(default)]
    pub role: Option<String>,
}

impl PairRoleQuery {
    fn sender_kind(&self) -> Result<derec_proto::SenderKind, Response> {
        match self.role.as_deref() {
            None | Some("helper") => Ok(derec_proto::SenderKind::Helper),
            Some("owner") => Ok(derec_proto::SenderKind::Owner),
            Some(other) => Err((
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": format!("unknown pairing role `{other}` — expected `owner` or `helper`")
                })),
            )
                .into_response()),
        }
    }
}

/// POST /sessions/:session_id/actors/:actor_id/contact
///
/// Unified endpoint for creating a contact message for any provisioned actor,
/// regardless of role (participant or replica). All message exchange between
/// parties must flow through the actor's transport URI (mailbox).
pub async fn create_contact(
    State(state): State<Arc<AppState>>,
    Path((session_id, actor_id)): Path<(Uuid, Uuid)>,
) -> Response {
    if !state.sessions.contains_key(&session_id) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        )
            .into_response();
    }

    let inbox_entry = match state.actor_inboxes.get(&actor_id) {
        Some(entry) => entry,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "actor not found" })),
            )
                .into_response();
        }
    };

    let addr = match inbox_entry.value() {
        ActorInbox::Provisioned(addr) => addr.clone(),
        ActorInbox::Browser(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "browser-managed actors generate their own contacts"
                })),
            )
                .into_response();
        }
    };

    // Drop the dashmap reference before the await point to avoid holding it across async.
    drop(inbox_entry);

    // Provisioned actors publish their keys inline: they are unattended test
    // fixtures, so the PrePair round-trip that HashedKeys/NoKeys require has
    // no user to drive it.
    let msg = CreateContactMsg {
        contact_mode: derec_proto::ContactMode::InlineKeys,
        nonce: None,
    };

    match addr.send(msg).await {
        Ok(Ok(contact)) => {
            let dto = contact_to_dto(&contact);
            info!(
                session_id = %session_id,
                actor_id = %actor_id,
                channel_id = %dto.channel_id,
                "actor contact created"
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

/// POST /sessions/:session_id/actors/:actor_id/start-pairing
///
/// Has a backend-managed actor initiate pairing using the provided contact.
/// The caller supplies the owner's contact; this endpoint triggers the actor
/// to call protocol.start(Pairing { kind: Helper, contact }) and returns the
/// resulting channel_id.
pub async fn start_pairing(
    State(state): State<Arc<AppState>>,
    Path((session_id, actor_id)): Path<(Uuid, Uuid)>,
    Query(role): Query<PairRoleQuery>,
    Json(req): Json<ContactMessageDto>,
) -> Response {
    let sender_kind = match role.sender_kind() {
        Ok(k) => k,
        Err(resp) => return resp,
    };

    if !state.sessions.contains_key(&session_id) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        )
            .into_response();
    }

    let inbox_entry = match state.actor_inboxes.get(&actor_id) {
        Some(entry) => entry,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "actor not found" })),
            )
                .into_response();
        }
    };

    let addr = match inbox_entry.value() {
        ActorInbox::Provisioned(addr) => addr.clone(),
        ActorInbox::Browser(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "browser-managed actors initiate pairing themselves"
                })),
            )
                .into_response();
        }
    };

    drop(inbox_entry);

    let channel_id: u64 = match req.channel_id.parse() {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "invalid channel_id" })),
            )
                .into_response();
        }
    };
    let nonce: u64 = match req.nonce.parse() {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "invalid nonce" })),
            )
                .into_response();
        }
    };
    // Key material is absent under HashedKeys / NoKeys, so decode only what
    // the initiator actually sent.
    let decode_opt = |field: &Option<String>| -> Result<Option<Vec<u8>>, ()> {
        field
            .as_deref()
            .map(|v| URL_SAFE_NO_PAD.decode(v).map_err(|_| ()))
            .transpose()
    };

    let (mlkem_encapsulation_key, ecies_public_key, contact_binding_hash) = match (
        decode_opt(&req.mlkem_encapsulation_key),
        decode_opt(&req.ecies_public_key),
        decode_opt(&req.contact_binding_hash),
    ) {
        (Ok(m), Ok(e), Ok(h)) => (m, e, h),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "invalid contact key material" })),
            )
                .into_response();
        }
    };

    let contact = derec_proto::ContactMessage {
        channel_id,
        nonce,
        transport_protocol: Some(derec_proto::TransportProtocol {
            uri: req.transport_protocol.uri.clone(),
            protocol: 0, // HTTPS
        }),
        contact_mode: req.contact_mode,
        mlkem_encapsulation_key,
        ecies_public_key,
        contact_binding_hash,
        timestamp: None,
    };

    let flow = DeRecFlow::Pairing {
        kind: sender_kind,
        contact,
        // The provisioned actor doesn't carry an app-level label for the
        // initiator; the peer's `communication_info` arrives on the wire
        // with the pair-request and is what the responder side stores.
        peer_communication_info: std::collections::HashMap::new(),
    };

    match addr.send(StartFlowMsg { flow }).await {
        Ok(Ok(events)) => {
            // `start` no longer returns the channel id directly — it reports
            // the dispatched handshake as a `PairingStarted` event. This is
            // the transient pairing id; the handshake rotates to a long-term
            // id that surfaces on `PairingCompleted`.
            let started = events.iter().find_map(|e| match e {
                DeRecEvent::PairingStarted { channel_id, .. } => Some(channel_id.0),
                _ => None,
            });

            match started {
                Some(pairing_channel_id) => {
                    info!(
                        session_id = %session_id,
                        actor_id = %actor_id,
                        role = ?sender_kind,
                        channel_id = pairing_channel_id,
                        "actor started pairing as initiator"
                    );
                    (
                        StatusCode::OK,
                        Json(serde_json::json!({
                            "channel_id": pairing_channel_id.to_string()
                        })),
                    )
                        .into_response()
                }
                None => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": "pairing emitted no PairingStarted event" })),
                )
                    .into_response(),
            }
        }
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("pairing failed: {e}") })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("actor mailbox error: {e}") })),
        )
            .into_response(),
    }
}
