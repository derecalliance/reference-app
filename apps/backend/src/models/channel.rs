// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Channels a provisioned actor holds, as the operator sees them.

/// One channel a provisioned actor holds, for the operator's link picker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelSummary {
    pub channel_id: String,
    /// Peer's app-level display name, from `communication_info["name"]`.
    /// Informational only — never an identity the actor acts on.
    pub peer_name: String,
    /// This actor's role on the channel: "owner" or "helper".
    pub role: String,
    /// Channels already linked to this one, itself excluded.
    pub linked_channel_ids: Vec<String>,
}
