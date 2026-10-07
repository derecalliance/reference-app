// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Getting protocol messages to actors: the HTTP transport route, gRPC
//! ingress, browser mailboxes, the relay, and delivery to this node's own
//! actors without a dial.
//!
//! Every way a message can arrive ends in [`DeliveryService::dispatch`], so a
//! simulated-offline helper drops gRPC traffic exactly as it drops HTTP, a full
//! browser mailbox refuses a relayed message exactly as it refuses a posted
//! one, and a browser actor receives over gRPC without knowing that is what
//! happened.

use std::sync::Arc;

use async_trait::async_trait;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use tracing::info;
use uuid::Uuid;

use super::ports::{ChannelRoutes, EventRecorder, InboxDirectory, OwnEndpoints};
use super::ServiceError;
use crate::models::{
    Carrier, Direction, DispatchOutcome, EnvelopeMeta, InboxKind, LocalAttempt, NewEvent,
    NodeConfig, Outcome, OwnTarget, RelayRefusal, RelayRequest, RelayTarget, Resolution,
    SENDER_METADATA,
};
use crate::repositories::actors::ActorRepository;
use crate::repositories::disabled_helpers::DisabledHelperRepository;
use crate::repositories::mailbox_polls::MailboxPollRepository;
use crate::repositories::mailboxes::MailboxRepository;
use crate::repositories::RepositoryError;
use crate::utils::time::now_unix_ms;

/// The largest DeRec message this node accepts on any transport, in raw
/// (decoded) bytes: 4 MiB.
///
/// The figure is the gRPC listener's — tonic's default decoding limit, set
/// explicitly on the listener so the two cannot drift — and the HTTP transport
/// route and the relay are held to the same one, so a message that can travel
/// one way can travel every way.
pub const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

/// Why a message addressed to this node has no recipient here.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct NotHere(pub String);

/// Why gRPC ingress refused a message. Each maps to the gRPC status a peer's
/// transport sees.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GrpcRefusal {
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    FailedPrecondition(String),
    #[error("{0}")]
    ResourceExhausted(String),
    #[error("{0}")]
    Unavailable(String),
}

/// Why a dial delivered nothing.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct DialError(pub String);

/// Dials another node, for the relay. Bounded on every leg by the transports'
/// own connect and request timeouts.
#[async_trait]
pub trait PeerDialer: Send + Sync {
    async fn dial(&self, uri: &str, bytes: Vec<u8>) -> Result<(), DialError>;
}

/// Delivery to this node's own actors without a dial, for an actor's outbound
/// transport.
///
/// Dialling an endpoint that names this node is pointless even when it works,
/// and fails outright for an address this node advertised before and no
/// longer listens on — so a sender asks here first.
#[async_trait]
pub trait LocalDelivery: Send + Sync {
    /// Deliver `bytes`, addressed to `uri`, straight into the recipient's
    /// inbox when `uri` names this node. `sender` is the sending actor, when
    /// known: a message is never for the actor that sent it.
    async fn deliver_local(&self, uri: &str, bytes: &[u8], sender: Option<Uuid>) -> LocalAttempt;
}

#[async_trait]
pub trait DeliveryService: Send + Sync {
    /// A message a peer posted to an actor's HTTP transport endpoint.
    async fn deliver(&self, actor_id: Uuid, body: Vec<u8>) -> Result<(), ServiceError>;

    /// Drain a browser actor's queue, oldest first. A provisioned actor has
    /// no mailbox: its messages go straight to its in-process instance.
    async fn poll_mailbox(&self, actor_id: Uuid) -> Result<Vec<Vec<u8>>, ServiceError>;

    /// Dial an endpoint on a browser owner's behalf — a browser has no HTTP/2
    /// trailer access and so cannot speak gRPC — or deliver in-process when
    /// the endpoint is this node. Every refusal is recorded with its reason.
    async fn relay(&self, request: RelayRequest) -> Result<(), ServiceError>;

    /// A message that arrived on the gRPC listener, routed by its channel id.
    async fn receive_grpc(
        &self,
        envelope: derec_proto::DeRecMessage,
        sender: Option<Uuid>,
    ) -> Result<(), GrpcRefusal>;

    /// Hand raw wire bytes to an actor's inbox, recording what became of
    /// them.
    async fn dispatch(&self, actor_id: Uuid, carrier: Carrier, bytes: Vec<u8>) -> DispatchOutcome;

    /// Deliver `bytes`, addressed to `target` on this node, straight into the
    /// recipient's inbox. [`NotHere`] means nothing on this node holds what
    /// the message names; the caller decides whether to dial instead.
    async fn deliver_to_own_target(
        &self,
        target: OwnTarget,
        uri: &str,
        bytes: Vec<u8>,
        sender: Option<Uuid>,
    ) -> Result<DispatchOutcome, NotHere>;

    /// Decide where the relay may deliver `uri`.
    async fn relay_target(&self, uri: &str) -> RelayTarget;
}

pub struct DeliveryServiceImpl {
    config: Arc<NodeConfig>,
    actors: Arc<dyn ActorRepository>,
    disabled_helpers: Arc<dyn DisabledHelperRepository>,
    mailboxes: Arc<dyn MailboxRepository>,
    polls: Arc<dyn MailboxPollRepository>,
    inboxes: Arc<dyn InboxDirectory>,
    routes: Arc<dyn ChannelRoutes>,
    events: Arc<dyn EventRecorder>,
    endpoints: Arc<dyn OwnEndpoints>,
    dialer: Arc<dyn PeerDialer>,
}

impl DeliveryServiceImpl {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        config: Arc<NodeConfig>,
        actors: Arc<dyn ActorRepository>,
        disabled_helpers: Arc<dyn DisabledHelperRepository>,
        mailboxes: Arc<dyn MailboxRepository>,
        polls: Arc<dyn MailboxPollRepository>,
        inboxes: Arc<dyn InboxDirectory>,
        routes: Arc<dyn ChannelRoutes>,
        events: Arc<dyn EventRecorder>,
        endpoints: Arc<dyn OwnEndpoints>,
        dialer: Arc<dyn PeerDialer>,
    ) -> Self {
        Self {
            config,
            actors,
            disabled_helpers,
            mailboxes,
            polls,
            inboxes,
            routes,
            events,
            endpoints,
            dialer,
        }
    }

    /// [`DeliveryService::dispatch`], recording `delivered` as the event's
    /// detail when the message lands — so a local delivery reads differently
    /// in the log from one that came in over a listener.
    async fn dispatch_noting(
        &self,
        actor_id: Uuid,
        carrier: Carrier,
        bytes: Vec<u8>,
        delivered: &str,
    ) -> DispatchOutcome {
        let len = bytes.len();
        // Correlation key for anyone reading the log. Best effort: a body that
        // will not decode is still worth recording — that it arrived at all is
        // the interesting part.
        let channel_id = channel_of(&bytes);

        let record = |outcome: Outcome, detail: &str| {
            self.events.record(NewEvent {
                direction: Direction::Inbound,
                carrier,
                outcome,
                actor_id: Some(actor_id),
                channel_id,
                bytes: len,
                detail: detail.to_owned(),
            });
        };

        // A store failure here is treated as "not disabled": dropping a
        // message because the database hiccuped would silently lose protocol
        // traffic, which is worse than delivering to a helper the operator
        // meant to have switched off.
        if self
            .disabled_helpers
            .is_disabled(&actor_id)
            .await
            .unwrap_or(false)
        {
            info!(actor_id = %actor_id, bytes = len, "message dropped — actor is offline");
            record(
                Outcome::Dropped,
                "actor is simulating offline; message discarded",
            );
            return DispatchOutcome::Dropped;
        }

        match self.inboxes.kind(&actor_id) {
            None => {
                record(Outcome::Refused, "actor has no inbox registered");
                return DispatchOutcome::NoInbox;
            }
            Some(InboxKind::Provisioned) => {
                if !self.inboxes.deliver(&actor_id, bytes) {
                    record(Outcome::Refused, "actor has no inbox registered");
                    return DispatchOutcome::NoInbox;
                }
            }
            Some(InboxKind::Browser) => match self.mailboxes.enqueue(&actor_id, &bytes).await {
                Ok(()) => {}
                Err(RepositoryError::MailboxFull {
                    queued,
                    bytes: waiting,
                }) => {
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
                Err(e) => {
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

    /// Which actor a message on `channel_id`, addressed to this node's gRPC
    /// listener, is for.
    ///
    /// The router decides, with one narrowing when it finds several claimants:
    /// an actor that advertises no gRPC endpoint is set aside, since nothing
    /// addressed to the gRPC listener can be for an actor no peer dials over
    /// gRPC. A replica is the everyday case: hydrating the source's roster
    /// gives the replica's instance the source's helper channels, so an
    /// HTTP-only replica claims the same ids as the gRPC helpers serving them.
    ///
    /// A claimant is only set aside when the registry positively says it is
    /// HTTP-only; one the registry cannot answer for stays, and the channel
    /// stays ambiguous rather than being guessed.
    async fn resolve_recipient(&self, channel_id: u64, sender: Option<Uuid>) -> Resolution {
        let claimants = match self.routes.resolve_from(channel_id, sender) {
            Resolution::Ambiguous(claimants) => claimants,
            resolved => return resolved,
        };

        let mut reachable = Vec::with_capacity(claimants.len());
        for actor_id in claimants {
            let http_only = matches!(
                self.actors.get(&actor_id).await,
                Ok(Some(actor)) if !actor.advertises_grpc()
            );
            if !http_only {
                reachable.push(actor_id);
            }
        }

        match reachable.as_slice() {
            [only] => Resolution::Actor(*only),
            // Every claimant is HTTP-only: none of them is what the sender
            // dialled.
            [] => Resolution::Unknown,
            _ => Resolution::Ambiguous(reachable),
        }
    }

    /// Record a message gRPC ingress could not place, so the debug log shows it.
    fn refuse_grpc(&self, channel_id: u64, len: usize, detail: &str) {
        self.events.record(NewEvent {
            direction: Direction::Inbound,
            carrier: Carrier::Grpc,
            outcome: Outcome::Refused,
            actor_id: None,
            channel_id: (channel_id != 0).then_some(channel_id),
            bytes: len,
            detail: detail.to_owned(),
        });
    }
}

#[async_trait]
impl DeliveryService for DeliveryServiceImpl {
    async fn deliver(&self, actor_id: Uuid, body: Vec<u8>) -> Result<(), ServiceError> {
        if self.actors.get(&actor_id).await?.is_none() {
            return Err(ServiceError::NotFound("actor not found".to_owned()));
        }
        if body.is_empty() {
            return Err(ServiceError::BadRequest("empty message body".to_owned()));
        }

        match self.dispatch(actor_id, Carrier::Http, body).await {
            // A dropped message is still accepted: "offline" simulates an
            // unreachable peer, and the sender sees what it would see then.
            DispatchOutcome::Delivered | DispatchOutcome::Dropped => Ok(()),
            DispatchOutcome::NoInbox => {
                Err(ServiceError::NotFound("actor inbox not found".to_owned()))
            }
            DispatchOutcome::MailboxFull => Err(mailbox_full()),
            DispatchOutcome::Unavailable => Err(mailbox_unwritable()),
        }
    }

    async fn poll_mailbox(&self, actor_id: Uuid) -> Result<Vec<Vec<u8>>, ServiceError> {
        if self.actors.get(&actor_id).await?.is_none() {
            return Err(ServiceError::NotFound("actor not found".to_owned()));
        }
        if self.inboxes.kind(&actor_id) != Some(InboxKind::Browser) {
            return Err(ServiceError::BadRequest(
                "this actor runs on the backend; only browser-managed actors have a mailbox to poll"
                    .to_owned(),
            ));
        }

        let messages = match self.mailboxes.drain(&actor_id).await {
            Ok(messages) => messages,
            Err(e) => {
                tracing::error!(actor_id = %actor_id, error = %e, "mailbox unreadable");
                return Err(ServiceError::Internal("mailbox unavailable".to_owned()));
            }
        };

        // Recorded only once the drain succeeded: a poll that could not read
        // the mailbox delivered nothing, so it is not evidence the tab is
        // keeping up.
        self.polls.record(actor_id, now_unix_ms());

        if !messages.is_empty() {
            info!(actor_id = %actor_id, count = messages.len(), "mailbox drained");
        }
        Ok(messages)
    }

    async fn relay(&self, request: RelayRequest) -> Result<(), ServiceError> {
        let relay = Relay {
            events: self.events.as_ref(),
            uri: &request.uri,
            actor_id: request.actor_id,
            carrier: if request.uri.starts_with("grpc") {
                Carrier::GrpcViaRelay
            } else {
                Carrier::HttpViaRelay
            },
        };

        if !self.config.defaults.grpc_relay_enabled {
            return relay.refuse(
                None,
                0,
                ServiceError::RelayDisabled(
                    "relay disabled on this node (defaults.grpc_relay_enabled / \
                     DEREC_GRPC_RELAY_ENABLED)"
                        .to_owned(),
                ),
            );
        }

        if let Some(actor_id) = request.actor_id {
            if self.actors.get(&actor_id).await?.is_none() {
                return relay.refuse(
                    None,
                    0,
                    ServiceError::BadRequest("actor_id names no actor on this node".to_owned()),
                );
            }
        }

        let Ok(bytes) = URL_SAFE_NO_PAD.decode(&request.data) else {
            return relay.refuse(
                None,
                0,
                ServiceError::BadRequest("data is not base64url".to_owned()),
            );
        };
        let len = bytes.len();
        if bytes.is_empty() {
            return relay.refuse(
                None,
                len,
                ServiceError::BadRequest("data is empty".to_owned()),
            );
        }
        if len > MAX_MESSAGE_BYTES {
            return relay.refuse(
                None,
                len,
                ServiceError::PayloadTooLarge(format!(
                    "data decodes to {len} bytes; the most a DeRec message may be is {} \
                     bytes (4 MiB), what a gRPC peer accepts",
                    MAX_MESSAGE_BYTES
                )),
            );
        }
        let Some(channel_id) = channel_of(&bytes) else {
            return relay.refuse(
                None,
                len,
                ServiceError::BadRequest(
                    "data is not a DeRec envelope naming a channel".to_owned(),
                ),
            );
        };

        match self.relay_target(&request.uri).await {
            RelayTarget::Local(target) => {
                let outcome = self
                    .deliver_to_own_target(target, &request.uri, bytes, request.actor_id)
                    .await;
                relay.delivered_locally(channel_id, len, outcome)
            }
            RelayTarget::Remote => match self.dialer.dial(&request.uri, bytes).await {
                Ok(()) => {
                    relay.record(
                        Outcome::Delivered,
                        Some(channel_id),
                        len,
                        format!("relayed on a browser owner's behalf to {}", request.uri),
                    );
                    Ok(())
                }
                Err(e) => {
                    tracing::error!(uri = %request.uri, error = %e, "relay delivery failed");
                    relay.refuse(
                        Some(channel_id),
                        len,
                        ServiceError::BadGateway(format!("relay delivery failed: {e}")),
                    )
                }
            },
            RelayTarget::Refused(refusal) => {
                let uri = &request.uri;
                let error = match refusal {
                    RelayRefusal::NotAllowed => ServiceError::Forbidden(format!(
                        "relay target {uri} is not this node and not an allowed host; to relay \
                         to another node, add its host or host:port to \
                         server.relay_allowed_hosts (DEREC_RELAY_ALLOWED_HOSTS) on this node, \
                         or \"*\" to allow any host on a trusted network"
                    )),
                    RelayRefusal::GrpcDisabled => ServiceError::Conflict(format!(
                        "relay target {uri} is this node's gRPC address, but gRPC is disabled here \
                         (defaults.grpc_enabled / DEREC_GRPC_ENABLED), so nothing answers on it"
                    )),
                    RelayRefusal::Malformed => ServiceError::BadRequest(format!(
                        "relay target {uri} is not an endpoint the relay can dial: it must be \
                         grpc://host:port or http(s)://host[:port]/path, with no credentials, \
                         query or fragment"
                    )),
                };
                relay.refuse(Some(channel_id), len, error)
            }
        }
    }

    async fn receive_grpc(
        &self,
        envelope: derec_proto::DeRecMessage,
        sender: Option<Uuid>,
    ) -> Result<(), GrpcRefusal> {
        let channel_id = envelope.channel_id;
        let len = envelope.message.len();

        let actor_id = match self.resolve_recipient(channel_id, sender).await {
            Resolution::Actor(actor_id) => actor_id,
            // Refused rather than guessed. A wrong guess delivers a peer's
            // message to an actor that does not own the channel.
            Resolution::Unknown => {
                self.refuse_grpc(channel_id, len, "no actor on this node holds the channel");
                return Err(GrpcRefusal::NotFound(format!(
                    "no actor holds channel {channel_id}"
                )));
            }
            Resolution::Ambiguous(claimants) => {
                // Both ends of a pairing are on this node and the caller did
                // not say which one it is. Only another node — or a client
                // other than this backend's — reaches here, since every actor
                // here stamps its calls.
                tracing::warn!(
                    channel_id,
                    claimants = ?claimants,
                    "gRPC message on a channel held by more than one actor here, \
                     with no sender hint; refusing rather than guessing"
                );
                self.refuse_grpc(
                    channel_id,
                    len,
                    "more than one actor on this node holds the channel and the \
                     sender did not identify itself",
                );
                return Err(GrpcRefusal::FailedPrecondition(format!(
                    "channel {channel_id} is held by more than one actor on this node; \
                     send `{SENDER_METADATA}` to say which end you are"
                )));
            }
        };

        // Re-encoded rather than passed on decoded: every inbox in this app
        // takes wire bytes, because that is what `DeRecProtocol::process`
        // takes.
        let bytes = prost::Message::encode_to_vec(&envelope);

        match self.dispatch(actor_id, Carrier::Grpc, bytes).await {
            // A dropped message is still an accepted call: "offline" is a
            // simulation of an unreachable peer, and the peer's transport
            // should see the same success it sees over HTTP.
            DispatchOutcome::Delivered | DispatchOutcome::Dropped => Ok(()),
            DispatchOutcome::NoInbox => {
                Err(GrpcRefusal::NotFound("actor inbox not found".to_owned()))
            }
            DispatchOutcome::MailboxFull => Err(GrpcRefusal::ResourceExhausted(
                "the recipient's mailbox is full; it has not polled for a while".to_owned(),
            )),
            DispatchOutcome::Unavailable => Err(GrpcRefusal::Unavailable(
                "the recipient's mailbox could not be written".to_owned(),
            )),
        }
    }

    async fn dispatch(&self, actor_id: Uuid, carrier: Carrier, bytes: Vec<u8>) -> DispatchOutcome {
        self.dispatch_noting(actor_id, carrier, bytes, "delivered to the actor's inbox")
            .await
    }

    async fn deliver_to_own_target(
        &self,
        target: OwnTarget,
        uri: &str,
        bytes: Vec<u8>,
        sender: Option<Uuid>,
    ) -> Result<DispatchOutcome, NotHere> {
        let note = format!("delivered to the actor's inbox without a dial ({uri} is this node)");
        match target {
            OwnTarget::Actor(actor_id) => {
                if self.inboxes.kind(&actor_id).is_none() {
                    return Err(NotHere(format!("no actor {actor_id} runs on this node")));
                }
                Ok(self
                    .dispatch_noting(actor_id, Carrier::Http, bytes, &note)
                    .await)
            }
            OwnTarget::GrpcListener { served: false } => Err(NotHere(
                "gRPC is disabled on this node (defaults.grpc_enabled / DEREC_GRPC_ENABLED), so \
                 nothing here answers on a gRPC address"
                    .to_owned(),
            )),
            OwnTarget::GrpcListener { served: true } => {
                let channel_id = channel_of(&bytes)
                    .ok_or_else(|| NotHere("the message names no channel".to_owned()))?;
                match self.resolve_recipient(channel_id, sender).await {
                    Resolution::Actor(actor_id) => Ok(self
                        .dispatch_noting(actor_id, Carrier::Grpc, bytes, &note)
                        .await),
                    Resolution::Unknown => Err(NotHere(format!(
                        "no actor on this node holds channel {channel_id}"
                    ))),
                    Resolution::Ambiguous(_) => Err(NotHere(format!(
                        "channel {channel_id} is held by more than one actor on this node and the \
                         sender is not known"
                    ))),
                }
            }
        }
    }

    async fn relay_target(&self, uri: &str) -> RelayTarget {
        // The relay exists so a browser owner can reach a gRPC peer it cannot
        // dial itself. Without a limit it would be a general-purpose proxy, so
        // it admits:
        //
        // 1. this node, under any address it answers to now or advertised
        //    before — delivered locally, so an address this node no longer
        //    listens on still works for a browser paired before the move;
        // 2. an endpoint some actor on this node advertises right now;
        // 3. another node the operator listed in `server.relay_allowed_hosts`,
        //    or any node when it is `*`.
        if let Some(target) = self.endpoints.own_target(uri) {
            return match target {
                OwnTarget::GrpcListener { served: false } => {
                    RelayTarget::Refused(RelayRefusal::GrpcDisabled)
                }
                target => RelayTarget::Local(target),
            };
        }

        let Some((host, port)) = dialable(uri) else {
            return RelayTarget::Refused(RelayRefusal::Malformed);
        };

        // A store failure denies rather than allows: failing open would turn
        // the allowlist into a proxy.
        let advertised = self
            .actors
            .all()
            .await
            .map(|actors| actors.iter().any(|actor| actor.advertises(uri)))
            .unwrap_or(false);
        if advertised
            || self
                .config
                .loaded
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
}

#[async_trait]
impl LocalDelivery for DeliveryServiceImpl {
    async fn deliver_local(&self, uri: &str, bytes: &[u8], sender: Option<Uuid>) -> LocalAttempt {
        let Some(target) = self.endpoints.own_target(uri) else {
            return LocalAttempt::NotLocal;
        };
        match self
            .deliver_to_own_target(target, uri, bytes.to_vec(), sender)
            .await
        {
            Ok(DispatchOutcome::Delivered | DispatchOutcome::Dropped) => {
                tracing::debug!(uri = %uri, "transport: delivered locally");
                LocalAttempt::Delivered
            }
            Ok(DispatchOutcome::NoInbox) => LocalAttempt::NotLocal,
            Ok(DispatchOutcome::MailboxFull) => {
                LocalAttempt::Refused("the recipient's mailbox is full".to_owned())
            }
            Ok(DispatchOutcome::Unavailable) => {
                LocalAttempt::Refused("the recipient's mailbox could not be written".to_owned())
            }
            Err(not_here) => {
                tracing::debug!(uri = %uri, reason = %not_here, "transport: names this node but nothing here takes it; dialling");
                LocalAttempt::NotLocal
            }
        }
    }
}

/// One relay request, for recording what became of it.
struct Relay<'a> {
    events: &'a dyn EventRecorder,
    uri: &'a str,
    /// The requesting actor, when the request named one.
    actor_id: Option<Uuid>,
    carrier: Carrier,
}

impl Relay<'_> {
    /// Record a refusal with its reason, then answer with it. The event log is
    /// where a reader looks first.
    fn refuse(
        &self,
        channel_id: Option<u64>,
        len: usize,
        error: ServiceError,
    ) -> Result<(), ServiceError> {
        self.record(
            Outcome::Refused,
            channel_id,
            len,
            format!("relay to {} refused: {error}", self.uri),
        );
        Err(error)
    }

    fn record(&self, outcome: Outcome, channel_id: Option<u64>, len: usize, detail: String) {
        // The browser could not deliver this itself, so from a reader's point
        // of view the message left *here*. Tagged with the relay, which is the
        // only way to tell relayed traffic from this server's own.
        self.events.record(NewEvent {
            direction: Direction::Outbound,
            carrier: self.carrier,
            outcome,
            actor_id: self.actor_id,
            channel_id,
            bytes: len,
            detail,
        });
    }

    /// Answer a relay whose target was this node.
    fn delivered_locally(
        &self,
        channel_id: u64,
        len: usize,
        outcome: Result<DispatchOutcome, NotHere>,
    ) -> Result<(), ServiceError> {
        match outcome {
            Ok(DispatchOutcome::Delivered | DispatchOutcome::Dropped) => {
                self.record(
                    Outcome::Delivered,
                    Some(channel_id),
                    len,
                    format!(
                        "relayed on a browser owner's behalf to {} — this node, so delivered \
                         without a dial",
                        self.uri
                    ),
                );
                Ok(())
            }
            Ok(DispatchOutcome::MailboxFull) => self.refuse(Some(channel_id), len, mailbox_full()),
            Ok(DispatchOutcome::Unavailable) => {
                self.refuse(Some(channel_id), len, mailbox_unwritable())
            }
            Ok(DispatchOutcome::NoInbox) => self.refuse(
                Some(channel_id),
                len,
                ServiceError::BadGateway(
                    "relay delivery failed: the recipient has no inbox here".to_owned(),
                ),
            ),
            Err(not_here) => self.refuse(
                Some(channel_id),
                len,
                ServiceError::BadGateway(format!("relay delivery failed: {not_here}")),
            ),
        }
    }
}

fn mailbox_full() -> ServiceError {
    ServiceError::MailboxFull(
        "the recipient's mailbox is full; it has not polled for a while".to_owned(),
    )
}

fn mailbox_unwritable() -> ServiceError {
    ServiceError::Unavailable("the recipient's mailbox could not be written".to_owned())
}

/// The cleartext channel id of `bytes`, when there is one worth recording.
///
/// `0` is the proto3 default, so an empty or garbled body decodes to it; it
/// names no channel and is reported as unknown rather than as "channel 0".
fn channel_of(bytes: &[u8]) -> Option<u64> {
    EnvelopeMeta::try_from(bytes)
        .ok()
        .map(|m| m.channel_id)
        .filter(|&channel_id| channel_id != 0)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Defaults, LoadedConfig};
    use crate::models::{Actor, Role, TransportMode};
    use crate::repositories::mailbox_polls::InMemoryMailboxPolls;
    use crate::services::test_fakes::{
        FakeActorRepository, FakeDialer, FakeDisabledHelpers, FakeEventRecorder, FakeInboxes,
        FakeMailboxes, FakeOwnEndpoints, FakeRoutes,
    };

    struct Fixture {
        defaults: Defaults,
        allowed_hosts: String,
        actors: Arc<FakeActorRepository>,
        disabled: Arc<FakeDisabledHelpers>,
        mailboxes: Arc<FakeMailboxes>,
        polls: Arc<InMemoryMailboxPolls>,
        inboxes: Arc<FakeInboxes>,
        routes: Arc<FakeRoutes>,
        events: Arc<FakeEventRecorder>,
        endpoints: Arc<FakeOwnEndpoints>,
        dialer: Arc<FakeDialer>,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                defaults: Defaults::default(),
                allowed_hosts: String::new(),
                actors: Arc::new(FakeActorRepository::default()),
                disabled: Arc::new(FakeDisabledHelpers::default()),
                mailboxes: Arc::new(FakeMailboxes::default()),
                polls: Arc::new(InMemoryMailboxPolls::new()),
                inboxes: Arc::new(FakeInboxes::default()),
                routes: Arc::new(FakeRoutes::default()),
                events: Arc::new(FakeEventRecorder::default()),
                endpoints: Arc::new(FakeOwnEndpoints::default()),
                dialer: Arc::new(FakeDialer::default()),
            }
        }

        fn service(&self) -> DeliveryServiceImpl {
            let mut loaded = LoadedConfig::default();
            loaded.settings.server.relay_allowed_hosts = self.allowed_hosts.clone();
            let config =
                NodeConfig::new("http://localhost:5000", self.defaults.clone()).with_loaded(loaded);
            DeliveryServiceImpl::new(
                Arc::new(config),
                self.actors.clone(),
                self.disabled.clone(),
                self.mailboxes.clone(),
                self.polls.clone(),
                self.inboxes.clone(),
                self.routes.clone(),
                self.events.clone(),
                self.endpoints.clone(),
                self.dialer.clone(),
            )
        }

        fn actor(&self, role: Role, mode: TransportMode) -> Actor {
            let actor = Actor::mint(role, "A", "http://localhost:5000", "localhost:50051", mode);
            self.actors.insert(actor.clone());
            actor
        }

        /// A browser-run owner with a mailbox.
        fn browser(&self) -> Actor {
            let actor = self.actor(Role::Owner, TransportMode::Http);
            self.inboxes.register_browser(actor.id);
            actor
        }

        /// A backend-run helper.
        fn provisioned(&self, mode: TransportMode) -> Actor {
            let actor = self.actor(Role::Helper, mode);
            self.inboxes.provisioned(actor.id);
            actor
        }

        fn outcomes(&self) -> Vec<Outcome> {
            self.events
                .recorded()
                .into_iter()
                .map(|e| e.outcome)
                .collect()
        }
    }

    fn envelope(channel_id: u64) -> Vec<u8> {
        prost::Message::encode_to_vec(&derec_proto::DeRecMessage {
            channel_id,
            ..Default::default()
        })
    }

    fn relay_of(uri: &str, bytes: &[u8]) -> RelayRequest {
        RelayRequest {
            uri: uri.to_owned(),
            data: URL_SAFE_NO_PAD.encode(bytes),
            actor_id: None,
        }
    }

    // ── Dispatch ────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_message_for_a_provisioned_actor_goes_to_its_instance() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Http);

        let outcome = fixture
            .service()
            .dispatch(alex.id, Carrier::Http, envelope(7))
            .await;

        assert_eq!(outcome, DispatchOutcome::Delivered);
        assert_eq!(fixture.inboxes.delivered(), vec![(alex.id, envelope(7))]);
        let event = &fixture.events.recorded()[0];
        assert_eq!(event.outcome, Outcome::Delivered);
        assert_eq!(event.channel_id, Some(7));
    }

    #[tokio::test]
    async fn a_message_for_a_browser_actor_waits_in_its_mailbox() {
        let fixture = Fixture::new();
        let alice = fixture.browser();

        let outcome = fixture
            .service()
            .dispatch(alice.id, Carrier::Grpc, envelope(7))
            .await;

        assert_eq!(outcome, DispatchOutcome::Delivered);
        assert_eq!(fixture.mailboxes.waiting(&alice.id), vec![envelope(7)]);
    }

    #[tokio::test]
    async fn a_helper_simulating_offline_drops_the_message_and_says_so() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Http);
        fixture.disabled.disable(alex.id);

        let outcome = fixture
            .service()
            .dispatch(alex.id, Carrier::Http, envelope(7))
            .await;

        assert_eq!(outcome, DispatchOutcome::Dropped);
        assert!(fixture.inboxes.delivered().is_empty());
        assert_eq!(fixture.outcomes(), vec![Outcome::Dropped]);
    }

    #[tokio::test]
    async fn a_full_mailbox_refuses_rather_than_dropping_what_waits() {
        let fixture = Fixture::new();
        let alice = fixture.browser();
        fixture.mailboxes.cap_at(1);
        let service = fixture.service();

        service.dispatch(alice.id, Carrier::Http, envelope(1)).await;
        let outcome = service.dispatch(alice.id, Carrier::Http, envelope(2)).await;

        assert_eq!(outcome, DispatchOutcome::MailboxFull);
        assert_eq!(fixture.mailboxes.waiting(&alice.id), vec![envelope(1)]);
    }

    #[tokio::test]
    async fn an_unwritable_mailbox_is_unavailable() {
        let fixture = Fixture::new();
        let alice = fixture.browser();
        fixture.mailboxes.fail();

        let outcome = fixture
            .service()
            .dispatch(alice.id, Carrier::Http, envelope(1))
            .await;

        assert_eq!(outcome, DispatchOutcome::Unavailable);
        assert_eq!(fixture.outcomes(), vec![Outcome::Refused]);
    }

    #[tokio::test]
    async fn an_actor_with_no_inbox_is_refused_and_recorded() {
        let fixture = Fixture::new();
        let ghost = fixture.actor(Role::Helper, TransportMode::Http);

        let outcome = fixture
            .service()
            .dispatch(ghost.id, Carrier::Http, envelope(1))
            .await;

        assert_eq!(outcome, DispatchOutcome::NoInbox);
        assert_eq!(fixture.outcomes(), vec![Outcome::Refused]);
    }

    // ── The HTTP transport route ────────────────────────────────────────────

    #[tokio::test]
    async fn a_message_for_an_unknown_actor_is_not_found() {
        let fixture = Fixture::new();

        let error = fixture
            .service()
            .deliver(Uuid::new_v4(), envelope(1))
            .await
            .expect_err("refused");

        assert_eq!(error, ServiceError::NotFound("actor not found".to_owned()));
    }

    #[tokio::test]
    async fn an_empty_body_is_refused() {
        let fixture = Fixture::new();
        let alice = fixture.browser();

        let error = fixture
            .service()
            .deliver(alice.id, Vec::new())
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::BadRequest("empty message body".to_owned())
        );
    }

    #[tokio::test]
    async fn a_dropped_message_is_still_accepted() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Http);
        fixture.disabled.disable(alex.id);

        fixture
            .service()
            .deliver(alex.id, envelope(1))
            .await
            .expect("accepted");
    }

    #[tokio::test]
    async fn a_registered_actor_with_no_inbox_is_not_found() {
        let fixture = Fixture::new();
        let ghost = fixture.actor(Role::Helper, TransportMode::Http);

        let error = fixture
            .service()
            .deliver(ghost.id, envelope(1))
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::NotFound("actor inbox not found".to_owned())
        );
    }

    // ── Mailbox polls ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_poll_drains_the_mailbox_and_records_when_it_happened() {
        let fixture = Fixture::new();
        let alice = fixture.browser();
        let service = fixture.service();
        service.dispatch(alice.id, Carrier::Http, envelope(1)).await;

        let messages = service.poll_mailbox(alice.id).await.expect("polls");

        assert_eq!(messages, vec![envelope(1)]);
        assert!(fixture.mailboxes.waiting(&alice.id).is_empty());
        assert!(fixture.polls.last(&alice.id).is_some());
    }

    #[tokio::test]
    async fn a_provisioned_actor_has_no_mailbox_to_poll() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Http);

        let error = fixture
            .service()
            .poll_mailbox(alex.id)
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::BadRequest(
                "this actor runs on the backend; only browser-managed actors have a mailbox to poll"
                    .to_owned()
            )
        );
    }

    #[tokio::test]
    async fn a_poll_that_could_not_read_the_mailbox_is_not_counted_as_a_poll() {
        let fixture = Fixture::new();
        let alice = fixture.browser();
        fixture.mailboxes.fail();

        let error = fixture
            .service()
            .poll_mailbox(alice.id)
            .await
            .expect_err("fails");

        assert_eq!(
            error,
            ServiceError::Internal("mailbox unavailable".to_owned())
        );
        assert_eq!(fixture.polls.last(&alice.id), None);
    }

    // ── The relay ───────────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_relay_switched_off_is_unavailable_and_recorded() {
        let mut fixture = Fixture::new();
        fixture.defaults.grpc_relay_enabled = false;

        let error = fixture
            .service()
            .relay(relay_of("grpc://peer:50051", &envelope(1)))
            .await
            .expect_err("refused");

        assert!(
            matches!(error, ServiceError::RelayDisabled(m) if m.starts_with("relay disabled on this node"))
        );
        let event = &fixture.events.recorded()[0];
        assert_eq!(
            (event.direction, event.carrier, event.outcome),
            (Direction::Outbound, Carrier::GrpcViaRelay, Outcome::Refused)
        );
        assert!(event
            .detail
            .starts_with("relay to grpc://peer:50051 refused: relay disabled"));
    }

    #[tokio::test]
    async fn malformed_relay_payloads_are_refused_before_any_delivery() {
        let fixture = Fixture::new();
        let service = fixture.service();
        let cases = [
            (
                RelayRequest {
                    data: "!!!".to_owned(),
                    ..relay_of("grpc://peer:1", &[])
                },
                "data is not base64url",
            ),
            (relay_of("grpc://peer:1", &[]), "data is empty"),
            (
                relay_of("grpc://peer:1", &[0xff, 0xff]),
                "data is not a DeRec envelope naming a channel",
            ),
        ];

        for (request, message) in cases {
            let error = service.relay(request).await.expect_err("refused");
            assert_eq!(error, ServiceError::BadRequest(message.to_owned()));
        }
        assert!(fixture.dialer.dialled().is_empty());
    }

    #[tokio::test]
    async fn an_oversized_relay_payload_is_too_large() {
        let fixture = Fixture::new();
        let mut big = envelope(1);
        big.resize(MAX_MESSAGE_BYTES + 1, 0);

        let error = fixture
            .service()
            .relay(relay_of("grpc://peer:1", &big))
            .await
            .expect_err("refused");

        assert!(matches!(error, ServiceError::PayloadTooLarge(_)));
    }

    #[tokio::test]
    async fn a_relay_naming_an_unknown_actor_is_refused() {
        let fixture = Fixture::new();
        let request = RelayRequest {
            actor_id: Some(Uuid::new_v4()),
            ..relay_of("grpc://peer:1", &envelope(1))
        };

        let error = fixture.service().relay(request).await.expect_err("refused");

        assert_eq!(
            error,
            ServiceError::BadRequest("actor_id names no actor on this node".to_owned())
        );
    }

    #[tokio::test]
    async fn a_host_nobody_allowed_is_forbidden_and_not_dialled() {
        let fixture = Fixture::new();

        let error = fixture
            .service()
            .relay(relay_of("grpc://stranger.example:50051", &envelope(1)))
            .await
            .expect_err("refused");

        assert!(
            matches!(error, ServiceError::Forbidden(m) if m.starts_with("relay target grpc://stranger.example:50051 is not this node"))
        );
        assert!(fixture.dialer.dialled().is_empty());
    }

    #[tokio::test]
    async fn an_allowed_host_is_dialled_and_recorded_as_relayed() {
        let mut fixture = Fixture::new();
        fixture.allowed_hosts = "peer.example".to_owned();

        fixture
            .service()
            .relay(relay_of("grpc://peer.example:50051", &envelope(1)))
            .await
            .expect("relays");

        assert_eq!(fixture.dialer.dialled(), vec!["grpc://peer.example:50051"]);
        assert_eq!(fixture.outcomes(), vec![Outcome::Delivered]);
    }

    #[tokio::test]
    async fn an_endpoint_an_actor_here_advertises_may_be_dialled_without_an_allowlist() {
        let fixture = Fixture::new();
        let alex = fixture.actor(Role::Helper, TransportMode::Grpc);
        let uri = alex.transports[0].uri.clone();

        assert_eq!(
            fixture.service().relay_target(&uri).await,
            RelayTarget::Remote
        );
    }

    #[tokio::test]
    async fn a_failed_dial_is_a_bad_gateway() {
        let mut fixture = Fixture::new();
        fixture.allowed_hosts = "*".to_owned();
        fixture.dialer.fail();

        let error = fixture
            .service()
            .relay(relay_of("grpc://peer.example:50051", &envelope(1)))
            .await
            .expect_err("fails");

        assert_eq!(
            error,
            ServiceError::BadGateway("relay delivery failed: connection refused".to_owned())
        );
    }

    #[tokio::test]
    async fn this_nodes_own_grpc_address_with_grpc_off_is_a_conflict() {
        let fixture = Fixture::new();
        fixture.endpoints.own(
            "grpc://localhost:50051",
            OwnTarget::GrpcListener { served: false },
        );

        let error = fixture
            .service()
            .relay(relay_of("grpc://localhost:50051", &envelope(1)))
            .await
            .expect_err("refused");

        assert!(matches!(error, ServiceError::Conflict(_)));
    }

    #[tokio::test]
    async fn a_target_the_relay_cannot_dial_is_malformed() {
        let fixture = Fixture::new();

        for uri in [
            "ftp://peer:21",
            "grpc://peer",
            "http://user:pw@peer/x",
            "not a uri",
        ] {
            assert_eq!(
                fixture.service().relay_target(uri).await,
                RelayTarget::Refused(RelayRefusal::Malformed),
                "{uri}"
            );
        }
    }

    #[tokio::test]
    async fn a_relay_to_this_node_is_delivered_without_a_dial() {
        let fixture = Fixture::new();
        let alice = fixture.browser();
        let uri = format!("http://localhost:5000/derec/{}", alice.id);
        fixture.endpoints.own(&uri, OwnTarget::Actor(alice.id));

        fixture
            .service()
            .relay(relay_of(&uri, &envelope(9)))
            .await
            .expect("relays");

        assert!(fixture.dialer.dialled().is_empty());
        assert_eq!(fixture.mailboxes.waiting(&alice.id), vec![envelope(9)]);
    }

    #[tokio::test]
    async fn a_relay_to_an_actor_this_node_does_not_run_is_a_bad_gateway() {
        let fixture = Fixture::new();
        let ghost = Uuid::new_v4();
        let uri = format!("http://localhost:5000/derec/{ghost}");
        fixture.endpoints.own(&uri, OwnTarget::Actor(ghost));

        let error = fixture
            .service()
            .relay(relay_of(&uri, &envelope(9)))
            .await
            .expect_err("fails");

        assert_eq!(
            error,
            ServiceError::BadGateway(format!(
                "relay delivery failed: no actor {ghost} runs on this node"
            ))
        );
    }

    // ── gRPC ingress ────────────────────────────────────────────────────────

    fn message(channel_id: u64) -> derec_proto::DeRecMessage {
        derec_proto::DeRecMessage {
            channel_id,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn a_grpc_message_on_an_unknown_channel_is_not_found_and_recorded() {
        let fixture = Fixture::new();

        let refusal = fixture
            .service()
            .receive_grpc(message(5), None)
            .await
            .expect_err("refused");

        assert_eq!(
            refusal,
            GrpcRefusal::NotFound("no actor holds channel 5".to_owned())
        );
        assert_eq!(fixture.outcomes(), vec![Outcome::Refused]);
    }

    #[tokio::test]
    async fn an_http_only_claimant_is_set_aside_on_a_grpc_message() {
        // A replica holds copies of the source's helper channels, so it claims
        // the same ids as the gRPC helper serving them — but nothing addressed
        // to the gRPC listener can be for an HTTP-only actor.
        let fixture = Fixture::new();
        let replica = fixture.provisioned(TransportMode::Http);
        let helper = fixture.provisioned(TransportMode::Grpc);
        fixture
            .routes
            .resolve_to(5, Resolution::Ambiguous(vec![replica.id, helper.id]));

        fixture
            .service()
            .receive_grpc(message(5), None)
            .await
            .expect("delivered");

        assert_eq!(fixture.inboxes.delivered()[0].0, helper.id);
    }

    #[tokio::test]
    async fn two_grpc_claimants_and_no_sender_is_refused_rather_than_guessed() {
        let fixture = Fixture::new();
        let a = fixture.provisioned(TransportMode::Grpc);
        let b = fixture.provisioned(TransportMode::Grpc);
        fixture
            .routes
            .resolve_to(5, Resolution::Ambiguous(vec![a.id, b.id]));

        let refusal = fixture
            .service()
            .receive_grpc(message(5), None)
            .await
            .expect_err("refused");

        assert!(matches!(refusal, GrpcRefusal::FailedPrecondition(_)));
        assert!(fixture.inboxes.delivered().is_empty());
    }

    #[tokio::test]
    async fn a_full_mailbox_is_resource_exhausted_over_grpc() {
        let fixture = Fixture::new();
        let alice = fixture.browser();
        fixture.routes.resolve_to(5, Resolution::Actor(alice.id));
        fixture.mailboxes.cap_at(0);

        let refusal = fixture
            .service()
            .receive_grpc(message(5), None)
            .await
            .expect_err("refused");

        assert!(matches!(refusal, GrpcRefusal::ResourceExhausted(_)));
    }

    // ── Local delivery for an actor's transport ─────────────────────────────

    #[tokio::test]
    async fn an_endpoint_that_is_not_this_node_is_left_to_the_dial() {
        let fixture = Fixture::new();

        let attempt = fixture
            .service()
            .deliver_local("http://elsewhere/derec/x", &envelope(1), None)
            .await;

        assert_eq!(attempt, LocalAttempt::NotLocal);
    }

    #[tokio::test]
    async fn an_endpoint_naming_an_actor_here_is_delivered_in_process() {
        let fixture = Fixture::new();
        let alice = fixture.browser();
        let uri = format!("http://localhost:5000/derec/{}", alice.id);
        fixture.endpoints.own(&uri, OwnTarget::Actor(alice.id));

        let attempt = fixture
            .service()
            .deliver_local(&uri, &envelope(1), None)
            .await;

        assert_eq!(attempt, LocalAttempt::Delivered);
        assert_eq!(fixture.mailboxes.waiting(&alice.id), vec![envelope(1)]);
    }

    #[tokio::test]
    async fn a_recipient_here_with_a_full_mailbox_refuses_rather_than_being_dialled() {
        let fixture = Fixture::new();
        let alice = fixture.browser();
        let uri = format!("http://localhost:5000/derec/{}", alice.id);
        fixture.endpoints.own(&uri, OwnTarget::Actor(alice.id));
        fixture.mailboxes.cap_at(0);

        let attempt = fixture
            .service()
            .deliver_local(&uri, &envelope(1), None)
            .await;

        assert_eq!(
            attempt,
            LocalAttempt::Refused("the recipient's mailbox is full".to_owned())
        );
    }

    #[tokio::test]
    async fn a_grpc_listener_here_resolves_the_recipient_by_channel_excluding_the_sender() {
        let fixture = Fixture::new();
        let alice = fixture.browser();
        fixture.endpoints.own(
            "grpc://localhost:50051",
            OwnTarget::GrpcListener { served: true },
        );
        fixture.routes.resolve_to(7, Resolution::Actor(alice.id));

        let attempt = fixture
            .service()
            .deliver_local("grpc://localhost:50051", &envelope(7), Some(Uuid::new_v4()))
            .await;

        assert_eq!(attempt, LocalAttempt::Delivered);
        assert_eq!(fixture.mailboxes.waiting(&alice.id), vec![envelope(7)]);
    }
}
