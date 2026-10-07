// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, Extension};
use uuid::Uuid;

use super::dtos::{SetStatusRequest, ToggleStatusResponse};
use crate::handlers::errors::ApiError;
use crate::handlers::extractors::{ApiJson, ApiPath};
use crate::handlers::response::ApiResponse;
use crate::middlewares::request_id::RequestId;
use crate::services::helpers::HelperService;

/// `POST /api/v1/helpers/{helper_id}/toggle-status` — simulates the helper
/// going offline or back online.
///
/// The body is optional, and its absence means "toggle". Absence is decided
/// the way Axum decides it for an optional JSON body: **no `Content-Type`
/// header**. A request that does send `Content-Type: application/json` must
/// carry `{"disabled": bool}` — an empty or malformed body is `400`, a wrong
/// shape `422`, and any other content type `415`.
#[tracing::instrument(skip(helpers, request_id, body))]
pub async fn toggle_status(
    State(helpers): State<Arc<dyn HelperService>>,
    Extension(request_id): Extension<RequestId>,
    ApiPath(helper_id): ApiPath<Uuid>,
    body: Option<ApiJson<SetStatusRequest>>,
) -> Result<ApiResponse<ToggleStatusResponse>, ApiError> {
    let wanted = body.map(|ApiJson(request)| request.disabled);
    let disabled = helpers.toggle_status(helper_id, wanted).await?;
    Ok(ApiResponse::ok(disabled.into(), request_id))
}
