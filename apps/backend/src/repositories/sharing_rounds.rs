// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! How each sharing round ended, for the share store's `keep_list`.

use async_trait::async_trait;
use uuid::Uuid;

use super::sdk::id_to_text;
use super::{begin_write, RepositoryError};

/// The SDK keeps no record of which rounds committed, so the application has
/// to: [`super::sdk::share::SqlShareStore`]'s `keep_list` answers from these
/// rows.
#[async_trait]
pub trait SharingRoundRepository: Send + Sync {
    /// Record how the round for `version` on `(actor_id, secret_id)` ended. A
    /// second outcome for the same version replaces the first.
    async fn record(
        &self,
        actor_id: &Uuid,
        secret_id: u64,
        version: u32,
        committed: bool,
    ) -> Result<(), RepositoryError>;
}

pub struct SqlSharingRoundRepository {
    pool: sqlx::AnyPool,
}

impl SqlSharingRoundRepository {
    pub fn new(pool: sqlx::AnyPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl SharingRoundRepository for SqlSharingRoundRepository {
    async fn record(
        &self,
        actor_id: &Uuid,
        secret_id: u64,
        version: u32,
        committed: bool,
    ) -> Result<(), RepositoryError> {
        let actor = actor_id.to_string();
        let secret = id_to_text(secret_id);

        let mut tx = begin_write(&self.pool).await?;

        sqlx::query(
            "DELETE FROM sharing_rounds \
             WHERE actor_id = $1 AND secret_id = $2 AND version = $3",
        )
        .bind(&actor)
        .bind(&secret)
        .bind(i64::from(version))
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "INSERT INTO sharing_rounds (actor_id, secret_id, version, committed) \
             VALUES ($1, $2, $3, $4)",
        )
        .bind(&actor)
        .bind(&secret)
        .bind(i64::from(version))
        .bind(i64::from(committed))
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(())
    }
}
