// In-memory implementations of the derec-library store and transport traits.
//
// Each actor protocol instance gets its own set of stores. Concurrency is
// handled by the outer `tokio::sync::Mutex` on the `ActorProtocol`, so
// these stores do not need internal synchronization.

use std::collections::{HashMap, HashSet, VecDeque};

use derec_library::protocol::{
    ChannelStoreFuture, DeRecChannelStore, DeRecSecretStore, DeRecShareStore,
    DeRecTransport, SecretKind, SecretStoreFuture, SecretValue, Share, ShareStoreFuture,
    TransportFuture,
};
use derec_library::types::{Channel, ChannelId};
use derec_proto::TransportProtocol;

// ── Channel store ───────────────────────────────────────────────────────────

/// Stores paired channels plus the channel-link graph (channels belonging to
/// the same Owner identity, e.g. after a recovery re-pairing). The link graph
/// is a bidirectional adjacency list; `linked_channels` is a BFS over it.
#[derive(Default)]
pub struct InMemoryChannelStore {
    data: HashMap<u64, Channel>,
    links: HashMap<u64, HashSet<u64>>,
}

impl DeRecChannelStore for InMemoryChannelStore {
    fn load(&self, channel_id: ChannelId) -> ChannelStoreFuture<'_, Option<Channel>> {
        let result = self.data.get(&channel_id.0).cloned();
        Box::pin(std::future::ready(Ok(result)))
    }

    fn save(&mut self, channel: Channel) -> ChannelStoreFuture<'_, ()> {
        self.data.insert(channel.id.0, channel);
        Box::pin(std::future::ready(Ok(())))
    }

    fn remove(&mut self, channel_id: ChannelId) -> ChannelStoreFuture<'_, bool> {
        let removed = self.data.remove(&channel_id.0).is_some();
        Box::pin(std::future::ready(Ok(removed)))
    }

    fn channels(&self) -> ChannelStoreFuture<'_, Vec<Channel>> {
        let entries: Vec<Channel> = self.data.values().cloned().collect();
        Box::pin(std::future::ready(Ok(entries)))
    }

    fn link_channel(&mut self, a: ChannelId, b: ChannelId) -> ChannelStoreFuture<'_, ()> {
        let (a, b) = (a.0, b.0);
        if a != b {
            self.links.entry(a).or_default().insert(b);
            self.links.entry(b).or_default().insert(a);
        }
        Box::pin(std::future::ready(Ok(())))
    }

    fn linked_channels(
        &self,
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
            if let Some(neighbors) = self.links.get(&curr) {
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
    data: HashMap<(u64, u8), SecretValue>,
}

impl DeRecSecretStore for InMemorySecretStore {
    fn load(
        &self,
        channel_id: ChannelId,
        kind: SecretKind,
    ) -> SecretStoreFuture<'_, Option<SecretValue>> {
        let result = self.data.get(&(channel_id.0, kind as u8)).map(clone_secret_value);
        Box::pin(std::future::ready(Ok(result)))
    }

    fn save(&mut self, channel_id: ChannelId, value: SecretValue) -> SecretStoreFuture<'_, ()> {
        let kind = match &value {
            SecretValue::SharedKey(_) => SecretKind::SharedKey as u8,
            SecretValue::PairingSecret(_) => SecretKind::PairingSecret as u8,
            SecretValue::PairingContact(_) => SecretKind::PairingContact as u8,
        };
        self.data.insert((channel_id.0, kind), value);
        Box::pin(std::future::ready(Ok(())))
    }

    fn remove(
        &mut self,
        channel_id: ChannelId,
        kind: SecretKind,
    ) -> SecretStoreFuture<'_, ()> {
        self.data.remove(&(channel_id.0, kind as u8));
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

// ── Share store ──────────────────────────────────────────────────────────────

/// Stores shares keyed by `(channel_id, secret_id, version)`. Pure keyed
/// store — channel linking lives in [`InMemoryChannelStore`]; `load_many`
/// is fed the resolved channel set by the recovery handler (and `load_all`
/// by the discovery handler).
#[derive(Default)]
pub struct InMemoryShareStore {
    data: HashMap<(u64, u64, u32), Share>,
}

impl DeRecShareStore for InMemoryShareStore {
    fn load(
        &self,
        channel_id: ChannelId,
        secret_id: u64,
        versions: &[u32],
    ) -> ShareStoreFuture<'_, Vec<Share>> {
        let cid = channel_id.0;
        let result: Vec<Share> = if versions.is_empty() {
            self.data
                .iter()
                .filter(|((c, s, _), _)| *c == cid && *s == secret_id)
                .map(|(_, s)| s.clone())
                .collect()
        } else {
            let version_set: HashSet<u32> = versions.iter().copied().collect();
            self.data
                .iter()
                .filter(|((c, s, v), _)| {
                    *c == cid && *s == secret_id && version_set.contains(v)
                })
                .map(|(_, s)| s.clone())
                .collect()
        };
        Box::pin(std::future::ready(Ok(result)))
    }

    fn load_many(
        &self,
        channel_ids: &[ChannelId],
        secret_id: u64,
        versions: &[u32],
    ) -> ShareStoreFuture<'_, Vec<Share>> {
        let cid_set: HashSet<u64> = channel_ids.iter().map(|c| c.0).collect();
        let result: Vec<Share> = if versions.is_empty() {
            self.data
                .iter()
                .filter(|((c, s, _), _)| cid_set.contains(c) && *s == secret_id)
                .map(|(_, s)| s.clone())
                .collect()
        } else {
            let version_set: HashSet<u32> = versions.iter().copied().collect();
            self.data
                .iter()
                .filter(|((c, s, v), _)| {
                    cid_set.contains(c) && *s == secret_id && version_set.contains(v)
                })
                .map(|(_, s)| s.clone())
                .collect()
        };
        Box::pin(std::future::ready(Ok(result)))
    }

    fn load_all(&self, channel_ids: &[ChannelId]) -> ShareStoreFuture<'_, Vec<Share>> {
        let cid_set: HashSet<u64> = channel_ids.iter().map(|c| c.0).collect();
        let result: Vec<Share> = self
            .data
            .iter()
            .filter(|((c, _, _), _)| cid_set.contains(c))
            .map(|(_, s)| s.clone())
            .collect();
        Box::pin(std::future::ready(Ok(result)))
    }

    fn latest_version(&self) -> ShareStoreFuture<'_, Option<u32>> {
        let max = self.data.keys().map(|(_, _, v)| *v).max();
        Box::pin(std::future::ready(Ok(max)))
    }

    fn save(&mut self, channel_id: ChannelId, share: Share) -> ShareStoreFuture<'_, ()> {
        let key = (channel_id.0, share.secret_id, share.version);
        self.data.insert(key, share);
        Box::pin(std::future::ready(Ok(())))
    }

    /// Drop every share stored under `channel_id` (all secret_ids, all
    /// versions). Idempotent — a non-existent channel is a no-op. Called by
    /// the unpair flow when a channel is being torn down.
    fn remove_channel(&mut self, channel_id: ChannelId) -> ShareStoreFuture<'_, ()> {
        let cid = channel_id.0;
        self.data.retain(|(c, _, _), _| *c != cid);
        Box::pin(std::future::ready(Ok(())))
    }
}

impl InMemorySecretStore {
    /// Load the raw shared key bytes for a channel, if present.
    pub fn load_shared_key(&self, channel_id: u64) -> Option<[u8; 32]> {
        self.data
            .get(&(channel_id, SecretKind::SharedKey as u8))
            .and_then(|v| match v {
                SecretValue::SharedKey(k) => Some(*k),
                _ => None,
            })
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
    HttpTransport,
>;
