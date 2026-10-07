// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The one envelope every `/api/v1` answer travels in.
//!
//! ```json
//! { "result": { … }, "timestamp": "2026-10-07T12:00:00.000Z", "request_id": "…" }
//! { "error": { "code": "NOT_FOUND", "message": "…" }, "timestamp": "…", "request_id": "…" }
//! ```
//!
//! `timestamp` is RFC 3339 UTC, taken when the answer is built. `request_id`
//! is the id the [`crate::middlewares::request_id`] middleware assigned — the
//! caller's own `x-request-id` when it sent a usable one — and is omitted only
//! when no id is in scope. A `204` stays bodyless.
//!
//! The DeRec transport (`/derec/*`) and `/health` keep their own success
//! bodies, which other implementations read; their errors use
//! [`ErrorEnvelope`] like everything else.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

use super::errors::ErrorCode;
use crate::middlewares::request_id::RequestId;
use crate::utils::time::{now_unix_ms, rfc3339_from_unix_ms};

/// A successful answer: `result` in the envelope, at `status`.
#[derive(Debug)]
pub struct ApiResponse<T> {
    status: StatusCode,
    body: SuccessEnvelope<T>,
}

/// The success body: `{"result", "timestamp", "request_id"}`.
#[derive(Debug, Serialize)]
pub struct SuccessEnvelope<T> {
    pub result: T,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<RequestId>,
}

impl<T: Serialize> ApiResponse<T> {
    /// `200 OK` carrying `result`.
    pub fn ok(result: T, request_id: RequestId) -> Self {
        Self::with_status(StatusCode::OK, result, request_id)
    }

    /// `201 Created` carrying `result`.
    pub fn created(result: T, request_id: RequestId) -> Self {
        Self::with_status(StatusCode::CREATED, result, request_id)
    }

    fn with_status(status: StatusCode, result: T, request_id: RequestId) -> Self {
        Self {
            status,
            body: SuccessEnvelope {
                result,
                timestamp: now(),
                request_id: Some(request_id),
            },
        }
    }
}

impl<T: Serialize> IntoResponse for ApiResponse<T> {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}

/// The error body: `{"error": {"code", "message"}, "timestamp", "request_id"}`.
#[derive(Debug, Serialize)]
pub struct ErrorEnvelope {
    pub error: ErrorDetail,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<RequestId>,
}

/// What went wrong: a stable `code` to branch on and a `message` to show.
#[derive(Debug, Serialize)]
pub struct ErrorDetail {
    pub code: ErrorCode,
    pub message: String,
}

impl ErrorEnvelope {
    pub fn new(code: ErrorCode, message: String, request_id: Option<RequestId>) -> Self {
        Self {
            error: ErrorDetail { code, message },
            timestamp: now(),
            request_id,
        }
    }
}

/// Now, as RFC 3339 UTC with milliseconds.
fn now() -> String {
    rfc3339_from_unix_ms(now_unix_ms())
}
