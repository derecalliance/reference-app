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
    http::{header, request::Parts, StatusCode},
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

/// The body a route that also speaks protobuf should answer with, negotiated
/// from the request's `Accept` header.
///
/// JSON — the envelope — unless the caller ranks `application/octet-stream`
/// strictly above `application/json`. A missing header, `*/*`, a tie, or a
/// header naming neither all get JSON, so the UI and any client that does not
/// ask are unaffected. Only the success body is negotiated; errors are always
/// the JSON envelope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseFormat {
    Json,
    Protobuf,
}

impl ResponseFormat {
    /// The media type a [`ResponseFormat::Protobuf`] body is served as.
    pub const PROTOBUF_MEDIA_TYPE: &'static str = "application/octet-stream";

    /// Pick the format from an `Accept` header value.
    fn from_accept(accept: &str) -> Self {
        let json = accept_quality(accept, "application", "json");
        let protobuf = accept_quality(accept, "application", "octet-stream");
        if protobuf > json {
            Self::Protobuf
        } else {
            Self::Json
        }
    }
}

impl<S> FromRequestParts<S> for ResponseFormat
where
    S: Send + Sync,
{
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        // Repeated `Accept` headers are one comma-separated list (RFC 9110 §5.3).
        let accept = parts
            .headers
            .get_all(header::ACCEPT)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .collect::<Vec<_>>()
            .join(",");
        Ok(Self::from_accept(&accept))
    }
}

/// The quality (`q`, in thousandths) an `Accept` header gives `type/subtype`,
/// taken from the most specific media range that covers it — exact, then
/// `type/*`, then `*/*` — per RFC 9110 §12.5.1. `0` when nothing covers it.
fn accept_quality(accept: &str, main_type: &str, subtype: &str) -> u16 {
    accept
        .split(',')
        .filter_map(|range| {
            let mut params = range.split(';').map(str::trim);
            let (range_type, range_subtype) = params.next()?.split_once('/')?;
            let specificity = match (range_type, range_subtype) {
                (t, s) if t.eq_ignore_ascii_case(main_type) && s.eq_ignore_ascii_case(subtype) => 2,
                (t, "*") if t.eq_ignore_ascii_case(main_type) => 1,
                ("*", "*") => 0,
                _ => return None,
            };
            let quality = params
                .filter_map(|param| param.split_once('='))
                .find(|(name, _)| name.trim().eq_ignore_ascii_case("q"))
                .map_or(1000, |(_, value)| parse_quality(value.trim()));
            Some((specificity, quality))
        })
        .max_by_key(|(specificity, _)| *specificity)
        .map_or(0, |(_, quality)| quality)
}

/// A `qvalue` (`0` to `1`, up to three decimals) in thousandths; anything
/// unparseable counts as `0`, so a malformed range never wins.
fn parse_quality(value: &str) -> u16 {
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if fraction.len() > 3 || !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return 0;
    }
    let thousandths: u16 = format!("{fraction:0<3}").parse().unwrap_or(0);
    match whole {
        "1" if thousandths == 0 => 1000,
        "0" => thousandths,
        _ => 0,
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
    fn json_is_the_format_unless_octet_stream_is_ranked_above_it() {
        use ResponseFormat::{Json, Protobuf};

        for (accept, expected) in [
            ("", Json),
            ("*/*", Json),
            ("application/json", Json),
            ("text/html", Json),
            ("application/octet-stream", Protobuf),
            ("APPLICATION/Octet-Stream", Protobuf),
            ("application/octet-stream, application/json", Json),
            ("application/octet-stream, application/json;q=0.9", Protobuf),
            ("application/json;q=0.5, application/octet-stream", Protobuf),
            ("application/octet-stream;q=0.8, */*;q=0.1", Protobuf),
            ("application/octet-stream;q=0", Json),
            ("application/*, application/json;q=0.2", Protobuf),
            ("application/octet-stream;q=nonsense", Json),
            ("application/octet-stream ; Q=1.0", Protobuf),
        ] {
            assert_eq!(ResponseFormat::from_accept(accept), expected, "{accept:?}");
        }
    }

    #[test]
    fn a_quality_value_reads_in_thousandths() {
        assert_eq!(parse_quality("1"), 1000);
        assert_eq!(parse_quality("1.000"), 1000);
        assert_eq!(parse_quality("0.5"), 500);
        assert_eq!(parse_quality("0.125"), 125);
        assert_eq!(parse_quality("0"), 0);
        assert_eq!(parse_quality("1.5"), 0);
        assert_eq!(parse_quality("0.1234"), 0);
        assert_eq!(parse_quality("2"), 0);
    }

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
