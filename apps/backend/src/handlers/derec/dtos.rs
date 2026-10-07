// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::models::RelayRequest;

/// One queued message.
#[derive(Debug, Serialize)]
pub struct MailboxMessage {
    /// Raw wire bytes, base64url-encoded for JSON transport.
    pub data: String,
}

/// `GET /derec/{actor_id}/mailbox`: the drained queue, oldest first. Not
/// enveloped — this is the transport's own shape.
#[derive(Debug, Serialize)]
pub struct PollMessagesResponse {
    pub messages: Vec<MailboxMessage>,
}

impl From<Vec<Vec<u8>>> for PollMessagesResponse {
    fn from(messages: Vec<Vec<u8>>) -> Self {
        Self {
            messages: messages
                .into_iter()
                .map(|bytes| MailboxMessage {
                    data: URL_SAFE_NO_PAD.encode(&bytes),
                })
                .collect(),
        }
    }
}

/// `POST /derec/relay`: what to deliver, and where.
#[derive(Debug, Deserialize)]
pub struct RelayRequestDto {
    /// The endpoint to deliver to, as the peer advertised it.
    pub uri: String,
    /// Raw wire bytes, base64url-encoded — the same encoding
    /// [`MailboxMessage`] uses in the other direction.
    pub data: String,
    /// The browser-run actor on whose behalf this is relayed. Optional, and
    /// used only to attribute the relay's events in `/api/v1/debug/events` and
    /// as the sender when the target is a channel on this node; it is not an
    /// authenticator. When present it must name an actor on this node.
    #[serde(default)]
    pub actor_id: Option<Uuid>,
}

impl From<RelayRequestDto> for RelayRequest {
    fn from(dto: RelayRequestDto) -> Self {
        Self {
            uri: dto.uri,
            data: dto.data,
            actor_id: dto.actor_id,
        }
    }
}
