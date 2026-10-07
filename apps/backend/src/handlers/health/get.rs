// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use axum::http::StatusCode;

/// `GET /health` — `200` with an empty body while the HTTP listener answers.
#[tracing::instrument]
pub async fn get() -> StatusCode {
    StatusCode::OK
}
