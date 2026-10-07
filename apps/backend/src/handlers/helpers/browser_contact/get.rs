// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, Extension};
use uuid::Uuid;

use crate::handlers::errors::ApiError;
use crate::handlers::extractors::ApiPath;
use crate::handlers::helpers::dtos::BrowserContactResponse;
use crate::handlers::response::ApiResponse;
use crate::middlewares::request_id::RequestId;
use crate::services::helpers::HelperService;

/// `GET /api/v1/helpers/{helper_id}/browser-contact` — the stored contact as
/// the `result`, exactly as it was posted. `404` until one is published.
#[tracing::instrument(skip(helpers, request_id))]
pub async fn get(
    State(helpers): State<Arc<dyn HelperService>>,
    Extension(request_id): Extension<RequestId>,
    ApiPath(helper_id): ApiPath<Uuid>,
) -> Result<ApiResponse<BrowserContactResponse>, ApiError> {
    let contact = helpers.browser_contact(helper_id).await?;
    Ok(ApiResponse::ok(contact.try_into()?, request_id))
}
