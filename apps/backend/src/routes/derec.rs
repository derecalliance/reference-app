use std::sync::Arc;

use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use tracing::info;
use uuid::Uuid;

use crate::{
    actor::IncomingMessage,
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

/// What happened to a message handed to an actor's inbox.
#[derive(Debug, PartialEq, Eq)]
pub enum DispatchOutcome {
    Delivered,
    /// The actor is simulating offline; the message is discarded, not queued.
    Dropped,
    NoInbox,
}

/// Hand raw wire bytes to an actor's inbox.
///
/// Shared by both transports so a suspended helper drops gRPC traffic exactly
/// as it drops HTTP, and so a browser actor receives over gRPC without knowing
/// that is what happened.
pub fn dispatch_to_inbox(
    state: &AppState,
    actor_id: Uuid,
    carrier: crate::debug::Carrier,
    bytes: Vec<u8>,
) -> DispatchOutcome {
    use crate::debug::{Direction, Outcome};

    let len = bytes.len();
    // Correlation key for anyone reading the log. Best effort: a body that
    // will not decode is still worth recording — that it arrived at all is
    // the interesting part — so a failure here yields `None`, not an early
    // return that would lose the event.
    let channel_id = crate::envelope::decode(&bytes).ok().map(|m| m.channel_id);

    let record = |outcome: Outcome, detail: &str| {
        state.events.record(
            Direction::Inbound,
            carrier,
            outcome,
            Some(actor_id),
            channel_id,
            len,
            detail,
        );
    };

    if state.disabled_helpers.contains_key(&actor_id) {
        info!(actor_id = %actor_id, bytes = len, "message dropped — actor is offline");
        record(Outcome::Dropped, "actor is simulating offline; message discarded");
        return DispatchOutcome::Dropped;
    }

    match state.actor_inboxes.get(&actor_id) {
        Some(entry) => {
            match entry.value() {
                ActorInbox::Browser(tx) => {
                    let _ = tx.send(bytes);
                }
                ActorInbox::Provisioned(addr) => {
                    addr.do_send(IncomingMessage(bytes));
                }
            }
            info!(actor_id = %actor_id, bytes = len, "message delivered to inbox");
            record(Outcome::Delivered, "delivered to the actor's inbox");
            DispatchOutcome::Delivered
        }
        None => {
            record(Outcome::Refused, "actor has no inbox registered");
            DispatchOutcome::NoInbox
        }
    }
}

/// POST /derec/:actor_id
///
/// The transport endpoint peers post protocol messages to. The actor id is a
/// UUID and identifies the actor by itself — there is no role segment to
/// check.
pub async fn deliver_message(
    State(state): State<Arc<AppState>>,
    Path(actor_id): Path<Uuid>,
    body: Bytes,
) -> Response {
    if state.actors.get(&actor_id).is_none() {
        return not_found("actor not found");
    }

    if body.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "empty message body" })),
        )
            .into_response();
    }

    match dispatch_to_inbox(&state, actor_id, crate::debug::Carrier::Http, body.to_vec()) {
        DispatchOutcome::Delivered | DispatchOutcome::Dropped => {
            StatusCode::ACCEPTED.into_response()
        }
        DispatchOutcome::NoInbox => not_found("actor inbox not found"),
    }
}

/// GET /derec/:actor_id/mailbox
pub async fn poll_mailbox(
    State(state): State<Arc<AppState>>,
    Path(actor_id): Path<Uuid>,
) -> Response {
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

#[derive(Debug, Deserialize)]
pub struct RelayRequest {
    /// The endpoint to deliver to, as the peer advertised it.
    pub uri: String,
    /// Raw wire bytes, base64url-encoded — the same encoding
    /// [`MailboxMessage`] uses in the other direction.
    pub data: String,
}

/// Whether any registered actor currently advertises `uri`.
///
/// The relay exists so a browser owner can reach a gRPC peer it cannot dial
/// itself. Restricting it to advertised endpoints is what keeps it from being
/// a general-purpose proxy.
pub fn relay_target_is_known(state: &AppState, uri: &str) -> bool {
    state
        .actors
        .all()
        .iter()
        .any(|actor| actor.transports.iter().any(|t| t.uri == uri))
}

/// POST /derec/relay
///
/// Dial an endpoint on a browser owner's behalf. A browser has no HTTP/2
/// trailer access and so cannot speak gRPC; the backend already terminates
/// transport for every actor here, so performing the dial is a small extension
/// of that rather than a new role.
pub async fn relay(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RelayRequest>,
) -> Response {
    if !state.defaults.grpc_relay_enabled {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "relay disabled" })),
        )
            .into_response();
    }

    if !relay_target_is_known(&state, &req.uri) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "unknown relay target" })),
        )
            .into_response();
    }

    let Ok(bytes) = URL_SAFE_NO_PAD.decode(&req.data) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "invalid base64url payload" })),
        )
            .into_response();
    };

    let transport = crate::transport::CompositeTransport::new(
        crate::transport::HttpTransport::new(state.http_client.clone()),
        crate::transport::GrpcTransport::new(),
    );
    let endpoint = derec_proto::TransportProtocol {
        protocol: if req.uri.starts_with("grpc") {
            derec_proto::Protocol::Grpc as i32
        } else {
            derec_proto::Protocol::Https as i32
        },
        uri: req.uri.clone(),
    };

    // The browser could not dial this itself, so from a reader's point of view
    // the message left *here*. Recorded as such, tagged with the relay, which
    // is the only way to tell relayed traffic from this server's own.
    use crate::debug::{Carrier, Direction, Outcome};
    let carrier = if req.uri.starts_with("grpc") {
        Carrier::GrpcViaRelay
    } else {
        Carrier::Http
    };
    let channel_id = crate::envelope::decode(&bytes).ok().map(|m| m.channel_id);
    let len = bytes.len();

    use derec_library::protocol::DeRecTransport as _;
    match transport.send(std::slice::from_ref(&endpoint), bytes).await {
        Ok(()) => {
            state.events.record(
                Direction::Outbound,
                carrier,
                Outcome::Delivered,
                None,
                channel_id,
                len,
                format!("relayed on a browser owner's behalf to {}", req.uri),
            );
            StatusCode::ACCEPTED.into_response()
        }
        Err(e) => {
            state.events.record(
                Direction::Outbound,
                carrier,
                Outcome::Refused,
                None,
                channel_id,
                len,
                format!("relay to {} failed: {e}", req.uri),
            );
            tracing::error!(uri = %req.uri, error = %e, "relay delivery failed");
            (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": "relay delivery failed" })),
            )
                .into_response()
        }
    }
}
