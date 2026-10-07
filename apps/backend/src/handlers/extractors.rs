// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Extractors whose rejections are answered in the API's error envelope.
//!
//! Axum's own extractors reject a request before any handler runs, and answer
//! in their own way: a malformed body came back as `text/plain` naming the Rust
//! type it failed to become (`invalid type: sequence, expected struct
//! AddHelperRequest`), an unparseable id as `UUID parsing failed…`. A client —
//! or an agent reading the API — then needed two parsers and learned about this
//! crate's internals.
//!
//! So these wrap Axum's own and translate their rejections into [`ApiError`],
//! keeping the status Axum chose (400, 413, 415, 422) and replacing the body
//! with a sentence a caller can act on. Handlers use [`ApiJson`], [`ApiPath`],
//! [`ApiQuery`] and [`ApiBytes`] in place of the plain extractors.

use axum::{
    body::Bytes,
    extract::{
        rejection::{BytesRejection, JsonRejection, PathRejection, QueryRejection},
        FromRequest, FromRequestParts, OptionalFromRequest, Request,
    },
    http::{request::Parts, StatusCode},
    Json,
};
use serde::de::DeserializeOwned;

use super::errors::{ApiError, ErrorCode};

/// Reject a request whose JSON body is missing, malformed or the wrong shape.
impl From<JsonRejection> for ApiError {
    fn from(rejection: JsonRejection) -> Self {
        let status = rejection.status();
        let message = match status {
            StatusCode::UNSUPPORTED_MEDIA_TYPE => {
                "expected a JSON body with `Content-Type: application/json`".to_owned()
            }
            StatusCode::PAYLOAD_TOO_LARGE => "request body is too large".to_owned(),
            StatusCode::UNPROCESSABLE_ENTITY => format!(
                "request body has the wrong shape: {}",
                serde_detail(&rejection.body_text())
            ),
            StatusCode::BAD_REQUEST => format!(
                "request body is not valid JSON: {}",
                serde_detail(&rejection.body_text())
            ),
            _ => "request body could not be read".to_owned(),
        };
        Self::new(ErrorCode::for_rejection(status), message)
    }
}

/// Reject a path segment that does not parse — in this API, always an id.
impl From<PathRejection> for ApiError {
    fn from(rejection: PathRejection) -> Self {
        use axum::extract::path::ErrorKind;

        let message = match &rejection {
            PathRejection::FailedToDeserializePathParams(inner) => match inner.kind() {
                ErrorKind::ParseErrorAtKey { key, value, .. }
                | ErrorKind::DeserializeError { key, value, .. } => {
                    format!("`{key}` in the URL path is not valid: `{value}`")
                }
                // `Uuid` reports through serde's free-form channel, which is
                // where its "UUID parsing failed" text comes from.
                ErrorKind::Message(text) if text.contains("UUID") => {
                    "the id in the URL path is not a valid UUID".to_owned()
                }
                _ => "the URL path is not valid".to_owned(),
            },
            _ => "the URL path is not valid".to_owned(),
        };
        // Always a caller error, whatever Axum would have answered.
        Self::new(ErrorCode::BadRequest, message)
    }
}

/// Reject a query string that does not fit the parameters a route takes.
impl From<QueryRejection> for ApiError {
    fn from(rejection: QueryRejection) -> Self {
        Self::new(
            ErrorCode::BadRequest,
            format!(
                "query string is not valid: {}",
                serde_detail(&rejection.body_text())
            ),
        )
    }
}

/// Reject a raw body that could not be read — in practice, one over the limit.
impl From<BytesRejection> for ApiError {
    fn from(rejection: BytesRejection) -> Self {
        let status = rejection.status();
        let message = if status == StatusCode::PAYLOAD_TOO_LARGE {
            "request body is too large"
        } else {
            "request body could not be read"
        };
        Self::new(ErrorCode::for_rejection(status), message)
    }
}

// ── Extractors ──────────────────────────────────────────────────────────────

/// [`axum::Json`], with rejections answered in the API's error envelope.
pub struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        // Fully qualified: `Json` also implements `OptionalFromRequest`, whose
        // method has the same name.
        match <Json<T> as FromRequest<S>>::from_request(req, state).await {
            Ok(Json(value)) => Ok(Self(value)),
            Err(rejection) => Err(ApiError::from(rejection)),
        }
    }
}

/// `Option<ApiJson<T>>`: absent when the request carries no `Content-Type`.
///
/// Mirrors Axum's own rule for `Option<Json<T>>`, so a route with an optional
/// body behaves the same as before — only the rejection body changes. A body
/// sent *with* a JSON content type must still parse.
impl<S, T> OptionalFromRequest<S> for ApiJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Option<Self>, Self::Rejection> {
        match <Json<T> as OptionalFromRequest<S>>::from_request(req, state).await {
            Ok(value) => Ok(value.map(|Json(value)| Self(value))),
            Err(rejection) => Err(ApiError::from(rejection)),
        }
    }
}

/// [`axum::extract::Path`], with rejections answered in the API's error envelope.
pub struct ApiPath<T>(pub T);

impl<S, T> FromRequestParts<S> for ApiPath<T>
where
    T: DeserializeOwned + Send,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match <axum::extract::Path<T> as FromRequestParts<S>>::from_request_parts(parts, state)
            .await
        {
            Ok(axum::extract::Path(value)) => Ok(Self(value)),
            Err(rejection) => Err(ApiError::from(rejection)),
        }
    }
}

/// [`axum::extract::Query`], with rejections answered in the API's error envelope.
pub struct ApiQuery<T>(pub T);

impl<S, T> FromRequestParts<S> for ApiQuery<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match <axum::extract::Query<T> as FromRequestParts<S>>::from_request_parts(parts, state)
            .await
        {
            Ok(axum::extract::Query(value)) => Ok(Self(value)),
            Err(rejection) => Err(ApiError::from(rejection)),
        }
    }
}

/// A raw request body, with an over-limit body answered in the API's shape.
pub struct ApiBytes(pub Bytes);

impl<S> FromRequest<S> for ApiBytes
where
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match <Bytes as FromRequest<S>>::from_request(req, state).await {
            Ok(bytes) => Ok(Self(bytes)),
            Err(rejection) => Err(ApiError::from(rejection)),
        }
    }
}

// ── Message clean-up ────────────────────────────────────────────────────────

/// The part of a rejection's text worth showing, with Rust type names removed.
///
/// Axum prefixes the serde error with its own sentence (`Failed to deserialize
/// the JSON body into the target type: …`), and serde names the Rust type it
/// was building (`expected struct AddHelperRequest`, `expected u8`). Neither
/// means anything to a caller; the field path and the line/column do.
pub fn serde_detail(body_text: &str) -> String {
    let detail = body_text
        .split_once(": ")
        .map(|(_, rest)| rest)
        .unwrap_or(body_text);
    humanize_types(detail)
}

/// Replace the Rust-isms serde puts in its messages with JSON vocabulary.
fn humanize_types(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;

    // `struct Name`, `tuple struct Name`, `enum Name`, `struct variant Name::V`
    // — the noun is replaced and the identifier after it dropped.
    const NAMED: &[(&str, &str)] = &[
        ("tuple struct ", "a JSON array"),
        ("struct variant ", "a JSON object"),
        ("struct ", "a JSON object"),
        ("enum ", "one of the documented values"),
    ];

    'scan: while !rest.is_empty() {
        // Only at a word boundary, so `construct …` is not read as `struct …`.
        let at_word_start = !out.chars().next_back().is_some_and(char::is_alphanumeric);
        for (prefix, replacement) in NAMED.iter().filter(|_| at_word_start) {
            if let Some(after) = rest.strip_prefix(prefix) {
                let ident_len = after
                    .find(|c: char| !(c.is_alphanumeric() || c == '_' || c == ':'))
                    .unwrap_or(after.len());
                if ident_len > 0 {
                    out.push_str(replacement);
                    rest = &after[ident_len..];
                    continue 'scan;
                }
            }
        }
        let mut chars = rest.chars();
        if let Some(c) = chars.next() {
            out.push(c);
        }
        rest = chars.as_str();
    }

    // Integer widths, as serde spells them after "expected".
    for (rust, json) in [
        ("expected u8", "expected an integer from 0 to 255"),
        ("expected u16", "expected an integer from 0 to 65535"),
        (
            "expected u32",
            "expected a non-negative integer below 4294967296",
        ),
        ("expected u64", "expected a non-negative integer"),
        ("expected usize", "expected a non-negative integer"),
        ("expected i32", "expected an integer"),
        ("expected i64", "expected an integer"),
    ] {
        out = replace_word(&out, rust, json);
    }
    out
}

/// Replace `needle` only where it is not followed by another identifier
/// character, so `expected u8` does not also rewrite `expected u80`.
fn replace_word(haystack: &str, needle: &str, replacement: &str) -> String {
    let mut out = String::with_capacity(haystack.len());
    let mut rest = haystack;
    while let Some(at) = rest.find(needle) {
        let end = at + needle.len();
        let boundary = !matches!(
            rest[end..].chars().next(),
            Some(c) if c.is_alphanumeric() || c == '_'
        );
        out.push_str(&rest[..at]);
        out.push_str(if boundary { replacement } else { needle });
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_struct_name_is_replaced_with_json_vocabulary() {
        let text = "Failed to deserialize the JSON body into the target type: \
                    invalid type: sequence, expected struct AddHelperRequest at line 1 column 1";

        let shown = serde_detail(text);

        assert_eq!(
            shown,
            "invalid type: sequence, expected a JSON object at line 1 column 1"
        );
        assert!(!shown.contains("AddHelperRequest"));
    }

    #[test]
    fn integer_widths_read_as_ranges() {
        assert_eq!(
            humanize_types("total: invalid value: integer `300`, expected u8"),
            "total: invalid value: integer `300`, expected an integer from 0 to 255"
        );
    }

    #[test]
    fn a_field_path_and_missing_field_message_survive_untouched() {
        assert_eq!(
            serde_detail("Failed to deserialize: missing field `name` at line 1 column 2"),
            "missing field `name` at line 1 column 2"
        );
    }

    #[test]
    fn a_longer_identifier_is_not_mistaken_for_a_shorter_one() {
        assert_eq!(
            replace_word("expected u80", "expected u8", "X"),
            "expected u80"
        );
        assert_eq!(replace_word("expected u8,", "expected u8", "X"), "X,");
    }

    #[test]
    fn an_enum_name_is_dropped() {
        assert_eq!(
            humanize_types("expected enum TransportMode"),
            "expected one of the documented values"
        );
    }
}
