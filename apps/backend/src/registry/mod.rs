//! The node's registries, backed by SQL.
//!
//! These replace the `dashmap`s that used to live on `AppState`. Two registries
//! deliberately did **not** move: `actor_inboxes` and `browser_receivers` hold
//! `actix::Addr`s and `mpsc` channel halves, which are live runtime handles
//! with no serialised form. They are rebuilt when actors are respawned.

pub mod actors;
pub mod flags;

/// Why a registry operation failed.
///
/// One variant on purpose: every failure here is the database being
/// unreachable or a row being unreadable, and a caller can do nothing
/// different about either — they all become a 500.
#[derive(Debug, thiserror::Error)]
#[error("registry backend error: {0}")]
pub struct RegistryError(pub Box<dyn std::error::Error + Send + Sync + 'static>);

impl RegistryError {
    pub fn new<E: std::error::Error + Send + Sync + 'static>(e: E) -> Self {
        Self(Box::new(e))
    }

    /// For the cases that are a malformed row rather than a failed call.
    pub fn message(message: impl Into<String>) -> Self {
        Self(message.into().into())
    }
}
