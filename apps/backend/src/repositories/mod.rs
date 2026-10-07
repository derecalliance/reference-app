// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Persistence, and only persistence.
//!
//! Each app repository is a trait — the port the services read and write
//! through, so they are tested without a database and never see SQL — and its
//! implementation: SQL over the node's pool, or in memory for the derived
//! indexes that are deliberately never persisted. No business rule lives here;
//! where a rule needs a read and a write to be atomic, the repository offers the
//! atomic primitive and the service supplies the rule (see
//! [`actors::ActorRepository::register_planned`]).
//!
//! The protocol's own stores are under [`sdk`]: they implement the SDK's
//! `DeRec*Store` traits, which are their ports.

pub mod actors;
pub mod advertised_addresses;
pub mod browser_contacts;
pub mod disabled_helpers;
pub mod helper_channels;
pub mod mailbox_polls;
pub mod mailboxes;
pub mod participant_data;
pub mod protocol_records;
pub mod sdk;
pub mod sharing_rounds;

/// Why a repository call failed.
#[derive(Debug, thiserror::Error)]
pub enum RepositoryError {
    /// The database refused or could not be reached.
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    /// A row was read but could not be turned back into what was stored.
    #[error("unreadable row: {0}")]
    Corrupt(String),
    /// A browser mailbox is at its cap; nothing was queued and nothing already
    /// queued was touched. See [`mailboxes::MAX_QUEUED_MESSAGES`].
    #[error("mailbox is full ({queued} messages, {bytes} bytes waiting)")]
    MailboxFull { queued: i64, bytes: i64 },
}

impl RepositoryError {
    /// A row that could not be decoded, for any decoding error.
    pub fn corrupt(e: impl std::fmt::Display) -> Self {
        Self::Corrupt(e.to_string())
    }
}

/// Open a transaction that will write.
///
/// On SQLite this is `BEGIN IMMEDIATE`, not the default deferred `BEGIN`. A
/// deferred transaction takes a read lock at its first read and asks for the
/// write lock only at its first write. Two of them in flight together both
/// hold the read lock and both ask to upgrade, and SQLite cannot let either
/// wait for the other without deadlocking — so it fails one *at once* with
/// `database is locked`, without consulting the busy timeout. Every writer
/// here reads before it writes (`register` reads `MAX(seq)`, the stores read
/// before they replace), so two browser tabs registering at the same moment
/// failed about half the time. `IMMEDIATE` takes the write lock up front: the
/// second writer queues behind the first for up to the busy timeout instead.
///
/// Postgres has no such upgrade and no such syntax, so it keeps the default.
pub async fn begin_write(
    pool: &sqlx::AnyPool,
) -> Result<sqlx::Transaction<'static, sqlx::Any>, sqlx::Error> {
    if pool.connect_options().database_url.scheme() == "sqlite" {
        pool.begin_with("BEGIN IMMEDIATE").await
    } else {
        pool.begin().await
    }
}
