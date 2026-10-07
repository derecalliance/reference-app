// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, http::StatusCode};

use super::dtos::RelayRequestDto;
use crate::handlers::errors::ApiError;
use crate::handlers::extractors::ApiJson;
use crate::services::delivery::DeliveryService;

/// `POST /derec/relay` — dials an endpoint on a browser owner's behalf.
/// Answers `202` with an empty body.
///
/// A browser has no HTTP/2 trailer access and so cannot speak gRPC; the
/// backend already terminates transport for every actor here, so performing
/// the dial is a small extension of that rather than a new role. A target on
/// this node is delivered in-process instead of dialled.
///
/// `data` must be a DeRec envelope naming a channel: anything else is refused
/// with `400` before any delivery, rather than surfacing as the peer's `502`.
/// A relay switched off on this node is `503 RELAY_DISABLED`. Every refusal is
/// recorded in `/api/v1/debug/events` with its reason.
#[tracing::instrument(skip(delivery, request), fields(uri = %request.uri))]
pub async fn relay(
    State(delivery): State<Arc<dyn DeliveryService>>,
    ApiJson(request): ApiJson<RelayRequestDto>,
) -> Result<StatusCode, ApiError> {
    delivery.relay(request.into()).await?;
    Ok(StatusCode::ACCEPTED)
}
