// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, Extension};
use uuid::Uuid;

use super::dtos::{ConfirmFingerprintBody, ConfirmFingerprintResponse};
use crate::handlers::errors::ApiError;
use crate::handlers::extractors::{ApiJson, ApiPath};
use crate::handlers::response::ApiResponse;
use crate::middlewares::request_id::RequestId;
use crate::services::actors::ActorService;

/// `POST /api/v1/actors/{actor_id}/confirm-fingerprint` — promotes the actor's
/// side of the channel from `Pending` to `Paired`.
///
/// A mismatch is `400` with code `FINGERPRINT_MISMATCH` and leaves the channel
/// `Pending` — the man-in-the-middle case, where the two sides derived
/// different shared keys, which must reach the operator rather than be
/// retried.
#[tracing::instrument(skip(actors, request_id))]
pub async fn confirm_fingerprint(
    State(actors): State<Arc<dyn ActorService>>,
    Extension(request_id): Extension<RequestId>,
    ApiPath(actor_id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<ConfirmFingerprintBody>,
) -> Result<ApiResponse<ConfirmFingerprintResponse>, ApiError> {
    actors
        .confirm_fingerprint(actor_id, &body.channel_id, body.fingerprint)
        .await?;
    Ok(ApiResponse::ok(
        ConfirmFingerprintResponse::CONFIRMED,
        request_id,
    ))
}
