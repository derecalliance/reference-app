// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Fixtures for integration tests under `tests/`.
//!
//! Not `#[cfg(test)]`: that attribute only covers unit tests compiled into this
//! crate, and integration tests link against the ordinary library build.

use std::sync::Arc;

use super::bootstrap::Node;
use crate::models::{Defaults, NodeConfig};

/// A node wired to the arbiter of the currently running actix system, over a
/// private in-memory database.
///
/// Must be called from inside an actix runtime — `#[actix_rt::test]` or an
/// equivalent — because there is no arbiter to hand out otherwise.
///
/// Every fixture gets its *own* in-memory database, which is what keeps
/// concurrent tests from truncating each other's rows.
pub async fn node() -> Arc<Node> {
    let pool = super::db::connect("sqlite::memory:")
        .await
        .expect("an in-memory database always connects");

    Arc::new(Node::new(
        NodeConfig::new("http://localhost:5000", Defaults::default()),
        reqwest::Client::new(),
        actix_rt::Arbiter::current(),
        pool,
    ))
}
