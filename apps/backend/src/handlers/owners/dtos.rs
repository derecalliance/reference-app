// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::models::{Actor, RegisterOwner, RenamedOwner};

#[derive(Debug, Deserialize)]
pub struct RegisterOwnerRequest {
    /// Display name of the owner.
    pub name: String,
    /// When set, the caller **claims an existing owner actor's identity**
    /// rather than creating a new actor. Used by the recovery flow so a
    /// recovering user can resume polling the mailbox of an old owner whose
    /// helpers still hold the old transport URI on their channel records.
    ///
    /// The claim is **unauthenticated here** — for a reference app, this is
    /// intentional. A real app would gate this behind server-side auth.
    #[serde(default)]
    pub claim_actor_id: Option<Uuid>,
}

impl From<RegisterOwnerRequest> for RegisterOwner {
    fn from(request: RegisterOwnerRequest) -> Self {
        Self {
            name: request.name,
            claim_actor_id: request.claim_actor_id,
        }
    }
}

/// The registered (or claimed) owner actor, flattened.
#[derive(Debug, Serialize)]
pub struct RegisterOwnerResponse {
    #[serde(flatten)]
    pub actor: Actor,
}

impl From<Actor> for RegisterOwnerResponse {
    fn from(actor: Actor) -> Self {
        Self { actor }
    }
}

/// `PATCH /api/v1/owners/{owner_id}`: the owner's new display name, held to the same
/// rules as a name given at registration.
#[derive(Debug, Deserialize)]
pub struct RenameOwnerRequest {
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct RenameOwnerResponse {
    pub id: Uuid,
    /// The name as stored — trimmed, which may differ from what was sent.
    pub name: String,
}

impl From<RenamedOwner> for RenameOwnerResponse {
    fn from(renamed: RenamedOwner) -> Self {
        Self {
            id: renamed.id,
            name: renamed.name,
        }
    }
}
