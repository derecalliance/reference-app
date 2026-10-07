// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! One id per request, so a caller's report and the node's logs can be lined
//! up.
//!
//! For every request this middleware:
//!
//! 1. takes the caller's `x-request-id` when it is a reasonable token (see
//!    [`RequestId::parse`]) and otherwise mints a UUID v4;
//! 2. puts it in a request extension, where a handler reads it with
//!    `Extension(request_id): Extension<RequestId>` to stamp a success
//!    envelope;
//! 3. opens a `request` tracing span carrying it, so every log line the
//!    request produces is tagged with it;
//! 4. scopes it for the error path ([`current`]): a refusal raised by an
//!    extractor or a fallback has no handler to hand it the extension, so the
//!    error envelope reads it from here;
//! 5. echoes it in the `x-request-id` response header.

use std::fmt;
use std::sync::Arc;

use axum::{
    extract::Request,
    http::{HeaderName, HeaderValue},
    middleware::Next,
    response::Response,
};
use serde::{Serialize, Serializer};
use tracing::Instrument;
use uuid::Uuid;

/// The header a request id travels in, both ways.
pub static REQUEST_ID_HEADER: HeaderName = HeaderName::from_static("x-request-id");

/// Longest caller-supplied id honoured. Long enough for any tracing scheme's
/// ids; short enough that a log line stays a log line.
const MAX_REQUEST_ID_LEN: usize = 128;

tokio::task_local! {
    static CURRENT: RequestId;
}

/// The id of the request being served.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestId(Arc<str>);

impl RequestId {
    /// A fresh UUID v4.
    pub fn generate() -> Self {
        Self(Uuid::new_v4().to_string().into())
    }

    /// A caller-supplied id, when it is a reasonable token: 1 to 128
    /// characters of ASCII letters, digits, `-`, `_`, `.` or `:`. Anything
    /// else — empty, oversized, or carrying characters that would need
    /// escaping in a log line — is replaced rather than echoed.
    pub fn parse(raw: &str) -> Option<Self> {
        let reasonable = !raw.is_empty()
            && raw.len() <= MAX_REQUEST_ID_LEN
            && raw
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'));
        reasonable.then(|| Self(raw.into()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for RequestId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Serialize for RequestId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

/// The id of the request this task is serving, if it runs under
/// [`request_id`].
pub fn current() -> Option<RequestId> {
    CURRENT.try_with(RequestId::clone).ok()
}

/// Assign, propagate and echo the request id. Registered with
/// `axum::middleware::from_fn`.
pub async fn request_id(mut request: Request, next: Next) -> Response {
    let request_id = request
        .headers()
        .get(&REQUEST_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(RequestId::parse)
        .unwrap_or_else(RequestId::generate);

    request.extensions_mut().insert(request_id.clone());

    let span = tracing::info_span!(
        "request",
        request_id = %request_id,
        method = %request.method(),
        path = %request.uri().path(),
    );

    let mut response = CURRENT
        .scope(request_id.clone(), next.run(request).instrument(span))
        .await;

    // Always valid: `parse` admits only visible ASCII, and a UUID is too.
    if let Ok(value) = HeaderValue::from_str(request_id.as_str()) {
        response
            .headers_mut()
            .insert(REQUEST_ID_HEADER.clone(), value);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_uuid_or_a_tracing_token_is_honoured() {
        for raw in ["0b9a0a4e-3f43-4b51-9a3c-0f1f5e3a2c11", "trace:abc.123_x-y"] {
            assert_eq!(
                RequestId::parse(raw).map(|id| id.to_string()),
                Some(raw.to_owned())
            );
        }
    }

    #[test]
    fn an_empty_oversized_or_unsafe_id_is_refused() {
        assert_eq!(RequestId::parse(""), None);
        assert_eq!(RequestId::parse(&"a".repeat(MAX_REQUEST_ID_LEN + 1)), None);
        assert_eq!(RequestId::parse("two words"), None);
        assert_eq!(RequestId::parse("line\nbreak"), None);
    }

    #[test]
    fn a_generated_id_is_a_uuid() {
        assert!(Uuid::parse_str(RequestId::generate().as_str()).is_ok());
    }

    #[test]
    fn no_id_is_current_outside_a_request() {
        assert_eq!(current(), None);
    }
}
