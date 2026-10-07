// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The OpenAPI spec is hand-written, so it can drift from the router.
//!
//! One failure mode actually happens: someone adds an endpoint and forgets the
//! doc. An agent then cannot discover it, which defeats the point of shipping
//! a spec at all. So the spec and the router are compared in both directions,
//! by method as well as by path:
//!
//! - **Every documented operation is served** — checked at runtime: each one
//!   is sent through the assembled router, and must reach a handler rather
//!   than the "no such route" or "method not allowed" fallback.
//! - **Every routed operation is documented** — axum offers no way to list a
//!   `Router`'s routes, so this direction reads `handlers/mod.rs`, the one
//!   file that registers them. Its `routes()` is nested under
//!   [`API_PREFIX`]; its `root_routes()` is served as written.

use std::collections::BTreeSet;

use axum::{
    body::Body,
    http::{Method, Request, StatusCode},
};
use derec_backend::infrastructure::server::{build_router, API_PREFIX};
use serde_json::Value;
use tower::ServiceExt;

const HANDLERS_SOURCE: &str = include_str!("../src/handlers/mod.rs");
const SPEC: &str = include_str!("../openapi.yaml");

/// The verbs the router uses, as both the spec and the routing functions
/// spell them.
const VERBS: &[&str] = &["get", "post", "put", "patch", "delete"];

type Operation = (String, String);

/// Every `(METHOD, path)` registered in `handlers/mod.rs`, with the API's
/// prefix applied to the routes `routes()` registers.
fn routed_operations() -> BTreeSet<Operation> {
    let (api, root) = HANDLERS_SOURCE
        .split_once("pub fn root_routes")
        .expect("handlers/mod.rs defines root_routes()");

    let mut operations = BTreeSet::new();
    for (source, prefix) in [(api, API_PREFIX), (root, "")] {
        for call in route_calls(source) {
            let path = first_string_literal(call).expect("a route names its path");
            for verb in verbs_in(call) {
                operations.insert((verb.to_ascii_uppercase(), format!("{prefix}{path}")));
            }
        }
    }
    operations
}

/// The text of each `.route( … )` call, up to its matching parenthesis.
fn route_calls(source: &str) -> Vec<&str> {
    const MARKER: &str = ".route(";

    source
        .match_indices(MARKER)
        .filter_map(|(at, _)| {
            let start = at + MARKER.len();
            let mut depth = 1usize;
            for (offset, c) in source[start..].char_indices() {
                match c {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(&source[start..start + offset]);
                        }
                    }
                    _ => {}
                }
            }
            None
        })
        .collect()
}

fn first_string_literal(text: &str) -> Option<&str> {
    let open = text.find('"')?;
    let rest = &text[open + 1..];
    rest.find('"').map(|close| &rest[..close])
}

/// The routing functions a `.route(…)` call uses: `get(`, `.post(`, … — a
/// verb immediately followed by `(` and not part of a longer identifier or a
/// module path (`helpers::delete::delete` is a handler, not a verb).
fn verbs_in(call: &str) -> Vec<&'static str> {
    let mut found = Vec::new();
    for verb in VERBS {
        let needle = format!("{verb}(");
        for (at, _) in call.match_indices(&needle) {
            let before = call[..at].chars().next_back();
            if !before.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == ':') {
                found.push(*verb);
            }
        }
    }
    found
}

/// Every `(METHOD, path)` under `paths:` in the spec.
///
/// A hand-rolled scan rather than a YAML dependency: the structure being read
/// is two levels deep — a path at two spaces of indent, its verbs at four —
/// and adding a parser to the build for this would cost more than it saves.
fn documented_operations() -> BTreeSet<Operation> {
    let mut operations = BTreeSet::new();
    let mut in_paths = false;
    let mut path: Option<&str> = None;

    for line in SPEC.lines() {
        if line.starts_with("paths:") {
            in_paths = true;
            continue;
        }
        if !in_paths {
            continue;
        }
        // A new top-level key ends the section.
        if !line.starts_with(char::is_whitespace) && !line.trim().is_empty() {
            break;
        }
        if let Some(rest) = line.strip_prefix("  ").filter(|r| r.starts_with('/')) {
            path = rest.strip_suffix(':');
            continue;
        }
        if let Some(rest) = line.strip_prefix("    ").filter(|r| !r.starts_with(' ')) {
            if let (Some(path), Some(verb)) = (path, rest.strip_suffix(':')) {
                if VERBS.contains(&verb) {
                    operations.insert((verb.to_ascii_uppercase(), path.to_owned()));
                }
            }
        }
    }
    operations
}

#[test]
fn the_route_scan_finds_the_routes_it_is_supposed_to() {
    // Guards the test itself: a scan that silently matched nothing would make
    // every assertion below vacuously pass.
    let routed = routed_operations();

    assert!(
        routed.len() >= 20,
        "the scan is probably broken: {routed:?}"
    );
    for (method, path) in [
        ("GET", "/health"),
        ("GET", "/api/v1/debug/state"),
        ("POST", "/api/v1/actors/{actor_id}/contact"),
        ("DELETE", "/api/v1/helpers/{helper_id}"),
        ("GET", "/api/v1/helpers/{helper_id}/browser-contact"),
        ("POST", "/api/v1/helpers/{helper_id}/browser-contact"),
        ("POST", "/derec/relay"),
    ] {
        assert!(
            routed.contains(&(method.to_owned(), path.to_owned())),
            "{method} {path} missing from {routed:?}"
        );
    }
}

#[test]
fn the_spec_scan_finds_the_operations_it_is_supposed_to() {
    let documented = documented_operations();

    assert!(
        documented.len() >= 20,
        "the scan is probably broken: {documented:?}"
    );
    assert!(documented.contains(&("GET".to_owned(), "/health".to_owned())));
    assert!(documented.contains(&("PATCH".to_owned(), "/api/v1/owners/{owner_id}".to_owned())));
}

#[test]
fn every_route_is_documented() {
    let missing: Vec<_> = routed_operations()
        .difference(&documented_operations())
        .cloned()
        .collect();

    assert!(
        missing.is_empty(),
        "these routes exist but are absent from openapi.yaml, so nothing \
         reading the spec can discover them: {missing:?}"
    );
}

#[test]
fn the_spec_and_the_route_table_agree() {
    // The rarer direction, and the more misleading one: a caller that trusts
    // the spec and gets a 404 has no way to tell a bug from a stale document.
    let phantom: Vec<_> = documented_operations()
        .difference(&routed_operations())
        .cloned()
        .collect();

    assert!(
        phantom.is_empty(),
        "openapi.yaml documents operations handlers/mod.rs does not register: {phantom:?}"
    );
}

/// The same direction as above, without trusting the source scan: every
/// documented operation, sent to the assembled router, reaches a handler.
#[actix_rt::test]
async fn every_documented_operation_is_served_by_the_router() {
    let node = derec_backend::infrastructure::test_support::node().await;
    let router = build_router(node.state.clone());

    for (method, path) in documented_operations() {
        // Any well-formed id: the handler may refuse it, but only a handler can.
        let uri = substitute_path_parameters(&path);
        let request = Request::builder()
            .method(Method::from_bytes(method.as_bytes()).expect("a valid verb"))
            .uri(&uri)
            .body(Body::empty())
            .expect("request builds");

        let response = router.clone().oneshot(request).await.expect("infallible");
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("readable");
        let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);

        assert_ne!(
            status,
            StatusCode::METHOD_NOT_ALLOWED,
            "{method} {path} is documented but the route does not take {method}"
        );
        let unrouted = status == StatusCode::NOT_FOUND
            && body["error"]["message"]
                .as_str()
                .is_some_and(|message| message.starts_with("no such route"));
        assert!(!unrouted, "{method} {path} is documented but not routed");
    }
}

/// `/a/{id}/b` → `/a/<uuid>/b`.
fn substitute_path_parameters(path: &str) -> String {
    path.split('/')
        .map(|segment| {
            if segment.starts_with('{') && segment.ends_with('}') {
                uuid::Uuid::new_v4().to_string()
            } else {
                segment.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// The spec describes this release: its `info.version` is the app's version,
/// which is the SDK's (see CHANGELOG.md). It drifted to an unrelated `0.1.0`
/// once; this keeps the two in step.
#[test]
fn the_spec_version_is_the_app_version() {
    let declared = SPEC
        .lines()
        .skip_while(|line| line.trim() != "info:")
        .find_map(|line| line.trim().strip_prefix("version:"))
        .map(|value| value.trim().trim_matches('"'))
        .expect("openapi.yaml declares info.version");
    assert_eq!(declared, env!("CARGO_PKG_VERSION"));
}
