// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The node's registries, backed by SQL.
//!
//! These replace the `dashmap`s that used to live on `AppState`. One registry
//! deliberately did **not** move: `actor_inboxes` holds `actix::Addr`s, which
//! are live runtime handles with no serialised form, and is rebuilt when
//! actors are respawned. Browser mailboxes did move — see [`mailbox`] — because
//! what they hold is undelivered data, not a handle.

pub mod actors;
pub mod flags;
pub mod mailbox;

/// Why a registry operation failed.
///
/// One variant on purpose: every failure here is the database being
/// unreachable or a row being unreadable, and a caller can do nothing
/// different about either — they all become a 500.
#[derive(Debug, thiserror::Error)]
#[error("registry backend error: {0}")]
pub struct RegistryError(pub Box<dyn std::error::Error + Send + Sync + 'static>);

impl RegistryError {
    pub fn new<E: std::error::Error + Send + Sync + 'static>(e: E) -> Self {
        Self(Box::new(e))
    }

    /// For the cases that are a malformed row rather than a failed call.
    pub fn message(message: impl Into<String>) -> Self {
        Self(message.into().into())
    }
}
