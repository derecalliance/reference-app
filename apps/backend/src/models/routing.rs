// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! How a channel id resolves to an actor on this node, for gRPC ingress, and
//! the routes the router holds.
//!
//! The router itself is [`crate::infrastructure::routing::ChannelRouter`];
//! these are its answers.

use uuid::Uuid;

/// gRPC metadata key carrying the sending actor's id on calls this node makes.
///
/// A routing hint for *this* node's ingress, meaningful only when both ends of
/// a channel live here. A foreign server ignores unknown metadata. It is not an
/// authenticator: the most a forged value can do is pick between two local
/// claimants of one channel, and the payload is encrypted to the right one.
pub const SENDER_METADATA: &str = "x-derec-sender-actor";

/// What ingress should do with a channel id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    /// Exactly one actor other than the sender holds it.
    Actor(Uuid),
    /// No actor here holds it.
    Unknown,
    /// More than one actor here holds it, and the sender did not single one
    /// out. Ordered, so the error naming them is stable.
    Ambiguous(Vec<Uuid>),
}

/// Which tier of the router holds a route.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    /// Store-derived and authoritative: the pairing completed.
    Bound,
    /// A channel that exists only in memory — a contact minted, or one this
    /// server is about to pair against. Resolves only until `bound` supersedes
    /// it, and expires after the pin lifetime.
    Pinned,
}

/// One route, as the debug surface reports it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Route {
    /// Decimal string: a `u64` exceeds JavaScript's exact integer range.
    #[serde(serialize_with = "crate::utils::json::u64_as_string")]
    pub channel_id: u64,
    pub actor_id: Uuid,
    pub tier: Tier,
}
