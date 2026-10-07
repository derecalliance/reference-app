// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, Extension};

use super::dtos::StateResponse;
use crate::handlers::response::ApiResponse;
use crate::middlewares::request_id::RequestId;
use crate::services::diagnostics::DiagnosticsService;

/// `GET /api/v1/debug/state` — everything this node currently knows: its
/// advertised addresses, every actor and its channels, and the gRPC routes.
#[tracing::instrument(skip_all)]
pub async fn state(
    State(diagnostics): State<Arc<dyn DiagnosticsService>>,
    Extension(request_id): Extension<RequestId>,
) -> ApiResponse<StateResponse> {
    ApiResponse::ok(diagnostics.snapshot().await.into(), request_id)
}
