// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, Extension};

use super::dtos::{EventQuery, EventsResponse};
use crate::handlers::extractors::ApiQuery;
use crate::handlers::response::ApiResponse;
use crate::middlewares::request_id::RequestId;
use crate::services::diagnostics::DiagnosticsService;

/// `GET /api/v1/debug/events?after=N&limit=M` — what the node did, in order,
/// after sequence `after`. A query that does not parse is a `400` in the error
/// envelope.
#[tracing::instrument(skip(diagnostics, request_id))]
pub async fn events(
    State(diagnostics): State<Arc<dyn DiagnosticsService>>,
    Extension(request_id): Extension<RequestId>,
    ApiQuery(query): ApiQuery<EventQuery>,
) -> ApiResponse<EventsResponse> {
    ApiResponse::ok(
        diagnostics.events(query.after, query.limit).into(),
        request_id,
    )
}
