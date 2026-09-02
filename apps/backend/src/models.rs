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
    Helper,
}

/// How the app decides that two pairing channels belong to the same user.
///
/// This is an **app-level** concern (the DeRec protocol is identity-blind). The
/// backend never acts on it — it only carries it as an operator-supplied
/// default for the front end (see [`crate::config`]).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthenticationMethod {
    /// Helper manually links channels (the in-modal "accept + link" flow).
    #[default]
    User,
    /// Reserved for a future automatic-linking mode; not yet implemented.
    Application,
}

/// Protocol-level acknowledgement policy for the unpair flow. Mirrors
/// `derec_library::protocol::UnpairAck`; supplied per provisioning request by
/// the node that provisions the actor.
///
/// - `Required` (default): the initiator keeps local state until the peer
///   ACKs or the timeout elapses.
/// - `NotRequired`: fire-and-forget — state drops immediately on
///   `start(Unpair)`.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UnpairAck {
    #[default]
    Required,
    NotRequired,
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

/// Protocol settings a provisioning request carries for the actor it mints.
///
/// The front end owns configuration, so these travel with each request rather
/// than being read from server state. Both are optional: a caller that omits
/// them gets the operator-supplied defaults the server already serves at
/// `GET /config`.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub struct ProtocolSettingsRequest {
    pub protocol_timeout_secs: Option<u32>,
    pub unpair_ack: Option<UnpairAck>,
}

impl ProtocolSettingsRequest {
    /// Fill the unset fields from the operator-supplied defaults.
    pub fn resolve(self, defaults: &crate::config::Defaults) -> (u32, UnpairAck) {
        (
            self.protocol_timeout_secs
                .unwrap_or(defaults.protocol_timeout_secs),
            self.unpair_ack.unwrap_or(defaults.unpair_ack),
        )
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Actor {
    pub id: Uuid,
    pub role: Role,
    pub name: String,
    pub transport: Transport,
    /// This actor's own `secret_id` — the secret it protects when acting as
    /// Owner — as a decimal string (a `u64` exceeds JavaScript's exact
    /// integer range).
    ///
    /// Each actor runs one protocol instance bound to this value. Helper-role
    /// channels live in that same instance; the shares they hold carry their
    /// own Owner's `secret_id` on the record.
    pub secret_id: String,
}

/// Actor enriched with live pairing state — used in `GET /actors`.
#[derive(Debug, Clone, Serialize)]
pub struct ActorWithStatus {
    #[serde(flatten)]
    pub actor: Actor,
    /// Protocol channel ID, present only if pairing has completed for this actor.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// Shared symmetric key for the helper channel (base64url-encoded), present only for helpers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared_key: Option<String>,
    /// Whether this actor is currently simulating offline status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
    /// True when this actor's protocol instance runs in a browser rather than
    /// on the backend, so it has no backend instance to drive. Peers must fetch
    /// its contact from the signaling endpoint instead of `/actors/:id/contact`.
    ///
    /// Set for every browser actor regardless of role — including one acting as
    /// another device's replica, which registers as an ordinary `Role::Owner`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_managed: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct ListActorsResponse {
    pub actors: Vec<ActorWithStatus>,
}

#[derive(Debug, Deserialize)]
pub struct RegisterOwnerRequest {
    /// Display name of the owner.
    pub name: String,
    /// When set, the caller **claims an existing owner actor's identity**
    /// rather than creating a new actor. Used by the recovery flow so a
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
pub struct RegisterOwnerResponse {
    #[serde(flatten)]
    pub actor: Actor,
}

#[derive(Debug, Deserialize)]
pub struct AddHelperRequest {
    /// Display name for the new helper.
    pub name: String,
    #[serde(flatten)]
    pub settings: ProtocolSettingsRequest,
}

#[derive(Debug, Serialize)]
pub struct AddHelperResponse {
    #[serde(flatten)]
    pub actor: Actor,
}

/// Bring the shared helper pool up to a size.
///
/// Provisioned helpers belong to the server rather than to whoever asked
/// for them, so this states a target, not a quantity to add. Asking for fewer
/// than exist is a no-op: another owner may be paired with a helper this
/// caller does not want.
#[derive(Debug, Deserialize)]
pub struct EnsureHelpersRequest {
    /// How many helpers should exist once this call returns.
    pub total: u8,
    /// Display names offered for any helpers that need creating, taken in
    /// order from the first one created. The caller cannot know in advance how
    /// many that will be — that depends on what other owners have already
    /// provisioned — so it sends candidates and the server uses what it needs.
    /// Anything not covered falls back to a numbered label.
    #[serde(default)]
    pub names: Vec<String>,
    #[serde(flatten)]
    pub settings: ProtocolSettingsRequest,
}

#[derive(Debug, Serialize)]
pub struct EnsureHelpersResponse {
    /// The whole pool, including helpers other owners provisioned.
    pub helpers: Vec<Actor>,
    /// How many of them this call had to create. Lets the caller report
    /// "reused 7, created 2" rather than guessing.
    pub created: usize,
}
