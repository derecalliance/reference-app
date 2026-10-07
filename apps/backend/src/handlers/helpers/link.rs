// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, Extension};
use uuid::Uuid;

use super::dtos::{LinkChannelsRequest, LinkChannelsResponse};
use crate::handlers::errors::ApiError;
use crate::handlers::extractors::{ApiJson, ApiPath};
use crate::handlers::response::ApiResponse;
use crate::middlewares::request_id::RequestId;
use crate::services::helpers::HelperService;

/// `POST /api/v1/helpers/{helper_id}/link` — declares that a newly paired
/// channel belongs to an owner the helper already helps.
///
/// That is an *authentication* step: nothing on the wire carries a trustworthy
/// identity, so an operator does it explicitly here. Both channels must be
/// helper channels this actor holds on its own instance — naming one it does
/// not hold is `404`.
#[tracing::instrument(skip(helpers, request_id))]
pub async fn link(
    State(helpers): State<Arc<dyn HelperService>>,
    Extension(request_id): Extension<RequestId>,
    ApiPath(helper_id): ApiPath<Uuid>,
    ApiJson(request): ApiJson<LinkChannelsRequest>,
) -> Result<ApiResponse<LinkChannelsResponse>, ApiError> {
    helpers
        .link_channels(helper_id, &request.channel_id, &request.link_to_channel_id)
        .await?;
    Ok(ApiResponse::ok(LinkChannelsResponse::LINKED, request_id))
}
