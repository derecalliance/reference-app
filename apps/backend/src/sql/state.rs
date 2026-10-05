// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! `DeRecStateStore` over SQL.
//!
//! `StateItem` has no serde of its own, so it round-trips through the SDK's
//! `StateItemRecord` — the same route the library's own WASM store adapter
//! takes (`interop/wasm/protocol/stores.rs:1020`), which is what makes this the
//! endorsed path rather than a workaround. The key is the serialised
//! `StateKeyRecord`; `kind` is denormalised beside it so `load_all` can filter
//! without deserialising every row.

use derec_library::protocol::types::{StateItemRecord, StateKeyRecord};
use derec_library::protocol::{
    DeRecStateStore, StateItem, StateKey, StateKind, StateStoreError, StateStoreFuture,
};

use super::id_to_text;

fn backend<E: std::error::Error + Send + Sync + 'static>(e: E) -> StateStoreError {
    StateStoreError::Backend(Box::new(e))
}

/// A message-only backend error, for the SDK conversions that report a `String`.
fn backend_msg(message: String) -> StateStoreError {
    StateStoreError::Backend(message.into())
}

/// The `state_key` column value for a key.
fn key_text(key: &StateKey) -> Result<String, StateStoreError> {
    serde_json::to_string(&StateKeyRecord::from(key)).map_err(backend)
}

/// The `kind` column value. Written out rather than a discriminant so a
/// developer reading rows with `sqlite3` can tell what they are looking at.
///
/// Exhaustive on purpose, with no catch-all arm: if the SDK adds a variant,
/// this must fail to compile rather than file the new kind under a wrong
/// string and make `load_all` silently return the wrong set.
fn kind_text(kind: StateKind) -> &'static str {
    match kind {
        StateKind::PendingVerification => "pending_verification",
        StateKind::PendingRecovery => "pending_recovery",
        StateKind::PendingUnpair => "pending_unpair",
        StateKind::SharingRound => "sharing_round",
        StateKind::PendingReplicaDiscovery => "pending_replica_discovery",
    }
}

pub struct SqlStateStore {
    pool: sqlx::AnyPool,
    /// Which actor's instance this store belongs to. See the migration's
    /// header: (actor_id, secret_id) identifies an instance, because two
    /// actors can hold instances bound to the same secret.
    actor_id: String,
}

impl SqlStateStore {
    pub fn new(pool: sqlx::AnyPool, actor_id: impl Into<String>) -> Self {
        Self {
            pool,
            actor_id: actor_id.into(),
        }
    }
}

impl DeRecStateStore for SqlStateStore {
    fn save(&mut self, secret_id: u64, item: StateItem) -> StateStoreFuture<'_, ()> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let actor = self.actor_id.clone();

        Box::pin(async move {
            // The key comes from the item, never from an argument.
            let key = item.key();
            let key_col = key_text(&key)?;
            let kind_col = kind_text(key.kind());
            let payload = serde_json::to_string(&StateItemRecord::from(&item)).map_err(backend)?;

            let mut tx = crate::db::begin_write(&pool).await.map_err(backend)?;

            sqlx::query(
                "DELETE FROM state_items \
                 WHERE secret_id = $1 AND state_key = $2 AND actor_id = $3",
            )
            .bind(&secret)
            .bind(&key_col)
            .bind(&actor)
            .execute(&mut *tx)
                .await
                .map_err(backend)?;

            sqlx::query(
                "INSERT INTO state_items (secret_id, state_key, kind, item, actor_id) \
                 VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(&secret)
            .bind(&key_col)
            .bind(kind_col)
            .bind(&payload)
            .bind(&actor)
            .execute(&mut *tx)
            .await
            .map_err(backend)?;

            tx.commit().await.map_err(backend)?;
            Ok(())
        })
    }

    fn load(&self, secret_id: u64, key: StateKey) -> StateStoreFuture<'_, Option<StateItem>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let actor = self.actor_id.clone();

        Box::pin(async move {
            let key_col = key_text(&key)?;

            let row: Option<(String,)> = sqlx::query_as(
                "SELECT item FROM state_items \
                 WHERE secret_id = $1 AND state_key = $2 AND actor_id = $3",
            )
            .bind(secret)
            .bind(key_col)
            .bind(actor)
            .fetch_optional(&pool)
            .await
            .map_err(backend)?;

            match row {
                Some((json,)) => {
                    let record: StateItemRecord = serde_json::from_str(&json).map_err(backend)?;
                    Ok(Some(record.into_item().map_err(backend_msg)?))
                }
                None => Ok(None),
            }
        })
    }

    fn remove(&mut self, secret_id: u64, key: StateKey) -> StateStoreFuture<'_, bool> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let actor = self.actor_id.clone();

        Box::pin(async move {
            let key_col = key_text(&key)?;

            let result = sqlx::query(
                "DELETE FROM state_items \
                 WHERE secret_id = $1 AND state_key = $2 AND actor_id = $3",
            )
            .bind(secret)
            .bind(key_col)
            .bind(actor)
            .execute(&pool)
                    .await
                    .map_err(backend)?;

            Ok(result.rows_affected() > 0)
        })
    }

    fn load_all(&self, secret_id: u64, kind: StateKind) -> StateStoreFuture<'_, Vec<StateItem>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let kind_col = kind_text(kind);
        let actor = self.actor_id.clone();

        Box::pin(async move {
            let rows: Vec<(String,)> =
                sqlx::query_as(
                    "SELECT item FROM state_items \
                     WHERE secret_id = $1 AND kind = $2 AND actor_id = $3",
                )
                    .bind(secret)
                    .bind(kind_col)
                    .bind(actor)
                    .fetch_all(&pool)
                    .await
                    .map_err(backend)?;

            let mut out = Vec::with_capacity(rows.len());
            for (json,) in rows {
                let record: StateItemRecord = serde_json::from_str(&json).map_err(backend)?;
                out.push(record.into_item().map_err(backend_msg)?);
            }
            Ok(out)
        })
    }
}
