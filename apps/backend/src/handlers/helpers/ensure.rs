// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, Extension};

use super::dtos::{EnsureHelpersRequest, EnsureHelpersResponse};
use crate::handlers::errors::ApiError;
use crate::handlers::extractors::ApiJson;
use crate::handlers::response::ApiResponse;
use crate::middlewares::request_id::RequestId;
use crate::services::helpers::HelperService;

/// `POST /api/v1/helpers/ensure` — brings the shared helper pool up to
/// `total`, provisioning only the shortfall.
///
/// Every owner pairs with the same fixtures, so a second owner asking for
/// seven when seven already exist gets those seven, and asking for fewer than
/// exist removes nothing.
#[tracing::instrument(skip(helpers, request_id))]
pub async fn ensure(
    State(helpers): State<Arc<dyn HelperService>>,
    Extension(request_id): Extension<RequestId>,
    ApiJson(request): ApiJson<EnsureHelpersRequest>,
) -> Result<ApiResponse<EnsureHelpersResponse>, ApiError> {
    let pool = helpers.ensure(request.into()).await?;
    Ok(ApiResponse::ok(pool.into(), request_id))
}
