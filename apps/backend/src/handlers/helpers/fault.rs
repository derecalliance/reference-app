// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, Extension};
use uuid::Uuid;

use super::dtos::{SetFaultRequest, SetFaultResponse};
use crate::handlers::errors::ApiError;
use crate::handlers::extractors::{ApiJson, ApiPath};
use crate::handlers::response::ApiResponse;
use crate::middlewares::request_id::RequestId;
use crate::services::helpers::HelperService;

/// `PUT /api/v1/helpers/{helper_id}/fault` — makes a provisioned helper
/// simulate a failure other than going offline: lost or corrupted shares, or
/// refusing to store or to verify. `{"fault": "none"}` restores it.
///
/// A property of the helper, seen by every owner it holds shares for. Only
/// this node's own helpers can simulate one: an owner is `400`, and a
/// browser-run participant, which has no store here, `404`.
#[tracing::instrument(skip(helpers, request_id, request))]
pub async fn set_fault(
    State(helpers): State<Arc<dyn HelperService>>,
    Extension(request_id): Extension<RequestId>,
    ApiPath(helper_id): ApiPath<Uuid>,
    ApiJson(request): ApiJson<SetFaultRequest>,
) -> Result<ApiResponse<SetFaultResponse>, ApiError> {
    let fault = helpers.set_fault(helper_id, request.fault.into()).await?;
    Ok(ApiResponse::ok(fault.into(), request_id))
}
