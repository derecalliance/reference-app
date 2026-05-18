use std::sync::Arc;

use actix::Addr;
use dashmap::DashMap;
use tokio::sync::{Mutex, mpsc};
use uuid::Uuid;

use crate::actor::ProvisionedActor;
use crate::models::Session;

/// Unified inbox for all actors, regardless of whether they run in-process or in a browser.
pub enum ActorInbox {
    /// Messages are buffered in an mpsc channel and drained by HTTP polling.
    Browser(mpsc::UnboundedSender<Vec<u8>>),
    /// Messages are delivered directly to the Actix actor's mailbox.
    Provisioned(Addr<ProvisionedActor>),
}

#[derive(Clone)]
pub struct AppState {
    pub sessions: Arc<DashMap<Uuid, Session>>,
    pub actor_inboxes: Arc<DashMap<Uuid, ActorInbox>>,
    /// Receiver halves for browser actor inboxes; drained by the poll_mailbox handler.
    pub browser_receivers: Arc<DashMap<Uuid, Arc<Mutex<mpsc::UnboundedReceiver<Vec<u8>>>>>>,
    /// Participant-side channel IDs per actor (one entry per paired owner).
    pub participant_channels: Arc<DashMap<Uuid, Vec<String>>>,
    pub disabled_participants: Arc<DashMap<Uuid, ()>>,
    pub replica_channels: Arc<DashMap<Uuid, Vec<String>>>,
    pub replica_confirmed: Arc<DashMap<Uuid, ()>>,
    pub disabled_replicas: Arc<DashMap<Uuid, ()>>,
    /// Contact messages posted by browser-managed participants for the owner to fetch.
    pub browser_participant_contacts: Arc<DashMap<Uuid, String>>,
    pub base_url: Arc<str>,
    pub http_client: reqwest::Client,
    pub arbiter: actix_rt::ArbiterHandle,
}

impl AppState {
    pub fn new(base_url: impl Into<Arc<str>>, http_client: reqwest::Client, arbiter: actix_rt::ArbiterHandle) -> Self {
        Self {
            sessions: Arc::new(DashMap::new()),
            actor_inboxes: Arc::new(DashMap::new()),
            browser_receivers: Arc::new(DashMap::new()),
            participant_channels: Arc::new(DashMap::new()),
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
