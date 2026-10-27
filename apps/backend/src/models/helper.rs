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

/// A failure a provisioned helper simulates, for testing how owners cope with
/// helpers that misbehave in ways other than going offline.
///
/// A property of the helper, not of a pairing: every owner it holds shares for
/// sees the same behaviour. Applied only to shares the helper holds *for
/// others*, never to a replica's own copies, and only to what it reads or
/// accepts — stored rows are never altered, so [`HelperFault::None`] restores
/// the helper exactly as it was.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HelperFault {
    /// Behaves normally.
    #[default]
    None,
    /// Answers as though its storage were wiped: verification and recovery
    /// get `UNKNOWN_SHARE_VERSION`, discovery lists nothing.
    LostShares,
    /// Hands out its shares with one subshare byte flipped: they still decode,
    /// but no longer match their commitment, so verification reports an
    /// invalid proof and recovery sets the share aside as corrupted.
    CorruptedShares,
    /// Refuses every share it is asked to store.
    RefusesNewShares,
    /// Refuses every verification challenge, while still holding its shares.
    RefusesVerification,
}

impl HelperFault {
    /// The stored and wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::LostShares => "lost_shares",
            Self::CorruptedShares => "corrupted_shares",
            Self::RefusesNewShares => "refuses_new_shares",
            Self::RefusesVerification => "refuses_verification",
        }
    }
}

/// A spelling that names no fault.
#[derive(Debug, thiserror::Error)]
#[error("unknown helper fault {0:?}")]
pub struct UnknownHelperFault(pub String);

impl TryFrom<&str> for HelperFault {
    type Error = UnknownHelperFault;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "none" => Ok(Self::None),
            "lost_shares" => Ok(Self::LostShares),
            "corrupted_shares" => Ok(Self::CorruptedShares),
            "refuses_new_shares" => Ok(Self::RefusesNewShares),
            "refuses_verification" => Ok(Self::RefusesVerification),
            other => Err(UnknownHelperFault(other.to_owned())),
        }
    }
}
