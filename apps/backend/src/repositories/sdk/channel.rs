// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! `DeRecChannelStore` over SQL.
//!
//! Helper channels and replica-group members share the `channels` table,
//! discriminated by `kind` and keyed by `entity_id`: a helper by its
//! `channel_id`, a member by its `replica_id` alone. That asymmetry is not an
//! optimisation — a member moves between channels during an admission handover
//! while remaining the same member, so a key requiring both to match would lose
//! the row exactly when that move needs to be observed.
//!
//! The record itself is stored as serialised `ChannelRecord`, which derives
//! serde behind the library's `serde` feature. The library owns that shape and
//! versions it (`CHANNEL_RECORD_SCHEMA_VERSION`), so decomposing it into
//! columns here would be this app inventing a schema the SDK already has.

use derec_library::protocol::types::{HelperFilter, ReplicaFilter};
use derec_library::protocol::{
    ChannelQuery, ChannelRecord, ChannelStoreError, ChannelStoreFuture, DeRecChannelStore,
    HelperChannel, ReplicaMember,
};
use derec_library::types::ChannelId;

use super::{id_to_text, text_to_id};

/// Boxes any error into the `Backend` variant the trait expects.
fn backend<E: std::error::Error + Send + Sync + 'static>(e: E) -> ChannelStoreError {
    ChannelStoreError::Backend(Box::new(e))
}

const KIND_HELPER: &str = "helper";
const KIND_REPLICA: &str = "replica";

pub struct SqlChannelStore {
    pool: sqlx::AnyPool,
    /// Which actor's instance this store belongs to. See the migration's
    /// header: (actor_id, secret_id) identifies an instance, because two
    /// actors can hold instances bound to the same secret.
    actor_id: String,
}

impl SqlChannelStore {
    pub fn new(pool: sqlx::AnyPool, actor_id: impl Into<String>) -> Self {
        Self {
            pool,
            actor_id: actor_id.into(),
        }
    }
}

/// The `(kind, entity_id, channel_id)` a record is keyed and filed under.
fn key_of(record: &ChannelRecord) -> (&'static str, String, String) {
    match record {
        ChannelRecord::Helper(h) => (
            KIND_HELPER,
            id_to_text(h.channel_id.0),
            id_to_text(h.channel_id.0),
        ),
        ChannelRecord::Replica(m) => (
            KIND_REPLICA,
            id_to_text(m.replica_id.0),
            id_to_text(m.channel_id.0),
        ),
    }
}

/// The `(kind, entity_id)` a query selects.
fn key_of_query(query: &ChannelQuery) -> (&'static str, String) {
    match query {
        ChannelQuery::Helper { channel_id } => (KIND_HELPER, id_to_text(channel_id.0)),
        // Keyed by `replica_id` alone — `channel_id` is context, not key.
        ChannelQuery::Replica { replica_id, .. } => (KIND_REPLICA, id_to_text(replica_id.0)),
    }
}

impl DeRecChannelStore for SqlChannelStore {
    fn load(
        &self,
        secret_id: u64,
        query: ChannelQuery,
    ) -> ChannelStoreFuture<'_, Option<ChannelRecord>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let (kind, entity) = key_of_query(&query);
        let actor = self.actor_id.clone();

        Box::pin(async move {
            let row: Option<(String,)> = sqlx::query_as(
                "SELECT record FROM channels \
                 WHERE secret_id = $1 AND kind = $2 AND entity_id = $3 AND actor_id = $4",
            )
            .bind(secret)
            .bind(kind)
            .bind(entity)
            .bind(actor)
            .fetch_optional(&pool)
            .await
            .map_err(backend)?;

            match row {
                Some((json,)) => {
                    let record: ChannelRecord = serde_json::from_str(&json).map_err(backend)?;
                    Ok(Some(record))
                }
                None => Ok(None),
            }
        })
    }

    fn save(&mut self, secret_id: u64, record: ChannelRecord) -> ChannelStoreFuture<'_, ()> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let (kind, entity, channel) = key_of(&record);
        let actor = self.actor_id.clone();

        Box::pin(async move {
            let json = serde_json::to_string(&record).map_err(backend)?;

            // Delete-then-insert rather than an upsert: it is the one shape
            // both engines accept unmodified, and it matches the in-memory
            // store's `HashMap::insert` — replace in place, never duplicate.
            let mut tx = crate::repositories::begin_write(&pool)
                .await
                .map_err(backend)?;

            sqlx::query(
                "DELETE FROM channels \
                 WHERE secret_id = $1 AND kind = $2 AND entity_id = $3 AND actor_id = $4",
            )
            .bind(&secret)
            .bind(kind)
            .bind(&entity)
            .bind(&actor)
            .execute(&mut *tx)
            .await
            .map_err(backend)?;

            sqlx::query(
                "INSERT INTO channels (secret_id, kind, entity_id, channel_id, record, actor_id) \
                 VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(&secret)
            .bind(kind)
            .bind(&entity)
            .bind(&channel)
            .bind(&json)
            .bind(&actor)
            .execute(&mut *tx)
            .await
            .map_err(backend)?;

            tx.commit().await.map_err(backend)?;
            Ok(())
        })
    }

    fn remove(&mut self, secret_id: u64, query: ChannelQuery) -> ChannelStoreFuture<'_, bool> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let (kind, entity) = key_of_query(&query);
        let actor = self.actor_id.clone();

        Box::pin(async move {
            let result = sqlx::query(
                "DELETE FROM channels \
                 WHERE secret_id = $1 AND kind = $2 AND entity_id = $3 AND actor_id = $4",
            )
            .bind(secret)
            .bind(kind)
            .bind(entity)
            .bind(actor)
            .execute(&pool)
            .await
            .map_err(backend)?;

            // The trait reports whether anything was removed, which the
            // protocol uses to distinguish a teardown from a no-op.
            Ok(result.rows_affected() > 0)
        })
    }

    fn helpers(
        &self,
        secret_id: u64,
        filter: HelperFilter,
    ) -> ChannelStoreFuture<'_, Vec<HelperChannel>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let actor = self.actor_id.clone();

        Box::pin(async move {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT record FROM channels \
                 WHERE secret_id = $1 AND kind = $2 AND actor_id = $3",
            )
            .bind(secret)
            .bind(KIND_HELPER)
            .bind(actor)
            .fetch_all(&pool)
            .await
            .map_err(backend)?;

            let mut out = Vec::with_capacity(rows.len());
            for (json,) in rows {
                match serde_json::from_str::<ChannelRecord>(&json).map_err(backend)? {
                    ChannelRecord::Helper(h) => out.push(h),
                    // A replica record filed under kind 'helper' is a bug in
                    // this store, not data to skip quietly.
                    ChannelRecord::Replica(_) => {
                        return Err(ChannelStoreError::Backend(
                            "replica record stored under kind 'helper'".into(),
                        ));
                    }
                }
            }

            // The library narrows a listing with a filter and does *not*
            // re-apply it to the result, so a store that ignored it would hand
            // the protocol rows it asked to be spared.
            out.retain(|h| filter.matches(&h.channel_id, h.status, &h.peer_role));
            Ok(out)
        })
    }

    fn replicas(
        &self,
        secret_id: u64,
        filter: ReplicaFilter,
    ) -> ChannelStoreFuture<'_, Vec<ReplicaMember>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let actor = self.actor_id.clone();

        Box::pin(async move {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT record FROM channels \
                 WHERE secret_id = $1 AND kind = $2 AND actor_id = $3",
            )
            .bind(secret)
            .bind(KIND_REPLICA)
            .bind(actor)
            .fetch_all(&pool)
            .await
            .map_err(backend)?;

            let mut out = Vec::with_capacity(rows.len());
            for (json,) in rows {
                match serde_json::from_str::<ChannelRecord>(&json).map_err(backend)? {
                    ChannelRecord::Replica(m) => out.push(m),
                    ChannelRecord::Helper(_) => {
                        return Err(ChannelStoreError::Backend(
                            "helper record stored under kind 'replica'".into(),
                        ));
                    }
                }
            }

            // Sorted numerically, not by the TEXT key: '9' sorts after '10' as
            // text but before it as a number, and the in-memory store uses a
            // `BTreeMap<u64>` precisely so a successor choice is reproducible
            // between runs. An unordered scan would reintroduce the variance
            // that was chosen away.
            out.sort_by_key(|m| m.replica_id.0);

            out.retain(|m| filter.matches(&m.replica_id, m.status, &m.role));
            Ok(out)
        })
    }

    fn link_channel(
        &mut self,
        secret_id: u64,
        a: ChannelId,
        b: ChannelId,
    ) -> ChannelStoreFuture<'_, ()> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let (a, b) = (id_to_text(a.0), id_to_text(b.0));
        let actor = self.actor_id.clone();

        Box::pin(async move {
            // Both directions, so `linked_channels` can start from either end.
            let mut tx = crate::repositories::begin_write(&pool)
                .await
                .map_err(backend)?;

            for (from, to) in [(&a, &b), (&b, &a)] {
                sqlx::query(
                    "DELETE FROM channel_links \
                     WHERE secret_id = $1 AND channel_id = $2 AND linked_id = $3 \
                     AND actor_id = $4",
                )
                .bind(&secret)
                .bind(from)
                .bind(to)
                .bind(&actor)
                .execute(&mut *tx)
                .await
                .map_err(backend)?;

                sqlx::query(
                    "INSERT INTO channel_links (secret_id, channel_id, linked_id, actor_id) \
                     VALUES ($1, $2, $3, $4)",
                )
                .bind(&secret)
                .bind(from)
                .bind(to)
                .bind(&actor)
                .execute(&mut *tx)
                .await
                .map_err(backend)?;
            }

            tx.commit().await.map_err(backend)?;
            Ok(())
        })
    }

    fn linked_channels(
        &self,
        secret_id: u64,
        channel_id: ChannelId,
    ) -> ChannelStoreFuture<'_, Vec<ChannelId>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let start = id_to_text(channel_id.0);
        let actor = self.actor_id.clone();

        Box::pin(async move {
            // A BFS over the link graph, matching the in-memory store: links
            // are transitive, so a channel linked to one that is linked to a
            // third reaches all of them. Done here rather than in SQL because a
            // recursive CTE is not portable across both engines in one
            // spelling.
            // The start node is part of the result, so an unlinked channel
            // returns just itself rather than nothing. Callers use this as the
            // channel set to read shares over — a helper answering a recovery
            // request asks for the linked set and looks for shares across it —
            // so returning an empty list for an unlinked channel makes it
            // report that it holds nothing at all.
            let mut seen = std::collections::HashSet::new();
            let mut queue = std::collections::VecDeque::new();
            let mut out = vec![text_to_id(&start).map_err(backend)?];

            seen.insert(start.clone());
            queue.push_back(start);

            while let Some(current) = queue.pop_front() {
                let rows: Vec<(String,)> = sqlx::query_as(
                    "SELECT linked_id FROM channel_links \
                     WHERE secret_id = $1 AND channel_id = $2 AND actor_id = $3",
                )
                .bind(&secret)
                .bind(&current)
                .bind(&actor)
                .fetch_all(&pool)
                .await
                .map_err(backend)?;

                for (linked,) in rows {
                    if seen.insert(linked.clone()) {
                        out.push(text_to_id(&linked).map_err(backend)?);
                        queue.push_back(linked);
                    }
                }
            }

            out.sort_unstable();
            Ok(out.into_iter().map(ChannelId).collect())
        })
    }
}
