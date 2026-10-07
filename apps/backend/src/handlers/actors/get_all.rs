// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, Extension};

use super::dtos::ListActorsResponse;
use crate::handlers::errors::ApiError;
use crate::handlers::response::ApiResponse;
use crate::middlewares::request_id::RequestId;
use crate::services::actors::ActorService;

/// `GET /api/v1/actors` — every actor registered on this node, enriched with
/// live pairing status, in registration order. This is how a browser context
/// discovers its peers.
#[tracing::instrument(skip_all)]
pub async fn get_all(
    State(actors): State<Arc<dyn ActorService>>,
    Extension(request_id): Extension<RequestId>,
) -> Result<ApiResponse<ListActorsResponse>, ApiError> {
    let listings = actors.list().await?;
    Ok(ApiResponse::ok(listings.into(), request_id))
}
