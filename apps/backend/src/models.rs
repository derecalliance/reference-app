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
    pub _id: Uuid,
    pub actors: Vec<Actor>,
}

// ── Request / Response DTOs ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateSessionRequest {
    /// Role the caller is taking in this session.
    pub role: Role,
    /// Display name of the calling actor.
    pub name: String,
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

/// Actor enriched with live pairing state — used in GET /sessions/{id}.
#[derive(Debug, Clone, Serialize)]
pub struct ActorWithStatus {
    #[serde(flatten)]
    pub actor: Actor,
    /// Protocol channel ID, present only if pairing has completed for this actor.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// New channel ID from a recovery pairing, awaiting association by the helper.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_recovery_channel_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GetSessionResponse {
    pub session_id: Uuid,
    pub actors: Vec<ActorWithStatus>,
}
