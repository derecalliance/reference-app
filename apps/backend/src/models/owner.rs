// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Browser-run owners: registering one, and renaming it.

use uuid::Uuid;

/// What a browser context registers as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisterOwner {
    /// Display name of a new owner. Unused when claiming.
    pub name: String,
    /// When set, claim this existing owner's identity instead of minting one.
    ///
    /// Unauthenticated here — for a reference app, this is intentional. A
    /// claim keeps the actor's mailbox: whatever queued while no tab was
    /// polling is delivered on the claiming tab's first poll.
    pub claim_actor_id: Option<Uuid>,
}

/// An owner's name as stored after a rename.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenamedOwner {
    pub id: Uuid,
    /// Trimmed, which may differ from what was sent.
    pub name: String,
}
