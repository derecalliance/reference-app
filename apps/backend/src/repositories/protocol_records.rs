// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The app's own questions about what the protocol stores hold.
//!
//! The protocol instances read and write their tables through the SDK store
//! traits ([`super::sdk`]), one instance at a time. The roster, the
//! fingerprint and linking routes, and boot recovery want answers *per actor*
//! — across every instance it runs — without borrowing, or even knowing,
//! those instances. The rows are the instances' own, so these are the answers
//! each instance would give, read without contending with in-flight protocol
//! calls.

use async_trait::async_trait;
use derec_library::protocol::{ChannelRecord, HelperChannel, SecretValue};
use uuid::Uuid;

use super::sdk::{id_to_text, text_to_id};
use super::RepositoryError;
use crate::models::UnpairedContact;

type Result<T> = std::result::Result<T, RepositoryError>;

#[async_trait]
pub trait ProtocolRecordRepository: Send + Sync {
    /// Whether `actor_id` holds `channel_id` on any instance, as a helper
    /// channel or as a replica-group member — narrowed to one instance when
    /// `secret_id` is given.
    async fn holds_channel(
        &self,
        actor_id: &Uuid,
        channel_id: u64,
        secret_id: Option<u64>,
    ) -> Result<bool>;

    /// Every helper-channel record `actor_id` holds, across all its instances,
    /// with the `secret_id` of the instance holding each. Ordered by
    /// `(created_at, channel_id)`, oldest first, so every caller sees the same
    /// sequence before and after a restart.
    async fn helper_channels(&self, actor_id: &Uuid) -> Result<Vec<(u64, HelperChannel)>>;

    /// The raw shared key for a channel under `secret_id`, if present.
    async fn shared_key(
        &self,
        actor_id: &Uuid,
        secret_id: u64,
        channel_id: u64,
    ) -> Result<Option<[u8; 32]>>;

    /// Contacts `actor_id` minted at or after `minted_since` (Unix seconds)
    /// that no peer has paired against yet, across every instance it runs.
    ///
    /// A minted contact exists only as a pairing secret or pairing contact —
    /// `create_contact` writes nothing to the channel store — and the SDK
    /// deletes that row once the pairing completes. So a surviving row is a
    /// contact still waiting for its first message.
    async fn unpaired_contacts(
        &self,
        actor_id: &Uuid,
        minted_since: i64,
    ) -> Result<Vec<UnpairedContact>>;

    /// The `secret_id` of every protocol instance `actor_id` has stored
    /// anything under, ascending.
    ///
    /// Every store table is partitioned by `(actor_id, secret_id)`, and that
    /// pair identifies an instance exactly (see `migrations/0001_initial.sql`),
    /// so the distinct partitions are the instances. That includes replica
    /// instances, which are created on demand and recorded nowhere else: this
    /// is how a restart finds them again.
    async fn instance_secret_ids(&self, actor_id: &Uuid) -> Result<Vec<u64>>;
}

pub struct SqlProtocolRecordRepository {
    pool: sqlx::AnyPool,
}

impl SqlProtocolRecordRepository {
    pub fn new(pool: sqlx::AnyPool) -> Self {
        Self { pool }
    }
}

/// The `kind` column values these queries read, as the SDK stores write them.
const CHANNEL_KIND_HELPER: &str = "helper";
const SECRET_KIND_SHARED_KEY: &str = "shared_key";
const SECRET_KIND_PAIRING_SECRET: &str = "pairing_secret";
const SECRET_KIND_PAIRING_CONTACT: &str = "pairing_contact";

#[async_trait]
impl ProtocolRecordRepository for SqlProtocolRecordRepository {
    async fn holds_channel(
        &self,
        actor_id: &Uuid,
        channel_id: u64,
        secret_id: Option<u64>,
    ) -> Result<bool> {
        let actor = actor_id.to_string();
        let row: Option<(String,)> = match secret_id {
            Some(secret_id) => {
                sqlx::query_as(
                    "SELECT channel_id FROM channels \
                     WHERE actor_id = $1 AND channel_id = $2 AND secret_id = $3",
                )
                .bind(&actor)
                .bind(id_to_text(channel_id))
                .bind(id_to_text(secret_id))
                .fetch_optional(&self.pool)
                .await?
            }
            None => {
                sqlx::query_as(
                    "SELECT channel_id FROM channels WHERE actor_id = $1 AND channel_id = $2",
                )
                .bind(&actor)
                .bind(id_to_text(channel_id))
                .fetch_optional(&self.pool)
                .await?
            }
        };
        Ok(row.is_some())
    }

    async fn helper_channels(&self, actor_id: &Uuid) -> Result<Vec<(u64, HelperChannel)>> {
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT secret_id, record FROM channels WHERE actor_id = $1 AND kind = $2",
        )
        .bind(actor_id.to_string())
        .bind(CHANNEL_KIND_HELPER)
        .fetch_all(&self.pool)
        .await?;

        let mut out = Vec::with_capacity(rows.len());
        for (secret, json) in rows {
            let secret_id = text_to_id(&secret).map_err(RepositoryError::corrupt)?;
            match serde_json::from_str::<ChannelRecord>(&json).map_err(RepositoryError::corrupt)? {
                ChannelRecord::Helper(h) => out.push((secret_id, h)),
                ChannelRecord::Replica(_) => {
                    return Err(RepositoryError::Corrupt(
                        "replica record stored under kind 'helper'".to_owned(),
                    ));
                }
            }
        }
        out.sort_by_key(|(_, h)| (h.created_at, h.channel_id.0));
        Ok(out)
    }

    async fn shared_key(
        &self,
        actor_id: &Uuid,
        secret_id: u64,
        channel_id: u64,
    ) -> Result<Option<[u8; 32]>> {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT value FROM secrets \
             WHERE secret_id = $1 AND channel_id = $2 AND kind = $3 AND actor_id = $4",
        )
        .bind(id_to_text(secret_id))
        .bind(id_to_text(channel_id))
        .bind(SECRET_KIND_SHARED_KEY)
        .bind(actor_id.to_string())
        .fetch_optional(&self.pool)
        .await?;

        let Some((json,)) = row else {
            return Ok(None);
        };

        // A row of another kind cannot appear: `kind` is part of the key and
        // this query names `shared_key`. A value that deserialises to another
        // variant therefore means the row was written wrong, and `None` is the
        // honest answer — there is no shared key here.
        match serde_json::from_str::<SecretValue>(&json).map_err(RepositoryError::corrupt)? {
            SecretValue::SharedKey(key) => Ok(Some(key)),
            _ => Ok(None),
        }
    }

    async fn unpaired_contacts(
        &self,
        actor_id: &Uuid,
        minted_since: i64,
    ) -> Result<Vec<UnpairedContact>> {
        let rows: Vec<(String, String, i64)> = sqlx::query_as(
            "SELECT secret_id, channel_id, created_at FROM secrets \
             WHERE actor_id = $1 AND kind IN ($2, $3) AND created_at >= $4",
        )
        .bind(actor_id.to_string())
        .bind(SECRET_KIND_PAIRING_SECRET)
        .bind(SECRET_KIND_PAIRING_CONTACT)
        .bind(minted_since)
        .fetch_all(&self.pool)
        .await?;

        let mut contacts = Vec::with_capacity(rows.len());
        for (secret_id, channel_id, created_at) in rows {
            contacts.push(UnpairedContact {
                secret_id: text_to_id(&secret_id).map_err(RepositoryError::corrupt)?,
                channel_id: text_to_id(&channel_id).map_err(RepositoryError::corrupt)?,
                minted_at: created_at,
            });
        }
        // A contact can hold both kinds of row on one channel; one route each.
        contacts.sort_by_key(|c| (c.secret_id, c.channel_id));
        contacts.dedup_by_key(|c| (c.secret_id, c.channel_id));
        Ok(contacts)
    }

    async fn instance_secret_ids(&self, actor_id: &Uuid) -> Result<Vec<u64>> {
        let actor = actor_id.to_string();
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT secret_id FROM channels WHERE actor_id = $1 \
             UNION SELECT secret_id FROM secrets WHERE actor_id = $2 \
             UNION SELECT secret_id FROM shares WHERE actor_id = $3 \
             UNION SELECT secret_id FROM state_items WHERE actor_id = $4 \
             UNION SELECT secret_id FROM user_secrets WHERE actor_id = $5",
        )
        // One bind per placeholder rather than a reused `$1`: SQLite reads `$1`
        // as a named parameter and Postgres as a positional one, and only
        // distinct placeholders mean the same thing to both.
        .bind(&actor)
        .bind(&actor)
        .bind(&actor)
        .bind(&actor)
        .bind(&actor)
        .fetch_all(&self.pool)
        .await?;

        let mut ids: Vec<u64> = rows
            .iter()
            .filter_map(|(text,)| match text_to_id(text) {
                Ok(id) => Some(id),
                Err(e) => {
                    // Skipped rather than fatal: one corrupt row must not keep
                    // every other instance of this actor down.
                    tracing::warn!(actor_id = %actor, error = %e, "unreadable secret_id; instance skipped");
                    None
                }
            })
            .collect();
        ids.sort_unstable();
        ids.dedup();
        Ok(ids)
    }
}
