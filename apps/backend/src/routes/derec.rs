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
use tracing::info;
use uuid::Uuid;

use crate::{
    actor::IncomingMessage,
    models::Role,
    state::{ActorInbox, AppState},
};

#[derive(Debug, Serialize)]
pub struct MailboxMessage {
    /// Raw wire bytes, base64url-encoded for JSON transport.
    pub data: String,
}

#[derive(Debug, Serialize)]
pub struct PollMessagesResponse {
    pub messages: Vec<MailboxMessage>,
}

fn parse_role(s: &str) -> Option<Role> {
    match s {
        "owners" => Some(Role::Owner),
        "participants" => Some(Role::Participant),
        "replicas" => Some(Role::Replica),
        _ => None,
    }
}

/// POST /derec/sessions/:session_id/:role/:actor_id
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
                Json(serde_json::json!({ "error": "unknown role — expected 'owners', 'participants', or 'replicas'" })),
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

    if state.disabled_participants.contains_key(&actor_id)
        || state.disabled_replicas.contains_key(&actor_id)
    {
        info!(
            session_id = %session_id,
            actor_id = %actor_id,
            bytes = body.len(),
            "message dropped — actor is offline"
        );
        return StatusCode::ACCEPTED.into_response();
    }

    match state.actor_inboxes.get(&actor_id) {
        Some(entry) => {
            match entry.value() {
                ActorInbox::Browser(tx) => {
                    let _ = tx.send(body.to_vec());
                }
                ActorInbox::Provisioned(addr) => {
                    addr.do_send(IncomingMessage(body.to_vec()));
                }
            }
            info!(
                session_id = %session_id,
                actor_id = %actor_id,
                role = %role,
                bytes = body.len(),
                "message delivered to inbox"
            );
            StatusCode::ACCEPTED.into_response()
        }
        None => {
            (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "actor inbox not found" })),
            )
                .into_response()
        }
    }
}

/// GET /derec/sessions/:session_id/:role/:actor_id/mailbox
pub async fn poll_mailbox(
    State(state): State<Arc<AppState>>,
    Path((session_id, role, actor_id)): Path<(Uuid, String, Uuid)>,
) -> Response {
    if parse_role(&role).is_none() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "unknown role — expected 'owners', 'participants', or 'replicas'" })),
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

    let raw_messages: Vec<Vec<u8>> = match state.browser_receivers.get(&actor_id) {
        Some(receiver_lock) => {
            let mut receiver = receiver_lock.lock().await;
            let mut msgs = Vec::new();
            while let Ok(msg) = receiver.try_recv() {
                msgs.push(msg);
            }
            msgs
        }
        None => Vec::new(),
    };

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
