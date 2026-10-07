// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, Json};
use uuid::Uuid;

use super::dtos::PollMessagesResponse;
use crate::handlers::errors::ApiError;
use crate::handlers::extractors::ApiPath;
use crate::services::delivery::DeliveryService;

/// `GET /derec/{actor_id}/mailbox` — drains a browser actor's queue, oldest
/// first, as `{"messages": [{"data": "<base64url>"}]}`.
///
/// `404` for an id this node does not know; `400` for a provisioned actor,
/// whose messages go straight to its in-process instance and never queue.
#[tracing::instrument(skip(delivery))]
pub async fn mailbox(
    State(delivery): State<Arc<dyn DeliveryService>>,
    ApiPath(actor_id): ApiPath<Uuid>,
) -> Result<Json<PollMessagesResponse>, ApiError> {
    let messages = delivery.poll_mailbox(actor_id).await?;
    Ok(Json(messages.into()))
}
