use std::sync::Arc;

use actix::Addr;
use dashmap::DashMap;
use tokio::sync::{Mutex, mpsc};
use uuid::Uuid;

use crate::actor::ProvisionedActor;
use crate::models::Session;

/// Uniform delivery abstraction for all actors.
/// Both browser-managed and provisioned actors receive messages through this enum.
pub enum ActorInbox {
    /// Browser-managed actor — messages buffered for HTTP polling.
    Browser(mpsc::UnboundedSender<Vec<u8>>),
    /// Provisioned actor — messages delivered to the Actix actor's mailbox.
    Provisioned(Addr<ProvisionedActor>),
}

#[derive(Clone)]
pub struct AppState {
    pub sessions: Arc<DashMap<Uuid, Session>>,

    // ── Uniform inbox layer ──────────────────────────────────────────────────
    /// Every actor (browser + provisioned) gets an entry here.
    /// Delivering a message = sending through this inbox.
    pub actor_inboxes: Arc<DashMap<Uuid, ActorInbox>>,

    /// Receiver side for browser-managed actors (owners, browser participants).
    /// The poll_mailbox HTTP handler drains these.
    pub browser_receivers: Arc<DashMap<Uuid, Arc<Mutex<mpsc::UnboundedReceiver<Vec<u8>>>>>>,

    // ── Status tracking ──────────────────────────────────────────────────────
    /// Tracks paired participant channel IDs. Key = participant actor UUID, value = list of channel IDs (one per paired owner).
    pub participant_channels: Arc<DashMap<Uuid, Vec<String>>>,
    /// Recovery pairings awaiting channel association by the participant.
    pub pending_associations: Arc<DashMap<Uuid, String>>,
    /// Participants currently simulating offline status. Messages are silently dropped.
    pub disabled_participants: Arc<DashMap<Uuid, ()>>,
    /// Tracks paired replica channel IDs. Key = replica actor UUID, value = list of channel IDs.
    pub replica_channels: Arc<DashMap<Uuid, Vec<String>>>,
    /// Replicas that have been confirmed via fingerprint verification.
    pub replica_confirmed: Arc<DashMap<Uuid, ()>>,
    /// Replicas currently simulating offline status. Messages are silently dropped.
    pub disabled_replicas: Arc<DashMap<Uuid, ()>>,

    // ── Browser participant signaling ────────────────────────────────────────
    /// Contact messages posted by browser-managed participants (JSON string).
    pub browser_participant_contacts: Arc<DashMap<Uuid, String>>,

    // ── Infrastructure ───────────────────────────────────────────────────────
    /// Base URL this server is reachable at, used to build transport URIs.
    pub base_url: Arc<str>,
    /// Shared HTTP client for outbound transport (participant protocol responses).
    pub http_client: reqwest::Client,
    /// Actix arbiter handle for starting provisioned actors.
    pub arbiter: actix_rt::ArbiterHandle,
}

impl AppState {
    pub fn new(base_url: impl Into<Arc<str>>, http_client: reqwest::Client, arbiter: actix_rt::ArbiterHandle) -> Self {
        Self {
            sessions: Arc::new(DashMap::new()),
            actor_inboxes: Arc::new(DashMap::new()),
            browser_receivers: Arc::new(DashMap::new()),
            participant_channels: Arc::new(DashMap::new()),
            pending_associations: Arc::new(DashMap::new()),
            disabled_participants: Arc::new(DashMap::new()),
            replica_channels: Arc::new(DashMap::new()),
            replica_confirmed: Arc::new(DashMap::new()),
            disabled_replicas: Arc::new(DashMap::new()),
            browser_participant_contacts: Arc::new(DashMap::new()),
            base_url: base_url.into(),
            http_client,
            arbiter,
        }
    }
}
