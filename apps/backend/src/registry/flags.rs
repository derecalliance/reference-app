// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The three small per-actor registries: which channels a helper holds, which
//! helpers the operator has switched off, and the contact a browser-managed
//! participant has posted for its owner to fetch.
//!
//! Each is a key-value map that used to be a `DashMap` on `AppState`. Every
//! method is one statement; the types exist to keep the SQL in one place rather
//! than spread across routes.

use uuid::Uuid;

use super::RegistryError;

/// Helper-side channel ids, one row per paired owner.
pub struct HelperChannels {
    pool: sqlx::AnyPool,
}

impl HelperChannels {
    pub fn new(pool: sqlx::AnyPool) -> Self {
        Self { pool }
    }

    /// Record a channel against an actor.
    ///
    /// Idempotent: the pairing path can run twice for one channel, and the old
    /// `Vec` would have grown a duplicate where the primary key here simply
    /// refuses the second. Delete-then-insert rather than an upsert, for the
    /// same portability reason as the stores.
    pub async fn push(&self, actor_id: &Uuid, channel_id: &str) -> Result<(), RegistryError> {
        let mut tx = crate::db::begin_write(&self.pool).await.map_err(RegistryError::new)?;

        sqlx::query("DELETE FROM actor_channels WHERE actor_id = $1 AND channel_id = $2")
            .bind(actor_id.to_string())
            .bind(channel_id)
            .execute(&mut *tx)
            .await
            .map_err(RegistryError::new)?;

        sqlx::query("INSERT INTO actor_channels (actor_id, channel_id) VALUES ($1, $2)")
            .bind(actor_id.to_string())
            .bind(channel_id)
            .execute(&mut *tx)
            .await
            .map_err(RegistryError::new)?;

        tx.commit().await.map_err(RegistryError::new)?;
        Ok(())
    }

    /// Drop one channel, so the roster stops reporting this actor as paired on
    /// a channel that no longer exists.
    pub async fn remove(&self, actor_id: &Uuid, channel_id: &str) -> Result<(), RegistryError> {
        sqlx::query("DELETE FROM actor_channels WHERE actor_id = $1 AND channel_id = $2")
            .bind(actor_id.to_string())
            .bind(channel_id)
            .execute(&self.pool)
            .await
            .map_err(RegistryError::new)?;
        Ok(())
    }

    /// Every channel this actor holds.
    pub async fn get(&self, actor_id: &Uuid) -> Result<Vec<String>, RegistryError> {
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT channel_id FROM actor_channels WHERE actor_id = $1 ORDER BY channel_id",
        )
        .bind(actor_id.to_string())
        .fetch_all(&self.pool)
        .await
        .map_err(RegistryError::new)?;

        Ok(rows.into_iter().map(|(c,)| c).collect())
    }
}

/// Helpers the operator has switched off to simulate being offline.
///
/// A row means disabled; absence means enabled. `deliver_message` consults this
/// for every actor, so "no row" is the hot path and is one indexed lookup.
pub struct DisabledHelpers {
    pool: sqlx::AnyPool,
}

impl DisabledHelpers {
    pub fn new(pool: sqlx::AnyPool) -> Self {
        Self { pool }
    }

    pub async fn is_disabled(&self, actor_id: &Uuid) -> Result<bool, RegistryError> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT actor_id FROM disabled_helpers WHERE actor_id = $1")
                .bind(actor_id.to_string())
                .fetch_optional(&self.pool)
                .await
                .map_err(RegistryError::new)?;

        Ok(row.is_some())
    }

    pub async fn set_disabled(&self, actor_id: &Uuid, disabled: bool) -> Result<(), RegistryError> {
        if disabled {
            let mut tx = crate::db::begin_write(&self.pool).await.map_err(RegistryError::new)?;

            sqlx::query("DELETE FROM disabled_helpers WHERE actor_id = $1")
                .bind(actor_id.to_string())
                .execute(&mut *tx)
                .await
                .map_err(RegistryError::new)?;

            sqlx::query("INSERT INTO disabled_helpers (actor_id) VALUES ($1)")
                .bind(actor_id.to_string())
                .execute(&mut *tx)
                .await
                .map_err(RegistryError::new)?;

            tx.commit().await.map_err(RegistryError::new)?;
        } else {
            sqlx::query("DELETE FROM disabled_helpers WHERE actor_id = $1")
                .bind(actor_id.to_string())
                .execute(&self.pool)
                .await
                .map_err(RegistryError::new)?;
        }
        Ok(())
    }
}

/// Contact messages posted by browser-managed participants for the owner to
/// fetch.
///
/// Read, not taken: `GET /helpers/:id/browser-contact` may be polled more than
/// once, and the old `DashMap::get` left the entry in place.
pub struct ParticipantContacts {
    pool: sqlx::AnyPool,
}

impl ParticipantContacts {
    pub fn new(pool: sqlx::AnyPool) -> Self {
        Self { pool }
    }

    /// Store a contact, replacing any previous one for this actor.
    pub async fn put(&self, actor_id: &Uuid, contact: &str) -> Result<(), RegistryError> {
        let mut tx = crate::db::begin_write(&self.pool).await.map_err(RegistryError::new)?;

        sqlx::query("DELETE FROM participant_contacts WHERE actor_id = $1")
            .bind(actor_id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(RegistryError::new)?;

        sqlx::query("INSERT INTO participant_contacts (actor_id, contact) VALUES ($1, $2)")
            .bind(actor_id.to_string())
            .bind(contact)
            .execute(&mut *tx)
            .await
            .map_err(RegistryError::new)?;

        tx.commit().await.map_err(RegistryError::new)?;
        Ok(())
    }

    pub async fn get(&self, actor_id: &Uuid) -> Result<Option<String>, RegistryError> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT contact FROM participant_contacts WHERE actor_id = $1")
                .bind(actor_id.to_string())
                .fetch_optional(&self.pool)
                .await
                .map_err(RegistryError::new)?;

        Ok(row.map(|(c,)| c))
    }
}
