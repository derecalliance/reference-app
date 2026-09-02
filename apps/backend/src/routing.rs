//! Server-wide `channel_id` → actor index, for gRPC ingress.
//!
//! HTTP carries the actor in its path (`/derec/<uuid>`), so it never consults
//! this. gRPC has no path to carry one — tonic builds the request URI from the
//! endpoint authority plus the fixed method path — so an inbound `Send` is
//! resolved from the cleartext `channel_id` on the envelope instead.
//!
//! Two tiers, mirroring [`crate::instances::InstanceMap`] one level up:
//!
//! - **bound** — written when a pairing completes, keyed on the long-term id
//!   both sides rotated to. The steady state.
//! - **pinned** — written when a channel exists only in memory: a contact this
//!   backend just minted, or a peer's contact this backend is about to pair
//!   against. Either way the *first* inbound message arrives on an id no
//!   channel store has seen, so nothing derived from a store can route it.
//!
//! An unrecognised channel is refused, never guessed. Guessing would hand a
//! peer's message to an actor that does not own it.

use dashmap::DashMap;
use uuid::Uuid;

#[derive(Default)]
pub struct ChannelRouter {
    bound: DashMap<u64, Uuid>,
    pinned: DashMap<u64, Uuid>,
}

impl ChannelRouter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Route `channel_id` to `actor_id` before any store knows about it.
    pub fn pin(&self, channel_id: u64, actor_id: Uuid) {
        self.pinned.insert(channel_id, actor_id);
    }

    /// Move a completed pairing onto its long-term id.
    ///
    /// The transient id is dropped from both tiers: the library refuses
    /// traffic on it from here on, so a route for it can only misdeliver.
    pub fn rotate(&self, transient: u64, long_term: u64, actor_id: Uuid) {
        self.pinned.remove(&transient);
        self.bound.remove(&transient);
        self.bound.insert(long_term, actor_id);
    }

    /// Forget a channel entirely — teardown, unpair, or a pairing that never
    /// completed.
    pub fn remove(&self, channel_id: u64) {
        self.pinned.remove(&channel_id);
        self.bound.remove(&channel_id);
    }

    /// The actor that owns `channel_id`, or `None` if this server has no
    /// route for it.
    ///
    /// `bound` is consulted first: it is store-derived and authoritative, and
    /// a pin is only ever a placeholder for a channel no store has seen yet.
    pub fn resolve(&self, channel_id: u64) -> Option<Uuid> {
        self.bound
            .get(&channel_id)
            .or_else(|| self.pinned.get(&channel_id))
            .map(|entry| *entry.value())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actor() -> Uuid {
        Uuid::new_v4()
    }

    #[test]
    fn a_pinned_channel_resolves() {
        // The case a store-derived index cannot cover: a freshly minted
        // contact, whose id the first inbound PairRequest carries.
        let router = ChannelRouter::new();
        let a = actor();

        router.pin(100, a);

        assert_eq!(router.resolve(100), Some(a));
    }

    #[test]
    fn an_unknown_channel_resolves_to_nothing() {
        let router = ChannelRouter::new();

        assert_eq!(router.resolve(999), None);
    }

    #[test]
    fn rotating_binds_the_long_term_id_and_drops_the_transient_one() {
        // The handshake atomically rotates off the transient id and the
        // library refuses traffic on it from then on, so leaving it resolvable
        // would keep a dead route alive.
        let router = ChannelRouter::new();
        let a = actor();
        router.pin(100, a);

        router.rotate(100, 200, a);

        assert_eq!(router.resolve(200), Some(a), "long-term id must route");
        assert_eq!(router.resolve(100), None, "transient id must stop routing");
    }

    #[test]
    fn rotating_a_channel_that_was_never_pinned_still_binds() {
        // The responder side of a pairing this backend did not initiate: no
        // pin was ever taken, but the completed channel must still route.
        let router = ChannelRouter::new();
        let a = actor();

        router.rotate(100, 200, a);

        assert_eq!(router.resolve(200), Some(a));
    }

    #[test]
    fn removing_drops_both_tiers() {
        let router = ChannelRouter::new();
        let a = actor();
        router.pin(100, a);
        router.rotate(100, 200, a);

        router.remove(200);
        router.remove(100);

        assert_eq!(router.resolve(200), None);
        assert_eq!(router.resolve(100), None);
    }

    #[test]
    fn a_bound_channel_wins_over_a_stale_pin_on_the_same_id() {
        // Defensive: if the same id were ever both pinned and bound, the
        // store-derived answer is the authoritative one.
        let router = ChannelRouter::new();
        let stale = actor();
        let current = actor();
        router.pin(100, stale);
        router.rotate(999, 100, current);

        assert_eq!(router.resolve(100), Some(current));
    }

    #[test]
    fn two_actors_keep_separate_channels() {
        let router = ChannelRouter::new();
        let (a, b) = (actor(), actor());

        router.pin(100, a);
        router.pin(200, b);

        assert_eq!(router.resolve(100), Some(a));
        assert_eq!(router.resolve(200), Some(b));
    }
}
