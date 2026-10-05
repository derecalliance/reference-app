// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

// In-memory implementations of the derec-library store traits, kept as the
// **conformance control**.
//
// Nothing in production constructs these any more — every actor runs on the SQL
// stores in `crate::sql`. They stay because `tests/store_conformance.rs` runs
// the conformance suite against them, and a suite that has only ever run
// against the implementation it was written from is not evidence of anything.
// A second, independent implementation is what makes its assertions checkable.
//
// They have already earned it. The `linked_channels` contract documented below
// — the start node is included, so an unlinked channel returns itself — is what
// identified a recovery bug in the SQL store that every unit test and both
// engines' conformance runs had passed.
//
// Every store here is partitioned by `secret_id`. The SQL stores are
// additionally keyed by `actor_id`, because two actors can hold instances bound
// to the same secret and a shared database needs a discriminator these do not:
// see the header of `migrations/0001_initial.sql`.
//
// The protocol holds each store by `&mut Self`, so these implementations never
// see overlapping calls and need no internal synchronization.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use derec_library::protocol::{
    ChannelQuery, ChannelRecord, ChannelStoreFuture, DeRecChannelStore, DeRecSecretStore,
    DeRecShareStore, DeRecStateStore, DeRecUserSecretStore, HelperChannel, MissingPolicy,
    ReplicaMember, SecretKind, SecretStoreError, SecretStoreFuture, SecretValue, Share,
    ShareStoreFuture, StateItem, StateKey, StateKind, StateStoreFuture, UserSecrets,
};
use derec_library::protocol::types::{HelperFilter, ReplicaFilter};
use derec_library::types::ChannelId;

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

    /// The filter is applied while walking the map, so a narrowed listing
    /// never materializes the rows it would discard. An in-memory `HashMap`
    /// has no query language to push it down into, so `ChannelFilter::matches`
    /// is the honest implementation here.
    fn helpers(
        &self,
        secret_id: u64,
        filter: HelperFilter,
    ) -> ChannelStoreFuture<'_, Vec<HelperChannel>> {
        let entries: Vec<HelperChannel> = self
            .helpers
            .iter()
            .filter(|((s, _), _)| *s == secret_id)
            .map(|(_, h)| h)
            .filter(|h| filter.matches(&h.channel_id, h.status, &h.peer_role))
            .cloned()
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
    fn replicas(
        &self,
        secret_id: u64,
        filter: ReplicaFilter,
    ) -> ChannelStoreFuture<'_, Vec<ReplicaMember>> {
        let mut entries: Vec<ReplicaMember> = self
            .members
            .iter()
            .filter(|((s, _), _)| *s == secret_id)
            .map(|(_, r)| r)
            .filter(|r| filter.matches(&r.replica_id, r.status, &r.role))
            .cloned()
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

// The `ActorProtocol` alias used to live here, over these in-memory stores. It
// now lives in `actor.rs` over the SQL ones — it describes what an actor is,
// not how one storage backend is written, and these types are on their way out.

#[cfg(test)]
mod tests {
    use super::*;
    use derec_library::protocol::types::{ChannelStatus, ReplicaRole};
    use derec_library::types::ReplicaId;
    use derec_proto::TransportProtocol;

    fn endpoint(uri: &str) -> Vec<TransportProtocol> {
        vec![TransportProtocol {
            uri: uri.to_owned(),
            protocol: derec_proto::Protocol::Https as i32,
        }]
    }

    fn helper(channel_id: u64, status: ChannelStatus, peer_role: derec_proto::SenderKind) -> HelperChannel {
        HelperChannel {
            channel_id: ChannelId(channel_id),
            transports: endpoint("http://localhost:5000/derec/a"),
            communication_info: Default::default(),
            peer_role,
            status,
            created_at: 0,
        }
    }

    fn member(replica_id: u64, status: ChannelStatus, role: ReplicaRole) -> ReplicaMember {
        ReplicaMember {
            channel_id: ChannelId(900),
            replica_id: ReplicaId(replica_id),
            transports: endpoint("http://localhost:5000/derec/b"),
            communication_info: Default::default(),
            role,
            status,
            created_at: replica_id,
        }
    }

    async fn seeded() -> InMemoryChannelStore {
        let mut store = InMemoryChannelStore::default();
        store
            .save(1, ChannelRecord::Replica(member(11, ChannelStatus::Paired, ReplicaRole::Source)))
            .await
            .expect("in-memory save cannot fail");
        store
            .save(
                1,
                ChannelRecord::Replica(member(22, ChannelStatus::Paired, ReplicaRole::Destination)),
            )
            .await
            .expect("in-memory save cannot fail");
        store
            .save(
                1,
                ChannelRecord::Replica(member(33, ChannelStatus::Pending, ReplicaRole::Destination)),
            )
            .await
            .expect("in-memory save cannot fail");
        store
    }

    fn ids(members: &[ReplicaMember]) -> Vec<u64> {
        members.iter().map(|m| m.replica_id.0).collect()
    }

    // The library narrows a listing with a filter and does *not* re-apply it to
    // the result, so a store that ignored it would hand the protocol rows it
    // asked to be spared.

    #[tokio::test]
    async fn a_default_filter_selects_every_member() {
        let store = seeded().await;

        let members = store.replicas(1, ReplicaFilter::default()).await.expect("readable");
        assert_eq!(ids(&members), vec![11, 22, 33]);
    }

    #[tokio::test]
    async fn ids_restrict_and_exclude_overrides_them() {
        let store = seeded().await;

        let members = store
            .replicas(
                1,
                ReplicaFilter {
                    ids: vec![ReplicaId(11), ReplicaId(22)],
                    exclude: vec![ReplicaId(11)],
                    ..Default::default()
                },
            )
            .await
            .expect("readable");
        assert_eq!(ids(&members), vec![22]);
    }

    #[tokio::test]
    async fn status_and_role_combine_with_and() {
        let store = seeded().await;

        // The publish-target shape: paired destinations only.
        let members = store
            .replicas(
                1,
                ReplicaFilter {
                    status: vec![ChannelStatus::Paired],
                    role: Some(ReplicaRole::Destination),
                    ..Default::default()
                },
            )
            .await
            .expect("readable");
        assert_eq!(ids(&members), vec![22]);
    }

    #[tokio::test]
    async fn filtering_preserves_the_succession_order() {
        let store = seeded().await;

        // Ordered by `(created_at, replica_id)` — this app's succession policy.
        // Dropping entries must not reorder what is left.
        let members = store
            .replicas(1, ReplicaFilter { exclude: vec![ReplicaId(22)], ..Default::default() })
            .await
            .expect("readable");
        assert_eq!(ids(&members), vec![11, 33]);
    }

    #[tokio::test]
    async fn a_helper_filter_addresses_channel_ids_and_the_peer_role() {
        let mut store = InMemoryChannelStore::default();
        store
            .save(
                1,
                ChannelRecord::Helper(helper(100, ChannelStatus::Paired, derec_proto::SenderKind::Owner)),
            )
            .await
            .expect("in-memory save cannot fail");
        store
            .save(
                1,
                ChannelRecord::Helper(helper(
                    101,
                    ChannelStatus::Pending,
                    derec_proto::SenderKind::Helper,
                )),
            )
            .await
            .expect("in-memory save cannot fail");

        let pending = store
            .helpers(
                1,
                HelperFilter { status: vec![ChannelStatus::Pending], ..Default::default() },
            )
            .await
            .expect("readable");
        assert_eq!(
            pending.iter().map(|h| h.channel_id.0).collect::<Vec<_>>(),
            vec![101]
        );

        let owners = store
            .helpers(
                1,
                HelperFilter { role: Some(derec_proto::SenderKind::Owner), ..Default::default() },
            )
            .await
            .expect("readable");
        assert_eq!(
            owners.iter().map(|h| h.channel_id.0).collect::<Vec<_>>(),
            vec![100]
        );
    }

    #[tokio::test]
    async fn a_filter_does_not_reach_across_secrets() {
        let mut store = seeded().await;
        store
            .save(2, ChannelRecord::Replica(member(44, ChannelStatus::Paired, ReplicaRole::Source)))
            .await
            .expect("in-memory save cannot fail");

        let members = store.replicas(2, ReplicaFilter::default()).await.expect("readable");
        assert_eq!(ids(&members), vec![44]);
    }
}
