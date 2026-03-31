use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ── Transport ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportProtocol {
    Https,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transport {
    pub protocol: TransportProtocol,
    pub uri: String,
}

// ── Actor ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Owner,
    Helper,
}

#[derive(Debug, Clone, Serialize)]
pub struct Actor {
    pub id: Uuid,
    pub role: Role,
    pub name: String,
    pub transport: Transport,
}

// ── Session ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Session {
    pub id: Uuid,
    pub actors: Vec<Actor>,
}

// ── Request / Response DTOs ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateSessionRequest {
    /// Role the caller is taking in this session.
    pub role: Role,
    /// Display name of the calling actor.
    pub name: String,
    /// Transport the caller is reachable at (provided by the FE).
    pub transport: Transport,
    /// Number of additional helpers to provision in the session.
    /// If role == Helper, an Owner is also provisioned automatically.
    pub additional_helpers: u8,
}

#[derive(Debug, Serialize)]
pub struct CreateSessionResponse {
    pub session_id: Uuid,
    /// All actors in the session, including the caller and any provisioned actors.
    pub actors: Vec<Actor>,
}
