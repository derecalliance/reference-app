// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, http::StatusCode};
use uuid::Uuid;

use crate::handlers::errors::ApiError;
use crate::handlers::extractors::{ApiBytes, ApiPath};
use crate::services::delivery::DeliveryService;

/// `POST /derec/{actor_id}` — the transport endpoint peers post protocol
/// messages to. Answers `202` with an empty body.
///
/// The actor id is a UUID and identifies the actor by itself — there is no
/// role segment to check.
#[tracing::instrument(skip(delivery, body), fields(bytes = body.len()))]
pub async fn deliver(
    State(delivery): State<Arc<dyn DeliveryService>>,
    ApiPath(actor_id): ApiPath<Uuid>,
    ApiBytes(body): ApiBytes,
) -> Result<StatusCode, ApiError> {
    delivery.deliver(actor_id, body.to_vec()).await?;
    Ok(StatusCode::ACCEPTED)
}
