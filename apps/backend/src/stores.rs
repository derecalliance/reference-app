// In-memory implementations of the derec-library store and transport traits.
//
// Every store is partitioned by `secret_id`: a single backend instance can
// serve many secrets on the same device (Owner of one secret, Helper for N
// other Owners). The protocol holds each store by `&mut Self`, so these
// implementations never see overlapping calls and need no internal
// synchronization.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use derec_library::protocol::{
    ChannelQuery, ChannelRecord, ChannelStoreFuture, DeRecChannelStore, DeRecSecretStore,
    DeRecShareStore, DeRecStateStore, DeRecTransport, DeRecUserSecretStore, HelperChannel,
    MissingPolicy, ReplicaMember, SecretKind, SecretStoreError, SecretStoreFuture, SecretValue,
    Share, ShareStoreFuture, StateItem, StateKey, StateKind, StateStoreFuture, TransportFuture,
    UserSecrets,
};
use derec_library::types::ChannelId;
use derec_proto::TransportProtocol;

// ── Channel store ───────────────────────────────────────────────────────────

/// Stores channel records plus the channel-link graph (channels belonging to
/// the same Owner identity, e.g. after a recovery re-pairing). The link graph
/// is a bidirectional adjacency list; `linked_channels` is a BFS over it.
///
/// Helper channels and replica-group members live in **separate maps**,
/// because they are keyed differently: a helper channel by `channel_id`, a
/// group member by `replica_id` alone. Every member of a group shares one
/// `channel_id`, so the channel cannot identify them — and a member moves
/// between channels during an admission handover while remaining the same
/// member, so a key requiring both to match would lose the row exactly when
/// that move needs to be observed.
///
/// Every map is partitioned by `secret_id` so nothing leaks across secrets.
#[derive(Default)]
pub struct InMemoryChannelStore {
    helpers: HashMap<(u64, u64), HelperChannel>,
    /// `BTreeMap` rather than `HashMap`: `replicas` is read to choose a
    /// successor, and `HashMap` iteration order varies between runs.
    members: BTreeMap<(u64, u64), ReplicaMember>,
    links: HashMap<(u64, u64), HashSet<u64>>,
}

impl DeRecChannelStore for InMemoryChannelStore {
    fn load(
        &self,
        secret_id: u64,
        query: ChannelQuery,
    ) -> ChannelStoreFuture<'_, Option<ChannelRecord>> {
        let result = match query {
            ChannelQuery::Helper { channel_id } => self
                .helpers
                .get(&(secret_id, channel_id.0))
                .cloned()
                .map(ChannelRecord::Helper),
            // Keyed by `replica_id` alone — `channel_id` is context, not key.
            ChannelQuery::Replica { replica_id, .. } => self
                .members
                .get(&(secret_id, replica_id.0))
                .cloned()
                .map(ChannelRecord::Replica),
        };
        Box::pin(std::future::ready(Ok(result)))
    }

    fn save(&mut self, secret_id: u64, record: ChannelRecord) -> ChannelStoreFuture<'_, ()> {
        match record {
            ChannelRecord::Helper(h) => {
                self.helpers.insert((secret_id, h.channel_id.0), h);
            }
            ChannelRecord::Replica(r) => {
                self.members.insert((secret_id, r.replica_id.0), r);
            }
        }
        Box::pin(std::future::ready(Ok(())))
    }

    fn remove(&mut self, secret_id: u64, query: ChannelQuery) -> ChannelStoreFuture<'_, bool> {
        // Removing one member removes that member only — the group channel and
        // every other member survive.
        let removed = match query {
            ChannelQuery::Helper { channel_id } => {
                self.helpers.remove(&(secret_id, channel_id.0)).is_some()
            }
            ChannelQuery::Replica { replica_id, .. } => {
                self.members.remove(&(secret_id, replica_id.0)).is_some()
            }
        };
        Box::pin(std::future::ready(Ok(removed)))
    }

    fn helpers(&self, secret_id: u64) -> ChannelStoreFuture<'_, Vec<HelperChannel>> {
        let entries: Vec<HelperChannel> = self
            .helpers
            .iter()
            .filter(|((s, _), _)| *s == secret_id)
            .map(|(_, h)| h.clone())
            .collect();
        Box::pin(std::future::ready(Ok(entries)))
    }

    /// Every member of the group, including this device's own row — that is
    /// what makes the roster reconstructible from storage alone.
    ///
    /// Ordered by `(created_at, replica_id)`, which is this app's succession
    /// policy: when the group's `Source` leaves, the protocol promotes the
    /// first eligible entry here, so the longest-standing member succeeds. An
    /// arbitrary order would be correct too, but it would hand the choice to
    /// the map's iteration order rather than making it.
    fn replicas(&self, secret_id: u64) -> ChannelStoreFuture<'_, Vec<ReplicaMember>> {
        let mut entries: Vec<ReplicaMember> = self
            .members
            .iter()
            .filter(|((s, _), _)| *s == secret_id)
            .map(|(_, r)| r.clone())
            .collect();
        entries.sort_by_key(|r| (r.created_at, r.replica_id.0));
        Box::pin(std::future::ready(Ok(entries)))
    }

    fn link_channel(
        &mut self,
        secret_id: u64,
        a: ChannelId,
        b: ChannelId,
    ) -> ChannelStoreFuture<'_, ()> {
        let (a, b) = (a.0, b.0);
        if a != b {
            self.links.entry((secret_id, a)).or_default().insert(b);
            self.links.entry((secret_id, b)).or_default().insert(a);
        }
        Box::pin(std::future::ready(Ok(())))
    }

    fn linked_channels(
        &self,
        secret_id: u64,
        channel_id: ChannelId,
    ) -> ChannelStoreFuture<'_, Vec<ChannelId>> {
        // BFS over the link graph; the start node is included so an unlinked
        // channel returns just itself.
        let mut visited: HashSet<u64> = HashSet::new();
        let mut queue: VecDeque<u64> = VecDeque::new();
        queue.push_back(channel_id.0);

        while let Some(curr) = queue.pop_front() {
            if !visited.insert(curr) {
                continue;
            }
            if let Some(neighbors) = self.links.get(&(secret_id, curr)) {
                for &n in neighbors {
                    if !visited.contains(&n) {
                        queue.push_back(n);
                    }
                }
            }
        }

        let result: Vec<ChannelId> = visited.into_iter().map(ChannelId).collect();
        Box::pin(std::future::ready(Ok(result)))
    }
}

// ── Secret store ─────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct InMemorySecretStore {
    data: HashMap<(u64, u64, u8), SecretValue>,
}

impl DeRecSecretStore for InMemorySecretStore {
    fn load(
        &self,
        secret_id: u64,
        channel_id: ChannelId,
        kind: SecretKind,
    ) -> SecretStoreFuture<'_, Option<SecretValue>> {
        let result = self
            .data
            .get(&(secret_id, channel_id.0, kind as u8))
            .map(clone_secret_value);
        Box::pin(std::future::ready(Ok(result)))
    }

    fn load_many(
        &self,
        secret_id: u64,
        channel_ids: &[ChannelId],
        kind: SecretKind,
        missing_policy: MissingPolicy,
    ) -> SecretStoreFuture<'_, Vec<(ChannelId, SecretValue)>> {
        let mut found = Vec::with_capacity(channel_ids.len());
        let mut missing = Vec::new();

        for cid in channel_ids {
            match self.data.get(&(secret_id, cid.0, kind as u8)) {
                Some(v) => found.push((*cid, clone_secret_value(v))),
                None => missing.push(cid.0),
            }
        }

        let result = match missing_policy {
            MissingPolicy::Skip => Ok(found),
            MissingPolicy::Fail if missing.is_empty() => Ok(found),
            MissingPolicy::Fail => Err(SecretStoreError::MissingEntries {
                kind,
                channel_ids: missing,
            }),
        };
        Box::pin(std::future::ready(result))
    }

    fn save(
        &mut self,
        secret_id: u64,
        channel_id: ChannelId,
        value: SecretValue,
    ) -> SecretStoreFuture<'_, ()> {
        let kind = match &value {
            SecretValue::SharedKey(_) => SecretKind::SharedKey as u8,
            SecretValue::PairingSecret(_) => SecretKind::PairingSecret as u8,
            SecretValue::PairingContact(_) => SecretKind::PairingContact as u8,
        };
        self.data.insert((secret_id, channel_id.0, kind), value);
        Box::pin(std::future::ready(Ok(())))
    }

    fn remove(
        &mut self,
        secret_id: u64,
        channel_id: ChannelId,
        kind: SecretKind,
    ) -> SecretStoreFuture<'_, ()> {
        self.data.remove(&(secret_id, channel_id.0, kind as u8));
        Box::pin(std::future::ready(Ok(())))
    }
}

fn clone_secret_value(v: &SecretValue) -> SecretValue {
    match v {
        SecretValue::SharedKey(k) => SecretValue::SharedKey(*k),
        SecretValue::PairingSecret(p) => SecretValue::PairingSecret(p.clone()),
        SecretValue::PairingContact(c) => SecretValue::PairingContact(c.clone()),
    }
}

impl InMemorySecretStore {
    /// Load the raw shared key bytes for a channel under `secret_id`, if present.
    pub fn load_shared_key(&self, secret_id: u64, channel_id: u64) -> Option<[u8; 32]> {
        self.data
            .get(&(secret_id, channel_id, SecretKind::SharedKey as u8))
            .and_then(|v| match v {
                SecretValue::SharedKey(k) => Some(*k),
                _ => None,
            })
    }
}

// ── Share store ──────────────────────────────────────────────────────────────

/// Stores shares keyed by `(secret_id, channel_id, version)`.
///
/// Pure keyed store — channel linking lives in [`InMemoryChannelStore`];
/// `load_many` is fed the resolved channel set by the recovery handler (and
/// `load_all` by the discovery handler).
#[derive(Default)]
pub struct InMemoryShareStore {
    data: HashMap<(u64, u64, u32), Share>,
}

impl DeRecShareStore for InMemoryShareStore {
    fn load(
        &self,
        secret_id: u64,
        channel_id: ChannelId,
        versions: &[u32],
    ) -> ShareStoreFuture<'_, Vec<Share>> {
        let version_filter: Option<HashSet<u32>> = if versions.is_empty() {
            None
        } else {
            Some(versions.iter().copied().collect())
        };
        let result: Vec<Share> = self
            .data
            .iter()
            .filter(|((s, c, v), _)| {
                *s == secret_id
                    && *c == channel_id.0
                    && version_filter.as_ref().is_none_or(|f| f.contains(v))
            })
            .map(|(_, share)| share.clone())
            .collect();
        Box::pin(std::future::ready(Ok(result)))
    }

    fn load_many(
        &self,
        secret_id: u64,
        channel_ids: &[ChannelId],
        versions: &[u32],
    ) -> ShareStoreFuture<'_, Vec<Share>> {
        let cid_set: HashSet<u64> = channel_ids.iter().map(|c| c.0).collect();
        let version_filter: Option<HashSet<u32>> = if versions.is_empty() {
            None
        } else {
            Some(versions.iter().copied().collect())
        };
        let result: Vec<Share> = self
            .data
            .iter()
            .filter(|((s, c, v), _)| {
                *s == secret_id
                    && cid_set.contains(c)
                    && version_filter.as_ref().is_none_or(|f| f.contains(v))
            })
            .map(|(_, share)| share.clone())
            .collect();
        Box::pin(std::future::ready(Ok(result)))
    }

    fn load_all(
        &self,
        secret_id: u64,
        channel_ids: &[ChannelId],
    ) -> ShareStoreFuture<'_, Vec<Share>> {
        let cid_set: HashSet<u64> = channel_ids.iter().map(|c| c.0).collect();
        let result: Vec<Share> = self
            .data
            .iter()
            .filter(|((s, c, _), _)| *s == secret_id && cid_set.contains(c))
            .map(|(_, share)| share.clone())
            .collect();
        Box::pin(std::future::ready(Ok(result)))
    }

    fn latest_version(&self, secret_id: u64) -> ShareStoreFuture<'_, Option<u32>> {
        let max = self
            .data
            .keys()
            .filter(|(s, _, _)| *s == secret_id)
            .map(|(_, _, v)| *v)
            .max();
        Box::pin(std::future::ready(Ok(max)))
    }

    fn save(
        &mut self,
        secret_id: u64,
        channel_id: ChannelId,
        share: Share,
    ) -> ShareStoreFuture<'_, ()> {
        let key = (secret_id, channel_id.0, share.version);
        self.data.insert(key, share);
        Box::pin(std::future::ready(Ok(())))
    }

    /// Drop every share stored under `(secret_id, channel_id)` — all versions.
    /// Idempotent; called by the unpair flow on teardown.
    fn remove_channel(
        &mut self,
        secret_id: u64,
        channel_id: ChannelId,
    ) -> ShareStoreFuture<'_, ()> {
        self.data
            .retain(|(s, c, _), _| !(*s == secret_id && *c == channel_id.0));
        Box::pin(std::future::ready(Ok(())))
    }
}

// ── User secret store ────────────────────────────────────────────────────────

/// Latest user-facing secret snapshot per `secret_id`. Read by the
/// pair-completion auto-publish hook so a freshly-paired Helper or Replica
/// receives the current secret without an explicit re-publish.
#[derive(Default)]
pub struct InMemoryUserSecretStore {
    data: HashMap<u64, UserSecrets>,
}

impl DeRecUserSecretStore for InMemoryUserSecretStore {
    fn load_latest(&self, secret_id: u64) -> ShareStoreFuture<'_, Option<UserSecrets>> {
        let result = self.data.get(&secret_id).cloned();
        Box::pin(std::future::ready(Ok(result)))
    }

    fn save_latest(&mut self, secret_id: u64, value: UserSecrets) -> ShareStoreFuture<'_, ()> {
        self.data.insert(secret_id, value);
        Box::pin(std::future::ready(Ok(())))
    }

    fn remove(&mut self, secret_id: u64) -> ShareStoreFuture<'_, ()> {
        self.data.remove(&secret_id);
        Box::pin(std::future::ready(Ok(())))
    }
}

// ── State store ──────────────────────────────────────────────────────────────

/// In-flight orchestrator state (verification challenges, recovery
/// accumulators, pending unpair acks, sharing rounds), keyed by
/// `(secret_id, StateKey)`.
///
/// `save` is a full-replacement upsert — the library grows accumulator-style
/// state via load-modify-save, so no append primitive is needed. This backend
/// is single-instance, so the multi-instance concurrency caveats in the trait
/// docs do not apply.
#[derive(Default)]
pub struct InMemoryStateStore {
    data: HashMap<(u64, StateKey), StateItem>,
}

impl DeRecStateStore for InMemoryStateStore {
    fn save(&mut self, secret_id: u64, item: StateItem) -> StateStoreFuture<'_, ()> {
        self.data.insert((secret_id, item.key()), item);
        Box::pin(std::future::ready(Ok(())))
    }

    fn load(&self, secret_id: u64, key: StateKey) -> StateStoreFuture<'_, Option<StateItem>> {
        let result = self.data.get(&(secret_id, key)).cloned();
        Box::pin(std::future::ready(Ok(result)))
    }

    fn remove(&mut self, secret_id: u64, key: StateKey) -> StateStoreFuture<'_, bool> {
        let removed = self.data.remove(&(secret_id, key)).is_some();
        Box::pin(std::future::ready(Ok(removed)))
    }

    fn load_all(&self, secret_id: u64, kind: StateKind) -> StateStoreFuture<'_, Vec<StateItem>> {
        let result: Vec<StateItem> = self
            .data
            .iter()
            .filter(|((s, k), _)| *s == secret_id && k.kind() == kind)
            .map(|(_, item)| item.clone())
            .collect();
        Box::pin(std::future::ready(Ok(result)))
    }
}

// ── HTTP transport ───────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct HttpTransport {
    client: reqwest::Client,
}

impl HttpTransport {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }
}

impl DeRecTransport for HttpTransport {
    fn send(&self, endpoint: &TransportProtocol, message: Vec<u8>) -> TransportFuture<'_> {
        let uri = endpoint.uri.clone();
        let client = self.client.clone();
        Box::pin(async move {
            let resp = client
                .post(&uri)
                .header("Content-Type", "application/octet-stream")
                .body(message)
                .send()
                .await;

            match resp {
                Ok(r) if r.status().is_success() => Ok(()),
                Ok(r) => {
                    tracing::error!(uri = %uri, status = %r.status(), "transport: non-success status");
                    Err(derec_library::Error::Invariant("transport: non-success HTTP status"))
                }
                Err(e) => {
                    tracing::error!(uri = %uri, error = %e, "transport: send failed");
                    Err(derec_library::Error::Invariant("transport: HTTP send failed"))
                }
            }
        })
    }
}

// ── Actor protocol type alias ────────────────────────────────────────────────

pub type ActorProtocol = derec_library::protocol::DeRecProtocol<
    InMemoryChannelStore,
    InMemoryShareStore,
    InMemorySecretStore,
    InMemoryUserSecretStore,
    InMemoryStateStore,
    HttpTransport,
>;
