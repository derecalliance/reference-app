// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! When each browser-managed actor last drained its mailbox.

use dashmap::DashMap;
use uuid::Uuid;

/// Served as `last_polled_at` on `GET /api/v1/actors`, so a peer can tell a tab that
/// is open from one that was closed hours ago.
///
/// In memory on purpose, and so it resets on restart: it describes this
/// process's view of a live tab, and a value carried across a restart would
/// claim a tab was polling a node that was not running.
pub trait MailboxPollRepository: Send + Sync {
    /// Record a successful drain at `at_unix_ms`.
    fn record(&self, actor_id: Uuid, at_unix_ms: u64);
    /// The last successful drain, in Unix milliseconds.
    fn last(&self, actor_id: &Uuid) -> Option<u64>;
}

#[derive(Debug, Default)]
pub struct InMemoryMailboxPolls {
    polls: DashMap<Uuid, u64>,
}

impl InMemoryMailboxPolls {
    pub fn new() -> Self {
        Self::default()
    }
}

impl MailboxPollRepository for InMemoryMailboxPolls {
    fn record(&self, actor_id: Uuid, at_unix_ms: u64) {
        self.polls.insert(actor_id, at_unix_ms);
    }

    fn last(&self, actor_id: &Uuid) -> Option<u64> {
        self.polls.get(actor_id).map(|at| *at.value())
    }
}
