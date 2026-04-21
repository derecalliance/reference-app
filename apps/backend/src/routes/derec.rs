use std::sync::Arc;

use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use tracing::{info, error};
use uuid::Uuid;

use derec_library::protocol::DeRecEvent;
use crate::{
    models::Role,
    state::AppState,
};

// ── Response types ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct MailboxMessage {
    /// Raw wire bytes, base64url-encoded for JSON transport.
    /// The client decodes this and feeds the bytes directly to the protocol.
    pub data: String,
}

#[derive(Debug, Serialize)]
pub struct PollMessagesResponse {
    pub messages: Vec<MailboxMessage>,
}

// ── Role validation ───────────────────────────────────────────────────────────

fn parse_role(s: &str) -> Option<Role> {
    match s {
        "owners" => Some(Role::Owner),
        "helpers" => Some(Role::Helper),
        _ => None,
    }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/// POST /derec/sessions/:session_id/:role/:actor_id
///
/// For **helpers with a backend protocol instance**: feeds the message directly
/// to the helper's `DeRecProtocol::process()`. The protocol handles decryption,
/// state updates, and sends any outbound replies via the transport. The message
/// is NOT queued in the mailbox — the backend IS the helper.
///
/// For **owners** (or actors without a protocol instance): deposits the raw
/// binary message into the actor's mailbox for frontend polling.
pub async fn deliver_message(
    State(state): State<Arc<AppState>>,
    Path((session_id, role, actor_id)): Path<(Uuid, String, Uuid)>,
    body: Bytes,
) -> Response {
    let actor_role = match parse_role(&role) {
        Some(r) => r,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "unknown role — expected 'owners' or 'helpers'" })),
            )
                .into_response();
        }
    };

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

    if !session.actors.iter().any(|a| a.id == actor_id && a.role == actor_role) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "actor not found in session" })),
        )
            .into_response();
    }

    if body.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "empty message body" })),
        )
            .into_response();
    }

    // If this actor has a backend-managed helper protocol, process inline.
    // The protocol's trait futures are not Send (Pin<Box<dyn Future + 'a>>),
    // so we use block_in_place + block_on to drive them on the current thread
    // without requiring Send on the handler's future.
    if let Some(protocol_lock) = state.helper_protocols.get(&actor_id) {
        let protocol_lock = protocol_lock.value().clone();

        let result = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                let mut protocol = protocol_lock.lock().await;
                protocol.process(&body).await
            })
        });

        match result {
            Ok(events) => {
                for event in &events {
                    if let DeRecEvent::PairingComplete { channel_id, .. } = event {
                        let cid = channel_id.0.to_string();
                        // If this helper already has a paired channel, the new
                        // pairing is a recovery: park it in pending_associations
                        // until the helper user explicitly associates the channels.
                        let already_paired = state.helper_channels.contains_key(&actor_id);
                        if already_paired {
                            state.pending_associations.insert(actor_id, cid.clone());
                            info!(
                                session_id = %session_id,
                                actor_id = %actor_id,
                                channel_id = channel_id.0,
                                "recovery pairing complete — awaiting channel association"
                            );
                        } else {
                            state.helper_channels.insert(actor_id, cid.clone());
                            info!(
                                session_id = %session_id,
                                actor_id = %actor_id,
                                channel_id = channel_id.0,
                                "helper pairing complete — channel recorded"
                            );
                        }
                    }
                }
                if !events.is_empty() {
                    info!(
                        session_id = %session_id,
                        actor_id = %actor_id,
                        event_count = events.len(),
                        "helper protocol processed message"
                    );
                }
            }
            Err(e) => {
                error!(
                    session_id = %session_id,
                    actor_id = %actor_id,
                    error = %e,
                    "helper protocol process() failed"
                );
            }
        }

        return StatusCode::ACCEPTED.into_response();
    }

    // Otherwise, queue in mailbox for frontend polling (owner actors).
    state
        .mailboxes
        .entry(actor_id)
        .or_default()
        .push(body.to_vec());

    info!(
        session_id = %session_id,
        actor_id = %actor_id,
        role = %role,
        bytes = body.len(),
        "message delivered to mailbox"
    );

    StatusCode::ACCEPTED.into_response()
}

/// GET /derec/sessions/:session_id/:role/:actor_id/mailbox
///
/// Drains and returns all pending messages from an actor's mailbox.
/// Each message is base64url-encoded for JSON transport. The client decodes
/// each `data` field and feeds the raw bytes to the protocol.
pub async fn poll_mailbox(
    State(state): State<Arc<AppState>>,
    Path((session_id, role, actor_id)): Path<(Uuid, String, Uuid)>,
) -> Response {
    if parse_role(&role).is_none() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "unknown role — expected 'owners' or 'helpers'" })),
        )
            .into_response();
    }

    if !state.sessions.contains_key(&session_id) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        )
            .into_response();
    }

    let raw_messages: Vec<Vec<u8>> = state
        .mailboxes
        .get_mut(&actor_id)
        .map(|mut m| std::mem::take(m.value_mut()))
        .unwrap_or_default();

    if !raw_messages.is_empty() {
        info!(
            session_id = %session_id,
            actor_id = %actor_id,
            count = raw_messages.len(),
            "mailbox drained"
        );
    }

    let messages: Vec<MailboxMessage> = raw_messages
        .into_iter()
        .map(|bytes| MailboxMessage {
            data: URL_SAFE_NO_PAD.encode(&bytes),
        })
        .collect();

    (StatusCode::OK, Json(PollMessagesResponse { messages })).into_response()
}
