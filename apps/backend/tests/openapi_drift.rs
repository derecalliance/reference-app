// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The OpenAPI spec is hand-written, so it can drift from the router.
//!
//! One failure mode actually happens: someone adds an endpoint and forgets the
//! doc. An agent then cannot discover it, which defeats the point of shipping
//! a spec at all. This test reads the routes straight out of `build_router`'s
//! source and asserts the spec covers every one, and no more.
//!
//! Reading the source rather than the built `Router` is deliberate: axum
//! exposes no way to enumerate a `Router`'s paths, and the alternative —
//! maintaining a separate list of routes in this test — would just be a third
//! thing to forget to update.

use std::collections::BTreeSet;

const ROUTER_SOURCE: &str = include_str!("../src/lib.rs");
const SPEC: &str = include_str!("../openapi.yaml");

/// Every path passed to `.route(...)` in `build_router`.
fn routed_paths() -> BTreeSet<String> {
    const MARKER: &str = ".route(";

    let mut paths = BTreeSet::new();
    for (at, _) in ROUTER_SOURCE.match_indices(MARKER) {
        // The path is the next string literal after `.route(`, whether it sits
        // on the same line or the next one.
        let rest = &ROUTER_SOURCE[at + MARKER.len()..];
        let Some(open) = rest.find('"') else { continue };
        let after = &rest[open + 1..];
        let Some(close) = after.find('"') else { continue };
        paths.insert(after[..close].to_owned());
    }
    paths
}

/// Every top-level key under `paths:` in the spec.
///
/// A hand-rolled scan rather than a YAML dependency: the structure being read
/// is two levels deep and adding a parser to the build for this would cost
/// more than it saves.
fn documented_paths() -> BTreeSet<String> {
    let mut paths = BTreeSet::new();
    let mut in_paths = false;

    for line in SPEC.lines() {
        if line.starts_with("paths:") {
            in_paths = true;
            continue;
        }
        if in_paths {
            // A new top-level key ends the section.
            if !line.starts_with(char::is_whitespace) && !line.trim().is_empty() {
                break;
            }
            // Exactly two spaces of indent is a path entry; deeper is a verb
            // or a field belonging to one.
            if let Some(rest) = line.strip_prefix("  ") {
                if !rest.starts_with(char::is_whitespace) {
                    if let Some(path) = rest.strip_suffix(':') {
                        paths.insert(path.to_owned());
                    }
                }
            }
        }
    }
    paths
}

#[test]
fn the_scan_finds_the_routes_it_is_supposed_to() {
    // Guards the test itself: a parser that silently matched nothing would
    // make every assertion below vacuously pass.
    let routed = routed_paths();

    assert!(
        routed.len() >= 15,
        "expected the router to expose at least 15 paths, found {} — the \
         scan is probably broken, not the router: {routed:?}",
        routed.len()
    );
    assert!(routed.contains("/health"));
    assert!(routed.contains("/debug/state"));
    assert!(routed.contains("/actors/{actor_id}/contact"));
}

#[test]
fn the_spec_finds_the_paths_it_is_supposed_to() {
    let documented = documented_paths();

    assert!(
        documented.len() >= 15,
        "expected the spec to document at least 15 paths, found {} — the \
         scan is probably broken: {documented:?}",
        documented.len()
    );
    assert!(documented.contains("/health"));
}

#[test]
fn every_route_is_documented() {
    let missing: Vec<_> = routed_paths()
        .difference(&documented_paths())
        .cloned()
        .collect();

    assert!(
        missing.is_empty(),
        "these routes exist but are absent from openapi.yaml, so nothing \
         reading the spec can discover them: {missing:?}"
    );
}

#[test]
fn the_spec_documents_nothing_that_does_not_exist() {
    // The rarer direction, and the more misleading one: a caller that trusts
    // the spec and gets a 404 has no way to tell a bug from a stale document.
    let phantom: Vec<_> = documented_paths()
        .difference(&routed_paths())
        .cloned()
        .collect();

    assert!(
        phantom.is_empty(),
        "openapi.yaml documents paths the router does not serve: {phantom:?}"
    );
}
