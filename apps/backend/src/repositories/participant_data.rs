// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Everything stored under one actor's id, for erasing a participant.

use async_trait::async_trait;
use uuid::Uuid;

use super::RepositoryError;

/// Every table keyed by `actor_id`, in an order safe to delete in.
///
/// `actors` is deliberately absent — the registry row is removed last and
/// separately ([`super::actors::ActorRepository::remove`]), so a failure
/// partway through leaves the participant still registered and therefore still
/// visible, rather than a registry entry whose data is gone.
const ACTOR_SCOPED_TABLES: &[&str] = &[
    "channel_links",
    "channels",
    "secrets",
    "user_secrets",
    "shares",
    "sharing_rounds",
    "state_items",
    "actor_channels",
    "disabled_helpers",
    "participant_contacts",
    "mailbox",
];

#[async_trait]
pub trait ParticipantDataRepository: Send + Sync {
    /// Delete every row stored under `actor_id`, except its registry row.
    async fn erase(&self, actor_id: &Uuid) -> Result<(), RepositoryError>;
}

pub struct SqlParticipantDataRepository {
    pool: sqlx::AnyPool,
}

impl SqlParticipantDataRepository {
    pub fn new(pool: sqlx::AnyPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl ParticipantDataRepository for SqlParticipantDataRepository {
    async fn erase(&self, actor_id: &Uuid) -> Result<(), RepositoryError> {
        let id = actor_id.to_string();
        for table in ACTOR_SCOPED_TABLES {
            // Table names come from the constant above, never from a caller.
            let sql = format!("DELETE FROM {table} WHERE actor_id = $1");
            sqlx::query(&sql).bind(&id).execute(&self.pool).await?;
        }
        Ok(())
    }
}
