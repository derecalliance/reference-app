// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, Extension};
use uuid::Uuid;

use super::dtos::{RenameOwnerRequest, RenameOwnerResponse};
use crate::handlers::errors::ApiError;
use crate::handlers::extractors::{ApiJson, ApiPath};
use crate::handlers::response::ApiResponse;
use crate::middlewares::request_id::RequestId;
use crate::services::owners::OwnerService;

/// `PATCH /api/v1/owners/{owner_id}` — renames a browser-managed owner.
///
/// `name` is held to the registration rules (trimmed, 1–64 characters, no
/// control characters) — `400` otherwise. An id naming no actor, or a helper,
/// is `404`: there is no owner by that id.
#[tracing::instrument(skip(owners, request_id))]
pub async fn rename(
    State(owners): State<Arc<dyn OwnerService>>,
    Extension(request_id): Extension<RequestId>,
    ApiPath(owner_id): ApiPath<Uuid>,
    ApiJson(request): ApiJson<RenameOwnerRequest>,
) -> Result<ApiResponse<RenameOwnerResponse>, ApiError> {
    let renamed = owners.rename(owner_id, &request.name).await?;
    Ok(ApiResponse::ok(renamed.into(), request_id))
}
