// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The debug surface: one state snapshot and one event log.
//!
//! Both exist because this app is a debugging tool, and the thing reading it is
//! as often an agent or a `curl` as a person at a browser. The Inspect tab in
//! the front end renders exactly what these return — one source of truth
//! rather than two implementations that drift.

use std::sync::Arc;

use async_trait::async_trait;

use super::ports::{ActorGateway, ChannelRoutes, EventRecorder, InboxDirectory, OwnEndpoints};
use crate::models::{
    ActorSnapshot, EventSnapshot, GrpcStatus, InboxKind, Listener, NodeConfig, NodeSnapshot,
    EVENT_LOG_CAPACITY,
};
use crate::repositories::actors::ActorRepository;
use crate::repositories::disabled_helpers::DisabledHelperRepository;
use crate::repositories::helper_channels::HelperChannelIndex;

#[async_trait]
pub trait DiagnosticsService: Send + Sync {
    /// Everything the node currently knows.
    ///
    /// Reports what it can rather than failing: an empty roster with a
    /// readable event log is more useful to someone diagnosing a database
    /// problem than an error with nothing in it.
    async fn snapshot(&self) -> NodeSnapshot;

    /// Events after `after`, oldest first. A `limit` of zero means the log's
    /// full capacity, and no page is larger than that.
    fn events(&self, after: u64, limit: usize) -> EventSnapshot;
}

pub struct DiagnosticsServiceImpl {
    config: Arc<NodeConfig>,
    actors: Arc<dyn ActorRepository>,
    disabled_helpers: Arc<dyn DisabledHelperRepository>,
    helper_channels: Arc<dyn HelperChannelIndex>,
    inboxes: Arc<dyn InboxDirectory>,
    gateway: Arc<dyn ActorGateway>,
    routes: Arc<dyn ChannelRoutes>,
    events: Arc<dyn EventRecorder>,
    endpoints: Arc<dyn OwnEndpoints>,
}

impl DiagnosticsServiceImpl {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        config: Arc<NodeConfig>,
        actors: Arc<dyn ActorRepository>,
        disabled_helpers: Arc<dyn DisabledHelperRepository>,
        helper_channels: Arc<dyn HelperChannelIndex>,
        inboxes: Arc<dyn InboxDirectory>,
        gateway: Arc<dyn ActorGateway>,
        routes: Arc<dyn ChannelRoutes>,
        events: Arc<dyn EventRecorder>,
        endpoints: Arc<dyn OwnEndpoints>,
    ) -> Self {
        Self {
            config,
            actors,
            disabled_helpers,
            helper_channels,
            inboxes,
            gateway,
            routes,
            events,
            endpoints,
        }
    }
}

#[async_trait]
impl DiagnosticsService for DiagnosticsServiceImpl {
    async fn snapshot(&self) -> NodeSnapshot {
        let log = self.events.since(u64::MAX, 0);

        let mut actors = Vec::new();
        for actor in self.actors.all().await.unwrap_or_default() {
            let kind = self.inboxes.kind(&actor.id);
            let browser_managed = kind == Some(InboxKind::Browser);

            // A browser actor runs its protocol in the page, so there is no
            // instance here to ask. Asking anyway would just time out.
            let instance_secret_ids = if kind == Some(InboxKind::Provisioned) {
                self.gateway
                    .instance_secret_ids(&actor.id)
                    .await
                    .into_iter()
                    .map(|id| id.to_string())
                    .collect()
            } else {
                Vec::new()
            };

            actors.push(ActorSnapshot {
                transport_mode: actor.transport_mode().label(),
                disabled: self
                    .disabled_helpers
                    .is_disabled(&actor.id)
                    .await
                    .unwrap_or(false),
                channels: self.helper_channels.get(&actor.id).unwrap_or_default(),
                id: actor.id,
                role: actor.role,
                name: actor.name,
                transports: actor.transports,
                secret_id: actor.secret_id,
                browser_managed,
                instance_secret_ids,
            });
        }

        let defaults = &self.config.defaults;
        NodeSnapshot {
            base_url: self.config.base_url.to_string(),
            grpc: GrpcStatus {
                enabled: defaults.grpc_enabled,
                port: defaults.grpc_port,
                authority: self.config.grpc_authority(),
                relay_enabled: defaults.grpc_relay_enabled,
            },
            advertised_http: self.endpoints.advertised(Listener::Http),
            advertised_grpc: self.endpoints.advertised(Listener::Grpc),
            actors,
            routes: self.routes.routes(),
            events_dropped: log.dropped,
            latest_event_seq: log.latest_seq,
        }
    }

    fn events(&self, after: u64, limit: usize) -> EventSnapshot {
        let limit = if limit == 0 {
            EVENT_LOG_CAPACITY
        } else {
            limit.min(EVENT_LOG_CAPACITY)
        };
        self.events.since(after, limit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        Actor, Carrier, Defaults, Direction, NewEvent, Outcome, Role, TransportMode,
    };
    use crate::repositories::helper_channels::InMemoryHelperChannelIndex;
    use crate::services::test_fakes::{
        FakeActorRepository, FakeDisabledHelpers, FakeEventRecorder, FakeGateway, FakeInboxes,
        FakeOwnEndpoints, FakeRoutes,
    };

    struct Fixture {
        actors: Arc<FakeActorRepository>,
        disabled: Arc<FakeDisabledHelpers>,
        channels: Arc<InMemoryHelperChannelIndex>,
        inboxes: Arc<FakeInboxes>,
        gateway: Arc<FakeGateway>,
        events: Arc<FakeEventRecorder>,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                actors: Arc::new(FakeActorRepository::default()),
                disabled: Arc::new(FakeDisabledHelpers::default()),
                channels: Arc::new(InMemoryHelperChannelIndex::new()),
                inboxes: Arc::new(FakeInboxes::default()),
                gateway: Arc::new(FakeGateway::default()),
                events: Arc::new(FakeEventRecorder::default()),
            }
        }

        fn service(&self) -> DiagnosticsServiceImpl {
            DiagnosticsServiceImpl::new(
                Arc::new(NodeConfig::new(
                    "http://192.168.0.28:5000",
                    Defaults::default(),
                )),
                self.actors.clone(),
                self.disabled.clone(),
                self.channels.clone(),
                self.inboxes.clone(),
                self.gateway.clone(),
                Arc::new(FakeRoutes::default()),
                self.events.clone(),
                Arc::new(FakeOwnEndpoints::default()),
            )
        }
    }

    fn helper(mode: TransportMode) -> Actor {
        Actor::mint(
            Role::Helper,
            "Alex",
            "http://localhost:5000",
            "localhost:50051",
            mode,
        )
    }

    #[tokio::test]
    async fn a_provisioned_actor_reports_its_instances_and_a_browser_actor_none() {
        let fixture = Fixture::new();
        let provisioned = helper(TransportMode::Both);
        let browser = helper(TransportMode::Http);
        fixture.actors.insert(provisioned.clone());
        fixture.actors.insert(browser.clone());
        fixture.inboxes.provisioned(provisioned.id);
        fixture.inboxes.register_browser(browser.id);
        fixture.gateway.set_instances(provisioned.id, vec![9, 3]);

        let snapshot = fixture.service().snapshot().await;

        assert_eq!(snapshot.actors.len(), 2);
        assert_eq!(snapshot.actors[0].instance_secret_ids, vec!["9", "3"]);
        assert_eq!(snapshot.actors[0].transport_mode, "both");
        assert!(!snapshot.actors[0].browser_managed);
        assert!(snapshot.actors[1].instance_secret_ids.is_empty());
        assert!(snapshot.actors[1].browser_managed);
    }

    #[tokio::test]
    async fn the_snapshot_reports_disabled_helpers_and_their_indexed_channels() {
        let fixture = Fixture::new();
        let alex = helper(TransportMode::Http);
        fixture.actors.insert(alex.clone());
        fixture.disabled.disable(alex.id);
        fixture.channels.replace(alex.id, vec!["42".to_owned()]);

        let snapshot = fixture.service().snapshot().await;

        assert!(snapshot.actors[0].disabled);
        assert_eq!(snapshot.actors[0].channels, vec!["42"]);
    }

    #[tokio::test]
    async fn an_unreadable_roster_still_yields_the_rest_of_the_snapshot() {
        let fixture = Fixture::new();
        fixture.actors.fail();

        let snapshot = fixture.service().snapshot().await;

        assert!(snapshot.actors.is_empty());
        assert_eq!(snapshot.grpc.authority, "192.168.0.28:50051");
    }

    #[test]
    fn an_omitted_or_oversized_limit_means_the_whole_log() {
        let fixture = Fixture::new();
        for i in 0..3 {
            fixture.events.record(NewEvent {
                direction: Direction::Inbound,
                carrier: Carrier::Http,
                outcome: Outcome::Delivered,
                actor_id: None,
                channel_id: Some(i),
                bytes: 1,
                detail: String::new(),
            });
        }
        let service = fixture.service();

        assert_eq!(service.events(0, 0).events.len(), 3);
        assert_eq!(service.events(0, usize::MAX).events.len(), 3);
        assert_eq!(service.events(0, 2).events.len(), 2);
        assert_eq!(service.events(2, 0).events.len(), 1);
    }
}
