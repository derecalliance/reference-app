// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The reference DeRec backend, as a library.
//!
//! Everything lives here rather than in `main.rs` so integration tests under
//! `tests/` can assemble a node, drive its actors directly, or exercise a route
//! through the real router. `main.rs` is only the binary entry point.
//!
//! Layered, outermost first:
//!
//! - [`handlers`] — the HTTP interface: one file per endpoint that parses its
//!   input, calls exactly one service and maps the answer into the envelope;
//!   [`middlewares`] runs around them (the request id).
//! - [`services`] — the rules, one service per entity, each a trait.
//! - [`repositories`] — storage only, each a trait over SQL or memory.
//! - [`infrastructure`] — configuration, the database, the actix actor
//!   runtime, the transports and the gRPC listener, boot, and the server;
//!   the adapters behind every port the services declare.
//! - [`models`] — the business types every layer shares, one file per model.
//! - [`utils`] — pure helpers with no business meaning: the clock, timestamp
//!   formatting, serde helpers.

pub mod handlers;
pub mod infrastructure;
pub mod middlewares;
pub mod models;
pub mod repositories;
pub mod services;
pub mod utils;
