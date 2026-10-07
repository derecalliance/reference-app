// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::models::{
    ActorSnapshot as ActorState, ConfigOrigin, Event, EventSnapshot, NodeSnapshot, ResolvedConfig,
    Role, Route, Settings, Transport,
};

// ── GET /api/v1/debug/config ───────────────────────────────────────────────

/// The resolved configuration and where each value came from.
#[derive(Debug, Serialize)]
pub struct DebugConfigResponse {
    /// The settings tree, with the database URL's password redacted.
    pub settings: Settings,
    /// One entry per setting: its dotted path and where its value came from.
    pub origins: Vec<ConfigOrigin>,
    /// Whether a config file was found at the configured path.
    pub file_found: bool,
    /// `DEREC_*` variables that matched no setting. Warned about, not fatal.
    pub unknown_env: Vec<String>,
    /// Known variables set to an empty value, and so ignored.
    pub empty_env: Vec<&'static str>,
}

impl From<ResolvedConfig> for DebugConfigResponse {
    fn from(resolved: ResolvedConfig) -> Self {
        Self {
            settings: resolved.settings,
            origins: resolved.origins,
            file_found: resolved.file_found,
            unknown_env: resolved.unknown_env,
            empty_env: resolved.empty_env,
        }
    }
}

// ── GET /api/v1/debug/state ────────────────────────────────────────────────

/// Everything this server currently knows.
#[derive(Debug, Serialize)]
pub struct StateResponse {
    /// Where this server believes it lives. Stamped into every transport URI
    /// handed to a peer, so a wrong value here explains a whole class of
    /// "pairing worked and then nothing arrived".
    pub base_url: String,
    pub grpc: GrpcStatus,
    /// Every address this node has advertised, current included. A message
    /// to any of them is delivered here without a dial.
    pub advertised_addresses: AdvertisedAddresses,
    pub actors: Vec<ActorSnapshot>,
    /// Every channel the gRPC router can resolve, and which tier holds it.
    pub routes: Vec<Route>,
    /// Non-zero means the event log has lost its oldest entries.
    pub events_dropped: u64,
    /// Highest event sequence assigned so far — pass as `after` to
    /// `GET /api/v1/debug/events` to poll for what comes next.
    pub latest_event_seq: u64,
}

#[derive(Debug, Serialize)]
pub struct GrpcStatus {
    pub enabled: bool,
    pub port: u16,
    /// The authority peers are told to dial. Derived from `base_url`'s host,
    /// so a LAN `BASE_URL` yields a LAN gRPC endpoint.
    pub authority: String,
    pub relay_enabled: bool,
}

#[derive(Debug, Serialize)]
pub struct AdvertisedAddresses {
    /// Base URLs, `http://host:port`.
    pub http: Vec<String>,
    /// Authorities, `host:port`.
    pub grpc: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ActorSnapshot {
    pub id: Uuid,
    pub role: Role,
    pub name: String,
    /// Every endpoint this actor advertises, in its own preference order.
    pub transports: Vec<Transport>,
    /// `http`, `grpc` or `both` — the mode its endpoints correspond to.
    pub transport_mode: String,
    /// Decimal string: a `u64` exceeds JavaScript's exact integer range.
    pub secret_id: String,
    /// True when this actor's protocol runs in a browser rather than here, so
    /// it has no backend instance to interrogate.
    pub browser_managed: bool,
    /// Simulating offline: inbound messages are dropped rather than queued.
    pub disabled: bool,
    /// Channel ids this actor holds, as decimal strings.
    pub channels: Vec<String>,
    /// The `secret_id` of each protocol instance this actor runs — its own,
    /// plus one per owner it mirrors as a replica. Empty for a browser actor.
    pub instance_secret_ids: Vec<String>,
}

impl From<NodeSnapshot> for StateResponse {
    fn from(snapshot: NodeSnapshot) -> Self {
        Self {
            base_url: snapshot.base_url,
            grpc: GrpcStatus {
                enabled: snapshot.grpc.enabled,
                port: snapshot.grpc.port,
                authority: snapshot.grpc.authority,
                relay_enabled: snapshot.grpc.relay_enabled,
            },
            advertised_addresses: AdvertisedAddresses {
                http: snapshot.advertised_http,
                grpc: snapshot.advertised_grpc,
            },
            actors: snapshot
                .actors
                .into_iter()
                .map(ActorSnapshot::from)
                .collect(),
            routes: snapshot.routes,
            events_dropped: snapshot.events_dropped,
            latest_event_seq: snapshot.latest_event_seq,
        }
    }
}

impl From<ActorState> for ActorSnapshot {
    fn from(actor: ActorState) -> Self {
        Self {
            id: actor.id,
            role: actor.role,
            name: actor.name,
            transports: actor.transports,
            transport_mode: actor.transport_mode.to_owned(),
            secret_id: actor.secret_id,
            browser_managed: actor.browser_managed,
            disabled: actor.disabled,
            channels: actor.channels,
            instance_secret_ids: actor.instance_secret_ids,
        }
    }
}

// ── GET /api/v1/debug/events ───────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct EventQuery {
    /// Return only events with a higher sequence number. Omit for the whole
    /// retained window.
    #[serde(default)]
    pub after: u64,
    /// Cap the page. Omitted or zero means the log's full capacity.
    #[serde(default)]
    pub limit: usize,
}

/// A page of the event log.
#[derive(Debug, Serialize)]
pub struct EventsResponse {
    pub events: Vec<Event>,
    /// How many events fell out of the retained window. Non-zero means this
    /// log is not the whole story.
    pub dropped: u64,
    /// The highest `seq` assigned so far. Pass it back as `after` to poll for
    /// what comes next.
    pub latest_seq: u64,
}

impl From<EventSnapshot> for EventsResponse {
    fn from(snapshot: EventSnapshot) -> Self {
        Self {
            events: snapshot.events,
            dropped: snapshot.dropped,
            latest_seq: snapshot.latest_seq,
        }
    }
}
