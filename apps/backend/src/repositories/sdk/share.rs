// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! `DeRecShareStore` over SQL.
//!
//! `bytes` is base64 `TEXT` rather than a blob type, which neither engine
//! spells the same way. `version` is bound as `i64` because `AnyPool` has no
//! `u32` binding, and converted back on read.
//!
//! Keyed by `(secret_id, channel_id, version)`. There is deliberately no
//! replica column: `save` takes no replica, so a column for one could never be
//! populated.

use std::collections::BTreeMap;

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

/// Render versions as a SQL `IN` list.
///
/// Built rather than bound for the same reason as [`in_list`]; every value is
/// an integer, so the text is digits and separators only.
fn version_list(versions: &[i64]) -> String {
    versions
        .iter()
        .map(|v| v.to_string())
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

/// The versions helpers keep when `version` is distributed, given how this
/// instance's earlier rounds ended (`version -> committed`).
///
/// The SDK numbers a round one above the latest snapshot it holds, so the
/// latest version that can have committed is `version - 1`. Walking down from
/// there finds the latest committed version:
///
/// - a round this instance saw commit ends the walk, and every committed
///   version is listed — no cap is applied, so only abandoned rounds leave the
///   helpers;
/// - a round this instance saw fall short is skipped, since it cannot be the
///   latest committed version;
/// - a version with no recorded outcome is either still in flight here, or
///   was not distributed here at all — another replica member published it,
///   or recovery restored it. Either way it could still be (or become) the
///   latest version, and the SDK's rule (0.0.7) is to list every version that
///   could, so the answer is `None`, which keeps everything. An open round
///   *below* a committed one needs no listing: it can no longer become the
///   latest.
///
/// Nothing recorded at all is also `None`: there is nothing known to keep, and
/// an empty list would tell helpers to drop whatever they hold.
fn keep_list_from_rounds(version: u32, rounds: &BTreeMap<u32, bool>) -> Option<Vec<u32>> {
    for candidate in (1..version).rev() {
        match rounds.get(&candidate) {
            Some(true) => {
                return Some(
                    rounds
                        .range(..version)
                        .filter(|(_, committed)| **committed)
                        .map(|(v, _)| *v)
                        .collect(),
                );
            }
            Some(false) => continue,
            None => return None,
        }
    }
    None
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
                let list = version_list(&versions);
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
                let version_list = version_list(&versions);
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
            let mut tx = crate::repositories::begin_write(&pool).await.map_err(backend)?;

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

    fn remove_versions(
        &mut self,
        secret_id: u64,
        channel_id: ChannelId,
        versions: &[u32],
    ) -> ShareStoreFuture<'_, ()> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let channel = id_to_text(channel_id.0);
        let actor = self.actor_id.clone();
        let versions: Vec<i64> = versions.iter().map(|v| i64::from(*v)).collect();

        Box::pin(async move {
            // `IN ()` is a syntax error on both engines, and the contract makes
            // an empty slice a no-op anyway.
            if versions.is_empty() {
                return Ok(());
            }

            let list = version_list(&versions);
            sqlx::query(&format!(
                "DELETE FROM shares \
                 WHERE secret_id = $1 AND channel_id = $2 AND actor_id = $3 \
                 AND version IN ({list})"
            ))
            .bind(secret)
            .bind(channel)
            .bind(actor)
            .execute(&pool)
            .await
            .map_err(backend)?;
            Ok(())
        })
    }

    fn keep_list(&self, secret_id: u64, version: u32) -> ShareStoreFuture<'_, Option<Vec<u32>>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let actor = self.actor_id.clone();

        Box::pin(async move {
            let rows: Vec<(i64, i64)> = sqlx::query_as(
                "SELECT version, committed FROM sharing_rounds \
                 WHERE actor_id = $1 AND secret_id = $2 AND version < $3",
            )
            .bind(actor)
            .bind(secret)
            .bind(i64::from(version))
            .fetch_all(&pool)
            .await
            .map_err(backend)?;

            let mut rounds = BTreeMap::new();
            for (round_version, committed) in rows {
                rounds.insert(u32::try_from(round_version).map_err(backend)?, committed != 0);
            }
            Ok(keep_list_from_rounds(version, &rounds))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rounds(entries: &[(u32, bool)]) -> BTreeMap<u32, bool> {
        entries.iter().copied().collect()
    }

    #[test]
    fn every_committed_version_is_kept_when_the_latest_one_committed() {
        let rounds = rounds(&[(1, true), (2, false), (3, true)]);
        assert_eq!(keep_list_from_rounds(4, &rounds), Some(vec![1, 3]));
    }

    #[test]
    fn rounds_that_fell_short_are_skipped_to_find_the_latest_commit() {
        let rounds = rounds(&[(1, true), (2, true), (3, false), (4, false)]);
        assert_eq!(keep_list_from_rounds(5, &rounds), Some(vec![1, 2]));
    }

    /// Version 3 was published by another replica member (or restored), so
    /// whether it is the latest committed version is unknown here — a list
    /// without it could delete it from every helper.
    #[test]
    fn a_version_this_instance_did_not_distribute_keeps_everything() {
        let rounds = rounds(&[(1, true), (2, true)]);
        assert_eq!(keep_list_from_rounds(4, &rounds), None);
    }

    #[test]
    fn nothing_known_to_have_committed_keeps_everything() {
        assert_eq!(keep_list_from_rounds(1, &rounds(&[])), None);
        assert_eq!(keep_list_from_rounds(3, &rounds(&[(1, false), (2, false)])), None);
    }

    /// The round being distributed has not committed yet, and a later round
    /// recorded by a replayed event must not leak into an earlier list.
    #[test]
    fn only_versions_below_the_one_distributed_are_considered() {
        let rounds = rounds(&[(1, true), (2, true), (5, true)]);
        assert_eq!(keep_list_from_rounds(3, &rounds), Some(vec![1, 2]));
    }
}
