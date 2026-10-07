// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! How a refused request is answered: one [`ApiError`] for every failure — a
//! service's refusal, an extractor's rejection, a path or method no route
//! serves — rendered as the [`ErrorEnvelope`] with a stable [`ErrorCode`].
//!
//! Messages are shown to callers, so they never carry a connection string, a
//! file path or a Rust type name; detail of that kind is logged where the
//! error is raised instead.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

use super::response::ErrorEnvelope;
use crate::middlewares::request_id;
use crate::services::ServiceError;

/// The machine-readable half of an error. Status families each have one;
/// a condition a client branches on gets its own, so nobody matches on
/// message text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    BadRequest,
    Forbidden,
    NotFound,
    MethodNotAllowed,
    Conflict,
    PayloadTooLarge,
    UnsupportedMediaType,
    UnprocessableEntity,
    InternalError,
    BadGateway,
    ServiceUnavailable,
    /// `400`: the confirming side derived a different fingerprint — the
    /// man-in-the-middle case.
    FingerprintMismatch,
    /// `409`: another helper already holds that display name.
    NameTaken,
    /// `503`: the relay is switched off on this node; retrying will not help.
    RelayDisabled,
    /// `503`: the recipient's mailbox is full until it polls.
    MailboxFull,
}

impl ErrorCode {
    /// The HTTP status this code is answered with.
    pub fn status(self) -> StatusCode {
        match self {
            Self::BadRequest | Self::FingerprintMismatch => StatusCode::BAD_REQUEST,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::MethodNotAllowed => StatusCode::METHOD_NOT_ALLOWED,
            Self::Conflict | Self::NameTaken => StatusCode::CONFLICT,
            Self::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::UnsupportedMediaType => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Self::UnprocessableEntity => StatusCode::UNPROCESSABLE_ENTITY,
            Self::InternalError => StatusCode::INTERNAL_SERVER_ERROR,
            Self::BadGateway => StatusCode::BAD_GATEWAY,
            Self::ServiceUnavailable | Self::RelayDisabled | Self::MailboxFull => {
                StatusCode::SERVICE_UNAVAILABLE
            }
        }
    }

    /// The family code for a status an extractor chose. Only the statuses
    /// Axum's rejections produce are distinguished; anything else is the
    /// caller's request.
    pub fn for_rejection(status: StatusCode) -> Self {
        match status {
            StatusCode::PAYLOAD_TOO_LARGE => Self::PayloadTooLarge,
            StatusCode::UNSUPPORTED_MEDIA_TYPE => Self::UnsupportedMediaType,
            StatusCode::UNPROCESSABLE_ENTITY => Self::UnprocessableEntity,
            _ => Self::BadRequest,
        }
    }
}

/// An error answered as the error envelope, at its code's status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    pub code: ErrorCode,
    pub message: String,
}

impl ApiError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn status(&self) -> StatusCode {
        self.code.status()
    }
}

/// Every refusal a service answers with, at the status it has always had.
impl From<ServiceError> for ApiError {
    fn from(error: ServiceError) -> Self {
        let code = match &error {
            ServiceError::BadRequest(_) => ErrorCode::BadRequest,
            ServiceError::Forbidden(_) => ErrorCode::Forbidden,
            ServiceError::NotFound(_) => ErrorCode::NotFound,
            ServiceError::Conflict(_) => ErrorCode::Conflict,
            ServiceError::PayloadTooLarge(_) => ErrorCode::PayloadTooLarge,
            // Already generic: the service logged the detail when it raised it.
            ServiceError::Internal(_) => ErrorCode::InternalError,
            ServiceError::BadGateway(_) => ErrorCode::BadGateway,
            ServiceError::Unavailable(_) => ErrorCode::ServiceUnavailable,
            ServiceError::FingerprintMismatch => ErrorCode::FingerprintMismatch,
            ServiceError::RelayDisabled(_) => ErrorCode::RelayDisabled,
            ServiceError::MailboxFull(_) => ErrorCode::MailboxFull,
            ServiceError::NameTaken(_) => ErrorCode::NameTaken,
        };
        Self::new(code, error.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status();
        // Read from the middleware's scope rather than taken as a parameter:
        // an extractor rejection or a fallback has no handler to pass it in.
        let envelope = ErrorEnvelope::new(self.code, self.message, request_id::current());
        (status, Json(envelope)).into_response()
    }
}

// ── Fallbacks ───────────────────────────────────────────────────────────────

/// Every path no route matches. Registered with `Router::fallback`.
pub async fn route_not_found() -> ApiError {
    ApiError::new(
        ErrorCode::NotFound,
        "no such route — see openapi.yaml for what this server serves",
    )
}

/// A known path called with a method it does not serve. Registered with
/// `Router::method_not_allowed_fallback`; Axum still adds the `Allow` header.
pub async fn method_not_allowed() -> ApiError {
    ApiError::new(
        ErrorCode::MethodNotAllowed,
        "this route does not accept that method",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_service_refusal_keeps_its_status_and_its_message() {
        let cases = [
            (
                ServiceError::BadRequest("a".to_owned()),
                StatusCode::BAD_REQUEST,
                "BAD_REQUEST",
            ),
            (
                ServiceError::Forbidden("b".to_owned()),
                StatusCode::FORBIDDEN,
                "FORBIDDEN",
            ),
            (
                ServiceError::NotFound("c".to_owned()),
                StatusCode::NOT_FOUND,
                "NOT_FOUND",
            ),
            (
                ServiceError::Conflict("d".to_owned()),
                StatusCode::CONFLICT,
                "CONFLICT",
            ),
            (
                ServiceError::PayloadTooLarge("e".to_owned()),
                StatusCode::PAYLOAD_TOO_LARGE,
                "PAYLOAD_TOO_LARGE",
            ),
            (
                ServiceError::Internal("f".to_owned()),
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR",
            ),
            (
                ServiceError::BadGateway("g".to_owned()),
                StatusCode::BAD_GATEWAY,
                "BAD_GATEWAY",
            ),
            (
                ServiceError::Unavailable("h".to_owned()),
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVICE_UNAVAILABLE",
            ),
            (
                ServiceError::FingerprintMismatch,
                StatusCode::BAD_REQUEST,
                "FINGERPRINT_MISMATCH",
            ),
            (
                ServiceError::RelayDisabled("i".to_owned()),
                StatusCode::SERVICE_UNAVAILABLE,
                "RELAY_DISABLED",
            ),
            (
                ServiceError::MailboxFull("j".to_owned()),
                StatusCode::SERVICE_UNAVAILABLE,
                "MAILBOX_FULL",
            ),
            (
                ServiceError::NameTaken("k".to_owned()),
                StatusCode::CONFLICT,
                "NAME_TAKEN",
            ),
        ];

        for (error, status, code) in cases {
            let message = error.to_string();
            let api = ApiError::from(error);

            assert_eq!(api.status(), status);
            assert_eq!(api.message, message);
            assert_eq!(serde_json::to_value(api.code).expect("serializes"), code);
        }
    }

    #[test]
    fn a_mismatch_keeps_the_message_older_clients_matched_on() {
        assert_eq!(
            ApiError::from(ServiceError::FingerprintMismatch).message,
            "fingerprint mismatch"
        );
    }
}
