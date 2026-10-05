// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use tracing::info;
use uuid::Uuid;

use crate::{
    actor::IncomingMessage,
    registry::mailbox::EnqueueError,
    routes::actor_guard::not_found,
    routes::api_error::{ApiBytes, ApiError, ApiJson, ApiPath},
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
    /// A browser actor's mailbox is at its cap; the message was refused and
    /// nothing already queued was touched. See [`crate::registry::mailbox`].
    MailboxFull,
    /// The mailbox could not be written — the database failed. The message
    /// was not queued, so the sender must see a failure and retry.
    Unavailable,
}

/// The cleartext channel id of `bytes`, when there is one worth recording.
///
/// `0` is the proto3 default, so an empty or garbled body decodes to it; it
/// names no channel and is reported as unknown rather than as "channel 0".
fn channel_of(bytes: &[u8]) -> Option<u64> {
    crate::envelope::decode(bytes)
        .ok()
        .map(|m| m.channel_id)
        .filter(|&channel_id| channel_id != 0)
}

/// Hand raw wire bytes to an actor's inbox.
///
/// Shared by both transports so a suspended helper drops gRPC traffic exactly
/// as it drops HTTP, and so a browser actor receives over gRPC without knowing
/// that is what happened.
pub async fn dispatch_to_inbox(
    state: &AppState,
    actor_id: Uuid,
    carrier: crate::debug::Carrier,
    bytes: Vec<u8>,
) -> DispatchOutcome {
    dispatch_to_inbox_noting(
        state,
        actor_id,
        carrier,
        bytes,
        "delivered to the actor's inbox",
    )
    .await
}

/// [`dispatch_to_inbox`], recording `delivered` as the event's detail when the
/// message lands — so a local delivery reads differently in the log from one
/// that came in over a listener.
pub async fn dispatch_to_inbox_noting(
    state: &AppState,
    actor_id: Uuid,
    carrier: crate::debug::Carrier,
    bytes: Vec<u8>,
    delivered: &str,
) -> DispatchOutcome {
    use crate::debug::{Direction, Outcome};

    let len = bytes.len();
    // Correlation key for anyone reading the log. Best effort: a body that
    // will not decode is still worth recording — that it arrived at all is
    // the interesting part — so a failure here yields `None`, not an early
    // return that would lose the event.
    let channel_id = channel_of(&bytes);

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

    // A registry failure here is treated as "not disabled": dropping a
    // message because the database hiccuped would silently lose protocol
    // traffic, which is worse than delivering to a helper the operator meant
    // to have switched off.
    if state
        .disabled_helpers
        .is_disabled(&actor_id)
        .await
        .unwrap_or(false)
    {
        info!(actor_id = %actor_id, bytes = len, "message dropped — actor is offline");
        record(Outcome::Dropped, "actor is simulating offline; message discarded");
        return DispatchOutcome::Dropped;
    }

    // Resolved and released before any `.await`: a `DashMap` guard held
    // across one would block every other writer to the same shard.
    let provisioned = match state.actor_inboxes.get(&actor_id) {
        None => {
            record(Outcome::Refused, "actor has no inbox registered");
            return DispatchOutcome::NoInbox;
        }
        Some(entry) => match entry.value() {
            ActorInbox::Provisioned(addr) => Some(addr.clone()),
            ActorInbox::Browser => None,
        },
    };

    match provisioned {
        Some(addr) => addr.do_send(IncomingMessage(bytes)),
        None => match state.mailboxes.enqueue(&actor_id, &bytes).await {
            Ok(()) => {}
            Err(EnqueueError::Full { queued, bytes: waiting }) => {
                tracing::warn!(
                    actor_id = %actor_id,
                    queued,
                    waiting,
                    "browser mailbox full; message refused"
                );
                record(
                    Outcome::Refused,
                    "recipient's mailbox is full; it has not polled for a while",
                );
                return DispatchOutcome::MailboxFull;
            }
            Err(EnqueueError::Backend(e)) => {
                tracing::error!(actor_id = %actor_id, error = %e, "browser mailbox unwritable");
                record(Outcome::Refused, "recipient's mailbox could not be written");
                return DispatchOutcome::Unavailable;
            }
        },
    }

    info!(actor_id = %actor_id, bytes = len, "message delivered to inbox");
    record(Outcome::Delivered, delivered);
    DispatchOutcome::Delivered
}

/// POST /derec/:actor_id
///
/// The transport endpoint peers post protocol messages to. The actor id is a
/// UUID and identifies the actor by itself — there is no role segment to
/// check.
pub async fn deliver_message(
    State(state): State<Arc<AppState>>,
    ApiPath(actor_id): ApiPath<Uuid>,
    ApiBytes(body): ApiBytes,
) -> Response {
    match state.actors.get(&actor_id).await {
        Ok(None) => return not_found("actor not found"),
        Err(e) => return crate::routes::actor_guard::registry_unavailable(e),
        Ok(Some(_)) => {}
    }

    if body.is_empty() {
        return ApiError::bad_request("empty message body").into_response();
    }

    match dispatch_to_inbox(&state, actor_id, crate::debug::Carrier::Http, body.to_vec()).await {
        DispatchOutcome::Delivered | DispatchOutcome::Dropped => {
            StatusCode::ACCEPTED.into_response()
        }
        DispatchOutcome::NoInbox => not_found("actor inbox not found"),
        DispatchOutcome::MailboxFull => ApiError::service_unavailable(
            "the recipient's mailbox is full; it has not polled for a while",
        )
        .into_response(),
        DispatchOutcome::Unavailable => {
            ApiError::service_unavailable("the recipient's mailbox could not be written")
                .into_response()
        }
    }
}

/// GET /derec/:actor_id/mailbox
///
/// Drains a browser actor's queue, oldest first. `404` for an id this node
/// does not know; `400` for a provisioned actor, whose messages go straight to
/// its in-process instance and never queue.
pub async fn poll_mailbox(
    State(state): State<Arc<AppState>>,
    ApiPath(actor_id): ApiPath<Uuid>,
) -> Response {
    match state.actors.contains(&actor_id).await {
        Ok(false) => return not_found("actor not found"),
        Err(e) => return crate::routes::actor_guard::registry_unavailable(e),
        Ok(true) => {}
    }

    if !state.is_browser_managed(&actor_id) {
        return ApiError::bad_request(
            "this actor runs on the backend; only browser-managed actors have a mailbox to poll",
        )
        .into_response();
    }

    let raw_messages = match state.mailboxes.drain(&actor_id).await {
        Ok(messages) => messages,
        Err(e) => {
            tracing::error!(actor_id = %actor_id, error = %e, "mailbox unreadable");
            return ApiError::internal("mailbox unavailable").into_response();
        }
    };

    // Recorded only once the drain succeeded: a poll that could not read the
    // mailbox delivered nothing, so it is not evidence the tab is keeping up.
    state
        .mailbox_polls
        .insert(actor_id, crate::timestamp::now_unix_ms());

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
    /// The browser-run actor on whose behalf this is relayed. Optional, and
    /// used only to attribute the relay's events in `/debug/events` and as
    /// the sender when the target is a channel on this node; it is not an
    /// authenticator. When present it must name an actor on this node.
    #[serde(default)]
    pub actor_id: Option<Uuid>,
}

/// The JSON body `POST /derec/relay` accepts: room for a
/// [`crate::transport::MAX_MESSAGE_BYTES`] message once base64url-encoded
/// (four characters per three bytes), plus headroom for the URI and the rest
/// of the envelope. Anything the gRPC listener accepts can therefore be
/// relayed; the decoded message is held to the same limit in the handler.
pub const RELAY_BODY_LIMIT: usize =
    crate::transport::MAX_MESSAGE_BYTES.div_ceil(3) * 4 + 64 * 1024;

/// Where the relay will deliver a target, or why it will not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayTarget {
    /// The target is this node, under a name it has now or had before:
    /// delivered in-process, never dialled.
    Local(crate::addresses::OwnTarget),
    /// Another node the relay may dial.
    Remote,
    /// Refused, with the reason the caller is told.
    Refused(RelayRefusal),
}

/// Why the relay will not deliver to a target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayRefusal {
    /// Another node, not named in `server.relay_allowed_hosts`.
    NotAllowed,
    /// This node's own gRPC address, while gRPC is disabled here.
    GrpcDisabled,
    /// Not an endpoint the relay can dial at all.
    Malformed,
}

/// Decide where the relay may deliver `uri`.
///
/// The relay exists so a browser owner can reach a gRPC peer it cannot dial
/// itself. Without a limit it would be a general-purpose proxy, so it admits:
///
/// 1. this node, under any address it answers to now or advertised before
///    ([`crate::addresses::own_target`]) — delivered locally, so an address
///    this node no longer listens on (a republished container port) still
///    works for a browser that was paired before the move;
/// 2. an endpoint some actor on this node advertises right now;
/// 3. another node the operator listed in `server.relay_allowed_hosts`
///    (`DEREC_RELAY_ALLOWED_HOSTS`), or any node when it is `*`.
///
/// A registry failure denies rather than allows: failing open would turn the
/// allowlist into a proxy.
pub async fn relay_target(state: &AppState, uri: &str) -> RelayTarget {
    if let Some(target) = crate::addresses::own_target(state, uri) {
        return match target {
            crate::addresses::OwnTarget::GrpcListener { served: false } => {
                RelayTarget::Refused(RelayRefusal::GrpcDisabled)
            }
            target => RelayTarget::Local(target),
        };
    }

    let Some((host, port)) = dialable(uri) else {
        return RelayTarget::Refused(RelayRefusal::Malformed);
    };

    let advertised = state
        .actors
        .all()
        .await
        .map(|actors| {
            actors
                .iter()
                .any(|actor| actor.transports.iter().any(|t| t.uri == uri))
        })
        .unwrap_or(false);
    if advertised
        || state
            .config
            .settings
            .server
            .relay_allowlist()
            .allows(&host, port)
    {
        RelayTarget::Remote
    } else {
        RelayTarget::Refused(RelayRefusal::NotAllowed)
    }
}

/// The lowercased host and port of an endpoint the relay could dial: `grpc://`
/// with an explicit port and no path, or `http(s)://`; never with credentials,
/// a query or a fragment.
fn dialable(uri: &str) -> Option<(String, u16)> {
    let url = reqwest::Url::parse(uri).ok()?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let port = match url.scheme() {
        "grpc" if matches!(url.path(), "" | "/") => url.port()?,
        "http" | "https" => url.port_or_known_default()?,
        _ => return None,
    };
    Some((url.host_str()?.to_ascii_lowercase(), port))
}

/// POST /derec/relay
///
/// Dial an endpoint on a browser owner's behalf. A browser has no HTTP/2
/// trailer access and so cannot speak gRPC; the backend already terminates
/// transport for every actor here, so performing the dial is a small extension
/// of that rather than a new role. A target on this node is delivered
/// in-process instead of dialled.
///
/// `data` must be a DeRec envelope naming a channel: anything else is refused
/// with `400` before any delivery, rather than surfacing as the peer's `502`.
/// Every refusal is recorded in `/debug/events` with its reason.
pub async fn relay(
    State(state): State<Arc<AppState>>,
    ApiJson(req): ApiJson<RelayRequest>,
) -> Response {
    let relay = Relay {
        state: &state,
        uri: &req.uri,
        actor_id: req.actor_id,
        carrier: if req.uri.starts_with("grpc") {
            crate::debug::Carrier::GrpcViaRelay
        } else {
            crate::debug::Carrier::HttpViaRelay
        },
    };

    if !state.defaults.grpc_relay_enabled {
        return relay.refuse(
            None,
            0,
            ApiError::service_unavailable(
                "relay disabled on this node (defaults.grpc_relay_enabled / \
                 DEREC_GRPC_RELAY_ENABLED)",
            ),
        );
    }

    if let Some(actor_id) = req.actor_id {
        match state.actors.contains(&actor_id).await {
            Ok(true) => {}
            Ok(false) => {
                return relay.refuse(
                    None,
                    0,
                    ApiError::bad_request("actor_id names no actor on this node"),
                );
            }
            Err(e) => return crate::routes::actor_guard::registry_unavailable(e),
        }
    }

    let Ok(bytes) = URL_SAFE_NO_PAD.decode(&req.data) else {
        return relay.refuse(None, 0, ApiError::bad_request("data is not base64url"));
    };
    let len = bytes.len();
    if bytes.is_empty() {
        return relay.refuse(None, len, ApiError::bad_request("data is empty"));
    }
    if len > crate::transport::MAX_MESSAGE_BYTES {
        return relay.refuse(
            None,
            len,
            ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                format!(
                    "data decodes to {len} bytes; the most a DeRec message may be is {} \
                     bytes (4 MiB), what a gRPC peer accepts",
                    crate::transport::MAX_MESSAGE_BYTES
                ),
            ),
        );
    }
    let Some(channel_id) = channel_of(&bytes) else {
        return relay.refuse(
            None,
            len,
            ApiError::bad_request("data is not a DeRec envelope naming a channel"),
        );
    };

    match relay_target(&state, &req.uri).await {
        RelayTarget::Local(target) => relay.locally(target, channel_id, bytes).await,
        RelayTarget::Remote => relay.dial(channel_id, bytes).await,
        RelayTarget::Refused(refusal) => {
            let error = match refusal {
                RelayRefusal::NotAllowed => ApiError::new(
                    StatusCode::FORBIDDEN,
                    format!(
                        "relay target {} is not this node and not an allowed host; to relay \
                         to another node, add its host or host:port to \
                         server.relay_allowed_hosts (DEREC_RELAY_ALLOWED_HOSTS) on this node, \
                         or \"*\" to allow any host on a trusted network",
                        req.uri
                    ),
                ),
                RelayRefusal::GrpcDisabled => ApiError::conflict(format!(
                    "relay target {} is this node's gRPC address, but gRPC is disabled here \
                     (defaults.grpc_enabled / DEREC_GRPC_ENABLED), so nothing answers on it",
                    req.uri
                )),
                RelayRefusal::Malformed => ApiError::bad_request(format!(
                    "relay target {} is not an endpoint the relay can dial: it must be \
                     grpc://host:port or http(s)://host[:port]/path, with no credentials, \
                     query or fragment",
                    req.uri
                )),
            };
            relay.refuse(Some(channel_id), len, error)
        }
    }
}

/// One relay request, for recording what became of it.
struct Relay<'a> {
    state: &'a AppState,
    uri: &'a str,
    /// The requesting actor, when the request named one.
    actor_id: Option<Uuid>,
    carrier: crate::debug::Carrier,
}

impl Relay<'_> {
    /// Record a refusal with its reason, then answer with it. Refusals used to
    /// leave no trace in the event log, which is where a reader looks first.
    fn refuse(&self, channel_id: Option<u64>, len: usize, error: ApiError) -> Response {
        self.record(
            crate::debug::Outcome::Refused,
            channel_id,
            len,
            format!("relay to {} refused: {}", self.uri, error.message),
        );
        error.into_response()
    }

    fn record(
        &self,
        outcome: crate::debug::Outcome,
        channel_id: Option<u64>,
        len: usize,
        detail: String,
    ) {
        // The browser could not deliver this itself, so from a reader's point
        // of view the message left *here*. Tagged with the relay, which is the
        // only way to tell relayed traffic from this server's own.
        self.state.events.record(
            crate::debug::Direction::Outbound,
            self.carrier,
            outcome,
            self.actor_id,
            channel_id,
            len,
            detail,
        );
    }

    /// Deliver to an actor on this node without dialling.
    async fn locally(
        &self,
        target: crate::addresses::OwnTarget,
        channel_id: u64,
        bytes: Vec<u8>,
    ) -> Response {
        let len = bytes.len();
        match crate::local::deliver(self.state, target, self.uri, bytes, self.actor_id).await {
            Ok(DispatchOutcome::Delivered | DispatchOutcome::Dropped) => {
                self.record(
                    crate::debug::Outcome::Delivered,
                    Some(channel_id),
                    len,
                    format!(
                        "relayed on a browser owner's behalf to {} — this node, so delivered \
                         without a dial",
                        self.uri
                    ),
                );
                StatusCode::ACCEPTED.into_response()
            }
            Ok(DispatchOutcome::MailboxFull) => self.refuse(
                Some(channel_id),
                len,
                ApiError::service_unavailable(
                    "the recipient's mailbox is full; it has not polled for a while",
                ),
            ),
            Ok(DispatchOutcome::Unavailable) => self.refuse(
                Some(channel_id),
                len,
                ApiError::service_unavailable("the recipient's mailbox could not be written"),
            ),
            Ok(DispatchOutcome::NoInbox) => self.refuse(
                Some(channel_id),
                len,
                ApiError::bad_gateway("relay delivery failed: the recipient has no inbox here"),
            ),
            Err(not_here) => self.refuse(
                Some(channel_id),
                len,
                ApiError::bad_gateway(format!("relay delivery failed: {not_here}")),
            ),
        }
    }

    /// Dial another node. Bounded on both legs: the gRPC client's own connect
    /// and request timeouts, and the shared HTTP client's.
    async fn dial(&self, channel_id: u64, bytes: Vec<u8>) -> Response {
        let transport = crate::transport::CompositeTransport::new(
            crate::transport::HttpTransport::new(self.state.http_client.clone()),
            crate::transport::GrpcTransport::new(),
        );
        let endpoint = derec_proto::TransportProtocol {
            protocol: if self.uri.starts_with("grpc") {
                derec_proto::Protocol::Grpc as i32
            } else {
                derec_proto::Protocol::Https as i32
            },
            uri: self.uri.to_owned(),
        };
        let len = bytes.len();

        use derec_library::protocol::DeRecTransport as _;
        match transport.send(std::slice::from_ref(&endpoint), bytes).await {
            Ok(()) => {
                self.record(
                    crate::debug::Outcome::Delivered,
                    Some(channel_id),
                    len,
                    format!("relayed on a browser owner's behalf to {}", self.uri),
                );
                StatusCode::ACCEPTED.into_response()
            }
            Err(e) => {
                tracing::error!(uri = %self.uri, error = %e, "relay delivery failed");
                self.refuse(
                    Some(channel_id),
                    len,
                    ApiError::bad_gateway(format!("relay delivery failed: {e}")),
                )
            }
        }
    }
}
