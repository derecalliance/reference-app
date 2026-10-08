// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Assembling the node: repositories, then the infrastructure adapters, then
//! the services over them, then the state the handlers draw them from.

use std::sync::Arc;

use super::actors::inboxes::ActorInboxes;
use super::actors::provisioned::ActorDependencies;
use super::actors::runtime::ActorRuntime;
use super::addresses::NodeAddresses;
use super::event_log::EventLog;
use super::routing::ChannelRouter;
use super::state::AppState;
use super::transport::RelayDialer;
use crate::models::NodeConfig;
use crate::repositories::actors::{ActorRepository, SqlActorRepository};
use crate::repositories::advertised_addresses::SqlAdvertisedAddressRepository;
use crate::repositories::browser_contacts::{
    BrowserContactRepository, SqlBrowserContactRepository,
};
use crate::repositories::disabled_helpers::{
    DisabledHelperRepository, SqlDisabledHelperRepository,
};
use crate::repositories::helper_channels::{HelperChannelIndex, InMemoryHelperChannelIndex};
use crate::repositories::mailbox_polls::{InMemoryMailboxPolls, MailboxPollRepository};
use crate::repositories::mailboxes::{MailboxRepository, SqlMailboxRepository};
use crate::repositories::participant_data::{
    ParticipantDataRepository, SqlParticipantDataRepository,
};
use crate::repositories::protocol_records::{
    ProtocolRecordRepository, SqlProtocolRecordRepository,
};
use crate::repositories::sharing_rounds::{SharingRoundRepository, SqlSharingRoundRepository};
use crate::services::actors::ActorServiceImpl;
use crate::services::configuration::ConfigurationServiceImpl;
use crate::services::delivery::{DeliveryServiceImpl, LocalDelivery};
use crate::services::diagnostics::DiagnosticsServiceImpl;
use crate::services::helpers::HelperServiceImpl;
use crate::services::owners::OwnerServiceImpl;

/// Everything the node is made of: the state the router serves, and the
/// infrastructure boot recovery and the gRPC listener work with directly.
///
/// The binary builds one in [`super::server`]; integration tests build their
/// own, over a private database, and reach into any part of it.
pub struct Node {
    /// The services, for the HTTP router.
    pub state: AppState,
    pub config: Arc<NodeConfig>,
    /// The database every repository and every actor's stores read and write.
    pub pool: sqlx::AnyPool,
    pub http_client: reqwest::Client,

    // ── Repositories ────────────────────────────────────────────────────────
    pub actors: Arc<dyn ActorRepository>,
    pub mailboxes: Arc<dyn MailboxRepository>,
    pub disabled_helpers: Arc<dyn DisabledHelperRepository>,
    pub browser_contacts: Arc<dyn BrowserContactRepository>,
    pub protocol_records: Arc<dyn ProtocolRecordRepository>,
    pub sharing_rounds: Arc<dyn SharingRoundRepository>,
    /// Helper-side channel ids per actor, derived from the channel stores.
    pub helper_channels: Arc<dyn HelperChannelIndex>,
    pub mailbox_polls: Arc<dyn MailboxPollRepository>,

    // ── Live infrastructure ─────────────────────────────────────────────────
    /// The provisioned actors, and how to start and call them.
    pub runtime: Arc<ActorRuntime>,
    /// Delivery to this node's own actors without a dial — what every actor's
    /// transport tries before dialling.
    pub local_delivery: Arc<dyn LocalDelivery>,
    /// Where each actor's traffic goes. Live delivery handles, not data.
    pub inboxes: Arc<ActorInboxes>,
    /// `channel_id` → actor, for gRPC ingress only.
    pub channel_router: Arc<ChannelRouter>,
    /// What this server did, in order, with the transport each message
    /// actually travelled over.
    pub events: Arc<EventLog>,
    /// Every address this node advertised, current and before.
    pub addresses: Arc<NodeAddresses>,
}

impl Node {
    /// Assemble a node over `pool`, spawning actors onto `arbiter`.
    pub fn new(
        config: NodeConfig,
        http_client: reqwest::Client,
        arbiter: actix_rt::ArbiterHandle,
        pool: sqlx::AnyPool,
    ) -> Self {
        let config = Arc::new(config);

        // Repositories.
        let actors: Arc<dyn ActorRepository> = Arc::new(SqlActorRepository::new(pool.clone()));
        let mailboxes: Arc<dyn MailboxRepository> =
            Arc::new(SqlMailboxRepository::new(pool.clone()));
        let disabled_helpers: Arc<dyn DisabledHelperRepository> =
            Arc::new(SqlDisabledHelperRepository::new(pool.clone()));
        let browser_contacts: Arc<dyn BrowserContactRepository> =
            Arc::new(SqlBrowserContactRepository::new(pool.clone()));
        let participant_data: Arc<dyn ParticipantDataRepository> =
            Arc::new(SqlParticipantDataRepository::new(pool.clone()));
        let protocol_records: Arc<dyn ProtocolRecordRepository> =
            Arc::new(SqlProtocolRecordRepository::new(pool.clone()));
        let sharing_rounds: Arc<dyn SharingRoundRepository> =
            Arc::new(SqlSharingRoundRepository::new(pool.clone()));
        let helper_channels: Arc<dyn HelperChannelIndex> =
            Arc::new(InMemoryHelperChannelIndex::new());
        let mailbox_polls: Arc<dyn MailboxPollRepository> = Arc::new(InMemoryMailboxPolls::new());

        // Infrastructure the services reach through their ports.
        let inboxes = Arc::new(ActorInboxes::new());
        let channel_router = Arc::new(ChannelRouter::new());
        let events = Arc::new(EventLog::new());
        let addresses = Arc::new(NodeAddresses::new(
            Arc::clone(&config),
            Arc::new(SqlAdvertisedAddressRepository::new(pool.clone())),
        ));

        // Delivery comes before the actor runtime: every actor's transport
        // delivers to this node's own actors through it, without a dial.
        let delivery = Arc::new(DeliveryServiceImpl::new(
            Arc::clone(&config),
            Arc::clone(&actors),
            Arc::clone(&disabled_helpers),
            Arc::clone(&mailboxes),
            Arc::clone(&mailbox_polls),
            inboxes.clone(),
            channel_router.clone(),
            events.clone(),
            addresses.clone(),
            Arc::new(RelayDialer::new(http_client.clone())),
        ));

        let runtime = Arc::new(ActorRuntime::new(
            arbiter,
            Arc::clone(&inboxes),
            ActorDependencies {
                channel_router: Arc::clone(&channel_router),
                helper_channels: Arc::clone(&helper_channels),
                sharing_rounds: Arc::clone(&sharing_rounds),
            },
            pool.clone(),
            http_client.clone(),
            delivery.clone(),
        ));
        let local_delivery: Arc<dyn LocalDelivery> = delivery.clone();

        let state = AppState {
            configuration: Arc::new(ConfigurationServiceImpl::new(Arc::clone(&config))),
            diagnostics: Arc::new(DiagnosticsServiceImpl::new(
                Arc::clone(&config),
                Arc::clone(&actors),
                Arc::clone(&disabled_helpers),
                Arc::clone(&helper_channels),
                inboxes.clone(),
                runtime.clone(),
                channel_router.clone(),
                events.clone(),
                addresses.clone(),
            )),
            owners: Arc::new(OwnerServiceImpl::new(
                Arc::clone(&config),
                Arc::clone(&actors),
                inboxes.clone(),
            )),
            actors: Arc::new(ActorServiceImpl::new(
                Arc::clone(&actors),
                Arc::clone(&protocol_records),
                Arc::clone(&disabled_helpers),
                Arc::clone(&helper_channels),
                Arc::clone(&mailbox_polls),
                inboxes.clone(),
                runtime.clone(),
                channel_router.clone(),
            )),
            helpers: Arc::new(HelperServiceImpl::new(
                Arc::clone(&config),
                Arc::clone(&actors),
                Arc::clone(&disabled_helpers),
                Arc::clone(&browser_contacts),
                participant_data,
                Arc::clone(&protocol_records),
                Arc::clone(&helper_channels),
                inboxes.clone(),
                runtime.clone(),
                channel_router.clone(),
            )),
            delivery,
            config: Arc::clone(&config),
        };

        Self {
            state,
            config,
            pool,
            http_client,
            actors,
            mailboxes,
            disabled_helpers,
            browser_contacts,
            protocol_records,
            sharing_rounds,
            helper_channels,
            mailbox_polls,
            runtime,
            local_delivery,
            inboxes,
            channel_router,
            events,
            addresses,
        }
    }

    /// What every provisioned actor on this node is built with, for a caller
    /// starting one by hand.
    pub fn actor_dependencies(&self) -> ActorDependencies {
        self.runtime.dependencies()
    }
}
