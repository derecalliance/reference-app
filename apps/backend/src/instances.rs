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
//! Channel ownership is recorded when a channel is **created** — a contact is
//! minted, or a pairing is initiated — never inferred from inbound traffic. An
//! unrecognised channel is an error, not a routing fallback: guessing would
//! hand a peer's message to an instance that does not own it.

use std::collections::HashMap;

pub struct InstanceMap<P> {
    /// `None` while an instance is borrowed by an in-flight async call.
    instances: HashMap<u64, Option<P>>,
    /// `channel_id` → the `secret_id` of the instance that owns it.
    channel_owner: HashMap<u64, u64>,
    own_secret_id: u64,
}

impl<P> InstanceMap<P> {
    pub fn new(own_secret_id: u64, own: P) -> Self {
        let mut instances = HashMap::new();
        instances.insert(own_secret_id, Some(own));
        Self {
            instances,
            channel_owner: HashMap::new(),
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
    pub fn reconcile(&mut self, secret_id: u64, current: &[u64]) {
        self.channel_owner.retain(|_, owner| *owner != secret_id);
        for channel_id in current {
            self.channel_owner.insert(*channel_id, secret_id);
        }
    }

    pub fn secret_for_channel(&self, channel_id: u64) -> Option<u64> {
        self.channel_owner.get(&channel_id).copied()
    }

    /// Borrow an instance. Returns `None` if it does not exist or is already
    /// borrowed by an in-flight call.
    pub fn take(&mut self, secret_id: u64) -> Option<P> {
        self.instances.get_mut(&secret_id)?.take()
    }

    pub fn restore(&mut self, secret_id: u64, instance: P) {
        self.instances.insert(secret_id, Some(instance));
    }

    /// Borrow the instance that owns a channel, with its `secret_id`.
    pub fn take_for_channel(&mut self, channel_id: u64) -> Option<(u64, P)> {
        let secret_id = self.secret_for_channel(channel_id)?;
        let instance = self.take(secret_id)?;
        Some((secret_id, instance))
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

        assert_eq!(m.take_for_channel(100), Some((OWN, "own")));
        assert_eq!(m.take_for_channel(200), Some((ALICE, "alice-replica")));
    }

    #[test]
    fn an_unknown_channel_does_not_fall_back_to_the_own_instance() {
        // The whole point of the index: guessing would hand a peer's message to
        // an instance that does not own the channel.
        let mut m = map();
        assert_eq!(m.take_for_channel(999), None);
    }

    #[test]
    fn a_borrowed_instance_cannot_be_borrowed_twice() {
        let mut m = map();
        m.reconcile(OWN, &[100]);

        assert_eq!(m.take(OWN), Some("own"));
        assert_eq!(m.take(OWN), None, "still borrowed");
        assert_eq!(m.take_for_channel(100), None, "still borrowed");
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

        assert_eq!(m.take_for_channel(300), Some((CAROL, "carol-replica")));
        // Borrowing Carol's must not affect Alice's.
        assert_eq!(m.take_for_channel(200), Some((ALICE, "alice-replica")));
    }
}
