// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportProtocol {
    Https,
    Grpc,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Transport {
    pub protocol: TransportProtocol,
    pub uri: String,
}

impl Transport {
    /// This endpoint as the protocol carries it on the wire.
    pub fn to_proto(&self) -> derec_proto::TransportProtocol {
        let protocol = match self.protocol {
            TransportProtocol::Https => derec_proto::Protocol::Https,
            TransportProtocol::Grpc => derec_proto::Protocol::Grpc,
        };
        derec_proto::TransportProtocol {
            uri: self.uri.clone(),
            protocol: protocol as i32,
        }
    }
}

/// Which transports one provisioned helper serves.
///
/// This is about what it *advertises*. Every provisioned actor dials both
/// regardless — a gRPC-only helper still answers a peer over HTTP if that is
/// what the peer advertised.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportMode {
    /// The status quo, and what an omitted mode resolves to.
    #[default]
    Http,
    Grpc,
    Both,
}

impl TransportMode {
    /// The endpoints a helper in this mode advertises, in preference order.
    ///
    /// `Both` leads with gRPC. The order is an arbitrary fixed app preference:
    /// the library hands a peer's whole list to `DeRecTransport::send` and
    /// takes no view on which entry is dialed.
    pub fn endpoints(&self, base_url: &str, grpc_authority: &str, actor_id: Uuid) -> Vec<Transport> {
        let http = Transport {
            protocol: TransportProtocol::Https,
            uri: format!("{base_url}/derec/{actor_id}"),
        };
        // No actor path: tonic builds the request URI from the authority plus
        // the fixed method path, so anything after it is dropped. The actor is
        // recovered from the envelope's channel id instead.
        let grpc = Transport {
            protocol: TransportProtocol::Grpc,
            uri: format!("grpc://{grpc_authority}"),
        };

        match self {
            TransportMode::Http => vec![http],
            TransportMode::Grpc => vec![grpc],
            TransportMode::Both => vec![grpc, http],
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Owner,
    Helper,
}

/// A target *composition* for the shared helper pool.
///
/// `EnsureHelpersRequest` states a target, not a quantity to add, so a
/// transport preference has to be expressed the same way: how many helpers of
/// each mode should exist once the call returns.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransportBreakdown {
    #[serde(default)]
    pub http: u8,
    #[serde(default)]
    pub grpc: u8,
    #[serde(default)]
    pub both: u8,
}

impl TransportBreakdown {
    pub fn total(&self) -> usize {
        self.http as usize + self.grpc as usize + self.both as usize
    }

    /// Every mode with a non-zero target, paired with that target.
    pub fn modes(&self) -> [(TransportMode, usize); 3] {
        [
            (TransportMode::Http, self.http as usize),
            (TransportMode::Grpc, self.grpc as usize),
            (TransportMode::Both, self.both as usize),
        ]
    }
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

/// The longest a requested protocol timeout may be, in seconds: one day.
///
/// The value is the replay window — how stale an inbound envelope may be and
/// still be accepted — so anything beyond a day is a typo, not a setting.
pub const MAX_PROTOCOL_TIMEOUT_SECS: u32 = 86_400;

impl ProtocolSettingsRequest {
    /// Reject settings no actor can usefully run with.
    ///
    /// Zero is the case that matters: as a replay window it refuses every
    /// inbound message, so the actor pairs with nothing and says nothing about
    /// why. Only the request's own values are checked — the operator defaults
    /// they fall back to are validated when the configuration is loaded.
    pub fn validate(&self) -> Result<(), String> {
        match self.protocol_timeout_secs {
            Some(secs) if secs == 0 || secs > MAX_PROTOCOL_TIMEOUT_SECS => Err(format!(
                "protocol_timeout_secs must be between 1 and {MAX_PROTOCOL_TIMEOUT_SECS}"
            )),
            _ => Ok(()),
        }
    }

    /// Fill the unset fields from the operator-supplied defaults.
    pub fn resolve(self, defaults: &crate::config::Defaults) -> (u32, UnpairAck) {
        (
            self.protocol_timeout_secs
                .unwrap_or(defaults.protocol_timeout_secs),
            self.unpair_ack.unwrap_or(defaults.unpair_ack),
        )
    }
}

/// The longest display name an actor may carry, in characters.
///
/// Names are rendered in roster rows and sent to peers as
/// `communication_info["name"]` on every pairing, so an unbounded one is both
/// a layout problem and a payload every peer has to carry.
pub const MAX_NAME_CHARS: usize = 64;

/// Trim a caller-supplied display name and check it is usable.
///
/// `field` names the input in the error, so a caller sending several names
/// learns which one was refused.
pub fn validate_display_name(raw: &str, field: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("{field} must be at most {MAX_NAME_CHARS} characters"));
    }
    if name.chars().any(char::is_control) {
        return Err(format!("{field} must not contain control characters"));
    }
    Ok(name.to_owned())
}

#[derive(Debug, Clone, Serialize)]
pub struct Actor {
    pub id: Uuid,
    pub role: Role,
    pub name: String,
    /// The first of [`Self::transports`]. Kept because several front-end call
    /// sites want "an address for this actor" and gain nothing from the list.
    pub transport: Transport,
    /// Every endpoint this actor advertises, in preference order.
    ///
    /// The relay's allowlist (`relay_target_is_known` in `routes::derec`)
    /// trusts these by exact string match, on the strength of two facts that
    /// hold together: `Actor` derives `Serialize` but not `Deserialize`, so a
    /// value here can never be supplied by a request body, and every
    /// non-test constructor (`provisioning::provisioned_actor`) builds these
    /// URIs from server config. If a client could ever populate this field,
    /// the relay would dial whatever URI it was handed — an open proxy.
    pub transports: Vec<Transport>,
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
    /// When a browser-managed actor last drained its mailbox, as an RFC 3339
    /// UTC timestamp — or `null` if it has not since this node started.
    ///
    /// The outer `Option` decides presence: only browser-managed actors carry
    /// the field at all, because nothing polls on a provisioned actor's
    /// behalf. Held in memory, so every value resets to `null` on restart.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_polled_at: Option<Option<String>>,
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
    /// A claim keeps the actor's mailbox: whatever queued while no tab was
    /// polling is delivered on the claiming tab's first poll. A previous tab
    /// still polling the same actor competes for messages from then on.
    #[serde(default)]
    pub claim_actor_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
pub struct RegisterOwnerResponse {
    #[serde(flatten)]
    pub actor: Actor,
}

/// `PATCH /owners/{owner_id}`: the owner's new display name, held to the same
/// rules as a name given at registration.
#[derive(Debug, Deserialize)]
pub struct RenameOwnerRequest {
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct RenameOwnerResponse {
    pub id: Uuid,
    /// The name as stored — trimmed, which may differ from what was sent.
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct AddHelperRequest {
    /// Display name for the new helper.
    pub name: String,
    /// What this helper advertises. Omitted means HTTP — today's behaviour.
    #[serde(default)]
    pub transport_mode: TransportMode,
    #[serde(flatten)]
    pub settings: ProtocolSettingsRequest,
}

#[derive(Debug, Serialize)]
pub struct AddHelperResponse {
    #[serde(flatten)]
    pub actor: Actor,
}

/// The largest helper pool `POST /helpers/ensure` will build.
///
/// The transport breakdown counts each mode in a `u8`, and so does the
/// front end's participant count, so a larger pool could not be described.
pub const MAX_POOL_SIZE: u8 = u8::MAX;

/// Bring the shared helper pool up to a size.
///
/// Provisioned helpers belong to the server rather than to whoever asked
/// for them, so this states a target, not a quantity to add. Asking for fewer
/// than exist is a no-op: another owner may be paired with a helper this
/// caller does not want.
#[derive(Debug, Deserialize)]
pub struct EnsureHelpersRequest {
    /// How many helpers should exist once this call returns, at most
    /// [`MAX_POOL_SIZE`].
    ///
    /// Wider than the limit on purpose: read as a `u8`, an out-of-range value
    /// was refused by serde with a message about integer widths and JSON
    /// columns. Read wide, the handler refuses it with the actual limit.
    pub total: u64,
    /// Display names offered for any helpers that need creating, taken in
    /// order from the first one created. The caller cannot know in advance how
    /// many that will be — that depends on what other owners have already
    /// provisioned — so it sends candidates and the server uses what it needs.
    /// Anything not covered falls back to a numbered label.
    #[serde(default)]
    pub names: Vec<String>,
    /// Target composition of the pool by transport. Must sum to `total`.
    /// Omitted means every helper is HTTP.
    #[serde(default)]
    pub transports: Option<TransportBreakdown>,
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
