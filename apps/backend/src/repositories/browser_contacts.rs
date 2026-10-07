// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Contacts posted by browser-managed participants for an owner to fetch.

use async_trait::async_trait;
use uuid::Uuid;

use super::{begin_write, RepositoryError};

/// Read, not taken: `GET /api/v1/helpers/:id/browser-contact` may be polled more than
/// once.
#[async_trait]
pub trait BrowserContactRepository: Send + Sync {
    /// Store a contact, replacing any previous one for this actor.
    async fn put(&self, actor_id: &Uuid, contact: &str) -> Result<(), RepositoryError>;
    async fn get(&self, actor_id: &Uuid) -> Result<Option<String>, RepositoryError>;
}

pub struct SqlBrowserContactRepository {
    pool: sqlx::AnyPool,
}

impl SqlBrowserContactRepository {
    pub fn new(pool: sqlx::AnyPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl BrowserContactRepository for SqlBrowserContactRepository {
    async fn put(&self, actor_id: &Uuid, contact: &str) -> Result<(), RepositoryError> {
        let mut tx = begin_write(&self.pool).await?;

        sqlx::query("DELETE FROM participant_contacts WHERE actor_id = $1")
            .bind(actor_id.to_string())
            .execute(&mut *tx)
            .await?;

        sqlx::query("INSERT INTO participant_contacts (actor_id, contact) VALUES ($1, $2)")
            .bind(actor_id.to_string())
            .bind(contact)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        Ok(())
    }

    async fn get(&self, actor_id: &Uuid) -> Result<Option<String>, RepositoryError> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT contact FROM participant_contacts WHERE actor_id = $1")
                .bind(actor_id.to_string())
                .fetch_optional(&self.pool)
                .await?;

        Ok(row.map(|(c,)| c))
    }
}
