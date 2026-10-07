// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Helpers the operator has switched off to simulate being offline.

use async_trait::async_trait;
use uuid::Uuid;

use super::{begin_write, RepositoryError};

/// A row means disabled; absence means enabled. Every inbound delivery
/// consults this, so "no row" is the hot path and is one indexed lookup.
#[async_trait]
pub trait DisabledHelperRepository: Send + Sync {
    async fn is_disabled(&self, actor_id: &Uuid) -> Result<bool, RepositoryError>;
    /// Idempotent in both directions.
    async fn set_disabled(&self, actor_id: &Uuid, disabled: bool) -> Result<(), RepositoryError>;
}

pub struct SqlDisabledHelperRepository {
    pool: sqlx::AnyPool,
}

impl SqlDisabledHelperRepository {
    pub fn new(pool: sqlx::AnyPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl DisabledHelperRepository for SqlDisabledHelperRepository {
    async fn is_disabled(&self, actor_id: &Uuid) -> Result<bool, RepositoryError> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT actor_id FROM disabled_helpers WHERE actor_id = $1")
                .bind(actor_id.to_string())
                .fetch_optional(&self.pool)
                .await?;

        Ok(row.is_some())
    }

    async fn set_disabled(&self, actor_id: &Uuid, disabled: bool) -> Result<(), RepositoryError> {
        if disabled {
            // Delete-then-insert rather than an upsert: the portable form this
            // schema uses everywhere (see `sdk`).
            let mut tx = begin_write(&self.pool).await?;

            sqlx::query("DELETE FROM disabled_helpers WHERE actor_id = $1")
                .bind(actor_id.to_string())
                .execute(&mut *tx)
                .await?;

            sqlx::query("INSERT INTO disabled_helpers (actor_id) VALUES ($1)")
                .bind(actor_id.to_string())
                .execute(&mut *tx)
                .await?;

            tx.commit().await?;
        } else {
            sqlx::query("DELETE FROM disabled_helpers WHERE actor_id = $1")
                .bind(actor_id.to_string())
                .execute(&self.pool)
                .await?;
        }
        Ok(())
    }
}
