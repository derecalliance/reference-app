// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Protocol instances held by one provisioned actor, keyed by the `secret_id`
//! each is bound to.
//!
//! An actor has exactly one "own" instance, bound to the secret it protects as
//! Owner. All helper-role channels live in that instance: shares are separated
//! by `channel_id` and each carries its own Owner's `secret_id` on the record.
//!
//! Replica mode is the exception. A replica mirrors one named owner's vault and
//! the share store keys on `(secret_id, channel_id, version, replica_id)`, so a
//! replica needs an instance bound to *that owner's* secret. Hence a map rather
//! than a single slot.
//!
//! Channel ownership is answered from **two** maps, and knowing which is which
//! is the first thing to read here.
//!
//! Store-derived bindings are the authoritative tier. [`InstanceMap::reconcile`]
//! re-reads an instance's channel store after every operation that borrowed the
//! instance and replaces *that instance's* bindings wholesale, so channel
//! creation, the pairing handshake's id rotation and teardown are all picked up
//! by one mechanism, none of which the caller can observe directly. Starting a
//! flow needs nothing else: the SDK writes a channel record before sending, so
//! the following reconcile sees it.
//!
//! Pins are a supplement for the one case a store read cannot cover: a channel
//! that exists only in memory. Today that is exactly a freshly minted contact —
//! `create_contact` writes to the secret store and never to the channel store,
//! so its channel is invisible to reconcile from minting until the peer's first
//! reply makes the library write a channel row. Pins are therefore exempt from
//! reconcile's sweep, and are dropped only when the store catches up
//! ([`InstanceMap::reconcile`]) or when a caller retires an id the store will
//! never report again ([`InstanceMap::unpin_channel`]).
//!
//! Neither tier ever guesses. An unrecognised channel is an error, not a routing
//! fallback: guessing would hand a peer's message to an instance that does not
//! own it.

use std::collections::HashMap;

pub struct InstanceMap<P> {
    /// `None` while an instance is borrowed by an in-flight async call.
    instances: HashMap<u64, Option<P>>,
    /// `channel_id` → the `secret_id` of the instance that owns it, as last
    /// reported by that instance's channel store.
    channel_owner: HashMap<u64, u64>,
    /// `channel_id` → `secret_id` for channels that exist only in-memory —
    /// most notably a freshly minted contact, which `create_contact` persists
    /// to the secret store but never to the channel store. `reconcile` never
    /// sweeps this map wholesale (a stale bulk sweep would erase every pin the
    /// instant any *other* reconcile ran); it only drops an entry once the
    /// channel store itself reports the channel, at which point the store is
    /// authoritative and the pin is redundant. See `pin_channel`.
    pinned_channel_owner: HashMap<u64, u64>,
    own_secret_id: u64,
}

impl<P> InstanceMap<P> {
    pub fn new(own_secret_id: u64, own: P) -> Self {
        let mut instances = HashMap::new();
        instances.insert(own_secret_id, Some(own));
        Self {
            instances,
            channel_owner: HashMap::new(),
            pinned_channel_owner: HashMap::new(),
            own_secret_id,
        }
    }

    pub fn own_secret_id(&self) -> u64 {
        self.own_secret_id
    }

    pub fn insert(&mut self, secret_id: u64, instance: P) {
        self.instances.insert(secret_id, Some(instance));
    }

    pub fn contains(&self, secret_id: u64) -> bool {
        self.instances.contains_key(&secret_id)
    }

    pub fn secret_ids(&self) -> Vec<u64> {
        self.instances.keys().copied().collect()
    }

    /// Make the index match an instance's actual channels.
    ///
    /// Called after any operation that borrows an instance, because all three of
    /// creation, rotation and teardown happen where the caller cannot see them:
    /// the library creates channels inside `start()` and `process()` as well as
    /// at contact minting, and the pairing handshake atomically rotates the
    /// transient id to a long-term one without returning it. Reconciling against
    /// the instance's own channel store covers all three with one mechanism.
    ///
    /// Only this instance's bindings are touched; other instances keep theirs.
    ///
    /// A pin (see [`Self::pin_channel`]) for a channel that now appears in
    /// `current` is dropped too: the store has caught up, so the store-backed
    /// binding above is authoritative and the pin would otherwise sit around
    /// forever, since a rotated-away channel id never reappears in `current`
    /// for the retain sweep to catch.
    pub fn reconcile(&mut self, secret_id: u64, current: &[u64]) {
        self.channel_owner.retain(|_, owner| *owner != secret_id);
        for channel_id in current {
            self.channel_owner.insert(*channel_id, secret_id);
            self.pinned_channel_owner.remove(channel_id);
        }
    }

    /// Bind a channel that exists only in memory — not yet in the channel
    /// store, so [`Self::reconcile`] cannot see it and would otherwise erase
    /// this binding on the next call for *any* instance.
    ///
    /// `create_contact` is the motivating case: it persists to the secret
    /// store only, so a freshly minted contact's channel is invisible to
    /// `channel_ids_of` until the peer's response makes the library write a
    /// channel-store row. Without a pin, the routing index has no entry for
    /// that channel between minting and first reply, and the peer's opening
    /// message gets dropped as unrouted.
    pub fn pin_channel(&mut self, channel_id: u64, secret_id: u64) {
        self.pinned_channel_owner.insert(channel_id, secret_id);
    }

    /// Remove a pin without waiting for `reconcile` to see it in the store.
    ///
    /// Needed for the transient pairing channel id: the handshake rotates it
    /// to a long-term id and the library refuses traffic on the old one from
    /// then on, so the old id never appears in a channel store read again —
    /// `reconcile`'s store-catch-up removal can never fire for it, and the pin
    /// would linger forever.
    pub fn unpin_channel(&mut self, channel_id: u64) {
        self.pinned_channel_owner.remove(&channel_id);
    }

    pub fn secret_for_channel(&self, channel_id: u64) -> Option<u64> {
        self.channel_owner
            .get(&channel_id)
            .or_else(|| self.pinned_channel_owner.get(&channel_id))
            .copied()
    }

    /// Borrow an instance. Returns `None` if it does not exist or is already
    /// borrowed by an in-flight call.
    pub fn take(&mut self, secret_id: u64) -> Option<P> {
        self.instances.get_mut(&secret_id)?.take()
    }

    pub fn restore(&mut self, secret_id: u64, instance: P) {
        self.instances.insert(secret_id, Some(instance));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWN: u64 = 0xA1;
    const ALICE: u64 = 0x7F;

    fn map() -> InstanceMap<&'static str> {
        InstanceMap::new(OWN, "own")
    }

    #[test]
    fn the_own_instance_is_present_from_construction() {
        let m = map();
        assert_eq!(m.own_secret_id(), OWN);
        assert!(m.contains(OWN));
    }

    #[test]
    fn a_replica_instance_coexists_with_the_own_instance() {
        let mut m = map();
        m.insert(ALICE, "alice-replica");

        assert!(m.contains(OWN));
        assert!(m.contains(ALICE));

        let mut ids = m.secret_ids();
        ids.sort_unstable();
        assert_eq!(ids, vec![ALICE, OWN]);
    }

    #[test]
    fn a_channel_routes_to_the_instance_it_was_bound_to() {
        let mut m = map();
        m.insert(ALICE, "alice-replica");
        m.reconcile(OWN, &[100]);
        m.reconcile(ALICE, &[200]);

        assert_eq!(m.secret_for_channel(100), Some(OWN));
        assert_eq!(m.take(OWN), Some("own"));
        assert_eq!(m.secret_for_channel(200), Some(ALICE));
        assert_eq!(m.take(ALICE), Some("alice-replica"));
    }

    #[test]
    fn an_unknown_channel_does_not_fall_back_to_the_own_instance() {
        // The whole point of the index: guessing would hand a peer's message to
        // an instance that does not own the channel. There is no owner to
        // `take()`, so the own instance is never reached as a fallback.
        let m = map();
        assert_eq!(m.secret_for_channel(999), None);
    }

    #[test]
    fn a_borrowed_instance_cannot_be_borrowed_twice() {
        let mut m = map();
        m.reconcile(OWN, &[100]);

        assert_eq!(m.take(OWN), Some("own"));
        assert_eq!(m.take(OWN), None, "still borrowed");

        // The index still knows the channel's owner; only the instance itself
        // is unavailable.
        let secret_id = m.secret_for_channel(100).expect("channel is known");
        assert_eq!(m.take(secret_id), None, "still borrowed");
    }

    #[test]
    fn restoring_makes_an_instance_borrowable_again() {
        let mut m = map();

        let borrowed = m.take(OWN).expect("present");
        m.restore(OWN, borrowed);

        assert_eq!(m.take(OWN), Some("own"));
    }

    #[test]
    fn reconciling_binds_channels_the_instance_now_holds() {
        let mut m = map();

        m.reconcile(OWN, &[100, 101]);

        assert_eq!(m.secret_for_channel(100), Some(OWN));
        assert_eq!(m.secret_for_channel(101), Some(OWN));
    }

    #[test]
    fn reconciling_retires_the_rotated_pairing_id() {
        // The handshake rotates the transient pairing id to a long-term one and
        // the library refuses traffic on the old id afterwards. After the
        // rotation the store lists only the new id.
        let mut m = map();
        m.reconcile(OWN, &[100]);

        m.reconcile(OWN, &[101]);

        assert_eq!(m.secret_for_channel(100), None, "old id is retired");
        assert_eq!(m.secret_for_channel(101), Some(OWN));
    }

    #[test]
    fn reconciling_drops_a_torn_down_channel() {
        let mut m = map();
        m.reconcile(OWN, &[100, 101]);

        m.reconcile(OWN, &[100]);

        assert_eq!(m.secret_for_channel(101), None);
        assert_eq!(m.secret_for_channel(100), Some(OWN));
    }

    #[test]
    fn reconciling_one_instance_leaves_another_alone() {
        // The retain() sweep must be scoped by secret id, or reconciling the own
        // instance would silently unroute every replica channel.
        let mut m = map();
        m.insert(ALICE, "alice-replica");
        m.reconcile(ALICE, &[200]);

        m.reconcile(OWN, &[100]);

        assert_eq!(m.secret_for_channel(200), Some(ALICE), "untouched");
        assert_eq!(m.secret_for_channel(100), Some(OWN));
    }

    #[test]
    fn two_owners_replicated_by_one_actor_stay_separate() {
        const CAROL: u64 = 0xC3;
        let mut m = map();
        m.insert(ALICE, "alice-replica");
        m.insert(CAROL, "carol-replica");
        m.reconcile(ALICE, &[200]);
        m.reconcile(CAROL, &[300]);

        assert_eq!(m.secret_for_channel(300), Some(CAROL));
        assert_eq!(m.take(CAROL), Some("carol-replica"));
        // Borrowing Carol's must not affect Alice's.
        assert_eq!(m.secret_for_channel(200), Some(ALICE));
        assert_eq!(m.take(ALICE), Some("alice-replica"));
    }

    #[test]
    fn a_pinned_channel_routes() {
        // A freshly minted contact has no channel-store row yet, so it can
        // only be found through the pin.
        let m = map();
        // No pin_channel call yet: the pin is what must supply the answer.
        assert_eq!(m.secret_for_channel(100), None, "unpinned, unbound");

        let mut m = map();
        m.pin_channel(100, OWN);
        assert_eq!(
            m.secret_for_channel(100),
            Some(OWN),
            "pin supplies the owner"
        );
    }

    #[test]
    fn a_pinned_channel_survives_a_reconcile_that_does_not_mention_it() {
        // This is the regression test for the actual bug: TickMsg reconciles
        // every ~15s from whatever the channel store currently reports, which
        // does not yet include a contact minted moments ago. A reconcile that
        // is silent about the pinned channel must not erase the pin — the
        // peer's opening reply has to land after that reconcile runs, not
        // just before it.
        let mut m = map();
        m.pin_channel(100, OWN);

        // Store-backed reconcile reports no channels at all for this
        // instance — as it would immediately after minting.
        m.reconcile(OWN, &[]);

        assert_eq!(m.secret_for_channel(100), Some(OWN), "pin must survive");
    }

    #[test]
    fn a_pinned_entry_is_dropped_once_the_channel_appears_in_current() {
        // Once the library has written the channel-store row (e.g. the peer's
        // PairRequest landed and the handshake progressed), the store becomes
        // authoritative and the pin is redundant.
        let mut m = map();
        m.pin_channel(100, OWN);

        m.reconcile(OWN, &[100]);

        assert_eq!(m.secret_for_channel(100), Some(OWN), "still routes");

        // The pin itself is gone, not just shadowed: retiring the channel
        // from the store now retires the binding entirely, the same as any
        // other store-backed channel.
        m.reconcile(OWN, &[]);
        assert_eq!(
            m.secret_for_channel(100),
            None,
            "pin did not survive underneath"
        );
    }

    #[test]
    fn pinning_one_instances_channel_does_not_disturb_another() {
        let mut m = map();
        m.insert(ALICE, "alice-replica");

        m.pin_channel(100, OWN);
        m.pin_channel(200, ALICE);

        // Reconciling one instance must leave *every* pin standing, its own
        // included: the pin map is exempt from the retain sweep, and a sweep
        // that ignored the secret id would erase both pins here.
        m.reconcile(ALICE, &[201]);

        assert_eq!(m.secret_for_channel(100), Some(OWN));
        assert_eq!(m.take(OWN), Some("own"));
        // Borrowing OWN's pinned channel must not affect Alice's.
        assert_eq!(m.secret_for_channel(200), Some(ALICE));
        assert_eq!(m.take(ALICE), Some("alice-replica"));
    }

    #[test]
    fn unpinning_removes_a_pin_that_the_store_will_never_report() {
        // The transient pairing channel id is exactly this case: once rotated
        // away, the library refuses traffic on it and the store never lists
        // it again, so reconcile's store-catch-up cleanup can never fire for
        // it. Explicit unpinning is the only way it is ever removed.
        let mut m = map();
        m.pin_channel(100, OWN);

        m.unpin_channel(100);

        assert_eq!(m.secret_for_channel(100), None);
    }
}
