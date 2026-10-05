// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! One error shape for every response this API sends: `{"error": "..."}`.
//!
//! The app's own handlers always answered that way, but anything Axum rejected
//! before a handler ran did not: a malformed body came back as `text/plain`
//! naming the Rust type it failed to become (`invalid type: sequence, expected
//! struct AddHelperRequest`), an unparseable id as `UUID parsing failed…`, and
//! an unknown path or method as an empty body. A client — or an agent reading
//! the API — then needed two parsers and learned about this crate's internals.
//!
//! So the extractors here wrap Axum's own and translate their rejections into
//! [`ApiError`], keeping the status Axum chose (400, 413, 415, 422) and
//! replacing the body with a sentence a caller can act on. Handlers use
//! [`ApiJson`], [`ApiPath`], [`ApiQuery`] and [`ApiBytes`] in place of the
//! plain extractors; [`route_not_found`] and [`method_not_allowed`] cover what
//! no handler sees at all.

use axum::{
    body::Bytes,
    extract::{
        rejection::{BytesRejection, JsonRejection, PathRejection, QueryRejection},
        FromRequest, FromRequestParts, OptionalFromRequest, Request,
    },
    http::{request::Parts, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::de::DeserializeOwned;

/// An error answered as `{"error": message}` with `status`.
///
/// `message` is shown to callers, so it never carries a connection string, a
/// file path or a Rust type name — detail of that kind is logged where the
/// error is raised instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, message)
    }

    pub fn service_unavailable(message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, message)
    }

    pub fn bad_gateway(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, message)
    }

    /// The actor's mailbox refused or dropped the message — it stopped, or
    /// is shutting down ahead of deletion. Transient from the caller's side.
    pub fn actor_unavailable(e: actix::MailboxError) -> Self {
        tracing::error!(error = %e, "actor mailbox unavailable");
        Self::service_unavailable("actor is not running; try again shortly")
    }

    /// Map an SDK error raised while serving a request.
    ///
    /// `context` names the operation (`"pairing"`, `"fingerprint"`) so the
    /// message says what failed. The split is by who can fix it: a contact or
    /// input the SDK refused is the caller's (400); a channel already paired is
    /// a state conflict (409); an instance busy with another call is
    /// transient (503); a delivery the transport could not make is the peer's
    /// (502); anything else is ours (500).
    pub fn from_protocol(context: &str, e: &derec_library::Error) -> Self {
        use derec_library::Error as E;

        match e {
            E::Pairing(_)
            | E::InvalidInput(_)
            | E::Transport(_)
            | E::NoUsableEndpoint { .. }
            | E::ProtobufDecode(_)
            | E::RoleMismatch { .. } => Self::bad_request(format!("{context} rejected: {e}")),
            E::ChannelAlreadyPaired { .. } => Self::conflict(format!("{context} rejected: {e}")),
            // `ProvisionedActor` hands its instance to one call at a time and
            // answers this when it is already out.
            E::Invariant(reason) if reason.contains("borrowed") => {
                Self::service_unavailable("actor is busy with another call; try again shortly")
            }
            // `CompositeTransport` reports a failed delivery as an invariant,
            // because the SDK's transport trait has no richer error to return.
            E::Invariant(reason) if reason.starts_with("transport:") => {
                Self::bad_gateway(format!("{context} failed: the peer could not be reached"))
            }
            other => {
                tracing::error!(context, error = %other, "protocol call failed");
                Self::internal(format!("{context} failed"))
            }
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({ "error": self.message })),
        )
            .into_response()
    }
}

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
        Self::new(status, message)
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
        Self::bad_request(message)
    }
}

/// Reject a query string that does not fit the parameters a route takes.
impl From<QueryRejection> for ApiError {
    fn from(rejection: QueryRejection) -> Self {
        Self::bad_request(format!(
            "query string is not valid: {}",
            serde_detail(&rejection.body_text())
        ))
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
        Self::new(status, message)
    }
}

// ── Extractors ──────────────────────────────────────────────────────────────

/// [`axum::Json`], with rejections answered in the API's error shape.
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

/// [`axum::extract::Path`], with rejections answered in the API's error shape.
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

/// [`axum::extract::Query`], with rejections answered in the API's error shape.
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

// ── Fallbacks ───────────────────────────────────────────────────────────────

/// Every path no route matches. Registered with `Router::fallback`.
pub async fn route_not_found() -> ApiError {
    ApiError::not_found("no such route — see openapi.yaml for what this server serves")
}

/// A known path called with a method it does not serve. Registered with
/// `Router::method_not_allowed_fallback`; Axum still adds the `Allow` header.
pub async fn method_not_allowed() -> ApiError {
    ApiError::new(
        StatusCode::METHOD_NOT_ALLOWED,
        "this route does not accept that method",
    )
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
