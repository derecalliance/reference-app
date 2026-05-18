// In-memory implementations of the derec-library store and transport traits.
//
// Each actor protocol instance gets its own set of stores. Concurrency is
// handled by the outer `tokio::sync::Mutex` on the `ActorProtocol`, so
// these stores do not need internal synchronization.

use std::collections::HashMap;

use derec_library::protocol::{
    ChannelStoreFuture, DeRecChannelStore, DeRecSecretStore, DeRecShareStore, DeRecTransport,
    SecretKind, SecretStoreFuture, SecretValue, ShareStoreFuture, TransportFuture,
};
use derec_library::types::{Channel, ChannelId};
use derec_proto::TransportProtocol;

// ── Channel store ───────────────────────────────────────────────────────────

#[derive(Default)]
pub struct InMemoryChannelStore {
    data: HashMap<u64, Channel>,
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

#[derive(Default)]
pub struct InMemoryShareStore {
    /// Primary data: (channel_id, version) → encoded bytes
    data: HashMap<(u64, i32), Vec<u8>>,
}

impl DeRecShareStore for InMemoryShareStore {
    fn load(
        &self,
        channel_id: ChannelId,
        versions: &[i32],
    ) -> ShareStoreFuture<'_, Vec<(i32, Vec<u8>)>> {
        let cid = channel_id.0;
        let result: Vec<(i32, Vec<u8>)> = if versions.is_empty() {
            // All versions for this channel
            self.data
                .iter()
                .filter(|((c, _), _)| *c == cid)
                .map(|((_, v), data)| (*v, data.clone()))
                .collect()
        } else {
            versions
                .iter()
                .filter_map(|v| {
                    self.data.get(&(cid, *v)).map(|data| (*v, data.clone()))
                })
                .collect()
        };
        Box::pin(std::future::ready(Ok(result)))
    }

    fn save(
        &mut self,
        channel_id: ChannelId,
        version: i32,
        encoded: Vec<u8>,
    ) -> ShareStoreFuture<'_, ()> {
        let key = (channel_id.0, version);
        self.data.insert(key, encoded);
        Box::pin(std::future::ready(Ok(())))
    }

    fn latest_version(&self) -> ShareStoreFuture<'_, Option<i32>> {
        let max = self.data.keys().map(|(_, v)| *v).max();
        Box::pin(std::future::ready(Ok(max)))
    }
}

impl InMemoryShareStore {
    /// Copy all share entries from `old_channel_id` to `new_channel_id`.
    /// Does NOT delete old entries — the reference app lets the developer inspect both.
    pub fn associate_channel(&mut self, old_channel_id: u64, new_channel_id: u64) -> usize {
        let entries: Vec<_> = self
            .data
            .iter()
            .filter(|((cid, _), _)| *cid == old_channel_id)
            .map(|((_, ver), val)| ((new_channel_id, *ver), val.clone()))
            .collect();
        let count = entries.len();
        for (key, val) in entries {
            self.data.insert(key, val);
        }
        count
    }

    /// Copy ALL share entries (from any channel) to `new_channel_id`.
    ///
    /// Used during recovery re-pairing when the channel ID under which shares
    /// were originally stored may differ from the channel ID recorded in
    /// `participant_channels` (the two can diverge depending on which party's
    /// contact was used during the initial pairing). Since the reference app
    /// provisions one actor per owner, it is safe to migrate every share held
    /// to the new recovery channel.
    ///
    /// Does NOT delete existing entries and does NOT overwrite entries that are
    /// already present under `new_channel_id`.
    pub fn associate_all_to_channel(&mut self, new_channel_id: u64) -> usize {
        let entries: Vec<_> = self
            .data
            .iter()
            .filter(|((cid, _), _)| *cid != new_channel_id)
            .map(|((_, ver), val)| ((new_channel_id, *ver), val.clone()))
            .collect();
        let count = entries.len();
        for (key, val) in entries {
            self.data.entry(key).or_insert(val);
        }
        count
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

    /// Copy secret entries (SharedKey, PairingSecret) from `old_channel_id` to `new_channel_id`.
    /// Skips entries that already exist on the new channel to avoid overwriting
    /// the recovery pairing's shared key with the old one.
    pub fn associate_channel(&mut self, old_channel_id: u64, new_channel_id: u64) {
        let entries: Vec<_> = self
            .data
            .iter()
            .filter(|((cid, _), _)| *cid == old_channel_id)
            .map(|((_, kind), val)| ((new_channel_id, *kind), clone_secret_value(val)))
            .collect();
        for (key, val) in entries {
            // Do not overwrite — the new channel may already have a shared key
            // from the recovery pairing that must be preserved.
            self.data.entry(key).or_insert(val);
        }
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
