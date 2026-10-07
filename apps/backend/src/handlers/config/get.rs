// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, Extension};

use super::dtos::ConfigResponse;
use crate::handlers::response::ApiResponse;
use crate::middlewares::request_id::RequestId;
use crate::services::configuration::ConfigurationService;

/// `GET /api/v1/config` — operator-supplied starting values for the front-end
/// setup wizard, read from the config file at boot.
#[tracing::instrument(skip_all)]
pub async fn get(
    State(configuration): State<Arc<dyn ConfigurationService>>,
    Extension(request_id): Extension<RequestId>,
) -> ApiResponse<ConfigResponse> {
    ApiResponse::ok(configuration.frontend().into(), request_id)
}
