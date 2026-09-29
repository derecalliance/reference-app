//! `DeRecShareStore` over SQL.
//!
//! `bytes` is base64 `TEXT` rather than a blob type, which neither engine
//! spells the same way. `version` is bound as `i64` because `AnyPool` has no
//! `u32` binding, and converted back on read.
//!
//! Keyed by `(secret_id, channel_id, version)`. There is deliberately no
//! replica column: `save` takes no replica, so a column for one could never be
//! populated.

use derec_library::protocol::{DeRecShareStore, Share, ShareStoreError, ShareStoreFuture};
use derec_library::types::ChannelId;

use super::{from_base64, id_to_text, to_base64};

fn backend<E: std::error::Error + Send + Sync + 'static>(e: E) -> ShareStoreError {
    ShareStoreError::Backend(Box::new(e))
}

/// Render a list of ids as a SQL `IN` list.
///
/// Built rather than bound: `AnyPool` has no array binding. Every value is an
/// id this process encoded from a `u64`, so it is digits — never operator
/// input.
fn in_list(ids: &[String]) -> String {
    ids.iter()
        .map(|id| format!("'{id}'"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Turn `(version, share_secret_id, bytes)` rows into `Share`s.
///
/// `share_secret_id` is read back rather than reconstructed from the partition
/// argument: a `Share` is self-describing and its `secret_id` is the secret the
/// share belongs to, which on a helper is the owner's, not the partition's.
fn to_shares(rows: Vec<(i64, String, String)>) -> Result<Vec<Share>, ShareStoreError> {
    rows.into_iter()
        .map(|(version, share_secret, encoded)| {
            Ok(Share {
                secret_id: super::text_to_id(&share_secret).map_err(backend)?,
                // Stored from a u32 and never written any other way, so a
                // value outside u32 means the row was written by something
                // else — an error rather than a truncating cast.
                version: u32::try_from(version).map_err(backend)?,
                bytes: from_base64(&encoded).map_err(backend)?,
            })
        })
        .collect()
}

pub struct SqlShareStore {
    pool: sqlx::AnyPool,
    /// Which actor's instance this store belongs to. See the migration's
    /// header: (actor_id, secret_id) identifies an instance, because two
    /// actors can hold instances bound to the same secret.
    actor_id: String,
}

impl SqlShareStore {
    pub fn new(pool: sqlx::AnyPool, actor_id: impl Into<String>) -> Self {
        Self {
            pool,
            actor_id: actor_id.into(),
        }
    }
}

impl DeRecShareStore for SqlShareStore {
    fn load(
        &self,
        secret_id: u64,
        channel_id: ChannelId,
        versions: &[u32],
    ) -> ShareStoreFuture<'_, Vec<Share>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let channel = id_to_text(channel_id.0);
        let actor = self.actor_id.clone();
        // Copied out of the borrowed slice: the future outlives the call.
        let versions: Vec<i64> = versions.iter().map(|v| i64::from(*v)).collect();

        Box::pin(async move {
            // An empty filter means "every version", matching the in-memory
            // store — not "no versions", which an `IN ()` would mean.
            let rows: Vec<(i64, String, String)> = if versions.is_empty() {
                sqlx::query_as(
                    "SELECT version, share_secret_id, bytes FROM shares \
                     WHERE secret_id = $1 AND channel_id = $2 AND actor_id = $3",
                )
                .bind(&secret)
                .bind(&channel)
                .bind(&actor)
                .fetch_all(&pool)
                .await
                .map_err(backend)?
            } else {
                let list = versions
                    .iter()
                    .map(|v| v.to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                sqlx::query_as(&format!(
                    "SELECT version, share_secret_id, bytes FROM shares \
                     WHERE secret_id = $1 AND channel_id = $2 AND actor_id = $3 \
                     AND version IN ({list})"
                ))
                .bind(&secret)
                .bind(&channel)
                .bind(&actor)
                .fetch_all(&pool)
                .await
                .map_err(backend)?
            };

            to_shares(rows)
        })
    }

    fn load_many(
        &self,
        secret_id: u64,
        channel_ids: &[ChannelId],
        versions: &[u32],
    ) -> ShareStoreFuture<'_, Vec<Share>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let channels: Vec<String> = channel_ids.iter().map(|c| id_to_text(c.0)).collect();
        let versions: Vec<i64> = versions.iter().map(|v| i64::from(*v)).collect();
        let actor = self.actor_id.clone();

        Box::pin(async move {
            // No channels means no rows — unlike an empty *version* list,
            // which means "every version". The asymmetry matches the in-memory
            // store: it intersects with the channel set, and the empty set
            // intersects to nothing.
            if channels.is_empty() {
                return Ok(Vec::new());
            }

            let channel_list = in_list(&channels);
            let sql = if versions.is_empty() {
                format!(
                    "SELECT version, share_secret_id, bytes FROM shares \
                     WHERE secret_id = $1 AND actor_id = $2 \
                     AND channel_id IN ({channel_list})"
                )
            } else {
                let version_list = versions
                    .iter()
                    .map(|v| v.to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(
                    "SELECT version, share_secret_id, bytes FROM shares \
                     WHERE secret_id = $1 AND actor_id = $2 \
                     AND channel_id IN ({channel_list}) \
                     AND version IN ({version_list})"
                )
            };

            let rows: Vec<(i64, String, String)> = sqlx::query_as(&sql)
                .bind(&secret)
                .bind(&actor)
                .fetch_all(&pool)
                .await
                .map_err(backend)?;

            to_shares(rows)
        })
    }

    fn load_all(
        &self,
        secret_id: u64,
        channel_ids: &[ChannelId],
    ) -> ShareStoreFuture<'_, Vec<Share>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let channels: Vec<String> = channel_ids.iter().map(|c| id_to_text(c.0)).collect();
        let actor = self.actor_id.clone();

        Box::pin(async move {
            if channels.is_empty() {
                return Ok(Vec::new());
            }

            let channel_list = in_list(&channels);
            let rows: Vec<(i64, String, String)> = sqlx::query_as(&format!(
                "SELECT version, share_secret_id, bytes FROM shares \
                 WHERE secret_id = $1 AND actor_id = $2 \
                 AND channel_id IN ({channel_list})"
            ))
            .bind(&secret)
            .bind(&actor)
            .fetch_all(&pool)
            .await
            .map_err(backend)?;

            to_shares(rows)
        })
    }

    fn latest_version(&self, secret_id: u64) -> ShareStoreFuture<'_, Option<u32>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let actor = self.actor_id.clone();

        Box::pin(async move {
            // MAX over no rows is NULL on both engines, which arrives as None.
            let row: Option<(Option<i64>,)> =
                sqlx::query_as(
                    "SELECT MAX(version) FROM shares WHERE secret_id = $1 AND actor_id = $2",
                )
                    .bind(secret)
                    .bind(actor)
                    .fetch_optional(&pool)
                    .await
                    .map_err(backend)?;

            match row.and_then(|(max,)| max) {
                Some(v) => Ok(Some(u32::try_from(v).map_err(backend)?)),
                None => Ok(None),
            }
        })
    }

    fn save(
        &mut self,
        secret_id: u64,
        channel_id: ChannelId,
        share: Share,
    ) -> ShareStoreFuture<'_, ()> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let channel = id_to_text(channel_id.0);
        let version = i64::from(share.version);
        let bytes = to_base64(&share.bytes);
        let actor = self.actor_id.clone();
        // The share's own secret, which is not necessarily the partition.
        let share_secret = id_to_text(share.secret_id);

        Box::pin(async move {
            let mut tx = pool.begin().await.map_err(backend)?;

            sqlx::query(
                "DELETE FROM shares \
                 WHERE secret_id = $1 AND channel_id = $2 AND version = $3 AND actor_id = $4",
            )
            .bind(&secret)
            .bind(&channel)
            .bind(version)
            .bind(&actor)
            .execute(&mut *tx)
            .await
            .map_err(backend)?;

            sqlx::query(
                "INSERT INTO shares \
                 (secret_id, channel_id, version, bytes, actor_id, share_secret_id) \
                 VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(&secret)
            .bind(&channel)
            .bind(version)
            .bind(&bytes)
            .bind(&actor)
            .bind(&share_secret)
            .execute(&mut *tx)
            .await
            .map_err(backend)?;

            tx.commit().await.map_err(backend)?;
            Ok(())
        })
    }

    fn remove_channel(
        &mut self,
        secret_id: u64,
        channel_id: ChannelId,
    ) -> ShareStoreFuture<'_, ()> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let channel = id_to_text(channel_id.0);
        let actor = self.actor_id.clone();

        Box::pin(async move {
            // Every version for the channel. Idempotent; the unpair flow calls
            // it on teardown.
            sqlx::query(
                "DELETE FROM shares WHERE secret_id = $1 AND channel_id = $2 AND actor_id = $3",
            )
                .bind(secret)
                .bind(channel)
                .bind(actor)
                .execute(&pool)
                .await
                .map_err(backend)?;
            Ok(())
        })
    }
}
