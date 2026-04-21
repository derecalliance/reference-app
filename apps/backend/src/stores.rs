// In-memory implementations of the derec-library store and transport traits.
//
// Each helper protocol instance gets its own set of stores. Concurrency is
// handled by the outer `tokio::sync::Mutex` on the `HelperProtocol`, so
// these stores do not need internal synchronization.

use std::collections::HashMap;

use derec_library::protocol::{
    ContactStoreFuture, DeRecContactStore, DeRecSecretStore, DeRecShareStore, DeRecTransport,
    SecretKind, SecretStoreFuture, SecretValue, ShareStoreFuture, TransportFuture,
};
use derec_library::types::ChannelId;
use derec_proto::{ContactMessage, TransportProtocol};

// ── Contact store ────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct InMemoryContactStore {
    data: HashMap<u64, ContactMessage>,
}

impl DeRecContactStore for InMemoryContactStore {
    fn load(&self, channel_id: ChannelId) -> ContactStoreFuture<'_, Option<ContactMessage>> {
        let result = self.data.get(&channel_id.0).cloned();
        Box::pin(std::future::ready(Ok(result)))
    }

    fn save(
        &mut self,
        channel_id: ChannelId,
        contact: ContactMessage,
    ) -> ContactStoreFuture<'_, ()> {
        self.data.insert(channel_id.0, contact);
        Box::pin(std::future::ready(Ok(())))
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
    }
}

// ── Share store ──────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct InMemoryShareStore {
    /// Primary data: (channel_id, secret_id_hex, version) → encoded bytes
    data: HashMap<(u64, Vec<u8>, i32), Vec<u8>>,
}

impl DeRecShareStore for InMemoryShareStore {
    fn load(
        &self,
        channel_id: ChannelId,
        secret_id: &[u8],
        version: i32,
    ) -> ShareStoreFuture<'_, Option<Vec<u8>>> {
        let key = (channel_id.0, secret_id.to_vec(), version);
        let result = self.data.get(&key).cloned();
        Box::pin(std::future::ready(Ok(result)))
    }

    fn save(
        &mut self,
        channel_id: ChannelId,
        secret_id: &[u8],
        version: i32,
        encoded: Vec<u8>,
    ) -> ShareStoreFuture<'_, ()> {
        let key = (channel_id.0, secret_id.to_vec(), version);
        self.data.insert(key, encoded);
        Box::pin(std::future::ready(Ok(())))
    }

    fn load_channels_for_secret(
        &self,
        secret_id: &[u8],
        version: i32,
    ) -> ShareStoreFuture<'_, Vec<ChannelId>> {
        let sid = secret_id.to_vec();
        let channels: Vec<ChannelId> = self
            .data
            .keys()
            .filter(|(_, s, v)| *s == sid && *v == version)
            .map(|(c, _, _)| ChannelId(*c))
            .collect();
        Box::pin(std::future::ready(Ok(channels)))
    }

    fn load_secrets_for_channel(
        &self,
        channel_id: ChannelId,
    ) -> ShareStoreFuture<'_, Vec<(Vec<u8>, Vec<i32>)>> {
        let cid = channel_id.0;
        let mut grouped: HashMap<Vec<u8>, Vec<i32>> = HashMap::new();
        for (c, sid, v) in self.data.keys() {
            if *c == cid {
                grouped.entry(sid.clone()).or_default().push(*v);
            }
        }
        let result: Vec<(Vec<u8>, Vec<i32>)> = grouped.into_iter().collect();
        Box::pin(std::future::ready(Ok(result)))
    }
}

impl InMemoryShareStore {
    /// Copy all share entries from `old_channel_id` to `new_channel_id`.
    /// Does NOT delete old entries — the reference app lets the developer inspect both.
    pub fn associate_channel(&mut self, old_channel_id: u64, new_channel_id: u64) -> usize {
        let entries: Vec<_> = self
            .data
            .iter()
            .filter(|((cid, _, _), _)| *cid == old_channel_id)
            .map(|((_, sid, ver), val)| ((new_channel_id, sid.clone(), *ver), val.clone()))
            .collect();
        let count = entries.len();
        for (key, val) in entries {
            self.data.insert(key, val);
        }
        count
    }
}

impl InMemorySecretStore {
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

// ── Helper protocol type alias ───────────────────────────────────────────────

pub type HelperProtocol = derec_library::protocol::DeRecProtocol<
    InMemoryContactStore,
    InMemoryShareStore,
    InMemorySecretStore,
    HttpTransport,
>;
