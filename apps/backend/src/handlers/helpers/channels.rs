// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, Extension};
use uuid::Uuid;

use super::dtos::ListChannelsResponse;
use crate::handlers::errors::ApiError;
use crate::handlers::extractors::ApiPath;
use crate::handlers::response::ApiResponse;
use crate::middlewares::request_id::RequestId;
use crate::services::helpers::HelperService;

/// `GET /api/v1/helpers/{helper_id}/channels` — every channel this actor
/// holds, so an operator can pick which one a newly paired owner should be
/// linked to.
#[tracing::instrument(skip(helpers, request_id))]
pub async fn channels(
    State(helpers): State<Arc<dyn HelperService>>,
    Extension(request_id): Extension<RequestId>,
    ApiPath(helper_id): ApiPath<Uuid>,
) -> Result<ApiResponse<ListChannelsResponse>, ApiError> {
    let channels = helpers.list_channels(helper_id).await?;
    Ok(ApiResponse::ok(channels.into(), request_id))
}
