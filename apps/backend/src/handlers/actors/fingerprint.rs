// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, Extension};
use uuid::Uuid;

use super::dtos::{ChannelQueryParam, FingerprintResponse};
use crate::handlers::errors::ApiError;
use crate::handlers::extractors::{ApiPath, ApiQuery};
use crate::handlers::response::ApiResponse;
use crate::middlewares::request_id::RequestId;
use crate::services::actors::ActorService;

/// `GET /api/v1/actors/{actor_id}/fingerprint?channel_id=…` — the actor's own
/// fingerprint for `channel_id`, for out-of-band comparison. Both sides derive
/// the same value from the shared key.
#[tracing::instrument(skip(actors, request_id))]
pub async fn fingerprint(
    State(actors): State<Arc<dyn ActorService>>,
    Extension(request_id): Extension<RequestId>,
    ApiPath(actor_id): ApiPath<Uuid>,
    ApiQuery(query): ApiQuery<ChannelQueryParam>,
) -> Result<ApiResponse<FingerprintResponse>, ApiError> {
    let fingerprint = actors.fingerprint(actor_id, &query.channel_id).await?;
    Ok(ApiResponse::ok(fingerprint.into(), request_id))
}
