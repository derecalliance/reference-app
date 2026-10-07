// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Every address this node has advertised, so the record survives the very
//! restart that changes it.

use async_trait::async_trait;

use super::{begin_write, RepositoryError};

#[async_trait]
pub trait AdvertisedAddressRepository: Send + Sync {
    /// Every recorded `(kind, address)` row.
    async fn all(&self) -> Result<Vec<(String, String)>, RepositoryError>;
    /// Record one address under `kind`. Idempotent.
    async fn insert(&self, kind: &str, address: &str) -> Result<(), RepositoryError>;
}

pub struct SqlAdvertisedAddressRepository {
    pool: sqlx::AnyPool,
}

impl SqlAdvertisedAddressRepository {
    pub fn new(pool: sqlx::AnyPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl AdvertisedAddressRepository for SqlAdvertisedAddressRepository {
    async fn all(&self) -> Result<Vec<(String, String)>, RepositoryError> {
        Ok(
            sqlx::query_as("SELECT kind, address FROM advertised_addresses")
                .fetch_all(&self.pool)
                .await?,
        )
    }

    async fn insert(&self, kind: &str, address: &str) -> Result<(), RepositoryError> {
        // Delete-then-insert in one transaction, the portable upsert this
        // schema uses everywhere (see `sdk`).
        let mut tx = begin_write(&self.pool).await?;
        sqlx::query("DELETE FROM advertised_addresses WHERE kind = $1 AND address = $2")
            .bind(kind)
            .bind(address)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO advertised_addresses (kind, address) VALUES ($1, $2)")
            .bind(kind)
            .bind(address)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
}
