use std::sync::Arc;

use dashmap::DashMap;
use uuid::Uuid;

use crate::models::Session;

#[derive(Clone)]
pub struct AppState {
    pub sessions: Arc<DashMap<Uuid, Session>>,
    /// Base URL this server is reachable at, used to build transport URIs for provisioned actors.
    /// Controlled via the BASE_URL env var (default: http://localhost:3000).
    pub base_url: Arc<str>,
}

impl AppState {
    pub fn new(base_url: impl Into<Arc<str>>) -> Self {
        Self {
            sessions: Arc::new(DashMap::new()),
            base_url: base_url.into(),
        }
    }
}
