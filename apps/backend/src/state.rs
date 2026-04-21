use std::sync::Arc;

use dashmap::DashMap;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::models::Session;
use crate::stores::HelperProtocol;

#[derive(Clone)]
pub struct AppState {
    pub sessions: Arc<DashMap<Uuid, Session>>,
    /// Per-actor message mailboxes keyed by actor UUID.
    /// Each entry is an ordered queue of raw protobuf-encoded DeRec wire messages
    /// waiting to be picked up by the actor via polling.
    pub mailboxes: Arc<DashMap<Uuid, Vec<Vec<u8>>>>,
    /// Backend-managed helper protocol instances keyed by helper actor UUID.
    /// Each protocol processes incoming messages inline (no polling needed).
    pub helper_protocols: Arc<DashMap<Uuid, Arc<Mutex<HelperProtocol>>>>,
    /// Tracks paired helper channel IDs. Key = helper actor UUID, value = channel ID string.
    /// Populated when PairingComplete events are observed from helper protocol processing.
    pub helper_channels: Arc<DashMap<Uuid, String>>,
    /// Recovery pairings awaiting channel association by the helper.
    /// Key = helper actor UUID, value = new recovery channel ID string.
    /// Cleared when the helper calls associate-channel.
    pub pending_associations: Arc<DashMap<Uuid, String>>,
    /// Base URL this server is reachable at, used to build transport URIs for provisioned actors.
    /// Controlled via the BASE_URL env var (default: http://localhost:5000).
    pub base_url: Arc<str>,
    /// Shared HTTP client for outbound transport (helper protocol responses).
    pub http_client: reqwest::Client,
}

impl AppState {
    pub fn new(base_url: impl Into<Arc<str>>, http_client: reqwest::Client) -> Self {
        Self {
            sessions: Arc::new(DashMap::new()),
            mailboxes: Arc::new(DashMap::new()),
            helper_protocols: Arc::new(DashMap::new()),
            helper_channels: Arc::new(DashMap::new()),
            pending_associations: Arc::new(DashMap::new()),
            base_url: base_url.into(),
            http_client,
        }
    }
}
