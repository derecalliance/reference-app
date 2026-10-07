// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Everything this node currently knows, for the debug surface.

use uuid::Uuid;

use super::{Role, Route, Transport};

/// Everything this server currently knows.
#[derive(Debug, Clone)]
pub struct NodeSnapshot {
    /// Where this server believes it lives.
    pub base_url: String,
    pub grpc: GrpcStatus,
    /// Every address this node has advertised, current included.
    pub advertised_http: Vec<String>,
    pub advertised_grpc: Vec<String>,
    pub actors: Vec<ActorSnapshot>,
    /// Every channel the gRPC router can resolve, and which tier holds it.
    pub routes: Vec<Route>,
    /// Non-zero means the event log has lost its oldest entries.
    pub events_dropped: u64,
    /// Highest event sequence assigned so far.
    pub latest_event_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrpcStatus {
    pub enabled: bool,
    pub port: u16,
    /// The authority peers are told to dial.
    pub authority: String,
    pub relay_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActorSnapshot {
    pub id: Uuid,
    pub role: Role,
    pub name: String,
    pub transports: Vec<Transport>,
    /// `http`, `grpc` or `both` — the mode its endpoints correspond to.
    pub transport_mode: &'static str,
    pub secret_id: String,
    /// True when this actor's protocol runs in a browser rather than here.
    pub browser_managed: bool,
    /// Simulating offline: inbound messages are dropped rather than queued.
    pub disabled: bool,
    /// Channel ids this actor holds, as decimal strings.
    pub channels: Vec<String>,
    /// The `secret_id` of each protocol instance this actor runs. Empty for a
    /// browser actor.
    pub instance_secret_ids: Vec<String>,
}
