// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, Extension};
use uuid::Uuid;

use super::dtos::{ContactMessageDto, PairRoleQuery, StartPairingResponse};
use crate::handlers::errors::ApiError;
use crate::handlers::extractors::{ApiJson, ApiPath, ApiQuery};
use crate::handlers::response::ApiResponse;
use crate::middlewares::request_id::RequestId;
use crate::services::actors::ActorService;

/// `POST /api/v1/actors/{actor_id}/start-pairing?role=helper|owner` — has a
/// backend-run actor initiate pairing with the contact in the body, and
/// answers the transient pairing `channel_id`.
///
/// A contact the SDK refuses is `400`, not `500`: it is the caller's input.
#[tracing::instrument(skip(actors, request_id, contact))]
pub async fn start_pairing(
    State(actors): State<Arc<dyn ActorService>>,
    Extension(request_id): Extension<RequestId>,
    ApiPath(actor_id): ApiPath<Uuid>,
    ApiQuery(role): ApiQuery<PairRoleQuery>,
    ApiJson(contact): ApiJson<ContactMessageDto>,
) -> Result<ApiResponse<StartPairingResponse>, ApiError> {
    let channel_id = actors
        .start_pairing(actor_id, role.role, contact.into())
        .await?;
    Ok(ApiResponse::ok(channel_id.into(), request_id))
}
