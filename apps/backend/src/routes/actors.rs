use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
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

    match addr.send(CreateContactMsg).await {
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
    Json(req): Json<ContactMessageDto>,
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
    let mlkem_encapsulation_key = match URL_SAFE_NO_PAD.decode(&req.mlkem_encapsulation_key) {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "invalid mlkem_encapsulation_key" })),
            )
                .into_response();
        }
    };
    let ecies_public_key = match URL_SAFE_NO_PAD.decode(&req.ecies_public_key) {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "invalid ecies_public_key" })),
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
        mlkem_encapsulation_key,
        ecies_public_key,
        timestamp: None,
    };

    let flow = DeRecFlow::Pairing {
        kind: derec_proto::SenderKind::Helper,
        contact,
        name: None,
    };

    match addr.send(StartFlowMsg(flow)).await {
        Ok(Ok(Some(returned_channel_id))) => {
            info!(
                session_id = %session_id,
                actor_id = %actor_id,
                channel_id = returned_channel_id,
                "actor started pairing as initiator"
            );
            (
                StatusCode::OK,
                Json(serde_json::json!({ "channel_id": returned_channel_id.to_string() })),
            )
                .into_response()
        }
        Ok(Ok(None)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "pairing returned no channel ID" })),
        )
            .into_response(),
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
