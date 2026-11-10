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
//!
//! A provisioned helper's simulated failure ([`HelperFault`]) is applied here,
//! through the SDK's own store contract: a share it "lost" is not found, a
//! "corrupted" one is read back altered, and a refusal is the SDK's
//! [`ShareStoreError::Refused`]. The library then answers the owner exactly
//! as it would for a real helper in that state.

use std::collections::BTreeMap;
use std::sync::Arc;

use derec_library::protocol::{DeRecShareStore, Refusal, Share, ShareStoreError, ShareStoreFuture};
use derec_library::types::ChannelId;
use prost::Message;
use uuid::Uuid;

use super::{from_base64, id_to_text, to_base64};
use crate::models::HelperFault;
use crate::repositories::helper_faults::{HelperFaultRepository, SqlHelperFaultRepository};

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

/// One stored share as selected: `(version, share_secret_id, bytes, subshares, threshold)`.
type ShareRow = (i64, String, String, Option<i64>, Option<i64>);

/// A nullable `u32` column back to its value: stored from a `u32`, so anything
/// outside the range means the row was written by something else.
fn optional_u32(value: Option<i64>) -> Result<Option<u32>, ShareStoreError> {
    value.map(|v| u32::try_from(v).map_err(backend)).transpose()
}

/// Turn selected [`ShareRow`]s into `Share`s.
///
/// `share_secret_id` is read back rather than reconstructed from the partition
/// argument: a `Share` is self-describing and its `secret_id` is the secret the
/// share belongs to, which on a helper is the owner's, not the partition's.
fn to_shares(rows: Vec<ShareRow>) -> Result<Vec<Share>, ShareStoreError> {
    rows.into_iter()
        .map(|(version, share_secret, encoded, subshares, threshold)| {
            Ok(Share {
                secret_id: super::text_to_id(&share_secret).map_err(backend)?,
                // Stored from a u32 and never written any other way, so a
                // value outside u32 means the row was written by something
                // else — an error rather than a truncating cast.
                version: u32::try_from(version).map_err(backend)?,
                bytes: from_base64(&encoded).map_err(backend)?,
                subshares: optional_u32(subshares)?,
                threshold: optional_u32(threshold)?,
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
    faults: Arc<dyn HelperFaultRepository>,
}

impl SqlShareStore {
    pub fn new(pool: sqlx::AnyPool, actor_id: impl Into<String>) -> Self {
        Self {
            faults: Arc::new(SqlHelperFaultRepository::new(pool.clone())),
            pool,
            actor_id: actor_id.into(),
        }
    }
}

/// The failure `actor_id` simulates. An id that is not a UUID — only test
/// fixtures build one — and a lookup that fails both mean none: a fault is a
/// test aid, and must never be what breaks a real read.
async fn fault_of(faults: &dyn HelperFaultRepository, actor_id: &str) -> HelperFault {
    let Ok(id) = Uuid::parse_str(actor_id) else {
        return HelperFault::None;
    };
    match faults.fault(&id).await {
        Ok(fault) => fault,
        Err(e) => {
            tracing::warn!(actor_id, error = %e, "could not read the helper's simulated fault; behaving normally");
            HelperFault::None
        }
    }
}

/// A share held *for another owner*: its own secret is not the partition's.
/// Only these are subject to a fault — a replica's owner-side copies, filed
/// under the secret they mirror, never are.
fn held_for_others(share: &Share, partition: u64) -> bool {
    share.secret_id != partition
}

/// `shares` as a helper simulating `fault` reads them back.
fn apply_fault(shares: Vec<Share>, partition: u64, fault: HelperFault) -> Vec<Share> {
    match fault {
        HelperFault::LostShares => shares
            .into_iter()
            .filter(|share| !held_for_others(share, partition))
            .collect(),
        HelperFault::CorruptedShares => shares
            .into_iter()
            .map(|share| {
                if held_for_others(&share, partition) {
                    corrupted(share)
                } else {
                    share
                }
            })
            .collect(),
        _ => shares,
    }
}

/// `share` with one byte of its first subshare flipped, re-encoded so it still
/// decodes. The stored bytes are a `StoreShareRequestMessage` wrapping a
/// `CommittedDeRecShare` wrapping the `DeRecShare`; altering the subshare
/// breaks the hash a verification proof is computed over and the Merkle proof
/// recovery checks, which is what real corruption does. Bytes that do not
/// decode are returned as they are: there is nothing to corrupt convincingly.
fn corrupted(share: Share) -> Share {
    match corrupt_bytes(&share.bytes) {
        Some(bytes) => Share { bytes, ..share },
        None => share,
    }
}

fn corrupt_bytes(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut request = derec_proto::StoreShareRequestMessage::decode(bytes).ok()?;
    let mut committed = derec_proto::CommittedDeRecShare::decode(request.share.as_slice()).ok()?;
    let mut inner = derec_proto::DeRecShare::decode(committed.de_rec_share.as_slice()).ok()?;
    let byte = inner.subshares.first_mut()?.y.last_mut()?;
    *byte ^= 0xFF;
    committed.de_rec_share = inner.encode_to_vec();
    request.share = committed.encode_to_vec();
    Some(request.encode_to_vec())
}

/// The one older version helpers keep when `version` is distributed, given
/// how this instance's earlier rounds ended (`version -> committed`).
///
/// SDK 0.0.10 lets an owner name a single `keepVersion`; helpers delete every
/// other version once `version` is stored, and `0` keeps none. The answer is
/// the newest version that may be the latest committed one. The SDK numbers a
/// round one above the latest snapshot it holds, so walking down from
/// `version - 1`:
///
/// - a round this instance saw commit is the answer;
/// - a round this instance saw fall short is skipped, since it cannot be the
///   latest committed version;
/// - a version with no recorded outcome was not distributed here — another
///   replica member published it, or recovery restored it — or is still in
///   flight. Either way it may be (or become) the latest version, and keeping
///   an older one instead could delete it from every helper, so it is the
///   answer too.
///
/// Every round below `version` having fallen short leaves nothing to keep.
fn keep_version_from_rounds(version: u32, rounds: &BTreeMap<u32, bool>) -> u32 {
    (1..version)
        .rev()
        .find(|candidate| rounds.get(candidate) != Some(&false))
        .unwrap_or(0)
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
        let faults = Arc::clone(&self.faults);
        // Copied out of the borrowed slice: the future outlives the call.
        let versions: Vec<i64> = versions.iter().map(|v| i64::from(*v)).collect();

        Box::pin(async move {
            // An empty filter means "every version", matching the in-memory
            // store — not "no versions", which an `IN ()` would mean.
            let rows: Vec<ShareRow> = if versions.is_empty() {
                sqlx::query_as(
                    "SELECT version, share_secret_id, bytes, subshares, threshold FROM shares \
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
                    "SELECT version, share_secret_id, bytes, subshares, threshold FROM shares \
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

            let fault = fault_of(faults.as_ref(), &actor).await;
            Ok(apply_fault(to_shares(rows)?, secret_id, fault))
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
        let faults = Arc::clone(&self.faults);

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
                    "SELECT version, share_secret_id, bytes, subshares, threshold FROM shares \
                     WHERE secret_id = $1 AND actor_id = $2 \
                     AND channel_id IN ({channel_list})"
                )
            } else {
                let version_list = version_list(&versions);
                format!(
                    "SELECT version, share_secret_id, bytes, subshares, threshold FROM shares \
                     WHERE secret_id = $1 AND actor_id = $2 \
                     AND channel_id IN ({channel_list}) \
                     AND version IN ({version_list})"
                )
            };

            let rows: Vec<ShareRow> = sqlx::query_as(&sql)
                .bind(&secret)
                .bind(&actor)
                .fetch_all(&pool)
                .await
                .map_err(backend)?;

            let fault = fault_of(faults.as_ref(), &actor).await;
            Ok(apply_fault(to_shares(rows)?, secret_id, fault))
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
        let faults = Arc::clone(&self.faults);

        Box::pin(async move {
            if channels.is_empty() {
                return Ok(Vec::new());
            }

            let channel_list = in_list(&channels);
            let rows: Vec<ShareRow> = sqlx::query_as(&format!(
                "SELECT version, share_secret_id, bytes, subshares, threshold FROM shares \
                 WHERE secret_id = $1 AND actor_id = $2 \
                 AND channel_id IN ({channel_list})"
            ))
            .bind(&secret)
            .bind(&actor)
            .fetch_all(&pool)
            .await
            .map_err(backend)?;

            let fault = fault_of(faults.as_ref(), &actor).await;
            Ok(apply_fault(to_shares(rows)?, secret_id, fault))
        })
    }

    fn latest_version(&self, secret_id: u64) -> ShareStoreFuture<'_, Option<u32>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let actor = self.actor_id.clone();

        Box::pin(async move {
            // MAX over no rows is NULL on both engines, which arrives as None.
            let row: Option<(Option<i64>,)> = sqlx::query_as(
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
        let subshares = share.subshares.map(i64::from);
        let threshold = share.threshold.map(i64::from);
        let held_for_others = held_for_others(&share, secret_id);
        let faults = Arc::clone(&self.faults);

        Box::pin(async move {
            // The SDK answers a refused write with the refusal's status and
            // memo, as for a real helper's full or rate-limited storage.
            if held_for_others
                && fault_of(faults.as_ref(), &actor).await == HelperFault::RefusesNewShares
            {
                return Err(ShareStoreError::Refused(Refusal::Rejected));
            }

            let mut tx = crate::repositories::begin_write(&pool)
                .await
                .map_err(backend)?;

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
                 (secret_id, channel_id, version, bytes, actor_id, share_secret_id, \
                  subshares, threshold) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            )
            .bind(&secret)
            .bind(&channel)
            .bind(version)
            .bind(&bytes)
            .bind(&actor)
            .bind(&share_secret)
            .bind(subshares)
            .bind(threshold)
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

    /// Called only for a challenge the helper is about to answer, so a refusal
    /// here is always on a share held for another owner.
    fn record_verification(
        &mut self,
        _secret_id: u64,
        _channel_id: ChannelId,
        _version: u32,
    ) -> ShareStoreFuture<'_, ()> {
        let actor = self.actor_id.clone();
        let faults = Arc::clone(&self.faults);
        Box::pin(async move {
            if fault_of(faults.as_ref(), &actor).await == HelperFault::RefusesVerification {
                return Err(ShareStoreError::Refused(Refusal::Rejected));
            }
            Ok(())
        })
    }

    fn keep_version(&self, secret_id: u64, version: u32) -> ShareStoreFuture<'_, u32> {
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
                rounds.insert(
                    u32::try_from(round_version).map_err(backend)?,
                    committed != 0,
                );
            }
            Ok(keep_version_from_rounds(version, &rounds))
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
    fn the_latest_committed_version_is_kept() {
        let rounds = rounds(&[(1, true), (2, false), (3, true)]);
        assert_eq!(keep_version_from_rounds(4, &rounds), 3);
    }

    #[test]
    fn rounds_that_fell_short_are_skipped_to_find_the_latest_commit() {
        let rounds = rounds(&[(1, true), (2, true), (3, false), (4, false)]);
        assert_eq!(keep_version_from_rounds(5, &rounds), 2);
    }

    /// Version 3 was published by another replica member (or restored), so
    /// it may be the latest committed version — keeping 2 instead could
    /// delete it from every helper.
    #[test]
    fn a_version_this_instance_did_not_distribute_is_kept() {
        let rounds = rounds(&[(1, true), (2, true)]);
        assert_eq!(keep_version_from_rounds(4, &rounds), 3);
    }

    #[test]
    fn nothing_that_may_have_committed_keeps_nothing() {
        assert_eq!(keep_version_from_rounds(1, &rounds(&[])), 0);
        assert_eq!(
            keep_version_from_rounds(3, &rounds(&[(1, false), (2, false)])),
            0
        );
    }

    /// The round being distributed has not committed yet, and a later round
    /// recorded by a replayed event must not leak into an earlier answer.
    #[test]
    fn only_versions_below_the_one_distributed_are_considered() {
        let rounds = rounds(&[(1, true), (2, true), (5, true)]);
        assert_eq!(keep_version_from_rounds(3, &rounds), 2);
    }
}
