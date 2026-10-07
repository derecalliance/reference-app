// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, Extension};

use super::dtos::{AddHelperRequest, AddHelperResponse};
use crate::handlers::errors::ApiError;
use crate::handlers::extractors::ApiJson;
use crate::handlers::response::ApiResponse;
use crate::middlewares::request_id::RequestId;
use crate::services::helpers::HelperService;

/// `POST /api/v1/helpers` — provisions one backend-run helper, answering `201`.
///
/// The caller supplies the protocol settings the new actor runs with; omitted
/// settings fall back to the operator defaults served at `GET /api/v1/config`.
/// A name another helper holds is `409 NAME_TAKEN`.
#[tracing::instrument(skip(helpers, request_id))]
pub async fn provision(
    State(helpers): State<Arc<dyn HelperService>>,
    Extension(request_id): Extension<RequestId>,
    ApiJson(request): ApiJson<AddHelperRequest>,
) -> Result<ApiResponse<AddHelperResponse>, ApiError> {
    let actor = helpers.add(request.into()).await?;
    Ok(ApiResponse::created(actor.into(), request_id))
}
