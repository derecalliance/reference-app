// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, Extension};

use super::dtos::DebugConfigResponse;
use crate::handlers::response::ApiResponse;
use crate::middlewares::request_id::RequestId;
use crate::services::configuration::ConfigurationService;

/// `GET /api/v1/debug/config` — the resolved configuration and where each
/// value came from: the same data the boot banner renders.
///
/// Separate from `GET /api/v1/config`, whose result is the flat `Defaults` the
/// front end decodes. The database URL is redacted: a Postgres URL carries its
/// password, and this endpoint is unauthenticated.
#[tracing::instrument(skip_all)]
pub async fn config(
    State(configuration): State<Arc<dyn ConfigurationService>>,
    Extension(request_id): Extension<RequestId>,
) -> ApiResponse<DebugConfigResponse> {
    ApiResponse::ok(configuration.resolved().into(), request_id)
}
