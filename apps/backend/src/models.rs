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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Owner,
    Participant,
    Replica,
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
    /// Display name of the owner.
    pub name: String,
    /// Number of additional participants to provision in the session.
    pub additional_participants: u8,
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
    /// New channel ID from a recovery pairing, awaiting association by the participant.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_recovery_channel_id: Option<String>,
    /// Shared symmetric key for the participant channel (base64url-encoded), present only for participants.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared_key: Option<String>,
    /// Whether this actor is currently simulating offline status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
    /// True when this participant is browser-managed (no backend protocol instance).
    /// The owner must fetch the participant's contact from the signaling endpoint.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_managed: Option<bool>,
    /// Whether this replica has been confirmed via fingerprint verification.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replica_confirmed: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct GetSessionResponse {
    pub session_id: Uuid,
    pub actors: Vec<ActorWithStatus>,
}

#[derive(Debug, Deserialize)]
pub struct AddParticipantRequest {
    /// Display name for the new participant (e.g. "Participant-4").
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct AddParticipantResponse {
    #[serde(flatten)]
    pub actor: Actor,
}

#[derive(Debug, Deserialize)]
pub struct AddReplicaRequest {
    /// Display name for the new replica (e.g. "Replica-1").
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct AddReplicaResponse {
    #[serde(flatten)]
    pub actor: Actor,
}

#[derive(Debug, Deserialize)]
pub struct JoinSessionRequest {
    /// Display name for the joining owner.
    pub name: String,
    /// Number of participants the joining owner wants pre-paired (frontend uses this locally).
    pub pre_paired_count: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct JoinSessionResponse {
    pub session_id: Uuid,
    /// The newly created actor for the joining participant.
    pub actor: Actor,
    /// All actors in the session (enriched with pairing status), so the
    /// joining participant can discover the owner and other participants.
    pub actors: Vec<ActorWithStatus>,
}
