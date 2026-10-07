// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Getting a message to an actor: what became of it in an inbox, a relay
//! request and where the relay may take it, and local delivery attempts.

use uuid::Uuid;

use super::OwnTarget;

/// What happened to a message handed to an actor's inbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DispatchOutcome {
    Delivered,
    /// The actor is simulating offline; the message is discarded, not queued.
    Dropped,
    NoInbox,
    /// A browser actor's mailbox is at its cap; the message was refused and
    /// nothing already queued was touched.
    MailboxFull,
    /// The mailbox could not be written — the database failed. The message
    /// was not queued, so the sender must see a failure and retry.
    Unavailable,
}

/// What trying an endpoint as a local delivery came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalAttempt {
    Delivered,
    /// The recipient is on this node and refused the message.
    Refused(String),
    /// The endpoint is not this node, or names nothing on it: dial as usual.
    /// A previously advertised address may since have been taken by another
    /// node, which is why an unknown recipient falls through to the dial
    /// rather than failing.
    NotLocal,
}

/// A message to relay on a browser owner's behalf.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayRequest {
    /// The endpoint to deliver to, as the peer advertised it.
    pub uri: String,
    /// Raw wire bytes, base64url-encoded.
    pub data: String,
    /// The browser-run actor on whose behalf this is relayed. Used only to
    /// attribute the relay's events, and as the sender when the target is a
    /// channel on this node; it is not an authenticator. When present it must
    /// name an actor on this node.
    pub actor_id: Option<Uuid>,
}

/// Where the relay will deliver a target, or why it will not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayTarget {
    /// The target is this node, under a name it has now or had before:
    /// delivered in-process, never dialled.
    Local(OwnTarget),
    /// Another node the relay may dial.
    Remote,
    /// Refused, with the reason the caller is told.
    Refused(RelayRefusal),
}

/// Why the relay will not deliver to a target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayRefusal {
    /// Another node, not named in `server.relay_allowed_hosts`.
    NotAllowed,
    /// This node's own gRPC address, while gRPC is disabled here.
    GrpcDisabled,
    /// Not an endpoint the relay can dial at all.
    Malformed,
}
