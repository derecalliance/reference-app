// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{extract::State, http::StatusCode};
use uuid::Uuid;

use crate::handlers::errors::ApiError;
use crate::handlers::extractors::ApiPath;
use crate::services::helpers::HelperService;

/// `DELETE /api/v1/helpers/{helper_id}` — erases a provisioned participant:
/// its actor, its stores and its registry entry. Answers `204` with no body.
///
/// The pool is server-wide, so this affects every owner using it — and an
/// owner paired with it keeps its channel, which from then on behaves like a
/// peer that has gone offline.
#[tracing::instrument(skip(helpers))]
pub async fn delete(
    State(helpers): State<Arc<dyn HelperService>>,
    ApiPath(helper_id): ApiPath<Uuid>,
) -> Result<StatusCode, ApiError> {
    helpers.delete(helper_id).await?;
    Ok(StatusCode::NO_CONTENT)
}
