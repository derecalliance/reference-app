use serde::{Deserialize, Serialize};
use uuid::Uuid;

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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Owner,
    Participant,
    Replica,
}

/// How the app decides that two pairing channels belong to the same user.
///
/// This is an **app-level** concern (the DeRec protocol is identity-blind).
/// The backend stores the choice and echoes it back to every joiner so the FE
/// renders a consistent pairing-confirmation UX across the session.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthenticationMethod {
    /// Helper manually links channels (the in-modal "accept + link" flow).
    User,
    /// Reserved for a future automatic-linking mode; not yet implemented.
    Application,
}

impl Default for AuthenticationMethod {
    fn default() -> Self {
        AuthenticationMethod::User
    }
}

/// Protocol-level acknowledgement policy for the unpair flow. Mirrors
/// `derec_library::protocol::UnpairAck`; chosen at session creation and
/// echoed back to every joiner so all participants agree on the semantics.
///
/// - `Required` (default): the initiator keeps local state until the peer
///   ACKs or the timeout elapses.
/// - `NotRequired`: fire-and-forget — state drops immediately on
///   `start(Unpair)`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UnpairAck {
    Required,
    NotRequired,
}

impl Default for UnpairAck {
    fn default() -> Self {
        UnpairAck::Required
    }
}

impl UnpairAck {
    /// Convert to the lib's enum for protocol builder consumption.
    pub fn to_library(self) -> derec_library::protocol::UnpairAck {
        match self {
            UnpairAck::Required => derec_library::protocol::UnpairAck::Required,
            UnpairAck::NotRequired => derec_library::protocol::UnpairAck::NotRequired,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Actor {
    pub id: Uuid,
    pub role: Role,
    pub name: String,
    pub transport: Transport,
}

#[derive(Debug, Clone)]
pub struct Session {
    pub _id: Uuid,
    pub actors: Vec<Actor>,
    /// Minimum number of participants required to protect a secret.
    pub min_participants: u8,
    /// Recommended number of participants for optimal protection.
    pub recommended_participants: u8,
    /// General protocol timeout in seconds (passive message/round expiry in
    /// `process()`, and the active wall-clock deadline at the app layer).
    pub protocol_timeout_secs: u32,
    /// App-level authentication method (no protocol semantics). Stored here so
    /// every joiner sees the same choice.
    pub authentication_method: AuthenticationMethod,
    /// Protocol-level unpair acknowledgement policy applied to every actor in
    /// this session.
    pub unpair_ack: UnpairAck,
    /// FE-only UI preference echoed back to every joiner so the whole
    /// session presents a consistent UX for incoming unpair requests.
    /// When `false`, the Owner's UI shows a confirmation modal; when
    /// `true`, the FE auto-accepts. Not consulted by the protocol layer.
    pub auto_accept_unpair_requests: bool,
}

#[derive(Debug, Deserialize)]
pub struct CreateSessionRequest {
    /// Display name of the owner.
    pub name: String,
    /// Number of additional participants to provision in the session.
    pub additional_participants: u8,
    /// Minimum participants required to protect a secret.
    pub min_participants: Option<u8>,
    /// Recommended participants for optimal protection.
    pub recommended_participants: Option<u8>,
    /// General protocol timeout in seconds. Defaults to 300 when omitted.
    pub protocol_timeout_secs: Option<u32>,
    /// App-level authentication method. Defaults to `user` when omitted.
    pub authentication_method: Option<AuthenticationMethod>,
    /// Unpair acknowledgement policy. Defaults to `required` when omitted.
    pub unpair_ack: Option<UnpairAck>,
    /// FE-only UX preference. Defaults to `true` (auto-accept) when omitted.
    pub auto_accept_unpair_requests: Option<bool>,
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
    pub min_participants: u8,
    pub recommended_participants: u8,
    pub protocol_timeout_secs: u32,
    pub authentication_method: AuthenticationMethod,
    pub unpair_ack: UnpairAck,
    pub auto_accept_unpair_requests: bool,
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
    pub name: String,
    /// When set, the caller **claims an existing owner actor's identity**
    /// rather than creating a new actor. Used by the recovery-join flow so a
    /// recovering user can resume polling the mailbox of an old owner whose
    /// helpers still hold the old transport URI on their channel records.
    ///
    /// The claim is **unauthenticated here** — for a reference app, this is
    /// intentional. A real app would gate this behind server-side auth.
    /// On a successful claim the actor's mailbox tx/rx is rebound to a fresh
    /// pair, so the new tab starts receiving messages and any previous tab
    /// silently stops.
    #[serde(default)]
    pub claim_actor_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
pub struct JoinSessionResponse {
    pub session_id: Uuid,
    /// The newly created actor for the joining participant.
    pub actor: Actor,
    /// All actors in the session (enriched with pairing status), so the
    /// joining participant can discover the owner and other participants.
    pub actors: Vec<ActorWithStatus>,
    pub min_participants: u8,
    pub recommended_participants: u8,
    pub protocol_timeout_secs: u32,
    pub authentication_method: AuthenticationMethod,
    pub unpair_ack: UnpairAck,
    pub auto_accept_unpair_requests: bool,
}
