// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Helpers: one provisioned helper to add, a target for the shared pool of
//! them, and what the pool holds once the target is met.

use super::{Actor, ProtocolSettings, TransportBreakdown, TransportMode};

/// The largest helper pool `POST /api/v1/helpers/ensure` will build.
///
/// The transport breakdown counts each mode in a `u8`, and so does the
/// front end's participant count, so a larger pool could not be described.
pub const MAX_POOL_SIZE: u8 = u8::MAX;

/// A target for the shared pool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnsurePool {
    /// How many helpers should exist once the call returns, at most
    /// [`MAX_POOL_SIZE`]. Wider than the limit on purpose, so an out-of-range
    /// value is refused with the actual limit.
    pub total: u64,
    /// Display names offered for any helpers that need creating, taken in
    /// order from the first one created. Anything not covered falls back to a
    /// numbered label.
    pub names: Vec<String>,
    /// Target composition by transport. Must sum to `total`; omitted means
    /// every helper is HTTP.
    pub transports: Option<TransportBreakdown>,
    pub settings: ProtocolSettings,
}

/// The pool after a request to ensure an [`EnsurePool`] target.
#[derive(Debug, Clone)]
pub struct EnsuredPool {
    /// The whole pool, including helpers other owners provisioned.
    pub helpers: Vec<Actor>,
    /// How many of them this call created.
    pub created: usize,
}

/// One helper to provision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddHelper {
    pub name: String,
    /// What the helper advertises.
    pub transport_mode: TransportMode,
    /// Omitted settings fall back to the operator-supplied defaults.
    pub settings: ProtocolSettings,
}
