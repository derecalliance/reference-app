// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The envelopes each provisioned actor sent or accepted — see [`SeenEnvelope`].

use std::fmt::Write as _;

use async_trait::async_trait;
use uuid::Uuid;

use super::{begin_write, RepositoryError};
use crate::models::SeenEnvelope;

/// What survives a restart of an actor's replay log. The actor checks its own
/// in-memory copy; this store is read once when the actor starts and written
/// as envelopes are remembered.
#[async_trait]
pub trait SeenMessageRepository: Send + Sync {
    /// Every envelope `actor_id` remembered that has not expired by `now`.
    async fn live(&self, actor_id: &Uuid, now: u64) -> Result<Vec<SeenEnvelope>, RepositoryError>;
    /// Remember `seen` for `actor_id`, dropping what expired by `now`.
    /// Idempotent: a second call for the same id keeps the later expiry.
    async fn remember(
        &self,
        actor_id: &Uuid,
        seen: SeenEnvelope,
        now: u64,
    ) -> Result<(), RepositoryError>;
}

pub struct SqlSeenMessageRepository {
    pool: sqlx::AnyPool,
}

impl SqlSeenMessageRepository {
    pub fn new(pool: sqlx::AnyPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl SeenMessageRepository for SqlSeenMessageRepository {
    async fn live(&self, actor_id: &Uuid, now: u64) -> Result<Vec<SeenEnvelope>, RepositoryError> {
        let rows: Vec<(String, i64)> = sqlx::query_as(
            "SELECT message_id, expires_at FROM seen_messages \
             WHERE actor_id = $1 AND expires_at >= $2",
        )
        .bind(actor_id.to_string())
        .bind(seconds(now))
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|(id, expires_at)| {
                Ok(SeenEnvelope {
                    id: from_hex(&id).ok_or_else(|| {
                        RepositoryError::corrupt(format!(
                            "message id {id:?} is not 32 bytes of hex"
                        ))
                    })?,
                    expires_at: u64::try_from(expires_at).map_err(RepositoryError::corrupt)?,
                })
            })
            .collect()
    }

    async fn remember(
        &self,
        actor_id: &Uuid,
        seen: SeenEnvelope,
        now: u64,
    ) -> Result<(), RepositoryError> {
        let actor = actor_id.to_string();
        let id = to_hex(&seen.id);
        // Delete-then-insert rather than an upsert: the portable form this
        // schema uses everywhere (see `sdk`). Expired rows go in the same
        // write, so the table never outgrows one window per actor.
        let mut tx = begin_write(&self.pool).await?;

        sqlx::query(
            "DELETE FROM seen_messages \
             WHERE actor_id = $1 AND (message_id = $2 OR expires_at < $3)",
        )
        .bind(&actor)
        .bind(&id)
        .bind(seconds(now))
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "INSERT INTO seen_messages (actor_id, message_id, expires_at) VALUES ($1, $2, $3)",
        )
        .bind(&actor)
        .bind(&id)
        .bind(seconds(seen.expires_at))
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(())
    }
}

/// Unix seconds as the signed column type; far-future values saturate.
fn seconds(at: u64) -> i64 {
    i64::try_from(at).unwrap_or(i64::MAX)
}

fn to_hex(bytes: &[u8; 32]) -> String {
    bytes.iter().fold(String::with_capacity(64), |mut hex, b| {
        let _ = write!(hex, "{b:02x}");
        hex
    })
}

fn from_hex(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 || !hex.is_ascii() {
        return None;
    }
    let mut id = [0u8; 32];
    for (byte, pair) in id.iter_mut().zip(hex.as_bytes().chunks(2)) {
        *byte = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
    }
    Some(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_survives_the_hex_round_trip() {
        let id: [u8; 32] = std::array::from_fn(|i| (i * 7) as u8);

        assert_eq!(from_hex(&to_hex(&id)), Some(id));
        assert_eq!(from_hex("zz"), None);
    }
}
