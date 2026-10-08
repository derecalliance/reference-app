// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Server-wide `channel_id` → actor index, for gRPC ingress.
//!
//! HTTP carries the actor in its path (`/derec/<uuid>`), so it never consults
//! this. gRPC has no path to carry one — tonic builds the request URI from the
//! endpoint authority plus the fixed method path — so an inbound `Send` is
//! resolved from the cleartext `channel_id` on the envelope instead.
//!
//! Two tiers, mirroring [`super::actors::instances::InstanceMap`] one level up:
//!
//! - **bound** — derived from an actor's channel store, or written when a
//!   pairing completes, keyed on the long-term id both sides rotated to. The
//!   steady state.
//! - **pinned** — written when a channel exists only in memory: a contact this
//!   backend just minted, or a peer's contact this backend is about to pair
//!   against. Either way the *first* inbound message arrives on an id no
//!   channel store has seen, so nothing derived from a store can route it.
//!
//! # One channel, possibly two actors
//!
//! A channel id names a *pairing*, not a party: both ends use the same id, on
//! the transient contact id and again on the long-term one. When both ends are
//! actors on this node — two provisioned helpers pairing with each other over
//! gRPC — the id alone cannot say which of them a message is for. Each tier
//! therefore records every actor that claims a channel, and claims are added
//! and removed per actor: one end rotating off a transient id, or being
//! deleted, must not take the other end's route with it.
//!
//! What breaks the tie is the sender. This node's own gRPC client stamps every
//! call with the sending actor ([`crate::models::SENDER_METADATA`]), and a message is never
//! for the actor that sent it — so of two claimants, the one that did not send
//! is the recipient. A foreign peer sends no such hint, and usually needs none:
//! it is not one of the claimants, so a channel it talks on has one claimant
//! here.
//!
//! # A replica's copies
//!
//! The exception is a replica. Hydrating its source's roster gives the
//! replica's instance the source's helper channels — the owner's view of each
//! — so the replica claims the same ids as the helpers on this node serving
//! them. Each bound claim therefore records its [`Side`]: an
//! [`Side::Endpoint`] is one end of the pairing, a [`Side::Mirror`] only holds
//! a copy of it. A peer talking on such a channel is addressing the helper,
//! so the endpoint wins; a mirror is the recipient only when nothing else
//! claims the id. See [`Resolution::among`] for the full ranking. The delivery
//! service narrows further on the gRPC paths, setting aside claimants no peer
//! could have dialled over gRPC.
//!
//! An unrecognised or still-ambiguous channel is refused, never guessed.
//! Guessing would hand a peer's message to an actor that does not own it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use uuid::Uuid;

use crate::models::{Resolution, Route, Side, Tier};
use crate::services::ports::ChannelRoutes;

/// How long a pin may wait for the store to catch up with it.
///
/// A pin stands for a contact that has been handed out but not yet paired
/// against. Matching the pending-channel TTL means a contact gets exactly as
/// long to be used as a paired-but-unconfirmed channel gets to be confirmed;
/// after that nobody is coming, and an unauthenticated caller minting contacts
/// in a loop must not grow this map forever.
pub const PIN_TTL: Duration = Duration::from_secs(super::actors::PENDING_CHANNEL_TTL_SECS);

/// The most pins one actor may hold at once. The oldest is evicted beyond it.
///
/// Far above any interop session's needs — each pin is one contact handed out
/// and not yet paired against — and low enough that a script minting contacts
/// as fast as it can is bounded long before [`PIN_TTL`] expires them.
pub const MAX_PINS_PER_ACTOR: usize = 64;

/// One actor's placeholder route on a channel.
#[derive(Debug, Clone, Copy)]
struct Pin {
    actor_id: Uuid,
    /// When it was taken, for [`PIN_TTL`].
    at: Instant,
    /// Taken-order across the whole router, so "the oldest pin" has one
    /// answer even when two `Instant`s compare equal.
    order: u64,
}

/// One actor's store-derived route on a channel.
#[derive(Debug, Clone, Copy)]
struct Bound {
    actor_id: Uuid,
    side: Side,
}

#[derive(Debug, Default)]
struct Claims {
    bound: Vec<Bound>,
    pinned: Vec<Pin>,
}

impl Claims {
    fn is_empty(&self) -> bool {
        self.bound.is_empty() && self.pinned.is_empty()
    }

    fn holds_bound(&self, actor_id: Uuid) -> bool {
        self.bound.iter().any(|b| b.actor_id == actor_id)
    }

    fn release(&mut self, actor_id: Uuid) {
        self.bound.retain(|b| b.actor_id != actor_id);
        self.pinned.retain(|p| p.actor_id != actor_id);
    }

    /// Every claim, as routes on `channel_id`.
    fn routes(&self, channel_id: u64) -> impl Iterator<Item = Route> + '_ {
        let bound = self.bound.iter().map(move |b| Route {
            channel_id,
            actor_id: b.actor_id,
            tier: Tier::Bound,
            side: b.side,
        });
        let pinned = self.pinned.iter().map(move |p| Route {
            channel_id,
            actor_id: p.actor_id,
            tier: Tier::Pinned,
            // A pin is only ever taken by the actor that minted the contact
            // or started the pairing — an end of it by construction.
            side: Side::Endpoint,
        });
        bound.chain(pinned)
    }
}

#[derive(Default)]
pub struct ChannelRouter {
    routes: DashMap<u64, Claims>,
    next_pin: AtomicU64,
}

impl ChannelRouter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Route `channel_id` to `actor_id` before any store knows about it.
    ///
    /// Adds a claim; never displaces another actor's. Expired pins are swept
    /// first, and the actor's oldest pin is evicted if it is at its cap.
    pub fn pin(&self, channel_id: u64, actor_id: Uuid) {
        self.pin_aged(channel_id, actor_id, Duration::ZERO);
    }

    /// [`Self::pin`] for a contact minted `age` ago — a pin restored at boot,
    /// which must expire when it would have had the process not restarted.
    /// One already past [`PIN_TTL`] is not taken at all.
    pub fn pin_aged(&self, channel_id: u64, actor_id: Uuid, age: Duration) {
        if age >= PIN_TTL {
            return;
        }
        // `Instant` cannot always reach back that far (it may be measured
        // from boot); a pin dated now is the generous fallback, and still
        // bounded by the TTL.
        let at = Instant::now().checked_sub(age).unwrap_or_else(Instant::now);

        self.expire_pins(PIN_TTL);
        self.evict_excess_pins(actor_id);

        let mut claims = self.routes.entry(channel_id).or_default();
        if claims.holds_bound(actor_id) {
            // Already store-derived for this actor; a pin would only shadow it.
            return;
        }
        claims.pinned.retain(|p| p.actor_id != actor_id);
        claims.pinned.push(Pin {
            actor_id,
            at,
            order: self.next_pin.fetch_add(1, Ordering::Relaxed),
        });
    }

    /// Drop `actor_id`'s pin on `channel_id`, leaving any other claim intact.
    ///
    /// For a pairing that never got going: the pin was taken ahead of the
    /// request so the reply could route, and the request then failed.
    pub fn unpin(&self, channel_id: u64, actor_id: Uuid) {
        if let Some(mut claims) = self.routes.get_mut(&channel_id) {
            claims.pinned.retain(|p| p.actor_id != actor_id);
        }
        self.drop_if_empty(channel_id);
    }

    /// Route a channel the actor's own store already holds.
    ///
    /// The store is the source of truth, so this is how the router survives a
    /// restart: nothing here is persisted, and the pairing events that
    /// [`Self::rotate`] follows happened before the process did. Re-deriving the
    /// bound tier from each actor's store is what keeps a recovered gRPC
    /// helper reachable. The actor's own pin on the same id is dropped — the
    /// store has caught up with it — but another actor's is left alone.
    ///
    /// `side` says whether the store holding the channel is an end of it or a
    /// replica's copy of the source's view. One actor can hold the same id
    /// both ways — a helper paired with an owner directly *and* mirroring that
    /// owner finds its own channel in the roster it hydrated — and then it is
    /// an end of the channel, whichever instance reconciled last.
    pub fn bind(&self, channel_id: u64, actor_id: Uuid, side: Side) {
        let mut claims = self.routes.entry(channel_id).or_default();
        claims.pinned.retain(|p| p.actor_id != actor_id);
        match claims.bound.iter_mut().find(|b| b.actor_id == actor_id) {
            Some(bound) => bound.side = bound.side.min(side),
            None => claims.bound.push(Bound { actor_id, side }),
        }
    }

    /// Move `actor_id`'s side of a completed pairing onto its long-term id.
    ///
    /// Only this actor's claim on the transient id goes: the library refuses
    /// traffic on it from here on, so a route for it can only misdeliver. The
    /// other end of the pairing, if it is on this node too, may still be
    /// waiting for its reply on that id — this is why claims are per actor.
    /// The actor completed the pairing itself, so it is an end of it.
    pub fn rotate(&self, transient: u64, long_term: u64, actor_id: Uuid) {
        self.remove(transient, actor_id);
        self.bind(long_term, actor_id, Side::Endpoint);
    }

    /// Forget `actor_id`'s claim on a channel — teardown or unpair. Another
    /// actor's claim on the same id survives.
    pub fn remove(&self, channel_id: u64, actor_id: Uuid) {
        if let Some(mut claims) = self.routes.get_mut(&channel_id) {
            claims.release(actor_id);
        }
        self.drop_if_empty(channel_id);
    }

    /// Forget every claim `actor_id` holds, in both tiers. Returns how many
    /// channels it held. For deletion: only routes that resolve to the deleted
    /// actor go, so a surviving actor on the other end keeps its own.
    pub fn remove_actor(&self, actor_id: Uuid) -> usize {
        let mut released = 0;
        self.routes.retain(|_, claims| {
            let before = claims.bound.len() + claims.pinned.len();
            claims.release(actor_id);
            if claims.bound.len() + claims.pinned.len() != before {
                released += 1;
            }
            !claims.is_empty()
        });
        released
    }

    /// The single actor holding `channel_id`, or `None` if there is no such
    /// actor or more than one. For callers with no sender to exclude.
    pub fn resolve(&self, channel_id: u64) -> Option<Uuid> {
        match self.resolve_from(channel_id, None) {
            Resolution::Actor(actor_id) => Some(actor_id),
            Resolution::Unknown | Resolution::Ambiguous(_) => None,
        }
    }

    /// Which actor a message on `channel_id`, sent by `sender`, is for.
    ///
    /// The sender is excluded first — a message is never for the actor that
    /// sent it. Of the rest, a bound endpoint beats a bound mirror, which
    /// beats a pin: the store is authoritative, a pin is only ever a
    /// placeholder for a channel no store has seen yet, and a replica's copy
    /// is never what a peer addresses while the channel's end claims it too.
    pub fn resolve_from(&self, channel_id: u64, sender: Option<Uuid>) -> Resolution {
        Resolution::among(&self.claims(channel_id, sender))
    }

    /// Every claim on `channel_id` but the sender's — what
    /// [`Self::resolve_from`] chooses among, for a caller that narrows the
    /// claimants further before choosing.
    pub fn claims(&self, channel_id: u64, sender: Option<Uuid>) -> Vec<Route> {
        let Some(claims) = self.routes.get(&channel_id) else {
            return Vec::new();
        };
        claims
            .routes(channel_id)
            .filter(|route| Some(route.actor_id) != sender)
            .collect()
    }

    /// Every route this server holds, with the tier holding it.
    ///
    /// For the debug surface only. Which tier a channel sits in is the single
    /// most useful thing to know when a message will not route: `pinned` means
    /// a contact was minted but the pairing never completed, `bound` means the
    /// handshake finished. A channel with both ends on this node appears once
    /// per actor. Ordered so two reads of an unchanged router compare equal —
    /// `DashMap` iteration order does not.
    pub fn routes(&self) -> Vec<Route> {
        let mut routes: Vec<Route> = Vec::new();
        for entry in self.routes.iter() {
            routes.extend(entry.value().routes(*entry.key()));
        }
        routes.sort_by_key(|r| (r.channel_id, r.tier, r.actor_id));
        routes
    }

    /// Drop every pin older than `ttl`. Bound routes never expire: the store
    /// holds those channels, and unpairing is what removes them.
    pub fn expire_pins(&self, ttl: Duration) {
        let now = Instant::now();
        self.routes.retain(|_, claims| {
            claims
                .pinned
                .retain(|p| now.saturating_duration_since(p.at) < ttl);
            !claims.is_empty()
        });
    }

    /// Make room for one more pin by `actor_id`, evicting its oldest.
    fn evict_excess_pins(&self, actor_id: Uuid) {
        // Collected first and released after: mutating an entry while an
        // iterator over the same map holds its shard would deadlock.
        let mut held: Vec<(u64, u64)> = self
            .routes
            .iter()
            .flat_map(|entry| {
                let channel_id = *entry.key();
                entry
                    .value()
                    .pinned
                    .iter()
                    .filter(|p| p.actor_id == actor_id)
                    .map(|p| (channel_id, p.order))
                    .collect::<Vec<_>>()
            })
            .collect();

        if held.len() < MAX_PINS_PER_ACTOR {
            return;
        }

        held.sort_by_key(|(_, order)| *order);
        let excess = held.len() + 1 - MAX_PINS_PER_ACTOR;
        for (channel_id, _) in held.into_iter().take(excess) {
            tracing::warn!(
                actor_id = %actor_id,
                channel_id,
                limit = MAX_PINS_PER_ACTOR,
                "actor holds too many unpaired contacts; evicting its oldest route"
            );
            self.unpin(channel_id, actor_id);
        }
    }

    fn drop_if_empty(&self, channel_id: u64) {
        self.routes
            .remove_if(&channel_id, |_, claims| claims.is_empty());
    }
}

impl ChannelRoutes for ChannelRouter {
    fn pin(&self, channel_id: u64, actor_id: Uuid) {
        ChannelRouter::pin(self, channel_id, actor_id);
    }

    fn unpin(&self, channel_id: u64, actor_id: Uuid) {
        ChannelRouter::unpin(self, channel_id, actor_id);
    }

    fn claims(&self, channel_id: u64, sender: Option<Uuid>) -> Vec<Route> {
        ChannelRouter::claims(self, channel_id, sender)
    }

    fn remove_actor(&self, actor_id: Uuid) -> usize {
        ChannelRouter::remove_actor(self, actor_id)
    }

    fn routes(&self) -> Vec<Route> {
        ChannelRouter::routes(self)
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
        assert_eq!(router.resolve_from(999, None), Resolution::Unknown);
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
    fn removing_drops_both_tiers_for_that_actor() {
        let router = ChannelRouter::new();
        let a = actor();
        router.pin(100, a);
        router.rotate(100, 200, a);

        router.remove(200, a);
        router.remove(100, a);

        assert_eq!(router.resolve(200), None);
        assert_eq!(router.resolve(100), None);
        assert!(router.routes().is_empty(), "no empty entries may linger");
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
    fn binding_a_stored_channel_routes_it_and_supersedes_the_actors_own_pin() {
        // The restart case: the store holds the channel, the router is empty.
        let router = ChannelRouter::new();
        let owner = actor();
        router.pin(100, owner);

        router.bind(100, owner, Side::Endpoint);

        assert_eq!(router.resolve(100), Some(owner));
        assert!(
            router.routes().iter().all(|r| r.tier == Tier::Bound),
            "the pin must be gone once the store-derived route exists"
        );
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

    // ── Both ends on this node ──────────────────────────────────────────────

    #[test]
    fn a_second_pin_on_the_same_channel_does_not_steal_the_first() {
        // The bug: the initiator's pin overwrote the responder's, so the
        // initiator's own PairRequest was delivered back to the initiator.
        let router = ChannelRouter::new();
        let (responder, initiator) = (actor(), actor());

        router.pin(100, responder);
        router.pin(100, initiator);

        assert_eq!(
            router.resolve_from(100, Some(initiator)),
            Resolution::Actor(responder),
            "the initiator's request must reach the responder"
        );
        assert_eq!(
            router.resolve_from(100, Some(responder)),
            Resolution::Actor(initiator),
            "the responder's reply must reach the initiator"
        );
    }

    #[test]
    fn two_claimants_and_no_sender_is_refused_rather_than_guessed() {
        let router = ChannelRouter::new();
        let (a, b) = (actor(), actor());
        router.pin(100, a);
        router.pin(100, b);

        let mut both = vec![a, b];
        both.sort_unstable();
        assert_eq!(router.resolve_from(100, None), Resolution::Ambiguous(both));
        assert_eq!(router.resolve(100), None);
    }

    #[test]
    fn one_end_rotating_leaves_the_other_ends_pin_in_place() {
        // The responder completes first and rotates off the contact id while
        // the initiator is still waiting for its reply on it.
        let router = ChannelRouter::new();
        let (responder, initiator) = (actor(), actor());
        router.pin(100, responder);
        router.pin(100, initiator);

        router.rotate(100, 200, responder);

        assert_eq!(
            router.resolve_from(100, Some(responder)),
            Resolution::Actor(initiator)
        );

        router.rotate(100, 200, initiator);

        assert_eq!(
            router.resolve_from(200, Some(initiator)),
            Resolution::Actor(responder)
        );
        assert_eq!(
            router.resolve_from(200, Some(responder)),
            Resolution::Actor(initiator)
        );
        assert_eq!(router.resolve_from(100, None), Resolution::Unknown);
    }

    #[test]
    fn unpinning_one_actor_leaves_anothers_claim() {
        // A failed start-pairing must take back only its own pin.
        let router = ChannelRouter::new();
        let (responder, failed) = (actor(), actor());
        router.pin(100, responder);
        router.pin(100, failed);

        router.unpin(100, failed);

        assert_eq!(router.resolve(100), Some(responder));
    }

    #[test]
    fn removing_an_actor_releases_only_its_own_routes() {
        // Deleting a helper must not cut the surviving end of a same-node
        // pairing off from its channel.
        let router = ChannelRouter::new();
        let (deleted, survivor) = (actor(), actor());
        router.bind(200, deleted, Side::Endpoint);
        router.bind(200, survivor, Side::Endpoint);
        router.pin(300, deleted);

        assert_eq!(router.remove_actor(deleted), 2);

        assert_eq!(router.resolve(200), Some(survivor));
        assert_eq!(router.resolve(300), None);
    }

    // ── A replica's copies ──────────────────────────────────────────────────

    #[test]
    fn a_replicas_copy_yields_to_the_helper_serving_the_channel() {
        // The bug: a replica's instance holds its source's helper channels, so
        // a message from the owner side to the helper had two claimants and
        // was refused whenever the replica could be dialled over gRPC too.
        let router = ChannelRouter::new();
        let (helper, replica) = (actor(), actor());
        router.bind(200, replica, Side::Mirror);
        router.bind(200, helper, Side::Endpoint);

        assert_eq!(router.resolve_from(200, None), Resolution::Actor(helper));
        assert_eq!(router.resolve(200), Some(helper));
    }

    #[test]
    fn a_replicas_copy_receives_what_the_helper_itself_sends() {
        // The helper's own reply on the channel is never for the helper; the
        // copy is all that is left.
        let router = ChannelRouter::new();
        let (helper, replica) = (actor(), actor());
        router.bind(200, replica, Side::Mirror);
        router.bind(200, helper, Side::Endpoint);

        assert_eq!(
            router.resolve_from(200, Some(helper)),
            Resolution::Actor(replica)
        );
    }

    #[test]
    fn two_replicas_copies_of_one_channel_are_still_a_tie() {
        let router = ChannelRouter::new();
        let (a, b) = (actor(), actor());
        router.bind(200, a, Side::Mirror);
        router.bind(200, b, Side::Mirror);

        let mut both = vec![a, b];
        both.sort_unstable();
        assert_eq!(router.resolve_from(200, None), Resolution::Ambiguous(both));
    }

    #[test]
    fn an_actor_holding_a_channel_both_ways_is_an_end_of_it() {
        // A helper paired with an owner directly and also mirroring that owner
        // finds its own channel in the roster; whichever instance reconciles
        // last, it stays the endpoint.
        let router = ChannelRouter::new();
        let (helper, other_replica) = (actor(), actor());
        router.bind(200, other_replica, Side::Mirror);
        router.bind(200, helper, Side::Endpoint);
        router.bind(200, helper, Side::Mirror);

        assert_eq!(router.resolve(200), Some(helper));
        assert!(router
            .routes()
            .iter()
            .any(|r| r.actor_id == helper && r.side == Side::Endpoint));
    }

    #[test]
    fn the_debug_routes_report_each_claims_side() {
        let router = ChannelRouter::new();
        let (helper, replica, minter) = (actor(), actor(), actor());
        router.bind(200, helper, Side::Endpoint);
        router.bind(200, replica, Side::Mirror);
        router.pin(300, minter);

        let sides: Vec<(Uuid, Tier, Side)> = router
            .routes()
            .iter()
            .map(|r| (r.actor_id, r.tier, r.side))
            .collect();
        assert!(sides.contains(&(helper, Tier::Bound, Side::Endpoint)));
        assert!(sides.contains(&(replica, Tier::Bound, Side::Mirror)));
        assert!(sides.contains(&(minter, Tier::Pinned, Side::Endpoint)));
    }

    // ── Bounded growth ──────────────────────────────────────────────────────

    #[test]
    fn a_pin_restored_at_boot_keeps_its_original_age() {
        // A contact minted 59 minutes before a restart has one minute left,
        // not a fresh hour; one minted before the TTL is not routed at all.
        let router = ChannelRouter::new();
        let a = actor();

        router.pin_aged(100, a, PIN_TTL - Duration::from_secs(60));
        router.pin_aged(200, a, PIN_TTL + Duration::from_secs(1));

        assert_eq!(router.resolve(100), Some(a));
        assert_eq!(
            router.resolve(200),
            None,
            "an expired contact is not restored"
        );

        router.expire_pins(PIN_TTL - Duration::from_secs(120));
        assert_eq!(
            router.resolve(100),
            None,
            "its age must count towards the TTL, as if no restart happened"
        );
    }

    #[test]
    fn pins_expire_after_their_ttl_but_bound_routes_do_not() {
        let router = ChannelRouter::new();
        let (a, b) = (actor(), actor());
        router.pin(100, a);
        router.bind(200, b, Side::Endpoint);

        router.expire_pins(Duration::ZERO);

        assert_eq!(router.resolve(100), None, "an unused contact's pin expires");
        assert_eq!(router.resolve(200), Some(b), "a paired channel never does");
    }

    #[test]
    fn an_actor_minting_contacts_in_a_loop_is_capped() {
        let router = ChannelRouter::new();
        let a = actor();

        for channel_id in 0..(MAX_PINS_PER_ACTOR as u64 + 10) {
            router.pin(channel_id, a);
        }

        let held = router.routes().iter().filter(|r| r.actor_id == a).count();
        assert_eq!(held, MAX_PINS_PER_ACTOR);
        assert_eq!(
            router.resolve(MAX_PINS_PER_ACTOR as u64 + 9),
            Some(a),
            "the newest contact must still route"
        );
        assert_eq!(router.resolve(0), None, "the oldest is the one evicted");
    }
}
