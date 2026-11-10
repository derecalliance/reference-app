// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The failure each provisioned helper simulates — see [`HelperFault`].

use async_trait::async_trait;
use uuid::Uuid;

use super::{begin_write, RepositoryError};
use crate::models::HelperFault;

/// A row names the fault; absence means [`HelperFault::None`]. The share store
/// consults this on every read, so "no row" is the hot path and one indexed
/// lookup.
#[async_trait]
pub trait HelperFaultRepository: Send + Sync {
    async fn fault(&self, actor_id: &Uuid) -> Result<HelperFault, RepositoryError>;
    /// Idempotent; [`HelperFault::None`] removes the row.
    async fn set_fault(&self, actor_id: &Uuid, fault: HelperFault) -> Result<(), RepositoryError>;
}

pub struct SqlHelperFaultRepository {
    pool: sqlx::AnyPool,
}

impl SqlHelperFaultRepository {
    pub fn new(pool: sqlx::AnyPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl HelperFaultRepository for SqlHelperFaultRepository {
    async fn fault(&self, actor_id: &Uuid) -> Result<HelperFault, RepositoryError> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT fault FROM helper_faults WHERE actor_id = $1")
                .bind(actor_id.to_string())
                .fetch_optional(&self.pool)
                .await?;

        match row {
            None => Ok(HelperFault::None),
            Some((fault,)) => {
                HelperFault::try_from(fault.as_str()).map_err(RepositoryError::corrupt)
            }
        }
    }

    async fn set_fault(&self, actor_id: &Uuid, fault: HelperFault) -> Result<(), RepositoryError> {
        // Delete-then-insert rather than an upsert: the portable form this
        // schema uses everywhere (see `sdk`).
        let mut tx = begin_write(&self.pool).await?;

        sqlx::query("DELETE FROM helper_faults WHERE actor_id = $1")
            .bind(actor_id.to_string())
            .execute(&mut *tx)
            .await?;

        if fault != HelperFault::None {
            sqlx::query("INSERT INTO helper_faults (actor_id, fault) VALUES ($1, $2)")
                .bind(actor_id.to_string())
                .bind(fault.as_str())
                .execute(&mut *tx)
                .await?;
        }

        tx.commit().await?;
        Ok(())
    }
}
