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
    routes::actor_guard::not_found,
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

fn unknown_role() -> Response {
    not_found("unknown role — expected 'owners', 'participants', or 'replicas'")
}

/// POST /derec/:role/:actor_id
///
/// The transport endpoint peers post protocol messages to. The `:role` segment
/// is part of the URI baked into every contact this actor hands out, so it is
/// checked against the registry rather than ignored — a message addressed to
/// the right id under the wrong role is not for this actor.
pub async fn deliver_message(
    State(state): State<Arc<AppState>>,
    Path((role, actor_id)): Path<(String, Uuid)>,
    body: Bytes,
) -> Response {
    let Some(actor_role) = Role::from_path_segment(&role) else {
        return unknown_role();
    };

    match state.actors.get(&actor_id) {
        Some(actor) if actor.role == actor_role => {}
        _ => return not_found("actor not found"),
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
                actor_id = %actor_id,
                role = %role,
                bytes = body.len(),
                "message delivered to inbox"
            );
            StatusCode::ACCEPTED.into_response()
        }
        None => not_found("actor inbox not found"),
    }
}

/// GET /derec/:role/:actor_id/mailbox
pub async fn poll_mailbox(
    State(state): State<Arc<AppState>>,
    Path((role, actor_id)): Path<(String, Uuid)>,
) -> Response {
    if Role::from_path_segment(&role).is_none() {
        return unknown_role();
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
