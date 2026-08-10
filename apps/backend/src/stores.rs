// In-memory implementations of the derec-library store and transport traits.
//
// Every store is partitioned by `secret_id`: a single backend instance can
// serve many secrets on the same device (Owner of one secret, Helper for N
// other Owners). The protocol holds each store by `&mut Self`, so these
// implementations never see overlapping calls and need no internal
// synchronization.

use std::collections::{HashMap, HashSet, VecDeque};

use derec_library::protocol::{
    Channel, ChannelStoreFuture, DeRecChannelStore, DeRecSecretStore, DeRecShareStore,
    DeRecStateStore, DeRecTransport, DeRecUserSecretStore, MissingPolicy, SecretKind,
    SecretStoreError, SecretStoreFuture, SecretValue, Share, ShareStoreFuture, StateItem,
    StateKey, StateKind, StateStoreFuture, TransportFuture, UserSecrets,
};
use derec_library::types::ChannelId;
use derec_proto::TransportProtocol;

// ── Channel store ───────────────────────────────────────────────────────────

/// Stores paired channels plus the channel-link graph (channels belonging to
/// the same Owner identity, e.g. after a recovery re-pairing). The link graph
/// is a bidirectional adjacency list; `linked_channels` is a BFS over it.
///
/// Both maps are keyed by `(secret_id, channel_id)` so links never leak
/// across secrets.
#[derive(Default)]
pub struct InMemoryChannelStore {
    data: HashMap<(u64, u64), Channel>,
    links: HashMap<(u64, u64), HashSet<u64>>,
}

impl DeRecChannelStore for InMemoryChannelStore {
    fn load(&self, secret_id: u64, channel_id: ChannelId) -> ChannelStoreFuture<'_, Option<Channel>> {
        let result = self.data.get(&(secret_id, channel_id.0)).cloned();
        Box::pin(std::future::ready(Ok(result)))
    }

    fn save(&mut self, secret_id: u64, channel: Channel) -> ChannelStoreFuture<'_, ()> {
        self.data.insert((secret_id, channel.id.0), channel);
        Box::pin(std::future::ready(Ok(())))
    }

    fn remove(&mut self, secret_id: u64, channel_id: ChannelId) -> ChannelStoreFuture<'_, bool> {
        let removed = self.data.remove(&(secret_id, channel_id.0)).is_some();
        Box::pin(std::future::ready(Ok(removed)))
    }

    fn channels(&self, secret_id: u64) -> ChannelStoreFuture<'_, Vec<Channel>> {
        let entries: Vec<Channel> = self
            .data
            .iter()
            .filter(|((s, _), _)| *s == secret_id)
            .map(|(_, c)| c.clone())
            .collect();
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

/// Stores shares keyed by `(secret_id, channel_id, version, replica_id)`.
///
/// `replica_id` is part of the key by contract: two distinct replicas may
/// write the same `(secret_id, channel_id, version)` independently, and a
/// store that ignored the discriminator would silently drop one of them.
///
/// Pure keyed store — channel linking lives in [`InMemoryChannelStore`];
/// `load_many` is fed the resolved channel set by the recovery handler (and
/// `load_all` by the discovery handler).
#[derive(Default)]
pub struct InMemoryShareStore {
    data: HashMap<(u64, u64, u32, Option<u64>), Share>,
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
            .filter(|((s, c, v, _), _)| {
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
            .filter(|((s, c, v, _), _)| {
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
            .filter(|((s, c, _, _), _)| *s == secret_id && cid_set.contains(c))
            .map(|(_, share)| share.clone())
            .collect();
        Box::pin(std::future::ready(Ok(result)))
    }

    fn latest_version(&self, secret_id: u64) -> ShareStoreFuture<'_, Option<u32>> {
        let max = self
            .data
            .keys()
            .filter(|(s, _, _, _)| *s == secret_id)
            .map(|(_, _, v, _)| *v)
            .max();
        Box::pin(std::future::ready(Ok(max)))
    }

    fn save(
        &mut self,
        secret_id: u64,
        channel_id: ChannelId,
        share: Share,
    ) -> ShareStoreFuture<'_, ()> {
        let key = (secret_id, channel_id.0, share.version, share.replica_id);
        self.data.insert(key, share);
        Box::pin(std::future::ready(Ok(())))
    }

    /// Drop every share stored under `(secret_id, channel_id)` — all versions,
    /// all replicas. Idempotent; called by the unpair flow on teardown.
    fn remove_channel(
        &mut self,
        secret_id: u64,
        channel_id: ChannelId,
    ) -> ShareStoreFuture<'_, ()> {
        self.data
            .retain(|(s, c, _, _), _| !(*s == secret_id && *c == channel_id.0));
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
