// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, Extension};
use uuid::Uuid;

use crate::handlers::errors::ApiError;
use crate::handlers::extractors::{ApiBytes, ApiPath};
use crate::handlers::response::ApiResponse;
use crate::middlewares::request_id::RequestId;
use crate::services::helpers::HelperService;

/// `POST /api/v1/helpers/{helper_id}/browser-contact` — stores the page's
/// serialized contact, a JSON object, to be handed back byte for byte.
/// Answers `200` with a `null` result.
///
/// Contacts are scoped to a secret: a node willing to help several owners
/// publishes one contact per owner secret.
#[tracing::instrument(skip(helpers, request_id, body))]
pub async fn publish(
    State(helpers): State<Arc<dyn HelperService>>,
    Extension(request_id): Extension<RequestId>,
    ApiPath(helper_id): ApiPath<Uuid>,
    ApiBytes(body): ApiBytes,
) -> Result<ApiResponse<()>, ApiError> {
    helpers.publish_browser_contact(helper_id, &body).await?;
    Ok(ApiResponse::ok((), request_id))
}
