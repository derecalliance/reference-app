// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Hand-written fakes of the repositories and ports the services depend on,
//! for the services' unit tests. Each keeps what it was given in memory and
//! records what it was asked to do, so a test can assert on both.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use async_trait::async_trait;
use derec_library::protocol::{ChannelStatus, DeRecEvent, DeRecFlow, HelperChannel};
use derec_library::types::ChannelId;
use uuid::Uuid;

use crate::models::{
    Actor, ActorSettings, ChannelSummary, ContactRequest, Event, EventSnapshot, InboxKind,
    Listener, NewEvent, OwnTarget, PlannedRegistration, Resolution, Role, Route, Transport,
    UnpairAck, UnpairedContact,
};
use crate::repositories::actors::{ActorRepository, RegistrationPlan};
use crate::repositories::browser_contacts::BrowserContactRepository;
use crate::repositories::disabled_helpers::DisabledHelperRepository;
use crate::repositories::mailboxes::MailboxRepository;
use crate::repositories::participant_data::ParticipantDataRepository;
use crate::repositories::protocol_records::ProtocolRecordRepository;
use crate::repositories::RepositoryError;
use crate::services::delivery::{DialError, PeerDialer};
use crate::services::ports::{
    ActorCallError, ActorGateway, ChannelRoutes, EventRecorder, InboxDirectory, OwnEndpoints,
    SpawnError,
};

type Result<T> = std::result::Result<T, RepositoryError>;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// What a failing fake answers with.
fn unavailable() -> RepositoryError {
    RepositoryError::Corrupt("the fake was told to fail".to_owned())
}

// ── Repositories ────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct FakeActorRepository {
    rows: Mutex<Vec<(Actor, ActorSettings)>>,
    failing: Mutex<bool>,
}

impl FakeActorRepository {
    pub fn insert(&self, actor: Actor) {
        lock(&self.rows).push((actor, ActorSettings::fresh(300, UnpairAck::Required)));
    }

    pub fn all_actors(&self) -> Vec<Actor> {
        lock(&self.rows).iter().map(|(a, _)| a.clone()).collect()
    }

    /// Every call fails from now on.
    pub fn fail(&self) {
        *lock(&self.failing) = true;
    }

    fn check(&self) -> Result<()> {
        if *lock(&self.failing) {
            Err(unavailable())
        } else {
            Ok(())
        }
    }
}

#[async_trait]
impl ActorRepository for FakeActorRepository {
    async fn register(&self, actor: Actor, settings: ActorSettings) -> Result<()> {
        self.check()?;
        lock(&self.rows).push((actor, settings));
        Ok(())
    }

    async fn register_planned(&self, plan: RegistrationPlan<'_>) -> Result<PlannedRegistration> {
        self.check()?;
        let mut rows = lock(&self.rows);
        let roster: Vec<Actor> = rows.iter().map(|(a, _)| a.clone()).collect();
        let planned = plan(&roster);
        let registered: Vec<Actor> = planned.iter().map(|(a, _)| a.clone()).collect();
        rows.extend(planned);
        Ok(PlannedRegistration {
            registered,
            roster: rows.iter().map(|(a, _)| a.clone()).collect(),
        })
    }

    async fn set_transports(&self, actor_id: &Uuid, transports: &[Transport]) -> Result<()> {
        self.check()?;
        for (actor, _) in lock(&self.rows)
            .iter_mut()
            .filter(|(a, _)| a.id == *actor_id)
        {
            actor.transports = transports.to_vec();
        }
        Ok(())
    }

    async fn rename(&self, actor_id: &Uuid, role: Role, name: &str) -> Result<bool> {
        self.check()?;
        let mut rows = lock(&self.rows);
        match rows
            .iter_mut()
            .find(|(a, _)| a.id == *actor_id && a.role == role)
        {
            Some((actor, _)) => {
                actor.name = name.to_owned();
                Ok(true)
            }
            None => Ok(false),
        }
    }

    async fn remove(&self, actor_id: &Uuid) -> Result<()> {
        self.check()?;
        lock(&self.rows).retain(|(a, _)| a.id != *actor_id);
        Ok(())
    }

    async fn get(&self, actor_id: &Uuid) -> Result<Option<Actor>> {
        self.check()?;
        Ok(lock(&self.rows)
            .iter()
            .find(|(a, _)| a.id == *actor_id)
            .map(|(a, _)| a.clone()))
    }

    async fn settings(&self, actor_id: &Uuid) -> Result<Option<ActorSettings>> {
        self.check()?;
        Ok(lock(&self.rows)
            .iter()
            .find(|(a, _)| a.id == *actor_id)
            .map(|(_, s)| s.clone()))
    }

    async fn all(&self) -> Result<Vec<Actor>> {
        self.check()?;
        Ok(self.all_actors())
    }
}

#[derive(Default)]
pub struct FakeDisabledHelpers {
    disabled: Mutex<HashSet<Uuid>>,
}

impl FakeDisabledHelpers {
    pub fn disable(&self, actor_id: Uuid) {
        lock(&self.disabled).insert(actor_id);
    }

    pub fn is_disabled_now(&self, actor_id: &Uuid) -> bool {
        lock(&self.disabled).contains(actor_id)
    }
}

#[async_trait]
impl DisabledHelperRepository for FakeDisabledHelpers {
    async fn is_disabled(&self, actor_id: &Uuid) -> Result<bool> {
        Ok(self.is_disabled_now(actor_id))
    }

    async fn set_disabled(&self, actor_id: &Uuid, disabled: bool) -> Result<()> {
        let mut set = lock(&self.disabled);
        if disabled {
            set.insert(*actor_id);
        } else {
            set.remove(actor_id);
        }
        Ok(())
    }
}

#[derive(Default)]
pub struct FakeBrowserContacts {
    contacts: Mutex<HashMap<Uuid, String>>,
}

#[async_trait]
impl BrowserContactRepository for FakeBrowserContacts {
    async fn put(&self, actor_id: &Uuid, contact: &str) -> Result<()> {
        lock(&self.contacts).insert(*actor_id, contact.to_owned());
        Ok(())
    }

    async fn get(&self, actor_id: &Uuid) -> Result<Option<String>> {
        Ok(lock(&self.contacts).get(actor_id).cloned())
    }
}

#[derive(Default)]
pub struct FakeParticipantData {
    erased: Mutex<Vec<Uuid>>,
    failing: Mutex<bool>,
}

impl FakeParticipantData {
    pub fn erased(&self) -> Vec<Uuid> {
        lock(&self.erased).clone()
    }

    pub fn fail(&self) {
        *lock(&self.failing) = true;
    }
}

#[async_trait]
impl ParticipantDataRepository for FakeParticipantData {
    async fn erase(&self, actor_id: &Uuid) -> Result<()> {
        if *lock(&self.failing) {
            return Err(unavailable());
        }
        lock(&self.erased).push(*actor_id);
        Ok(())
    }
}

/// A mailbox per actor, with an optional cap after which it is full, and an
/// optional failure for every call.
#[derive(Default)]
pub struct FakeMailboxes {
    queued: Mutex<HashMap<Uuid, Vec<Vec<u8>>>>,
    capacity: Mutex<Option<usize>>,
    failing: Mutex<bool>,
}

impl FakeMailboxes {
    pub fn cap_at(&self, messages: usize) {
        *lock(&self.capacity) = Some(messages);
    }

    pub fn fail(&self) {
        *lock(&self.failing) = true;
    }

    pub fn waiting(&self, actor_id: &Uuid) -> Vec<Vec<u8>> {
        lock(&self.queued)
            .get(actor_id)
            .cloned()
            .unwrap_or_default()
    }
}

#[async_trait]
impl MailboxRepository for FakeMailboxes {
    async fn enqueue(&self, actor_id: &Uuid, message: &[u8]) -> Result<()> {
        if *lock(&self.failing) {
            return Err(unavailable());
        }
        let mut queued = lock(&self.queued);
        let queue = queued.entry(*actor_id).or_default();
        if lock(&self.capacity).is_some_and(|cap| queue.len() >= cap) {
            return Err(RepositoryError::MailboxFull {
                queued: queue.len() as i64,
                bytes: 0,
            });
        }
        queue.push(message.to_vec());
        Ok(())
    }

    async fn drain(&self, actor_id: &Uuid) -> Result<Vec<Vec<u8>>> {
        if *lock(&self.failing) {
            return Err(unavailable());
        }
        Ok(lock(&self.queued).remove(actor_id).unwrap_or_default())
    }

    async fn len(&self, actor_id: &Uuid) -> Result<usize> {
        Ok(self.waiting(actor_id).len())
    }
}

/// A helper-channel record as the pairing handshake writes one.
pub fn helper_record(channel_id: u64, status: ChannelStatus, created_at: u64) -> HelperChannel {
    HelperChannel {
        channel_id: ChannelId(channel_id),
        transports: vec![derec_proto::TransportProtocol {
            uri: "http://peer/derec/x".to_owned(),
            protocol: derec_proto::Protocol::Https as i32,
        }],
        communication_info: HashMap::new(),
        peer_role: derec_proto::SenderKind::Owner,
        status,
        created_at,
    }
}

#[derive(Default)]
pub struct FakeProtocolRecords {
    held: Mutex<HashSet<(Uuid, u64)>>,
    helper_channels: Mutex<HashMap<Uuid, Vec<(u64, HelperChannel)>>>,
    shared_keys: Mutex<HashMap<(Uuid, u64, u64), [u8; 32]>>,
}

impl FakeProtocolRecords {
    /// `actor_id` holds `channel_id`, on any instance.
    pub fn hold(&self, actor_id: Uuid, channel_id: u64) {
        lock(&self.held).insert((actor_id, channel_id));
    }

    pub fn set_helper_channels(&self, actor_id: Uuid, records: Vec<(u64, HelperChannel)>) {
        lock(&self.helper_channels).insert(actor_id, records);
    }

    pub fn set_shared_key(&self, actor_id: Uuid, secret_id: u64, channel_id: u64, key: [u8; 32]) {
        lock(&self.shared_keys).insert((actor_id, secret_id, channel_id), key);
    }
}

#[async_trait]
impl ProtocolRecordRepository for FakeProtocolRecords {
    async fn holds_channel(
        &self,
        actor_id: &Uuid,
        channel_id: u64,
        _: Option<u64>,
    ) -> Result<bool> {
        Ok(lock(&self.held).contains(&(*actor_id, channel_id)))
    }

    async fn helper_channels(&self, actor_id: &Uuid) -> Result<Vec<(u64, HelperChannel)>> {
        Ok(lock(&self.helper_channels)
            .get(actor_id)
            .cloned()
            .unwrap_or_default())
    }

    async fn shared_key(
        &self,
        actor_id: &Uuid,
        secret_id: u64,
        channel_id: u64,
    ) -> Result<Option<[u8; 32]>> {
        Ok(lock(&self.shared_keys)
            .get(&(*actor_id, secret_id, channel_id))
            .copied())
    }

    async fn unpaired_contacts(&self, _: &Uuid, _: i64) -> Result<Vec<UnpairedContact>> {
        Ok(Vec::new())
    }

    async fn instance_secret_ids(&self, _: &Uuid) -> Result<Vec<u64>> {
        Ok(Vec::new())
    }
}

// ── Ports ───────────────────────────────────────────────────────────────────

/// Inboxes by kind; records what was delivered to provisioned ones.
#[derive(Default)]
pub struct FakeInboxes {
    kinds: Mutex<HashMap<Uuid, InboxKind>>,
    delivered: Mutex<Vec<(Uuid, Vec<u8>)>>,
}

impl FakeInboxes {
    pub fn provisioned(&self, actor_id: Uuid) {
        lock(&self.kinds).insert(actor_id, InboxKind::Provisioned);
    }

    pub fn delivered(&self) -> Vec<(Uuid, Vec<u8>)> {
        lock(&self.delivered).clone()
    }
}

impl InboxDirectory for FakeInboxes {
    fn kind(&self, actor_id: &Uuid) -> Option<InboxKind> {
        lock(&self.kinds).get(actor_id).copied()
    }

    fn register_browser(&self, actor_id: Uuid) {
        lock(&self.kinds)
            .entry(actor_id)
            .or_insert(InboxKind::Browser);
    }

    fn deliver(&self, actor_id: &Uuid, bytes: Vec<u8>) -> bool {
        if self.kind(actor_id) != Some(InboxKind::Provisioned) {
            return false;
        }
        lock(&self.delivered).push((*actor_id, bytes));
        true
    }
}

/// Answers every call with a canned success unless told to fail the next one,
/// and records what it was asked.
#[derive(Default)]
pub struct FakeGateway {
    next_error: Mutex<Option<ActorCallError>>,
    failing_spawns: Mutex<bool>,
    spawned: Mutex<Vec<Uuid>>,
    shut_down: Mutex<Vec<Uuid>>,
    replicas: Mutex<Vec<(Uuid, u64)>>,
    contacts: Mutex<Vec<ContactRequest>>,
    pairing_channel: Mutex<Option<u64>>,
    links: Mutex<Vec<(Uuid, u64, u64)>>,
    instances: Mutex<HashMap<Uuid, Vec<u64>>>,
}

impl FakeGateway {
    /// The next call that can fail, fails with `error`.
    pub fn fail_next(&self, error: ActorCallError) {
        *lock(&self.next_error) = Some(error);
    }

    pub fn fail_spawns(&self) {
        *lock(&self.failing_spawns) = true;
    }

    /// `start_flow` reports a pairing started on `channel_id`.
    pub fn pairing_starts_on(&self, channel_id: u64) {
        *lock(&self.pairing_channel) = Some(channel_id);
    }

    pub fn set_instances(&self, actor_id: Uuid, secret_ids: Vec<u64>) {
        lock(&self.instances).insert(actor_id, secret_ids);
    }

    pub fn spawned(&self) -> Vec<Uuid> {
        lock(&self.spawned).clone()
    }

    pub fn shut_down(&self) -> Vec<Uuid> {
        lock(&self.shut_down).clone()
    }

    pub fn replicas_ensured(&self) -> Vec<(Uuid, u64)> {
        lock(&self.replicas).clone()
    }

    pub fn contact_requests(&self) -> Vec<ContactRequest> {
        lock(&self.contacts).clone()
    }

    pub fn links(&self) -> Vec<(Uuid, u64, u64)> {
        lock(&self.links).clone()
    }

    fn check(&self) -> std::result::Result<(), ActorCallError> {
        match lock(&self.next_error).take() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

#[async_trait]
impl ActorGateway for FakeGateway {
    fn spawn(&self, actor: &Actor, _: &ActorSettings) -> std::result::Result<(), SpawnError> {
        if *lock(&self.failing_spawns) {
            return Err(SpawnError::SecretId);
        }
        lock(&self.spawned).push(actor.id);
        Ok(())
    }

    fn shutdown(&self, actor_id: &Uuid) {
        lock(&self.shut_down).push(*actor_id);
    }

    async fn ensure_replica_instance(
        &self,
        actor_id: &Uuid,
        owner_secret_id: u64,
    ) -> std::result::Result<bool, ActorCallError> {
        self.check()?;
        lock(&self.replicas).push((*actor_id, owner_secret_id));
        Ok(true)
    }

    async fn create_contact(
        &self,
        _: &Uuid,
        request: ContactRequest,
    ) -> std::result::Result<derec_proto::ContactMessage, ActorCallError> {
        self.check()?;
        lock(&self.contacts).push(request);
        Ok(derec_proto::ContactMessage {
            channel_id: 4242,
            nonce: request.nonce.unwrap_or(1),
            contact_mode: request.contact_mode as i32,
            ..Default::default()
        })
    }

    async fn start_flow(
        &self,
        _: &Uuid,
        _: DeRecFlow,
    ) -> std::result::Result<Vec<DeRecEvent>, ActorCallError> {
        self.check()?;
        Ok(lock(&self.pairing_channel)
            .map(|channel_id| DeRecEvent::PairingStarted {
                channel_id: ChannelId(channel_id),
                trace_id: 1,
                kind: derec_proto::SenderKind::Helper,
            })
            .into_iter()
            .collect())
    }

    async fn fingerprint(
        &self,
        _: &Uuid,
        channel_id: u64,
    ) -> std::result::Result<String, ActorCallError> {
        self.check()?;
        Ok(format!("fingerprint-{channel_id}"))
    }

    async fn verify_fingerprint(
        &self,
        _: &Uuid,
        channel_id: u64,
        fingerprint: String,
    ) -> std::result::Result<bool, ActorCallError> {
        self.check()?;
        Ok(fingerprint == format!("fingerprint-{channel_id}"))
    }

    async fn list_channels(
        &self,
        _: &Uuid,
    ) -> std::result::Result<Vec<ChannelSummary>, ActorCallError> {
        self.check()?;
        Ok(Vec::new())
    }

    async fn link_channels(
        &self,
        actor_id: &Uuid,
        channel_id: u64,
        link_to_channel_id: u64,
    ) -> std::result::Result<(), ActorCallError> {
        self.check()?;
        lock(&self.links).push((*actor_id, channel_id, link_to_channel_id));
        Ok(())
    }

    async fn instance_secret_ids(&self, actor_id: &Uuid) -> Vec<u64> {
        lock(&self.instances)
            .get(actor_id)
            .cloned()
            .unwrap_or_default()
    }
}

/// Records pins, unpins and removals; resolves from what it was told.
#[derive(Default)]
pub struct FakeRoutes {
    pins: Mutex<Vec<(u64, Uuid)>>,
    unpins: Mutex<Vec<(u64, Uuid)>>,
    removed: Mutex<Vec<Uuid>>,
    resolutions: Mutex<HashMap<u64, Resolution>>,
}

impl FakeRoutes {
    pub fn pins(&self) -> Vec<(u64, Uuid)> {
        lock(&self.pins).clone()
    }

    pub fn unpins(&self) -> Vec<(u64, Uuid)> {
        lock(&self.unpins).clone()
    }

    pub fn removed_actors(&self) -> Vec<Uuid> {
        lock(&self.removed).clone()
    }

    pub fn resolve_to(&self, channel_id: u64, resolution: Resolution) {
        lock(&self.resolutions).insert(channel_id, resolution);
    }
}

impl ChannelRoutes for FakeRoutes {
    fn pin(&self, channel_id: u64, actor_id: Uuid) {
        lock(&self.pins).push((channel_id, actor_id));
    }

    fn unpin(&self, channel_id: u64, actor_id: Uuid) {
        lock(&self.unpins).push((channel_id, actor_id));
    }

    fn resolve_from(&self, channel_id: u64, _: Option<Uuid>) -> Resolution {
        lock(&self.resolutions)
            .get(&channel_id)
            .cloned()
            .unwrap_or(Resolution::Unknown)
    }

    fn remove_actor(&self, actor_id: Uuid) -> usize {
        lock(&self.removed).push(actor_id);
        0
    }

    fn routes(&self) -> Vec<Route> {
        Vec::new()
    }
}

/// Keeps every event, numbered from one.
#[derive(Default)]
pub struct FakeEventRecorder {
    events: Mutex<Vec<NewEvent>>,
}

impl FakeEventRecorder {
    pub fn recorded(&self) -> Vec<NewEvent> {
        lock(&self.events).clone()
    }
}

impl EventRecorder for FakeEventRecorder {
    fn record(&self, event: NewEvent) {
        lock(&self.events).push(event);
    }

    fn since(&self, after: u64, limit: usize) -> EventSnapshot {
        let events = lock(&self.events);
        let page = events
            .iter()
            .enumerate()
            .map(|(i, e)| Event {
                seq: i as u64 + 1,
                at_ms: 0,
                direction: e.direction,
                carrier: e.carrier,
                outcome: e.outcome,
                actor_id: e.actor_id,
                channel_id: e.channel_id.map(|c| c.to_string()),
                bytes: e.bytes,
                detail: e.detail.clone(),
            })
            .filter(|e| e.seq > after)
            .take(limit)
            .collect();
        EventSnapshot {
            events: page,
            dropped: 0,
            latest_seq: events.len() as u64,
        }
    }
}

/// Answers `own_target` from what it was told.
#[derive(Default)]
pub struct FakeOwnEndpoints {
    targets: Mutex<HashMap<String, OwnTarget>>,
}

impl FakeOwnEndpoints {
    pub fn own(&self, uri: &str, target: OwnTarget) {
        lock(&self.targets).insert(uri.to_owned(), target);
    }
}

impl OwnEndpoints for FakeOwnEndpoints {
    fn own_target(&self, uri: &str) -> Option<OwnTarget> {
        lock(&self.targets).get(uri).copied()
    }

    fn advertised(&self, _: Listener) -> Vec<String> {
        Vec::new()
    }
}

/// Records every dial, and fails them all when told to.
#[derive(Default)]
pub struct FakeDialer {
    dialled: Mutex<Vec<String>>,
    failing: Mutex<bool>,
}

impl FakeDialer {
    pub fn dialled(&self) -> Vec<String> {
        lock(&self.dialled).clone()
    }

    pub fn fail(&self) {
        *lock(&self.failing) = true;
    }
}

#[async_trait]
impl PeerDialer for FakeDialer {
    async fn dial(&self, uri: &str, _: Vec<u8>) -> std::result::Result<(), DialError> {
        if *lock(&self.failing) {
            return Err(DialError("connection refused".to_owned()));
        }
        lock(&self.dialled).push(uri.to_owned());
        Ok(())
    }
}
