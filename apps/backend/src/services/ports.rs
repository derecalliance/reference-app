// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The ports more than one service reaches the outside through.
//!
//! Each is a trait the services hold as `Arc<dyn …>`, implemented in
//! [`crate::infrastructure`]: the actix actor runtime behind [`ActorGateway`],
//! its inbox table behind [`InboxDirectory`], the gRPC channel router behind
//! [`ChannelRoutes`], the event log behind [`EventRecorder`] and the node's
//! address book behind [`OwnEndpoints`]. A port only one service needs lives
//! beside that service instead.

use async_trait::async_trait;
use derec_library::protocol::{DeRecEvent, DeRecFlow};
use uuid::Uuid;

use crate::models::{
    Actor, ActorSettings, ChannelSummary, ContactRequest, EventSnapshot, InboxKind, Listener,
    NewEvent, OwnTarget, Resolution, Route,
};

// ── Inboxes ─────────────────────────────────────────────────────────────────

/// The live inbox of every actor this node delivers to.
pub trait InboxDirectory: Send + Sync {
    /// Where `actor_id`'s protocol runs, or `None` if nothing on this node
    /// takes its traffic.
    fn kind(&self, actor_id: &Uuid) -> Option<InboxKind>;

    /// Mark an actor as browser-run, so traffic for it queues in its mailbox
    /// until a tab polls. Idempotent, and deliberately so: the claim flow
    /// registers an actor that already has a mailbox, and recovery registers
    /// every owner at boot. Registering again never discards what is waiting.
    fn register_browser(&self, actor_id: Uuid);

    /// Hand raw wire bytes to a provisioned actor's running instance. Answers
    /// whether there was one to hand them to.
    fn deliver(&self, actor_id: &Uuid, bytes: Vec<u8>) -> bool;
}

// ── Provisioned actors ──────────────────────────────────────────────────────

/// Why a call into a provisioned actor did not produce an answer.
#[derive(Debug, thiserror::Error)]
pub enum ActorCallError {
    /// The actor has no backend protocol instance on this node.
    #[error("the actor has no backend protocol instance")]
    NotProvisioned,
    /// The actor stopped, or is shutting down ahead of deletion. Transient
    /// from the caller's side.
    #[error("the actor is not running: {0}")]
    NotRunning(String),
    /// The instance the call needs is out on another call.
    #[error("the actor is busy with another call")]
    Busy,
    /// A delivery the call had to make reached no endpoint the peer advertised.
    #[error("the peer could not be reached")]
    PeerUnreachable,
    /// The actor already mirrors as many owners as it will hold.
    #[error("this actor already mirrors {max} owners, the most it will hold")]
    ReplicaLimitReached { max: usize },
    /// The secret named for a replica instance is the actor's own.
    #[error("the secret named is this actor's own, not another owner's")]
    OwnSecret,
    /// The protocol refused the call.
    #[error(transparent)]
    Protocol(derec_library::Error),
}

/// Why a provisioned actor could not be started.
#[derive(Debug, thiserror::Error)]
pub enum SpawnError {
    #[error("actor has an unparseable secret_id")]
    SecretId,
    #[error("could not build the protocol instance: {0}")]
    Protocol(#[from] derec_library::Error),
}

/// The backend-run actors: starting and stopping them, and the calls their
/// protocol instances answer.
#[async_trait]
pub trait ActorGateway: Send + Sync {
    /// Start a new provisioned actor running `actor` with `settings`.
    ///
    /// Nothing is left running on failure: the instance is built before the
    /// actor starts, so an error means no actor and no inbox.
    fn spawn(&self, actor: &Actor, settings: &ActorSettings) -> Result<(), SpawnError>;

    /// Stop a provisioned actor for good and take its inbox away, ahead of its
    /// data being erased. A browser actor only loses its inbox entry.
    fn shutdown(&self, actor_id: &Uuid);

    /// Ensure the actor holds an instance bound to `owner_secret_id`,
    /// answering whether one was created. Idempotent.
    async fn ensure_replica_instance(
        &self,
        actor_id: &Uuid,
        owner_secret_id: u64,
    ) -> Result<bool, ActorCallError>;

    /// Mint an out-of-band contact.
    async fn create_contact(
        &self,
        actor_id: &Uuid,
        request: ContactRequest,
    ) -> Result<derec_proto::ContactMessage, ActorCallError>;

    /// Start a protocol flow on the actor's own instance.
    async fn start_flow(
        &self,
        actor_id: &Uuid,
        flow: DeRecFlow,
    ) -> Result<Vec<DeRecEvent>, ActorCallError>;

    /// The actor's own fingerprint for `channel_id`.
    async fn fingerprint(&self, actor_id: &Uuid, channel_id: u64)
        -> Result<String, ActorCallError>;

    /// Compare `fingerprint` with the actor's own for `channel_id`, promoting
    /// the channel out of `Pending` when they match.
    async fn verify_fingerprint(
        &self,
        actor_id: &Uuid,
        channel_id: u64,
        fingerprint: String,
    ) -> Result<bool, ActorCallError>;

    /// Every helper channel on the actor's own instance.
    async fn list_channels(&self, actor_id: &Uuid) -> Result<Vec<ChannelSummary>, ActorCallError>;

    /// Record that two channels belong to the same owner.
    async fn link_channels(
        &self,
        actor_id: &Uuid,
        channel_id: u64,
        link_to_channel_id: u64,
    ) -> Result<(), ActorCallError>;

    /// The `secret_id` of every instance the actor runs, ascending. Empty when
    /// it runs none here or does not answer.
    async fn instance_secret_ids(&self, actor_id: &Uuid) -> Vec<u64>;
}

// ── gRPC routing ────────────────────────────────────────────────────────────

/// The node-wide `channel_id` → actor index gRPC ingress resolves through.
pub trait ChannelRoutes: Send + Sync {
    /// Route `channel_id` to `actor_id` before any store knows about it. Adds
    /// a claim; never displaces another actor's.
    fn pin(&self, channel_id: u64, actor_id: Uuid);
    /// Drop `actor_id`'s pin on `channel_id`, leaving any other claim intact.
    fn unpin(&self, channel_id: u64, actor_id: Uuid);
    /// Which actor a message on `channel_id`, sent by `sender`, is for.
    fn resolve_from(&self, channel_id: u64, sender: Option<Uuid>) -> Resolution;
    /// Forget every claim `actor_id` holds, answering how many channels it
    /// held.
    fn remove_actor(&self, actor_id: Uuid) -> usize;
    /// Every route, ordered, for the debug surface.
    fn routes(&self) -> Vec<Route>;
}

// ── Observability ───────────────────────────────────────────────────────────

/// What the node did, in order.
pub trait EventRecorder: Send + Sync {
    fn record(&self, event: NewEvent);
    /// Events after `after`, oldest first, capped at `limit`.
    fn since(&self, after: u64, limit: usize) -> EventSnapshot;
}

// ── Addresses ───────────────────────────────────────────────────────────────

/// Which endpoints name this node, under any address it has had.
pub trait OwnEndpoints: Send + Sync {
    /// Whether `uri` names this node, and if so what it reaches.
    fn own_target(&self, uri: &str) -> Option<OwnTarget>;
    /// Every address this node has advertised on `listener`, sorted.
    fn advertised(&self, listener: Listener) -> Vec<String>;
}
