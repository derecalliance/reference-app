//! The reference DeRec backend, as a library.
//!
//! Everything lives here rather than in `main.rs` so integration tests under
//! `tests/` can drive the actors directly. `main.rs` is only the binary entry
//! point: argument-free boot, router assembly, and the Axum server.

pub mod actor;
pub mod config;
pub mod envelope;
pub mod instances;
pub mod models;
pub mod provisioning;
pub mod routes;
pub mod state;
pub mod stores;

/// Fixtures for integration tests, re-exported at the crate root so `tests/`
/// reaches them as `derec_backend::test_support`.
pub use state::test_support;
