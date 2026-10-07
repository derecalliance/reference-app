// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, Extension};

use super::dtos::{RegisterOwnerRequest, RegisterOwnerResponse};
use crate::handlers::errors::ApiError;
use crate::handlers::extractors::ApiJson;
use crate::handlers::response::ApiResponse;
use crate::middlewares::request_id::RequestId;
use crate::services::owners::OwnerService;

/// `POST /api/v1/owners` — registers the calling browser context as an owner
/// actor and hands back a mailbox it can poll.
///
/// Every browser context that wants to take part does this once — there is no
/// wider container to join, so a second tab is simply a second owner on the
/// same server. Two modes, both answering `201`:
///   - **Normal**: mints a new owner actor. `name` is trimmed and must be
///     1–64 characters.
///   - **Claim** (when `claim_actor_id` is set): adopts an existing owner
///     actor's identity. `name` is not used — the actor keeps the one it has.
///     The mailbox is kept, not replaced: anything that queued for this actor
///     while no tab was polling is delivered on the claiming tab's first poll.
#[tracing::instrument(skip(owners, request_id))]
pub async fn register(
    State(owners): State<Arc<dyn OwnerService>>,
    Extension(request_id): Extension<RequestId>,
    ApiJson(request): ApiJson<RegisterOwnerRequest>,
) -> Result<ApiResponse<RegisterOwnerResponse>, ApiError> {
    let actor = owners.register(request.into()).await?;
    Ok(ApiResponse::created(actor.into(), request_id))
}
