// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! What the node did, as the event log records it.
//!
//! The log itself is [`crate::infrastructure::event_log::EventLog`]; these are
//! the records it keeps and the page it answers with, read by the Inspect tab
//! and by agents over `GET /api/v1/debug/events`.

use serde::Serialize;
use uuid::Uuid;

/// Which way a message was moving, from this server's point of view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    /// A peer delivered a message to this server.
    Inbound,
    /// This server delivered a message to a peer.
    Outbound,
}

/// The transport a message travelled over.
///
/// Distinct from [`crate::models::TransportProtocol`], which describes an
/// endpoint a node *advertises*. This describes what actually carried a
/// specific message — the question that cost the most time to answer before
/// this existed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Carrier {
    Http,
    Grpc,
    /// A browser owner's message the backend dialled on its behalf, because a
    /// browser cannot speak gRPC itself.
    GrpcViaRelay,
    /// A browser owner's message the backend posted over HTTP on its behalf.
    ///
    /// Rare — a browser can post HTTP itself — but tagged apart from `Http`
    /// all the same: from the log alone, a relayed message and this node's
    /// own traffic must never look the same.
    HttpViaRelay,
}

/// What happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// Handed to the target actor's inbox.
    Delivered,
    /// The actor is simulating offline; discarded rather than queued.
    Dropped,
    /// No route, no inbox, or the peer refused it.
    Refused,
}

/// One thing the server did, as a reader wants to see it.
#[derive(Debug, Clone, Serialize)]
pub struct Event {
    /// Monotonic within one process run. Lets a reader poll for "everything
    /// after N" without relying on clock resolution.
    pub seq: u64,
    /// Milliseconds since the Unix epoch.
    pub at_ms: u64,
    pub direction: Direction,
    pub carrier: Carrier,
    pub outcome: Outcome,
    /// The actor this concerns, when one was resolved. Absent when the
    /// message could not be routed — which is itself the interesting case.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<Uuid>,
    /// Decimal string: a `u64` channel id exceeds JavaScript's exact range.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    pub bytes: usize,
    /// Human-readable, and the first thing anyone reads. Says what happened
    /// and why, not merely which function ran.
    pub detail: String,
}

/// One event as a caller reports it. The log assigns `seq` and `at_ms`, so a
/// caller cannot get either wrong.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewEvent {
    pub direction: Direction,
    pub carrier: Carrier,
    pub outcome: Outcome,
    pub actor_id: Option<Uuid>,
    pub channel_id: Option<u64>,
    pub bytes: usize,
    pub detail: String,
}

/// How many events the log retains, and so the most one page can hold. Large
/// enough to hold a full pairing plus a protect-and-verify round across a pool
/// of helpers, small enough that a container left running overnight costs
/// nothing.
pub const EVENT_LOG_CAPACITY: usize = 2_000;

/// A page of the log, plus what the reader needs to trust it.
#[derive(Debug, Clone)]
pub struct EventSnapshot {
    pub events: Vec<Event>,
    /// How many events fell out of the retained window. Non-zero means this
    /// log is not the whole story, which a reader diagnosing a gap must know.
    pub dropped: u64,
    /// The highest `seq` the server has assigned. Pass it back as `after` to
    /// poll for what comes next.
    pub latest_seq: u64,
}
