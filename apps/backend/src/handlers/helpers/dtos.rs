// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::handlers::errors::{ApiError, ErrorCode};
use crate::models::{
    Actor, AddHelper, ChannelSummary, EnsurePool, EnsuredPool, ProtocolSettings,
    TransportBreakdown, TransportMode, UnpairAck,
};

// ── Provisioning ────────────────────────────────────────────────────────────

/// Protocol settings a provisioning request carries, flattened into it.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub struct ProtocolSettingsRequest {
    pub protocol_timeout_secs: Option<u32>,
    pub unpair_ack: Option<UnpairAck>,
}

impl From<ProtocolSettingsRequest> for ProtocolSettings {
    fn from(request: ProtocolSettingsRequest) -> Self {
        Self {
            protocol_timeout_secs: request.protocol_timeout_secs,
            unpair_ack: request.unpair_ack,
        }
    }
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

impl From<AddHelperRequest> for AddHelper {
    fn from(request: AddHelperRequest) -> Self {
        Self {
            name: request.name,
            transport_mode: request.transport_mode,
            settings: request.settings.into(),
        }
    }
}

/// The provisioned helper actor, flattened.
#[derive(Debug, Serialize)]
pub struct AddHelperResponse {
    #[serde(flatten)]
    pub actor: Actor,
}

impl From<Actor> for AddHelperResponse {
    fn from(actor: Actor) -> Self {
        Self { actor }
    }
}

/// Bring the shared helper pool up to a size. States a target, not a quantity
/// to add.
#[derive(Debug, Deserialize)]
pub struct EnsureHelpersRequest {
    /// How many helpers should exist once this call returns, at most
    /// [`crate::models::MAX_POOL_SIZE`].
    ///
    /// Wider than the limit on purpose: read as a `u8`, an out-of-range value
    /// was refused by serde with a message about integer widths and JSON
    /// columns. Read wide, the service refuses it with the actual limit.
    pub total: u64,
    /// Display names offered for any helpers that need creating, taken in
    /// order from the first one created.
    #[serde(default)]
    pub names: Vec<String>,
    /// Target composition of the pool by transport. Must sum to `total`.
    /// Omitted means every helper is HTTP.
    #[serde(default)]
    pub transports: Option<TransportBreakdown>,
    #[serde(flatten)]
    pub settings: ProtocolSettingsRequest,
}

impl From<EnsureHelpersRequest> for EnsurePool {
    fn from(request: EnsureHelpersRequest) -> Self {
        Self {
            total: request.total,
            names: request.names,
            transports: request.transports,
            settings: request.settings.into(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct EnsureHelpersResponse {
    /// The whole pool, including helpers other owners provisioned.
    pub helpers: Vec<Actor>,
    /// How many of them this call had to create. Lets the caller report
    /// "reused 7, created 2" rather than guessing.
    pub created: usize,
}

impl From<EnsuredPool> for EnsureHelpersResponse {
    fn from(pool: EnsuredPool) -> Self {
        Self {
            helpers: pool.helpers,
            created: pool.created,
        }
    }
}

// ── Operator levers ─────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct SetStatusRequest {
    pub disabled: bool,
}

/// Whether the helper is offline once the call returns.
#[derive(Debug, Serialize)]
pub struct ToggleStatusResponse {
    pub disabled: bool,
}

impl From<bool> for ToggleStatusResponse {
    fn from(disabled: bool) -> Self {
        Self { disabled }
    }
}

#[derive(Debug, Deserialize)]
pub struct LinkChannelsRequest {
    /// Channel to link *from* — typically the caller's own channel with this actor.
    pub channel_id: String,
    /// Existing channel the actor already holds for the same owner.
    pub link_to_channel_id: String,
}

/// One channel a helper holds, for the operator's link picker.
#[derive(Debug, Clone, Serialize)]
pub struct ChannelSummaryDto {
    pub channel_id: String,
    /// Peer's app-level display name. Informational only.
    pub peer_name: String,
    /// This actor's role on the channel: "owner" or "helper".
    pub role: String,
    /// Channels already linked to this one, itself excluded.
    pub linked_channel_ids: Vec<String>,
}

impl From<ChannelSummary> for ChannelSummaryDto {
    fn from(summary: ChannelSummary) -> Self {
        Self {
            channel_id: summary.channel_id,
            peer_name: summary.peer_name,
            role: summary.role,
            linked_channel_ids: summary.linked_channel_ids,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ListChannelsResponse {
    pub channels: Vec<ChannelSummaryDto>,
}

impl From<Vec<ChannelSummary>> for ListChannelsResponse {
    fn from(channels: Vec<ChannelSummary>) -> Self {
        Self {
            channels: channels.into_iter().map(Into::into).collect(),
        }
    }
}

/// `POST /api/v1/helpers/{helper_id}/link`: always `true` on success.
#[derive(Debug, Serialize)]
pub struct LinkChannelsResponse {
    pub linked: bool,
}

impl LinkChannelsResponse {
    pub const LINKED: Self = Self { linked: true };
}

// ── Browser contacts ────────────────────────────────────────────────────────

/// A browser actor's published contact, exactly as it was posted.
///
/// Held as raw JSON rather than re-encoded: the contact is the browser's
/// format, and the backend only stores it and hands it back.
#[derive(Debug, Serialize)]
#[serde(transparent)]
pub struct BrowserContactResponse(Box<RawValue>);

impl TryFrom<String> for BrowserContactResponse {
    type Error = ApiError;

    /// Fails only for a stored row that is no longer JSON — the publish path
    /// refuses anything else — which is the node's fault, not the caller's.
    fn try_from(contact: String) -> Result<Self, Self::Error> {
        RawValue::from_string(contact).map(Self).map_err(|e| {
            tracing::error!(error = %e, "a stored browser contact is not JSON");
            ApiError::new(
                ErrorCode::InternalError,
                "the stored contact could not be read",
            )
        })
    }
}
