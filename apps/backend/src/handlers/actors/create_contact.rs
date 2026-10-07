// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, Extension};
use uuid::Uuid;

use super::dtos::{ContactMessageDto, ContactModeQuery};
use crate::handlers::errors::ApiError;
use crate::handlers::extractors::{ApiPath, ApiQuery};
use crate::handlers::response::ApiResponse;
use crate::middlewares::request_id::RequestId;
use crate::services::actors::ActorService;

/// `POST /api/v1/actors/{actor_id}/contact` — has a provisioned actor mint a
/// contact message.
///
/// A browser actor mints its own (`400`); replica mode is selected by
/// `replica_for_owner_secret`, and refused for the actor's own secret (`400`)
/// and beyond the replica-instance limit (`409`).
#[tracing::instrument(skip(actors, request_id))]
pub async fn create_contact(
    State(actors): State<Arc<dyn ActorService>>,
    Extension(request_id): Extension<RequestId>,
    ApiPath(actor_id): ApiPath<Uuid>,
    ApiQuery(query): ApiQuery<ContactModeQuery>,
) -> Result<ApiResponse<ContactMessageDto>, ApiError> {
    let contact = actors.create_contact(actor_id, query.into()).await?;
    Ok(ApiResponse::ok(
        ContactMessageDto::from(&contact),
        request_id,
    ))
}
