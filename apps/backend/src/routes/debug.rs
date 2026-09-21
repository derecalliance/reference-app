//! The debug surface: one state snapshot and one event log, over plain HTTP.
//!
//! Both exist because this app is a debugging tool, and the thing reading it is
//! as often an agent or a `curl` as a person at a browser. The Inspect tab in
//! the front end renders exactly what these return — one source of truth
//! rather than two implementations that drift.
//!
//! Nothing here is authenticated. The app ships as a developer's local
//! container and deliberately exposes its internals; that is the product.

use std::sync::Arc;

use axum::{
    Json,
    extract::{Query, State},
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    actor::ListInstanceSecretsMsg,
    debug::Snapshot,
    models::{Role, Transport},
    routes::actors::provisioned_addr,
    routing::Route,
    state::AppState,
};

/// Everything this server currently knows.
#[derive(Debug, Serialize)]
pub struct StateSnapshot {
    /// Where this server believes it lives. Stamped into every transport URI
    /// handed to a peer, so a wrong value here explains a whole class of
    /// "pairing worked and then nothing arrived".
    pub base_url: String,
    pub grpc: GrpcStatus,
    pub actors: Vec<ActorSnapshot>,
    /// Every channel the gRPC router can resolve, and which tier holds it.
    pub routes: Vec<Route>,
    /// Non-zero means the event log has lost its oldest entries.
    pub events_dropped: u64,
    /// Highest event sequence assigned so far — pass as `after` to
    /// `GET /debug/events` to poll for what comes next.
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

/// GET /debug/state
pub async fn state(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let log = state.events.since(u64::MAX, 0);

    let mut actors = Vec::new();
    for actor in state.actors.all() {
        let browser_managed = state.browser_receivers.contains_key(&actor.id);

        // A browser actor runs its protocol in the page, so there is no
        // instance here to ask. Asking anyway would just time out.
        let instance_secret_ids = match (browser_managed, provisioned_addr(&state, &actor.id)) {
            (false, Some(addr)) => addr
                .send(ListInstanceSecretsMsg)
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|id| id.to_string())
                .collect(),
            _ => Vec::new(),
        };

        actors.push(ActorSnapshot {
            transport_mode: mode_label(&actor.transports),
            id: actor.id,
            role: actor.role,
            name: actor.name.clone(),
            transports: actor.transports.clone(),
            secret_id: actor.secret_id.clone(),
            browser_managed,
            disabled: state.disabled_helpers.contains_key(&actor.id),
            channels: state
                .helper_channels
                .get(&actor.id)
                .map(|entry| entry.value().clone())
                .unwrap_or_default(),
            instance_secret_ids,
        });
    }

    Json(StateSnapshot {
        base_url: state.base_url.to_string(),
        grpc: GrpcStatus {
            enabled: state.defaults.grpc_enabled,
            port: state.defaults.grpc_port,
            authority: state.grpc_authority(),
            relay_enabled: state.defaults.grpc_relay_enabled,
        },
        actors,
        routes: state.channel_router.routes(),
        events_dropped: log.dropped,
        latest_event_seq: log.latest_seq,
    })
}

/// Read the advertised set back as a mode name, rather than trusting a second
/// stored field that could drift from the endpoints themselves.
fn mode_label(transports: &[Transport]) -> String {
    use crate::models::TransportProtocol as P;
    let grpc = transports.iter().any(|t| t.protocol == P::Grpc);
    let http = transports.iter().any(|t| t.protocol == P::Https);
    match (grpc, http) {
        (true, true) => "both",
        (true, false) => "grpc",
        _ => "http",
    }
    .to_owned()
}

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

/// GET /debug/events?after=N&limit=M
pub async fn events(
    State(state): State<Arc<AppState>>,
    Query(query): Query<EventQuery>,
) -> Json<Snapshot> {
    let limit = if query.limit == 0 {
        crate::debug::CAPACITY
    } else {
        query.limit.min(crate::debug::CAPACITY)
    };

    Json(state.events.since(query.after, limit))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::TransportProtocol;

    fn endpoint(protocol: TransportProtocol) -> Transport {
        Transport {
            protocol,
            uri: match protocol {
                TransportProtocol::Grpc => "grpc://localhost:50051".to_owned(),
                TransportProtocol::Https => "http://localhost:5000/derec/x".to_owned(),
            },
        }
    }

    #[test]
    fn the_mode_label_is_read_back_off_the_advertised_endpoints() {
        // Derived, never stored: a second field could disagree with the
        // endpoints it claims to describe.
        assert_eq!(mode_label(&[endpoint(TransportProtocol::Https)]), "http");
        assert_eq!(mode_label(&[endpoint(TransportProtocol::Grpc)]), "grpc");
        assert_eq!(
            mode_label(&[
                endpoint(TransportProtocol::Grpc),
                endpoint(TransportProtocol::Https),
            ]),
            "both"
        );
    }

    #[test]
    fn an_actor_advertising_nothing_reads_as_http() {
        // Unreachable through `provisioned_actor`, which never yields an empty
        // set — but the label must not panic if that ever changes.
        assert_eq!(mode_label(&[]), "http");
    }
}
