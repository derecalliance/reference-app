// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use axum::http::StatusCode;

pub async fn handler() -> StatusCode {
    StatusCode::OK
}
