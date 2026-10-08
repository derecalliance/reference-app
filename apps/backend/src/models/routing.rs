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

impl Resolution {
    /// Which of `claims` — every claim on one channel, the sender's already
    /// set aside — a message on that channel is for.
    ///
    /// Only the strongest claims compete, ranked by tier and then by side:
    ///
    /// 1. a **bound endpoint** — a paired channel this actor is one end of;
    /// 2. a **bound mirror** — a paired channel this actor only holds a copy
    ///    of. Never what a peer addresses while an endpoint claims the same
    ///    id, and still the recipient when it is the only claimant (a replica
    ///    that took over as source is dialled on its copies);
    /// 3. a **pin** — a contact no store has seen yet.
    ///
    /// Two actors left at the same rank is a genuine tie, answered as
    /// [`Resolution::Ambiguous`] rather than guessed.
    pub fn among(claims: &[Route]) -> Self {
        let Some(strongest) = claims.iter().map(Route::rank).min() else {
            return Resolution::Unknown;
        };
        let mut actors: Vec<Uuid> = claims
            .iter()
            .filter(|claim| claim.rank() == strongest)
            .map(|claim| claim.actor_id)
            .collect();
        actors.sort_unstable();
        actors.dedup();
        match actors.as_slice() {
            [] => Resolution::Unknown,
            [only] => Resolution::Actor(*only),
            _ => Resolution::Ambiguous(actors),
        }
    }
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

/// Which side of a channel an actor's claim on it stands for.
///
/// A channel id names a pairing, and a message on it is for whichever end the
/// sender is not. A replica's instance, though, holds copies of its source's
/// helper channels — the owner's view of each — so the replica claims the
/// same ids as the helpers serving them without being an end of any of them.
/// Ordered so that the endpoint outranks the copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    /// This actor is one end of the pairing: the helper serving the channel,
    /// the owner side of a pairing it started itself, or a member of a replica
    /// group. Every pin is one.
    Endpoint,
    /// This actor holds a copy of the source's view of a helper channel, from
    /// mirroring an owner's vault. The helper on the other end is who a peer
    /// on this channel addresses.
    Mirror,
}

/// One actor's claim on a channel, as the router resolves it and the debug
/// surface reports it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Route {
    /// Decimal string: a `u64` exceeds JavaScript's exact integer range.
    #[serde(serialize_with = "crate::utils::json::u64_as_string")]
    pub channel_id: u64,
    pub actor_id: Uuid,
    pub tier: Tier,
    pub side: Side,
}

impl Route {
    /// How strongly this claim competes for a message; lower wins. See
    /// [`Resolution::among`].
    fn rank(&self) -> (Tier, Side) {
        (self.tier, self.side)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claim(actor_id: Uuid, tier: Tier, side: Side) -> Route {
        Route {
            channel_id: 1,
            actor_id,
            tier,
            side,
        }
    }

    #[test]
    fn no_claims_is_unknown() {
        assert_eq!(Resolution::among(&[]), Resolution::Unknown);
    }

    #[test]
    fn an_endpoint_outranks_a_mirror_of_the_same_channel() {
        let (helper, replica) = (Uuid::new_v4(), Uuid::new_v4());
        let claims = [
            claim(replica, Tier::Bound, Side::Mirror),
            claim(helper, Tier::Bound, Side::Endpoint),
        ];

        assert_eq!(Resolution::among(&claims), Resolution::Actor(helper));
    }

    #[test]
    fn a_lone_mirror_is_still_the_recipient() {
        let replica = Uuid::new_v4();

        assert_eq!(
            Resolution::among(&[claim(replica, Tier::Bound, Side::Mirror)]),
            Resolution::Actor(replica)
        );
    }

    #[test]
    fn a_bound_mirror_outranks_a_pin() {
        let (replica, pinned) = (Uuid::new_v4(), Uuid::new_v4());
        let claims = [
            claim(pinned, Tier::Pinned, Side::Endpoint),
            claim(replica, Tier::Bound, Side::Mirror),
        ];

        assert_eq!(Resolution::among(&claims), Resolution::Actor(replica));
    }

    #[test]
    fn two_claims_of_the_same_rank_are_a_tie() {
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        for side in [Side::Endpoint, Side::Mirror] {
            let claims = [claim(b, Tier::Bound, side), claim(a, Tier::Bound, side)];
            let mut both = vec![a, b];
            both.sort_unstable();

            assert_eq!(Resolution::among(&claims), Resolution::Ambiguous(both));
        }
    }
}
