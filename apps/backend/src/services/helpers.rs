// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Helpers: the shared pool of provisioned participants, and the operator's
//! levers on each — switching it off, linking its channels, deleting it — plus
//! the contacts browser-run participants publish.
//!
//! Provisioned helpers belong to the server, not to whichever owner asked for
//! them, and every owner pairs with the same fixtures. So a requested pool size
//! is a *target*, not an order to create: only the shortfall is provisioned,
//! and asking for fewer than exist removes nothing.

use std::sync::Arc;

use async_trait::async_trait;
use tracing::{info, warn};
use uuid::Uuid;

use super::ports::{ActorGateway, ChannelRoutes, InboxDirectory};
use super::ServiceError;
use crate::models::{
    Actor, ActorSettings, AddHelper, ChannelSummary, DisplayName, EnsurePool, EnsuredPool,
    InboxKind, NameError, NewActor, NodeConfig, ProtocolSettings, Role, TransportBreakdown,
    TransportMode, MAX_POOL_SIZE,
};
use crate::repositories::actors::ActorRepository;
use crate::repositories::browser_contacts::BrowserContactRepository;
use crate::repositories::disabled_helpers::DisabledHelperRepository;
use crate::repositories::helper_channels::HelperChannelIndex;
use crate::repositories::participant_data::ParticipantDataRepository;
use crate::repositories::protocol_records::ProtocolRecordRepository;

/// The largest contact a browser may publish, in bytes. An inline-keys contact
/// — the largest mode, carrying an ML-KEM-768 key — is under 3 KiB as JSON.
pub const MAX_CONTACT_BYTES: usize = 16 * 1024;

#[async_trait]
pub trait HelperService: Send + Sync {
    /// Provision one backend-run helper. Its name must be one no other helper
    /// has.
    async fn add(&self, request: AddHelper) -> Result<Actor, ServiceError>;

    /// Bring the shared pool up to a target, provisioning only the shortfall.
    async fn ensure(&self, request: EnsurePool) -> Result<EnsuredPool, ServiceError>;

    /// Erase a provisioned participant: its actor, its stores and its
    /// registry entry. An owner paired with it keeps its channel, which from
    /// then on behaves like a peer that has gone offline.
    async fn delete(&self, helper_id: Uuid) -> Result<(), ServiceError>;

    /// Switch a helper's simulated offline state, to `disabled` or — when
    /// `None` — to the opposite of what it is. Answers the new state.
    async fn toggle_status(
        &self,
        helper_id: Uuid,
        disabled: Option<bool>,
    ) -> Result<bool, ServiceError>;

    /// Every channel a provisioned helper holds, for the operator's link
    /// picker.
    async fn list_channels(&self, helper_id: Uuid) -> Result<Vec<ChannelSummary>, ServiceError>;

    /// Record, as the operator, that two channels a helper holds belong to the
    /// same owner. Both must be channels the helper holds on its own instance.
    async fn link_channels(
        &self,
        helper_id: Uuid,
        channel_id: &str,
        link_to_channel_id: &str,
    ) -> Result<(), ServiceError>;

    /// Store the contact a browser-run participant publishes, exactly as
    /// posted. It must be a JSON object of a contact's size.
    async fn publish_browser_contact(
        &self,
        actor_id: Uuid,
        body: &[u8],
    ) -> Result<(), ServiceError>;

    /// The contact a browser-run participant published, exactly as posted.
    async fn browser_contact(&self, actor_id: Uuid) -> Result<String, ServiceError>;
}

pub struct HelperServiceImpl {
    config: Arc<NodeConfig>,
    actors: Arc<dyn ActorRepository>,
    disabled_helpers: Arc<dyn DisabledHelperRepository>,
    browser_contacts: Arc<dyn BrowserContactRepository>,
    participant_data: Arc<dyn ParticipantDataRepository>,
    records: Arc<dyn ProtocolRecordRepository>,
    helper_channels: Arc<dyn HelperChannelIndex>,
    inboxes: Arc<dyn InboxDirectory>,
    gateway: Arc<dyn ActorGateway>,
    routes: Arc<dyn ChannelRoutes>,
}

impl HelperServiceImpl {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        config: Arc<NodeConfig>,
        actors: Arc<dyn ActorRepository>,
        disabled_helpers: Arc<dyn DisabledHelperRepository>,
        browser_contacts: Arc<dyn BrowserContactRepository>,
        participant_data: Arc<dyn ParticipantDataRepository>,
        records: Arc<dyn ProtocolRecordRepository>,
        helper_channels: Arc<dyn HelperChannelIndex>,
        inboxes: Arc<dyn InboxDirectory>,
        gateway: Arc<dyn ActorGateway>,
        routes: Arc<dyn ChannelRoutes>,
    ) -> Self {
        Self {
            config,
            actors,
            disabled_helpers,
            browser_contacts,
            participant_data,
            records,
            helper_channels,
            inboxes,
            gateway,
            routes,
        }
    }

    /// The helper with this id. An unknown id is not found; a known id of
    /// another role is a bad request — the caller named a real actor on a
    /// route that cannot act on it, and saying so plainly is more useful than
    /// pretending it does not exist.
    async fn helper(&self, helper_id: &Uuid) -> Result<Actor, ServiceError> {
        match self.actors.get(helper_id).await? {
            None => Err(ServiceError::NotFound(format!(
                "{} not found",
                Role::Helper.noun()
            ))),
            Some(actor) if actor.role == Role::Helper => Ok(actor),
            Some(actor) => Err(ServiceError::BadRequest(format!(
                "actor is {}, not {}",
                actor.role.with_article(),
                Role::Helper.with_article()
            ))),
        }
    }

    /// Refuse an actor this node does not know, whatever its role.
    async fn ensure_exists(&self, actor_id: &Uuid) -> Result<(), ServiceError> {
        match self.actors.get(actor_id).await? {
            Some(_) => Ok(()),
            None => Err(ServiceError::NotFound("actor not found".to_owned())),
        }
    }

    /// Refuse a helper with no backend protocol instance.
    fn ensure_provisioned(&self, helper_id: &Uuid) -> Result<(), ServiceError> {
        match self.inboxes.kind(helper_id) {
            Some(InboxKind::Provisioned) => Ok(()),
            _ => Err(ServiceError::NotFound(
                "helper has no backend protocol instance".to_owned(),
            )),
        }
    }

    /// Refuse gRPC helpers on a node that does not run the gRPC listener: a
    /// helper advertising an endpoint nothing is listening on pairs
    /// successfully and then black-holes every reply. Not a silent downgrade.
    fn ensure_grpc_served(&self, wants_grpc: bool, refusal: &str) -> Result<(), ServiceError> {
        if wants_grpc && !self.config.defaults.grpc_enabled {
            return Err(ServiceError::BadRequest(refusal.to_owned()));
        }
        Ok(())
    }

    /// Settings for a new helper, with omitted values from the defaults.
    fn settings_for(&self, requested: ProtocolSettings) -> ActorSettings {
        let defaults = &self.config.defaults;
        let (timeout_secs, unpair_ack) =
            requested.resolve(defaults.protocol_timeout_secs, defaults.unpair_ack);
        // Minted here, with the actor, so the value stored is the value the
        // actor runs with — a respawn reads it back rather than inventing a
        // new one, which would make this helper a stranger to every replica
        // group holding its old id.
        ActorSettings::fresh(timeout_secs, unpair_ack)
    }

    /// Unlist a helper that failed to start, so the pool does not list one
    /// nobody runs. If that fails too the row stays, and the next boot's
    /// recovery tries to spawn it again — logged either way.
    async fn unregister_unstarted(&self, helper_id: &Uuid) {
        if let Err(e) = self.actors.remove(helper_id).await {
            tracing::error!(
                helper_id = %helper_id,
                error = %e,
                "could not unregister a helper that failed to start"
            );
        }
    }
}

#[async_trait]
impl HelperService for HelperServiceImpl {
    async fn add(&self, request: AddHelper) -> Result<Actor, ServiceError> {
        let name = DisplayName::try_from(request.name.as_str())?;
        request.settings.validate()?;
        self.ensure_grpc_served(
            request.transport_mode != TransportMode::Http,
            "gRPC helper requested but grpc_enabled is false",
        )?;

        let helper = Actor::mint(
            Role::Helper,
            name.as_str(),
            &self.config.base_url,
            &self.config.grpc_authority(),
            request.transport_mode,
        );
        let settings = self.settings_for(request.settings);

        // The name check and the insert are one step, so two requests naming
        // the same new helper at the same moment cannot both pass. Only
        // helpers are compared: owners are named by their own browser tabs,
        // and a helper sharing a name with one is not ambiguous in the pool.
        let candidate: NewActor = (helper.clone(), settings.clone());
        let plan = |roster: &[Actor]| {
            let taken = roster
                .iter()
                .any(|a| a.role == Role::Helper && a.is_named(&candidate.0.name));
            if taken {
                Vec::new()
            } else {
                vec![candidate.clone()]
            }
        };
        let registered = self.actors.register_planned(&plan).await?;
        if registered.registered.is_empty() {
            return Err(ServiceError::NameTaken(format!(
                "a helper named \"{name}\" already exists; choose another name"
            )));
        }

        // Registered before it is spawned: a running actor nothing lists is an
        // orphan that ticks against the database until the process ends, while
        // a listed actor that failed to start is a row this can take back.
        if let Err(e) = self.gateway.spawn(&helper, &settings) {
            self.unregister_unstarted(&helper.id).await;
            tracing::error!(helper_id = %helper.id, error = %e, "helper failed to start");
            return Err(ServiceError::Internal(
                "helper could not be started".to_owned(),
            ));
        }

        info!(helper_id = %helper.id, name = %helper.name, "helper provisioned");
        Ok(helper)
    }

    async fn ensure(&self, request: EnsurePool) -> Result<EnsuredPool, ServiceError> {
        // `MAX_POOL_SIZE` is `u8::MAX`, so the conversion is the whole check.
        let Ok(total) = u8::try_from(request.total) else {
            return Err(ServiceError::BadRequest(format!(
                "total must be at most {MAX_POOL_SIZE} (got {})",
                request.total
            )));
        };
        validate_offered_names(&request.names)?;
        request.settings.validate()?;

        let want = match request.transports {
            Some(breakdown) => {
                if breakdown.total() != total as usize {
                    return Err(ServiceError::BadRequest(
                        "transports must sum to total".to_owned(),
                    ));
                }
                self.ensure_grpc_served(
                    breakdown.wants_grpc(),
                    "gRPC helpers requested but grpc_enabled is false",
                )?;
                breakdown
            }
            None => TransportBreakdown {
                http: total,
                grpc: 0,
                both: 0,
            },
        };

        let defaults = &self.config.defaults;
        let (timeout_secs, unpair_ack) = request
            .settings
            .resolve(defaults.protocol_timeout_secs, defaults.unpair_ack);
        let base_url = &self.config.base_url;
        let grpc_authority = self.config.grpc_authority();
        let names = &request.names;

        // The count-and-create is one step inside the repository; doing it
        // here — read the count, then post the difference — would let two
        // owners setting up at the same moment each fill an empty pool.
        let plan = |roster: &[Actor]| {
            plan_shortfall(want, roster, |taken, pool_index, mode, pool| {
                let actor = Actor::mint(
                    Role::Helper,
                    &helper_name(names, taken, pool_index, pool),
                    base_url,
                    &grpc_authority,
                    mode,
                );
                // Minted with the actor and stored in the same transaction, so
                // the row a respawn reads back is the one this helper ran with.
                (actor, ActorSettings::fresh(timeout_secs, unpair_ack))
            })
        };
        let registration = self.actors.register_planned(&plan).await?;
        let created = registration.registered;
        let mut helpers: Vec<Actor> = registration
            .roster
            .into_iter()
            .filter(|a| a.role == Role::Helper)
            .collect();

        // Spawning touches the actor runtime, so it happens out here rather
        // than inside the registration.
        let mut started = 0usize;
        for helper in &created {
            // Read back rather than re-minted, so the running actor and its row
            // agree on `replica_id`.
            let spawned = match self.actors.settings(&helper.id).await {
                Ok(Some(stored)) => self
                    .gateway
                    .spawn(helper, &stored)
                    .map_err(|e| e.to_string()),
                Ok(None) => Err("no stored settings for a just-created helper".to_owned()),
                Err(e) => Err(e.to_string()),
            };

            match spawned {
                Ok(()) => started += 1,
                Err(reason) => {
                    // Unlisted again rather than left as a row nothing runs;
                    // the next `ensure` sees the shortfall and creates a
                    // replacement.
                    tracing::error!(helper_id = %helper.id, reason = %reason, "helper failed to start");
                    self.unregister_unstarted(&helper.id).await;
                    helpers.retain(|h| h.id != helper.id);
                }
            }
        }

        if started < created.len() {
            return Err(ServiceError::Internal(format!(
                "{} of {} new helpers could not be started",
                created.len() - started,
                created.len()
            )));
        }

        info!(
            requested = total,
            created = created.len(),
            pool = helpers.len(),
            "helper pool ensured"
        );
        Ok(EnsuredPool {
            created: created.len(),
            helpers,
        })
    }

    async fn delete(&self, helper_id: Uuid) -> Result<(), ServiceError> {
        // Guards both that it exists and that it is ours to delete: a
        // browser-managed actor belongs to the page driving it.
        self.helper(&helper_id).await?;

        // Ordering matters and is not arbitrary:
        //
        // 1. Stop the actor first. While it runs, its tick writes to the very
        //    tables step 3 clears.
        self.gateway.shutdown(&helper_id);

        // 2. Drop the routing handles. gRPC ingress resolves by channel id, so
        //    a stale route would hand messages to an actor that no longer
        //    exists. Only this actor's claims go: when the other end of one of
        //    its channels is also on this node, that actor keeps its route.
        let channel_ids = self.helper_channels.forget(&helper_id);
        let routes = self.routes.remove_actor(helper_id);

        // 3. Erase the data, then stop listing the participant — last, so an
        //    error partway leaves it listed rather than silently hollow.
        self.participant_data.erase(&helper_id).await?;
        self.actors.remove(&helper_id).await?;

        info!(actor_id = %helper_id, channels = channel_ids.len(), routes, "participant deleted");
        if !channel_ids.is_empty() {
            // Any owner paired over these keeps a channel that will now go
            // unanswered — the documented behaviour, not an oversight.
            warn!(
                actor_id = %helper_id,
                channels = channel_ids.len(),
                "deleted participant had live channels; peers will see it as unreachable"
            );
        }
        Ok(())
    }

    async fn toggle_status(
        &self,
        helper_id: Uuid,
        disabled: Option<bool>,
    ) -> Result<bool, ServiceError> {
        // The role check matters: the offline switch is consulted for every
        // inbound delivery, so switching an owner off would silently drop
        // that owner's mail.
        self.helper(&helper_id).await?;

        let currently = self.disabled_helpers.is_disabled(&helper_id).await?;
        let want_disabled = disabled.unwrap_or(!currently);
        self.disabled_helpers
            .set_disabled(&helper_id, want_disabled)
            .await?;

        info!(helper_id = %helper_id, disabled = want_disabled, "helper status updated");
        Ok(want_disabled)
    }

    async fn list_channels(&self, helper_id: Uuid) -> Result<Vec<ChannelSummary>, ServiceError> {
        self.helper(&helper_id).await?;
        self.ensure_provisioned(&helper_id)?;

        self.gateway
            .list_channels(&helper_id)
            .await
            .map_err(|e| ServiceError::from_actor_call("listing channels", e))
    }

    async fn link_channels(
        &self,
        helper_id: Uuid,
        channel_id: &str,
        link_to_channel_id: &str,
    ) -> Result<(), ServiceError> {
        let helper = self.helper(&helper_id).await?;

        let (Ok(channel_id), Ok(link_to_channel_id)) =
            (channel_id.parse::<u64>(), link_to_channel_id.parse::<u64>())
        else {
            return Err(ServiceError::BadRequest(
                "channel ids must be decimal u64 strings".to_owned(),
            ));
        };
        if channel_id == link_to_channel_id {
            return Err(ServiceError::BadRequest(
                "cannot link a channel to itself".to_owned(),
            ));
        }
        self.ensure_provisioned(&helper_id)?;

        let Ok(own_secret) = helper.secret_id.parse::<u64>() else {
            tracing::error!(helper_id = %helper_id, "helper has an unparseable secret_id");
            return Err(ServiceError::Internal(
                "helper record is unreadable".to_owned(),
            ));
        };

        // Linking one it does not hold would write a link to nothing, which
        // the store then reports as a real channel when the helper looks for
        // shares.
        for (field, id) in [
            ("channel_id", channel_id),
            ("link_to_channel_id", link_to_channel_id),
        ] {
            match self
                .records
                .holds_channel(&helper_id, id, Some(own_secret))
                .await
            {
                Ok(true) => {}
                Ok(false) => {
                    return Err(ServiceError::NotFound(format!(
                        "this helper holds no channel {id} (`{field}`)"
                    )));
                }
                Err(e) => {
                    tracing::error!(helper_id = %helper_id, error = %e, "channel store unreadable");
                    return Err(ServiceError::Internal(
                        "channel store unavailable".to_owned(),
                    ));
                }
            }
        }

        self.gateway
            .link_channels(&helper_id, channel_id, link_to_channel_id)
            .await
            .map_err(|e| ServiceError::from_actor_call("linking", e))?;

        info!(helper_id = %helper_id, channel_id, link_to_channel_id, "operator linked channels");
        Ok(())
    }

    async fn publish_browser_contact(
        &self,
        actor_id: Uuid,
        body: &[u8],
    ) -> Result<(), ServiceError> {
        self.ensure_exists(&actor_id).await?;

        if body.len() > MAX_CONTACT_BYTES {
            return Err(ServiceError::PayloadTooLarge(format!(
                "a contact may be at most {MAX_CONTACT_BYTES} bytes"
            )));
        }
        // The backend stores the page's serialized contact and hands it back
        // byte for byte: it is the browser's format, and re-encoding it here
        // would make this a second owner of that shape. What it does check is
        // that the body is a JSON object, so it can honestly be served as JSON.
        let contact = match std::str::from_utf8(body) {
            Ok(text)
                if serde_json::from_str::<serde_json::Value>(text)
                    .is_ok_and(|value| value.is_object()) =>
            {
                text
            }
            _ => {
                return Err(ServiceError::BadRequest(
                    "the contact must be a JSON object".to_owned(),
                ));
            }
        };

        self.browser_contacts.put(&actor_id, contact).await?;
        info!(helper_id = %actor_id, "browser contact stored");
        Ok(())
    }

    async fn browser_contact(&self, actor_id: Uuid) -> Result<String, ServiceError> {
        self.ensure_exists(&actor_id).await?;

        self.browser_contacts.get(&actor_id).await?.ok_or_else(|| {
            ServiceError::NotFound("this actor has not published a contact".to_owned())
        })
    }
}

/// The helpers to register to bring `roster`'s pool up to `want`: only the
/// per-mode shortfall, so asking for fewer of a mode than exist adds — and
/// removes — nothing.
///
/// `mint` receives two counters with distinct meanings, matching the two
/// documented on [`helper_name`]:
/// - `taken` is this plan's creation order, across every mode combined — the
///   first helper minted anywhere in the plan is `0`, the second `1`,
///   regardless of which mode each belongs to.
/// - `pool_index` is that helper's position in the whole shared pool (every
///   role-`Helper` actor, of any mode) at the moment it is added, so it keeps
///   climbing across separate plans rather than restarting at zero per mode.
///
/// `mint` is also handed the pool as it stands — including helpers this plan
/// already minted — so it can choose a name no helper has.
pub fn plan_shortfall<F>(want: TransportBreakdown, roster: &[Actor], mint: F) -> Vec<NewActor>
where
    F: Fn(usize, usize, TransportMode, &[Actor]) -> NewActor,
{
    let mut pool: Vec<Actor> = roster
        .iter()
        .filter(|a| a.role == Role::Helper)
        .cloned()
        .collect();
    let mut planned = Vec::new();
    let mut taken = 0usize;

    for (mode, target) in want.modes() {
        let have = pool.iter().filter(|a| a.transport_mode() == mode).count();
        for _ in have..target {
            let pool_index = pool.len();
            let new = mint(taken, pool_index, mode, &pool);
            pool.push(new.0.clone());
            planned.push(new);
            taken += 1;
        }
    }
    planned
}

/// Pick a display name for a helper being created, unique within `pool`.
///
/// `names` are consumed in creation order, not by pool position: the caller
/// cannot know how many it will need — that depends on what other owners have
/// already provisioned — so a caller offering two names for a two-helper
/// shortfall gets both used, whatever the resulting pool positions are.
///
/// The name offered for this creation is used unless a helper already has it
/// (see [`Actor::is_named`]); then the next offered name nobody holds is used
/// instead. That keeps a wizard that always offers the same names working
/// against a pool that already holds some of them — and keeps `ensure` from
/// minting the duplicates `add` refuses. A blank entry still means "number
/// this one".
///
/// The fallback numbers by pool position, so the label stays unique across
/// calls rather than restarting at 1 each time, and moves past any number a
/// helper already carries. Offered names have already been checked by
/// [`validate_offered_names`]; this only trims them.
pub fn helper_name(names: &[String], taken: usize, pool_index: usize, pool: &[Actor]) -> String {
    let in_use = |candidate: &str| pool.iter().any(|a| a.is_named(candidate));

    let offered = names.get(taken).map(|n| n.trim()).filter(|n| !n.is_empty());
    if offered.is_some() {
        let free = names
            .iter()
            .skip(taken)
            .map(|n| n.trim())
            .filter(|n| !n.is_empty())
            .find(|n| !in_use(n));
        if let Some(name) = free {
            return name.to_owned();
        }
    }

    // Terminates: `pool` is finite, so some number past it is free.
    let mut number = pool_index + 1;
    loop {
        let label = format!("Participant {number}");
        if !in_use(&label) {
            return label;
        }
        number += 1;
    }
}

/// Refuse an offered name that `add` would refuse.
///
/// A blank entry is allowed — it means "number this one" — but a name that is
/// too long, or carries control characters, is a caller error rather than
/// something to truncate silently.
pub fn validate_offered_names(names: &[String]) -> Result<(), NameError> {
    for (i, name) in names.iter().enumerate() {
        if name.trim().is_empty() {
            continue;
        }
        DisplayName::parse(name, &format!("names[{i}]"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Defaults;
    use crate::repositories::helper_channels::InMemoryHelperChannelIndex;
    use crate::services::ports::ActorCallError;
    use crate::services::test_fakes::{
        FakeActorRepository, FakeBrowserContacts, FakeDisabledHelpers, FakeGateway, FakeInboxes,
        FakeParticipantData, FakeProtocolRecords, FakeRoutes,
    };

    struct Fixture {
        defaults: Defaults,
        actors: Arc<FakeActorRepository>,
        disabled: Arc<FakeDisabledHelpers>,
        contacts: Arc<FakeBrowserContacts>,
        data: Arc<FakeParticipantData>,
        records: Arc<FakeProtocolRecords>,
        channels: Arc<InMemoryHelperChannelIndex>,
        inboxes: Arc<FakeInboxes>,
        gateway: Arc<FakeGateway>,
        routes: Arc<FakeRoutes>,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                defaults: Defaults::default(),
                actors: Arc::new(FakeActorRepository::default()),
                disabled: Arc::new(FakeDisabledHelpers::default()),
                contacts: Arc::new(FakeBrowserContacts::default()),
                data: Arc::new(FakeParticipantData::default()),
                records: Arc::new(FakeProtocolRecords::default()),
                channels: Arc::new(InMemoryHelperChannelIndex::new()),
                inboxes: Arc::new(FakeInboxes::default()),
                gateway: Arc::new(FakeGateway::default()),
                routes: Arc::new(FakeRoutes::default()),
            }
        }

        fn without_grpc(mut self) -> Self {
            self.defaults.grpc_enabled = false;
            self
        }

        fn service(&self) -> HelperServiceImpl {
            HelperServiceImpl::new(
                Arc::new(NodeConfig::new(
                    "http://localhost:5000",
                    self.defaults.clone(),
                )),
                self.actors.clone(),
                self.disabled.clone(),
                self.contacts.clone(),
                self.data.clone(),
                self.records.clone(),
                self.channels.clone(),
                self.inboxes.clone(),
                self.gateway.clone(),
                self.routes.clone(),
            )
        }

        fn helper(&self, name: &str) -> Actor {
            let actor = Actor::mint(
                Role::Helper,
                name,
                "http://localhost:5000",
                "localhost:50051",
                TransportMode::Http,
            );
            self.actors.insert(actor.clone());
            self.inboxes.provisioned(actor.id);
            actor
        }

        fn owner(&self) -> Actor {
            let actor = Actor::mint(
                Role::Owner,
                "Alice",
                "http://localhost:5000",
                "localhost:50051",
                TransportMode::Http,
            );
            self.actors.insert(actor.clone());
            actor
        }
    }

    fn add(name: &str) -> AddHelper {
        AddHelper {
            name: name.to_owned(),
            transport_mode: TransportMode::Http,
            settings: ProtocolSettings::default(),
        }
    }

    fn ensure(total: u64) -> EnsurePool {
        EnsurePool {
            total,
            names: Vec::new(),
            transports: None,
            settings: ProtocolSettings::default(),
        }
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_owned()).collect()
    }

    fn pool_named(v: &[&str]) -> Vec<Actor> {
        v.iter()
            .map(|name| {
                Actor::mint(
                    Role::Helper,
                    name,
                    "http://localhost:5000",
                    "localhost:50051",
                    TransportMode::Http,
                )
            })
            .collect()
    }

    // ── Adding one helper ───────────────────────────────────────────────────

    #[tokio::test]
    async fn an_added_helper_is_registered_and_started() {
        let fixture = Fixture::new();

        let helper = fixture.service().add(add(" Alex ")).await.expect("adds");

        assert_eq!(helper.name, "Alex");
        assert_eq!(fixture.gateway.spawned(), vec![helper.id]);
        assert_eq!(fixture.actors.all_actors().len(), 1);
    }

    #[tokio::test]
    async fn a_name_another_helper_has_is_a_conflict_whatever_its_case() {
        let fixture = Fixture::new();
        fixture.helper("Alex");

        let error = fixture
            .service()
            .add(add("alex"))
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::NameTaken(
                "a helper named \"alex\" already exists; choose another name".to_owned()
            )
        );
        assert!(fixture.gateway.spawned().is_empty());
    }

    #[tokio::test]
    async fn an_owner_sharing_the_name_does_not_block_a_helper() {
        let fixture = Fixture::new();
        fixture.owner();

        fixture.service().add(add("Alice")).await.expect("adds");
    }

    #[tokio::test]
    async fn a_grpc_helper_is_refused_when_the_node_does_not_serve_grpc() {
        let fixture = Fixture::new().without_grpc();
        let request = AddHelper {
            transport_mode: TransportMode::Both,
            ..add("Alex")
        };

        let error = fixture.service().add(request).await.expect_err("refused");

        assert_eq!(
            error,
            ServiceError::BadRequest("gRPC helper requested but grpc_enabled is false".to_owned())
        );
    }

    #[tokio::test]
    async fn an_out_of_range_timeout_is_refused() {
        let fixture = Fixture::new();
        let request = AddHelper {
            settings: ProtocolSettings {
                protocol_timeout_secs: Some(0),
                unpair_ack: None,
            },
            ..add("Alex")
        };

        let error = fixture.service().add(request).await.expect_err("refused");

        assert_eq!(
            error,
            ServiceError::BadRequest(
                "protocol_timeout_secs must be between 1 and 86400".to_owned()
            )
        );
    }

    #[tokio::test]
    async fn a_helper_that_fails_to_start_is_unlisted_again() {
        let fixture = Fixture::new();
        fixture.gateway.fail_spawns();

        let error = fixture.service().add(add("Alex")).await.expect_err("fails");

        assert_eq!(
            error,
            ServiceError::Internal("helper could not be started".to_owned())
        );
        assert!(fixture.actors.all_actors().is_empty());
    }

    // ── The shared pool ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn an_empty_pool_is_filled_to_the_requested_size() {
        let fixture = Fixture::new();

        let pool = fixture.service().ensure(ensure(7)).await.expect("ensures");

        assert_eq!(pool.created, 7);
        assert_eq!(pool.helpers.len(), 7);
        assert_eq!(fixture.gateway.spawned().len(), 7);
    }

    #[tokio::test]
    async fn asking_for_what_already_exists_creates_nothing() {
        // Alice sets up with seven, Bob then also asks for seven. Seven should
        // exist, not fourteen.
        let fixture = Fixture::new();
        fixture.service().ensure(ensure(7)).await.expect("ensures");

        let pool = fixture.service().ensure(ensure(7)).await.expect("ensures");

        assert_eq!(pool.created, 0);
        assert_eq!(pool.helpers.len(), 7);
    }

    #[tokio::test]
    async fn the_returned_pool_includes_helpers_the_caller_did_not_create() {
        // The caller wants the whole pool to pair against, not just its own
        // additions — otherwise a second owner would see an empty roster.
        let fixture = Fixture::new();
        fixture.service().ensure(ensure(2)).await.expect("ensures");

        let pool = fixture.service().ensure(ensure(3)).await.expect("ensures");

        assert_eq!(pool.created, 1);
        let names: Vec<String> = pool.helpers.into_iter().map(|a| a.name).collect();
        assert_eq!(names, ["Participant 1", "Participant 2", "Participant 3"]);
    }

    #[tokio::test]
    async fn owners_do_not_count_towards_the_pool_or_appear_in_it() {
        let fixture = Fixture::new();
        fixture.owner();

        let pool = fixture.service().ensure(ensure(1)).await.expect("ensures");

        assert_eq!(pool.created, 1);
        assert_eq!(pool.helpers.len(), 1);
    }

    #[tokio::test]
    async fn a_total_beyond_the_pool_limit_is_refused_naming_the_limit() {
        let fixture = Fixture::new();

        let error = fixture
            .service()
            .ensure(ensure(300))
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::BadRequest("total must be at most 255 (got 300)".to_owned())
        );
    }

    #[tokio::test]
    async fn a_breakdown_that_does_not_sum_to_the_total_is_refused() {
        let fixture = Fixture::new();
        let request = EnsurePool {
            transports: Some(TransportBreakdown {
                http: 1,
                grpc: 1,
                both: 0,
            }),
            ..ensure(3)
        };

        let error = fixture
            .service()
            .ensure(request)
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::BadRequest("transports must sum to total".to_owned())
        );
    }

    #[tokio::test]
    async fn grpc_helpers_in_the_pool_are_refused_when_the_node_does_not_serve_grpc() {
        let fixture = Fixture::new().without_grpc();
        let request = EnsurePool {
            transports: Some(TransportBreakdown {
                http: 1,
                grpc: 0,
                both: 1,
            }),
            ..ensure(2)
        };

        let error = fixture
            .service()
            .ensure(request)
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::BadRequest("gRPC helpers requested but grpc_enabled is false".to_owned())
        );
    }

    #[tokio::test]
    async fn an_over_long_offered_name_is_refused_and_named() {
        let fixture = Fixture::new();
        let request = EnsurePool {
            names: names(&["ok", &"x".repeat(65)]),
            ..ensure(2)
        };

        let error = fixture
            .service()
            .ensure(request)
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::BadRequest("names[1] must be at most 64 characters".to_owned())
        );
    }

    #[tokio::test]
    async fn helpers_that_fail_to_start_are_unlisted_and_reported() {
        let fixture = Fixture::new();
        fixture.gateway.fail_spawns();

        let error = fixture
            .service()
            .ensure(ensure(2))
            .await
            .expect_err("fails");

        assert_eq!(
            error,
            ServiceError::Internal("2 of 2 new helpers could not be started".to_owned())
        );
        assert!(fixture.actors.all_actors().is_empty());
    }

    #[test]
    fn only_the_per_mode_shortfall_is_planned() {
        let roster = pool_named(&["a", "b"]);
        let want = TransportBreakdown {
            http: 3,
            grpc: 1,
            both: 0,
        };

        let planned = plan_shortfall(want, &roster, |_, _, mode, _| {
            let actor = Actor::mint(Role::Helper, "n", "http://h", "h:1", mode);
            (
                actor,
                ActorSettings::fresh(300, crate::models::UnpairAck::Required),
            )
        });

        let modes: Vec<TransportMode> = planned.iter().map(|(a, _)| a.transport_mode()).collect();
        assert_eq!(modes, vec![TransportMode::Http, TransportMode::Grpc]);
    }

    #[test]
    fn a_mixed_shortfall_gives_every_mint_distinct_counters() {
        // The wizard's "1 http, 1 grpc, 1 both" against an empty pool: a
        // per-mode loop restarts at zero for each mode, so a caller naming
        // helpers off that alone would mint every helper under one name.
        let calls = std::sync::Mutex::new(Vec::new());
        let want = TransportBreakdown {
            http: 1,
            grpc: 1,
            both: 1,
        };

        let planned = plan_shortfall(want, &[], |taken, pool_index, mode, pool| {
            calls
                .lock()
                .expect("not poisoned")
                .push((taken, pool_index));
            let name = helper_name(&[], taken, pool_index, pool);
            let actor = Actor::mint(Role::Helper, &name, "http://h", "h:1", mode);
            (
                actor,
                ActorSettings::fresh(300, crate::models::UnpairAck::Required),
            )
        });

        assert_eq!(
            *calls.lock().expect("not poisoned"),
            vec![(0, 0), (1, 1), (2, 2)]
        );
        let mut names: Vec<String> = planned.into_iter().map(|(a, _)| a.name).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), 3, "every new helper gets a distinct name");
    }

    #[test]
    fn mint_is_told_which_pool_position_it_is_filling() {
        // So a caller supplying names can line them up with the gap it is
        // filling rather than restarting from zero each time.
        let roster = pool_named(&["a", "b"]);
        let want = TransportBreakdown {
            http: 5,
            grpc: 0,
            both: 0,
        };

        let planned = plan_shortfall(want, &roster, |taken, pool_index, mode, pool| {
            let name = helper_name(&[], taken, pool_index, pool);
            let actor = Actor::mint(Role::Helper, &name, "http://h", "h:1", mode);
            (
                actor,
                ActorSettings::fresh(300, crate::models::UnpairAck::Required),
            )
        });

        let names: Vec<String> = planned.into_iter().map(|(a, _)| a.name).collect();
        assert_eq!(names, ["Participant 3", "Participant 4", "Participant 5"]);
    }

    // ── Naming ──────────────────────────────────────────────────────────────

    #[test]
    fn no_names_at_all_is_fine() {
        assert_eq!(helper_name(&[], 0, 0, &[]), "Participant 1");
    }

    #[test]
    fn offered_names_are_used_in_creation_order() {
        let offered = names(&["Ann", "Bo"]);

        // Pool positions 7 and 8, but the caller's first two names still
        // apply: it offered names for what it needs created, not for slots.
        assert_eq!(helper_name(&offered, 0, 7, &[]), "Ann");
        assert_eq!(helper_name(&offered, 1, 8, &[]), "Bo");
    }

    #[test]
    fn running_out_of_names_falls_back_to_the_pool_position() {
        let offered = names(&["Ann"]);

        assert_eq!(helper_name(&offered, 1, 7, &[]), "Participant 8");
        assert_eq!(helper_name(&offered, 2, 8, &[]), "Participant 9");
    }

    #[test]
    fn a_blank_name_falls_back_rather_than_rendering_an_empty_row() {
        let offered = names(&["", "   "]);

        assert_eq!(helper_name(&offered, 0, 0, &[]), "Participant 1");
        assert_eq!(helper_name(&offered, 1, 1, &[]), "Participant 2");
    }

    #[test]
    fn an_offered_name_the_pool_already_has_is_skipped_for_the_next_free_one() {
        let offered = names(&["Alex", "Richard", "Bob"]);
        let pool = pool_named(&["alex"]);

        assert_eq!(helper_name(&offered, 0, 1, &pool), "Richard");
    }

    #[test]
    fn when_every_offered_name_is_taken_the_fallback_is_used() {
        let pool = pool_named(&["Alex"]);

        assert_eq!(helper_name(&names(&["Alex"]), 0, 1, &pool), "Participant 2");
    }

    #[test]
    fn the_numbered_fallback_moves_past_a_number_already_in_use() {
        let pool = pool_named(&["Ann", "Bo", "Participant 3"]);

        assert_eq!(helper_name(&[], 0, 2, &pool), "Participant 4");
    }

    #[test]
    fn blank_offered_names_are_allowed_and_mean_number_this_one() {
        assert!(validate_offered_names(&names(&["", "  "])).is_ok());
    }

    // ── Operator levers ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn toggling_with_no_preference_flips_the_state() {
        let fixture = Fixture::new();
        let alex = fixture.helper("Alex");

        assert!(fixture
            .service()
            .toggle_status(alex.id, None)
            .await
            .expect("toggles"));
        assert!(!fixture
            .service()
            .toggle_status(alex.id, None)
            .await
            .expect("toggles"));
        assert!(fixture
            .service()
            .toggle_status(alex.id, Some(true))
            .await
            .expect("sets"));
    }

    #[tokio::test]
    async fn an_owner_cannot_be_switched_off() {
        // Regression: switching an owner's id off silently dropped that
        // owner's entire mailbox, since every delivery consults the switch.
        let fixture = Fixture::new();
        let alice = fixture.owner();

        let error = fixture
            .service()
            .toggle_status(alice.id, None)
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::BadRequest("actor is an owner, not a helper".to_owned())
        );
        assert!(!fixture.disabled.is_disabled_now(&alice.id));
    }

    #[tokio::test]
    async fn an_unknown_helper_is_not_found() {
        let fixture = Fixture::new();

        let error = fixture
            .service()
            .toggle_status(Uuid::new_v4(), None)
            .await
            .expect_err("refused");

        assert_eq!(error, ServiceError::NotFound("helper not found".to_owned()));
    }

    #[tokio::test]
    async fn deleting_a_helper_stops_it_before_erasing_its_data() {
        let fixture = Fixture::new();
        let alex = fixture.helper("Alex");
        fixture.channels.replace(alex.id, vec!["7".to_owned()]);

        fixture.service().delete(alex.id).await.expect("deletes");

        assert_eq!(fixture.gateway.shut_down(), vec![alex.id]);
        assert_eq!(fixture.routes.removed_actors(), vec![alex.id]);
        assert_eq!(fixture.data.erased(), vec![alex.id]);
        assert_eq!(fixture.channels.get(&alex.id), None);
        assert!(fixture.actors.all_actors().is_empty());
    }

    #[tokio::test]
    async fn a_failed_erasure_leaves_the_helper_listed() {
        let fixture = Fixture::new();
        let alex = fixture.helper("Alex");
        fixture.data.fail();

        let error = fixture.service().delete(alex.id).await.expect_err("fails");

        assert_eq!(
            error,
            ServiceError::Internal("actor registry unavailable".to_owned())
        );
        assert_eq!(fixture.actors.all_actors().len(), 1);
    }

    #[tokio::test]
    async fn linking_a_channel_to_itself_is_refused() {
        let fixture = Fixture::new();
        let alex = fixture.helper("Alex");

        let error = fixture
            .service()
            .link_channels(alex.id, "1", "1")
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::BadRequest("cannot link a channel to itself".to_owned())
        );
    }

    #[tokio::test]
    async fn linking_a_channel_the_helper_does_not_hold_is_not_found_and_named() {
        let fixture = Fixture::new();
        let alex = fixture.helper("Alex");
        fixture.records.hold(alex.id, 1);

        let error = fixture
            .service()
            .link_channels(alex.id, "1", "2")
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::NotFound(
                "this helper holds no channel 2 (`link_to_channel_id`)".to_owned()
            )
        );
        assert!(fixture.gateway.links().is_empty());
    }

    #[tokio::test]
    async fn linking_two_held_channels_asks_the_actor() {
        let fixture = Fixture::new();
        let alex = fixture.helper("Alex");
        fixture.records.hold(alex.id, 1);
        fixture.records.hold(alex.id, 2);

        fixture
            .service()
            .link_channels(alex.id, "1", "2")
            .await
            .expect("links");

        assert_eq!(fixture.gateway.links(), vec![(alex.id, 1, 2)]);
    }

    #[tokio::test]
    async fn listing_the_channels_of_a_busy_actor_is_transient() {
        let fixture = Fixture::new();
        let alex = fixture.helper("Alex");
        fixture.gateway.fail_next(ActorCallError::Busy);

        let error = fixture
            .service()
            .list_channels(alex.id)
            .await
            .expect_err("busy");

        assert!(matches!(error, ServiceError::Unavailable(_)));
    }

    #[tokio::test]
    async fn a_helper_with_no_backend_instance_has_no_channels_to_list() {
        let fixture = Fixture::new();
        let alex = Actor::mint(Role::Helper, "Alex", "http://h", "h:1", TransportMode::Http);
        fixture.actors.insert(alex.clone());

        let error = fixture
            .service()
            .list_channels(alex.id)
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::NotFound("helper has no backend protocol instance".to_owned())
        );
    }

    // ── Browser contacts ────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_published_contact_is_handed_back_exactly() {
        let fixture = Fixture::new();
        let alice = fixture.owner();
        let body = br#"{ "channel_id": "1" }"#;

        fixture
            .service()
            .publish_browser_contact(alice.id, body)
            .await
            .expect("stores");

        assert_eq!(
            fixture
                .service()
                .browser_contact(alice.id)
                .await
                .expect("reads"),
            r#"{ "channel_id": "1" }"#
        );
    }

    #[tokio::test]
    async fn a_contact_that_is_not_a_json_object_is_refused() {
        let fixture = Fixture::new();
        let alice = fixture.owner();

        for body in [&b"[1]"[..], b"not json", &[0xff, 0xfe]] {
            let error = fixture
                .service()
                .publish_browser_contact(alice.id, body)
                .await
                .expect_err("refused");
            assert_eq!(
                error,
                ServiceError::BadRequest("the contact must be a JSON object".to_owned())
            );
        }
    }

    #[tokio::test]
    async fn an_oversized_contact_is_refused_as_too_large() {
        let fixture = Fixture::new();
        let alice = fixture.owner();
        let body = vec![b' '; MAX_CONTACT_BYTES + 1];

        let error = fixture
            .service()
            .publish_browser_contact(alice.id, &body)
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::PayloadTooLarge("a contact may be at most 16384 bytes".to_owned())
        );
    }

    #[tokio::test]
    async fn a_contact_never_published_is_not_found() {
        let fixture = Fixture::new();
        let alice = fixture.owner();

        let error = fixture
            .service()
            .browser_contact(alice.id)
            .await
            .expect_err("absent");

        assert_eq!(
            error,
            ServiceError::NotFound("this actor has not published a contact".to_owned())
        );
    }

    #[tokio::test]
    async fn a_contact_for_an_unknown_actor_is_not_found() {
        let fixture = Fixture::new();

        let error = fixture
            .service()
            .browser_contact(Uuid::new_v4())
            .await
            .expect_err("absent");

        assert_eq!(error, ServiceError::NotFound("actor not found".to_owned()));
    }
}
