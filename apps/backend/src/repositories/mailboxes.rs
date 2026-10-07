// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Store-and-forward mailboxes for browser-run actors.
//!
//! A browser cannot listen, so messages for it wait here until its tab polls
//! `GET /derec/{actor_id}/mailbox`. This used to be an in-memory `mpsc`
//! channel per actor, which lost messages twice over: a restart dropped every
//! undelivered message, and a recovering tab claiming an existing owner was
//! handed a *fresh* channel, discarding whatever had queued for it — usually
//! the very replies the recovery flow was waiting for.
//!
//! The `mailbox` table makes both survive. A message is a row until a poll
//! takes it, and the mailbox belongs to the actor rather than to whichever tab
//! last registered for it, so a claim finds the queue where it was left.
//!
//! # Bounded
//!
//! Anyone who can reach the node can post to any browser actor, and a tab that
//! is closed never drains. Each mailbox is therefore capped
//! ([`MAX_QUEUED_MESSAGES`], [`MAX_QUEUED_BYTES`]). A message beyond the cap is
//! **refused, not queued, and nothing already queued is dropped**: the sender's
//! transport sees the failure (HTTP 503, gRPC `RESOURCE_EXHAUSTED`) and the
//! protocol's own retry and timeout behaviour takes over. Evicting the oldest
//! instead would silently lose a message the recipient may still need, which
//! is the failure this module exists to remove.

use async_trait::async_trait;
use uuid::Uuid;

use super::sdk::{from_base64, to_base64};
use super::{begin_write, RepositoryError};

/// The most messages one browser actor may have waiting.
///
/// A busy protect-and-verify round across a full pool is a few dozen messages;
/// a thousand is a tab that has been closed for a long time.
pub const MAX_QUEUED_MESSAGES: i64 = 1_000;

/// The most payload one browser actor may have waiting, in raw message bytes
/// — what the senders posted, not the larger base64 the table stores (about
/// 21.3 MiB at the cap). Bounds the table when a few very large messages
/// arrive rather than many small ones: four of the largest a transport
/// accepts (4 MiB) fit exactly.
pub const MAX_QUEUED_BYTES: i64 = 16 * 1024 * 1024;

#[async_trait]
pub trait MailboxRepository: Send + Sync {
    /// Queue one message for `actor_id`, behind whatever is already waiting.
    ///
    /// The atomic primitive for the cap: the count, the check against
    /// [`MAX_QUEUED_MESSAGES`] and [`MAX_QUEUED_BYTES`] and the insert are one
    /// step. A message over the cap is refused with
    /// [`RepositoryError::MailboxFull`] and nothing is queued.
    async fn enqueue(&self, actor_id: &Uuid, message: &[u8]) -> Result<(), RepositoryError>;

    /// Take everything waiting for `actor_id`, oldest first.
    ///
    /// Destructive and atomic: two polls racing each other split the queue
    /// between them rather than both receiving it.
    async fn drain(&self, actor_id: &Uuid) -> Result<Vec<Vec<u8>>, RepositoryError>;

    /// How many messages are waiting for `actor_id`, without taking them.
    async fn len(&self, actor_id: &Uuid) -> Result<usize, RepositoryError>;
}

pub struct SqlMailboxRepository {
    pool: sqlx::AnyPool,
    /// Serialises `enqueue` within this process.
    ///
    /// `seq` is assigned as `MAX(seq) + 1` inside the inserting transaction,
    /// the portable alternative to `AUTOINCREMENT`/`SERIAL`. On SQLite
    /// `begin_write` already makes that atomic; on Postgres two concurrent
    /// transactions can read the same maximum, and the primary key would then
    /// refuse the second insert. This lock makes that impossible within one
    /// process, the same guarantee the actor repository makes for its inserts.
    enqueue_lock: tokio::sync::Mutex<()>,
}

impl SqlMailboxRepository {
    pub fn new(pool: sqlx::AnyPool) -> Self {
        Self {
            pool,
            enqueue_lock: tokio::sync::Mutex::new(()),
        }
    }
}

#[async_trait]
impl MailboxRepository for SqlMailboxRepository {
    async fn enqueue(&self, actor_id: &Uuid, message: &[u8]) -> Result<(), RepositoryError> {
        let payload = to_base64(message);
        let actor = actor_id.to_string();

        let _guard = self.enqueue_lock.lock().await;
        let mut tx = begin_write(&self.pool).await?;

        // Raw bytes, recovered from the stored base64 exactly: three bytes per
        // four characters, less one per `=` of padding. Counting the stored
        // text instead capped a mailbox at about 12 MiB of actual messages
        // while the limit said 16.
        let (queued, bytes, last_seq): (i64, i64, i64) = sqlx::query_as(
            "SELECT COUNT(*), \
                    COALESCE(SUM(LENGTH(payload) * 3 / 4 \
                                 - (LENGTH(payload) - LENGTH(REPLACE(payload, '=', '')))), 0), \
                    COALESCE(MAX(seq), 0) \
             FROM mailbox WHERE actor_id = $1",
        )
        .bind(&actor)
        .fetch_one(&mut *tx)
        .await?;

        let incoming = i64::try_from(message.len()).unwrap_or(i64::MAX);
        if queued >= MAX_QUEUED_MESSAGES || bytes.saturating_add(incoming) > MAX_QUEUED_BYTES {
            return Err(RepositoryError::MailboxFull { queued, bytes });
        }

        sqlx::query("INSERT INTO mailbox (actor_id, seq, payload) VALUES ($1, $2, $3)")
            .bind(&actor)
            .bind(last_seq + 1)
            .bind(&payload)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        Ok(())
    }

    async fn drain(&self, actor_id: &Uuid) -> Result<Vec<Vec<u8>>, RepositoryError> {
        // The rows are deleted by the same statement that returns them.
        // `DELETE … RETURNING` is spelled the same on SQLite (3.35+) and
        // Postgres.
        let mut rows: Vec<(i64, String)> =
            sqlx::query_as("DELETE FROM mailbox WHERE actor_id = $1 RETURNING seq, payload")
                .bind(actor_id.to_string())
                .fetch_all(&self.pool)
                .await?;

        // `RETURNING` promises no order on either engine.
        rows.sort_by_key(|(seq, _)| *seq);

        let mut messages = Vec::with_capacity(rows.len());
        for (seq, payload) in rows {
            match from_base64(&payload) {
                Ok(bytes) => messages.push(bytes),
                // Unreadable rows are skipped, not fatal: one corrupt row must
                // not wedge every message queued behind it.
                Err(e) => tracing::error!(
                    actor_id = %actor_id,
                    seq,
                    error = %e,
                    "unreadable mailbox row discarded"
                ),
            }
        }
        Ok(messages)
    }

    async fn len(&self, actor_id: &Uuid) -> Result<usize, RepositoryError> {
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM mailbox WHERE actor_id = $1")
            .bind(actor_id.to_string())
            .fetch_one(&self.pool)
            .await?;
        Ok(usize::try_from(count).unwrap_or(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: usize = 1024 * 1024;

    #[tokio::test]
    async fn the_byte_cap_counts_raw_message_bytes_exactly() {
        // Base64 inflates by a third, so counting the stored text refused the
        // fourth 4 MiB message of a mailbox documented to hold 16 MiB. Sizes
        // are chosen so the padding differs (0, 1 and 2 `=`), which an
        // approximate conversion would get wrong at the boundary.
        let pool = crate::infrastructure::db::connect("sqlite::memory:")
            .await
            .expect("an in-memory database always connects");
        let mailboxes = SqlMailboxRepository::new(pool);
        let actor = Uuid::new_v4();

        for len in [4 * MIB - 1, 4 * MIB - 2, 4 * MIB, 4 * MIB + 3] {
            mailboxes
                .enqueue(&actor, &vec![7u8; len])
                .await
                .unwrap_or_else(|e| panic!("{len} bytes must fit under the cap: {e}"));
        }

        match mailboxes.enqueue(&actor, &[1u8]).await {
            Err(RepositoryError::MailboxFull { bytes, .. }) => {
                assert_eq!(
                    bytes, MAX_QUEUED_BYTES,
                    "exactly 16 MiB of raw bytes waiting"
                )
            }
            other => panic!("one byte past the cap must be refused, got {other:?}"),
        }
        assert_eq!(mailboxes.len(&actor).await.expect("readable"), 4);
    }
}
