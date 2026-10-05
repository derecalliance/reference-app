// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! `DeRecSecretStore` over SQL.
//!
//! Keyed by `(secret_id, channel_id, kind)`. `save` takes no `kind` — it is
//! derived from the `SecretValue` variant, which is what keeps a shared key and
//! a pairing secret on the same channel from overwriting one another.
//!
//! `SecretValue` derives serde behind the library's `serde` feature, so the
//! value is stored as the library's own shape rather than a DTO this app
//! invents.

use derec_library::protocol::{
    DeRecSecretStore, MissingPolicy, SecretKind, SecretStoreError, SecretStoreFuture, SecretValue,
};
use derec_library::types::ChannelId;

use super::id_to_text;

fn backend<E: std::error::Error + Send + Sync + 'static>(e: E) -> SecretStoreError {
    SecretStoreError::Backend(Box::new(e))
}

/// The `kind` column value for a variant. Written out rather than derived from
/// the discriminant so the rows stay readable to a developer with `sqlite3`.
fn kind_text(kind: SecretKind) -> &'static str {
    match kind {
        SecretKind::SharedKey => "shared_key",
        SecretKind::PairingSecret => "pairing_secret",
        SecretKind::PairingContact => "pairing_contact",
    }
}

/// The `kind` a value will be filed under.
fn kind_of(value: &SecretValue) -> SecretKind {
    match value {
        SecretValue::SharedKey(_) => SecretKind::SharedKey,
        SecretValue::PairingSecret(_) => SecretKind::PairingSecret,
        SecretValue::PairingContact(_) => SecretKind::PairingContact,
    }
}

pub struct SqlSecretStore {
    pool: sqlx::AnyPool,
    /// Which actor's instance this store belongs to. See the migration's
    /// header: (actor_id, secret_id) identifies an instance, because two
    /// actors can hold instances bound to the same secret.
    actor_id: String,
}

impl SqlSecretStore {
    pub fn new(pool: sqlx::AnyPool, actor_id: impl Into<String>) -> Self {
        Self {
            pool,
            actor_id: actor_id.into(),
        }
    }

    /// Load the raw shared key bytes for a channel under `secret_id`, if present.
    ///
    /// Outside the trait, matching the inherent method the in-memory store
    /// carried: the fingerprint flow wants the key itself rather than a
    /// `SecretValue` it has to match on. Async here where the in-memory one was
    /// synchronous, which is why `LoadSharedKeyMsg`'s handler returns a
    /// `ResponseActFuture`.
    ///
    /// A row of another kind cannot appear: `kind` is part of the key and this
    /// query names `shared_key`. A value that deserialises to another variant
    /// therefore means the row was written wrong, and `None` is the honest
    /// answer — there is no shared key here.
    pub async fn load_shared_key(
        &self,
        secret_id: u64,
        channel_id: u64,
    ) -> Result<Option<[u8; 32]>, SecretStoreError> {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT value FROM secrets \
             WHERE secret_id = $1 AND channel_id = $2 AND kind = $3 AND actor_id = $4",
        )
        .bind(id_to_text(secret_id))
        .bind(id_to_text(channel_id))
        .bind(kind_text(SecretKind::SharedKey))
        .bind(&self.actor_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(backend)?;

        let Some((json,)) = row else {
            return Ok(None);
        };

        match serde_json::from_str::<SecretValue>(&json).map_err(backend)? {
            SecretValue::SharedKey(key) => Ok(Some(key)),
            _ => Ok(None),
        }
    }

    /// Contacts this actor minted at or after `minted_since` (Unix seconds)
    /// that no peer has paired against yet, across every instance it runs.
    ///
    /// Outside the trait because no protocol call needs it; recovery does. A
    /// minted contact exists only as a pairing secret or pairing contact here —
    /// `create_contact` writes nothing to the channel store — and the SDK
    /// deletes that row once the pairing completes. So a surviving row is a
    /// contact still waiting for its first message, and the instance and
    /// channel it names are what that message must be routed to.
    pub async fn unpaired_contacts(
        &self,
        minted_since: i64,
    ) -> Result<Vec<UnpairedContact>, SecretStoreError> {
        let rows: Vec<(String, String, i64)> = sqlx::query_as(
            "SELECT secret_id, channel_id, created_at FROM secrets \
             WHERE actor_id = $1 AND kind IN ($2, $3) AND created_at >= $4",
        )
        .bind(&self.actor_id)
        .bind(kind_text(SecretKind::PairingSecret))
        .bind(kind_text(SecretKind::PairingContact))
        .bind(minted_since)
        .fetch_all(&self.pool)
        .await
        .map_err(backend)?;

        let mut contacts = Vec::with_capacity(rows.len());
        for (secret_id, channel_id, created_at) in rows {
            contacts.push(UnpairedContact {
                secret_id: super::text_to_id(&secret_id).map_err(backend)?,
                channel_id: super::text_to_id(&channel_id).map_err(backend)?,
                minted_at: created_at,
            });
        }
        // A contact can hold both kinds of row on one channel; one route each.
        contacts.sort_by_key(|c| (c.secret_id, c.channel_id));
        contacts.dedup_by_key(|c| (c.secret_id, c.channel_id));
        Ok(contacts)
    }
}

/// A contact minted and not yet paired against; see
/// [`SqlSecretStore::unpaired_contacts`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnpairedContact {
    /// The instance that minted it.
    pub secret_id: u64,
    /// The channel its peer's first message will arrive on.
    pub channel_id: u64,
    /// Unix seconds.
    pub minted_at: i64,
}

/// The current time in Unix seconds, as the `created_at` column stores it.
pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

impl DeRecSecretStore for SqlSecretStore {
    fn load(
        &self,
        secret_id: u64,
        channel_id: ChannelId,
        kind: SecretKind,
    ) -> SecretStoreFuture<'_, Option<SecretValue>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let channel = id_to_text(channel_id.0);
        let kind = kind_text(kind);
        let actor = self.actor_id.clone();

        Box::pin(async move {
            let row: Option<(String,)> = sqlx::query_as(
                "SELECT value FROM secrets \
                 WHERE secret_id = $1 AND channel_id = $2 AND kind = $3 AND actor_id = $4",
            )
            .bind(secret)
            .bind(channel)
            .bind(kind)
            .bind(actor)
            .fetch_optional(&pool)
            .await
            .map_err(backend)?;

            match row {
                Some((json,)) => Ok(Some(serde_json::from_str(&json).map_err(backend)?)),
                None => Ok(None),
            }
        })
    }

    fn load_many(
        &self,
        secret_id: u64,
        channel_ids: &[ChannelId],
        kind: SecretKind,
        missing_policy: MissingPolicy,
    ) -> SecretStoreFuture<'_, Vec<(ChannelId, SecretValue)>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let kind_col = kind_text(kind);
        let actor = self.actor_id.clone();
        // Copied out of the borrowed slice: the future outlives the call. The
        // request order is preserved because the protocol pairs the result
        // against the channels it asked for.
        let wanted: Vec<ChannelId> = channel_ids.to_vec();

        Box::pin(async move {
            let mut found = Vec::with_capacity(wanted.len());
            let mut missing = Vec::new();

            // One query per channel rather than an `IN` list: the result has to
            // distinguish present from absent per channel to honour
            // `MissingPolicy`, and these lists are the size of a helper set.
            for cid in &wanted {
                let row: Option<(String,)> = sqlx::query_as(
                    "SELECT value FROM secrets \
                     WHERE secret_id = $1 AND channel_id = $2 AND kind = $3 AND actor_id = $4",
                )
                .bind(&secret)
                .bind(id_to_text(cid.0))
                .bind(kind_col)
                .bind(&actor)
                .fetch_optional(&pool)
                .await
                .map_err(backend)?;

                match row {
                    Some((json,)) => {
                        found.push((*cid, serde_json::from_str(&json).map_err(backend)?))
                    }
                    None => missing.push(cid.0),
                }
            }

            // `Fail` is not decoration: the caller uses it to refuse a round
            // rather than silently proceed with a short set of helpers.
            match missing_policy {
                MissingPolicy::Skip => Ok(found),
                MissingPolicy::Fail if missing.is_empty() => Ok(found),
                MissingPolicy::Fail => Err(SecretStoreError::MissingEntries {
                    kind,
                    channel_ids: missing,
                }),
            }
        })
    }

    fn save(
        &mut self,
        secret_id: u64,
        channel_id: ChannelId,
        value: SecretValue,
    ) -> SecretStoreFuture<'_, ()> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let channel = id_to_text(channel_id.0);
        let kind = kind_text(kind_of(&value));
        let actor = self.actor_id.clone();

        Box::pin(async move {
            let json = serde_json::to_string(&value).map_err(backend)?;

            let mut tx = crate::db::begin_write(&pool).await.map_err(backend)?;

            sqlx::query(
                "DELETE FROM secrets \
                 WHERE secret_id = $1 AND channel_id = $2 AND kind = $3 AND actor_id = $4",
            )
            .bind(&secret)
            .bind(&channel)
            .bind(kind)
            .bind(&actor)
            .execute(&mut *tx)
            .await
            .map_err(backend)?;

            // `created_at` is what lets a restart tell a contact still inside
            // its lifetime from an expired one; see `unpaired_contacts`.
            sqlx::query(
                "INSERT INTO secrets (secret_id, channel_id, kind, value, actor_id, created_at) \
                 VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(&secret)
            .bind(&channel)
            .bind(kind)
            .bind(&json)
            .bind(&actor)
            .bind(now_secs())
            .execute(&mut *tx)
            .await
            .map_err(backend)?;

            tx.commit().await.map_err(backend)?;
            Ok(())
        })
    }

    fn remove(
        &mut self,
        secret_id: u64,
        channel_id: ChannelId,
        kind: SecretKind,
    ) -> SecretStoreFuture<'_, ()> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let channel = id_to_text(channel_id.0);
        let kind = kind_text(kind);
        let actor = self.actor_id.clone();

        Box::pin(async move {
            sqlx::query(
                "DELETE FROM secrets \
                 WHERE secret_id = $1 AND channel_id = $2 AND kind = $3 AND actor_id = $4",
            )
            .bind(secret)
            .bind(channel)
            .bind(kind)
            .bind(actor)
            .execute(&pool)
            .await
            .map_err(backend)?;

            // Idempotent by contract: removing an absent secret is not an error.
            Ok(())
        })
    }
}
