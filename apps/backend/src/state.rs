use std::sync::{Arc, RwLock};

use actix::Addr;
use dashmap::DashMap;
use tokio::sync::{Mutex, mpsc};
use uuid::Uuid;

use crate::actor::ProvisionedActor;
use crate::config::Defaults;
use crate::models::{Actor, Role};

/// Unified inbox for all actors, regardless of whether they run in-process or in a browser.
pub enum ActorInbox {
    /// Messages are buffered in an mpsc channel and drained by HTTP polling.
    Browser(mpsc::UnboundedSender<Vec<u8>>),
    /// Messages are delivered directly to the Actix actor's mailbox.
    Provisioned(Addr<ProvisionedActor>),
}

/// Every actor the server knows about, in registration order.
///
/// A `Vec` rather than a map because order is part of the contract: the front
/// end polls `GET /actors` continuously and renders the result as a list, so an
/// unordered container would reshuffle the roster on every poll. Lookups are
/// linear, which is irrelevant at the scale this reference app runs at (tens of
/// actors) and buys stable output for free.
///
/// Every accessor returns owned data. That is deliberate: it makes it
/// impossible to hold the lock across an `.await`, which would otherwise
/// deadlock any writer.
#[derive(Default)]
pub struct ActorRegistry {
    actors: RwLock<Vec<Actor>>,
}

impl ActorRegistry {
    /// Add an actor to the registry. Callers mint ids with `Uuid::new_v4`, so
    /// collisions are not a case worth handling.
    pub fn register(&self, actor: Actor) {
        self.write().push(actor);
    }

    /// The actor with this id, if the server knows it.
    pub fn get(&self, actor_id: &Uuid) -> Option<Actor> {
        self.read().iter().find(|a| a.id == *actor_id).cloned()
    }

    /// The actor with this id, but only if it holds `role`.
    ///
    /// Distinguishes "no such actor" from "wrong kind of actor" so callers can
    /// map them onto different status codes.
    pub fn get_with_role(&self, actor_id: &Uuid, role: Role) -> Result<Actor, RoleMismatch> {
        match self.get(actor_id) {
            None => Err(RoleMismatch::NotFound),
            Some(actor) if actor.role == role => Ok(actor),
            Some(actor) => Err(RoleMismatch::WrongRole { actual: actor.role }),
        }
    }

    pub fn contains(&self, actor_id: &Uuid) -> bool {
        self.read().iter().any(|a| a.id == *actor_id)
    }

    /// Snapshot of the whole roster, in registration order.
    pub fn all(&self) -> Vec<Actor> {
        self.read().clone()
    }

    /// Bring the participant pool up to `desired`, creating only the shortfall.
    ///
    /// Provisioned participants are a **shared pool**: every owner pairs with
    /// the same fixtures, so "I want seven participants" is a statement about
    /// how many should exist, not how many to add. Two owners each asking for
    /// seven should leave seven on the server, not fourteen.
    ///
    /// Counting and creating happen under one write lock, which is the whole
    /// point of doing this here rather than in a handler: two callers asking
    /// for seven at the same moment would otherwise both observe an empty pool
    /// and both create seven. `mint` is called only for the shortfall, and is
    /// passed the index of the participant being created so callers can name
    /// them. It must stay cheap and non-blocking — it runs with the lock held.
    pub fn ensure_participants<F>(&self, desired: usize, mut mint: F) -> EnsuredParticipants
    where
        F: FnMut(usize) -> Actor,
    {
        let mut actors = self.write();

        let existing = actors.iter().filter(|a| a.role == Role::Participant).count();
        let created: Vec<Actor> = (existing..desired).map(&mut mint).collect();
        actors.extend(created.iter().cloned());

        let participants = actors
            .iter()
            .filter(|a| a.role == Role::Participant)
            .cloned()
            .collect();

        EnsuredParticipants { created, participants }
    }

    /// A poisoned lock means a previous holder panicked mid-update. The
    /// registry is a plain `Vec<Actor>` with no cross-field invariant to
    /// violate, so the data behind it is still coherent and recovering beats
    /// taking the whole server down.
    fn read(&self) -> std::sync::RwLockReadGuard<'_, Vec<Actor>> {
        self.actors.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, Vec<Actor>> {
        self.actors.write().unwrap_or_else(|e| e.into_inner())
    }
}

/// Outcome of [`ActorRegistry::ensure_participants`].
pub struct EnsuredParticipants {
    /// Only the participants this call brought into existence. The caller
    /// spawns a protocol instance for each — outside the registry lock.
    pub created: Vec<Actor>,
    /// The whole pool afterwards, which is what the caller actually wanted.
    pub participants: Vec<Actor>,
}

/// Why a lookup that expected a particular role failed.
#[derive(Debug, PartialEq, Eq)]
pub enum RoleMismatch {
    NotFound,
    WrongRole { actual: Role },
}

#[derive(Clone)]
pub struct AppState {
    /// Every actor on this server. There is no grouping above this: the app
    /// runs as a single local node that developers point browser contexts at.
    pub actors: Arc<ActorRegistry>,
    pub actor_inboxes: Arc<DashMap<Uuid, ActorInbox>>,
    /// Receiver halves for browser actor inboxes; drained by the poll_mailbox handler.
    pub browser_receivers: Arc<DashMap<Uuid, Arc<Mutex<mpsc::UnboundedReceiver<Vec<u8>>>>>>,
    /// Participant-side channel IDs per actor (one entry per paired owner).
    pub participant_channels: Arc<DashMap<Uuid, Vec<String>>>,
    pub disabled_participants: Arc<DashMap<Uuid, ()>>,
    pub replica_channels: Arc<DashMap<Uuid, Vec<String>>>,
    pub replica_confirmed: Arc<DashMap<Uuid, ()>>,
    pub disabled_replicas: Arc<DashMap<Uuid, ()>>,
    /// Contact messages posted by browser-managed participants for the owner to fetch.
    pub browser_participant_contacts: Arc<DashMap<Uuid, String>>,
    /// Operator-supplied starting values for the front end. Read once at boot
    /// and never mutated — the backend serves them, the front end owns them.
    pub defaults: Arc<Defaults>,
    pub base_url: Arc<str>,
    pub http_client: reqwest::Client,
    pub arbiter: actix_rt::ArbiterHandle,
}

impl AppState {
    pub fn new(
        base_url: impl Into<Arc<str>>,
        defaults: Defaults,
        http_client: reqwest::Client,
        arbiter: actix_rt::ArbiterHandle,
    ) -> Self {
        Self {
            actors: Arc::new(ActorRegistry::default()),
            actor_inboxes: Arc::new(DashMap::new()),
            browser_receivers: Arc::new(DashMap::new()),
            participant_channels: Arc::new(DashMap::new()),
            disabled_participants: Arc::new(DashMap::new()),
            replica_channels: Arc::new(DashMap::new()),
            replica_confirmed: Arc::new(DashMap::new()),
            disabled_replicas: Arc::new(DashMap::new()),
            browser_participant_contacts: Arc::new(DashMap::new()),
            defaults: Arc::new(defaults),
            base_url: base_url.into(),
            http_client,
            arbiter,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provisioning::provisioned_actor;

    fn actor(role: Role, name: &str) -> Actor {
        provisioned_actor(role, name, "http://localhost", Some(42))
    }

    #[test]
    fn a_registered_actor_is_found_by_id() {
        let registry = ActorRegistry::default();
        let alice = actor(Role::Owner, "Alice");
        registry.register(alice.clone());

        assert_eq!(registry.get(&alice.id).map(|a| a.name), Some("Alice".to_owned()));
        assert!(registry.contains(&alice.id));
    }

    #[test]
    fn an_unregistered_actor_is_not_found() {
        let registry = ActorRegistry::default();
        registry.register(actor(Role::Owner, "Alice"));

        let stranger = actor(Role::Owner, "Mallory");

        assert!(registry.get(&stranger.id).is_none());
        assert!(!registry.contains(&stranger.id));
    }

    #[test]
    fn registration_order_is_preserved() {
        // The front end polls this roster continuously and renders it as a
        // list; an unordered container would reshuffle the UI on every poll.
        let registry = ActorRegistry::default();
        for name in ["first", "second", "third", "fourth"] {
            registry.register(actor(Role::Participant, name));
        }

        let names: Vec<String> = registry.all().into_iter().map(|a| a.name).collect();

        assert_eq!(names, ["first", "second", "third", "fourth"]);
    }

    #[test]
    fn a_role_lookup_accepts_the_matching_role() {
        let registry = ActorRegistry::default();
        let replica = actor(Role::Replica, "Alice's laptop");
        registry.register(replica.clone());

        assert_eq!(
            registry.get_with_role(&replica.id, Role::Replica).map(|a| a.id),
            Ok(replica.id)
        );
    }

    // ── Shared participant pool ──────────────────────────────────────────────
    //
    // Provisioned participants belong to the server, not to whoever asked for
    // them. Every owner pairs with the same fixtures, so a request for seven is
    // a target for the pool rather than an order to create seven more.

    fn participants(registry: &ActorRegistry) -> usize {
        registry.all().iter().filter(|a| a.role == Role::Participant).count()
    }

    fn ensure(registry: &ActorRegistry, desired: usize) -> EnsuredParticipants {
        registry.ensure_participants(desired, |i| actor(Role::Participant, &format!("p{i}")))
    }

    #[test]
    fn an_empty_pool_is_filled_to_the_requested_size() {
        let registry = ActorRegistry::default();

        let outcome = ensure(&registry, 7);

        assert_eq!(outcome.created.len(), 7);
        assert_eq!(outcome.participants.len(), 7);
        assert_eq!(participants(&registry), 7);
    }

    #[test]
    fn asking_for_what_already_exists_creates_nothing() {
        // Alice sets up with seven, Bob then also asks for seven. Seven should
        // exist, not fourteen.
        let registry = ActorRegistry::default();
        ensure(&registry, 7);

        let outcome = ensure(&registry, 7);

        assert_eq!(outcome.created.len(), 0);
        assert_eq!(outcome.participants.len(), 7);
        assert_eq!(participants(&registry), 7);
    }

    #[test]
    fn only_the_shortfall_is_created() {
        // Bob wants nine and seven exist, so two are added.
        let registry = ActorRegistry::default();
        ensure(&registry, 7);

        let outcome = ensure(&registry, 9);

        assert_eq!(outcome.created.len(), 2);
        assert_eq!(participants(&registry), 9);
    }

    #[test]
    fn asking_for_fewer_than_exist_removes_nothing() {
        // The pool is shared: another owner may be paired with a participant
        // this caller does not want, so a lower target must never tear one down.
        let registry = ActorRegistry::default();
        ensure(&registry, 7);

        let outcome = ensure(&registry, 3);

        assert!(outcome.created.is_empty());
        assert_eq!(outcome.participants.len(), 7);
        assert_eq!(participants(&registry), 7);
    }

    #[test]
    fn owners_and_replicas_do_not_count_towards_the_pool() {
        // Only `Role::Participant` is the shared helper pool. Counting owners
        // would let two browser tabs suppress creation of real participants.
        let registry = ActorRegistry::default();
        registry.register(actor(Role::Owner, "Alice"));
        registry.register(actor(Role::Owner, "Bob"));
        registry.register(actor(Role::Replica, "Alice's laptop"));

        let outcome = ensure(&registry, 3);

        assert_eq!(outcome.created.len(), 3);
        assert_eq!(outcome.participants.len(), 3);
        assert_eq!(registry.all().len(), 6);
    }

    #[test]
    fn the_returned_pool_includes_participants_the_caller_did_not_create() {
        // The caller wants the whole pool to pair against, not just its own
        // additions — otherwise a second owner would see an empty roster.
        let registry = ActorRegistry::default();
        ensure(&registry, 2);

        let outcome = ensure(&registry, 3);

        assert_eq!(outcome.created.len(), 1);
        let names: Vec<String> = outcome.participants.into_iter().map(|a| a.name).collect();
        assert_eq!(names, ["p0", "p1", "p2"]);
    }

    #[test]
    fn mint_is_told_which_index_it_is_filling() {
        // So a caller supplying names can line them up with the gap it is
        // filling rather than restarting from zero each time.
        let registry = ActorRegistry::default();
        ensure(&registry, 2);

        let outcome = ensure(&registry, 5);

        let names: Vec<String> = outcome.created.into_iter().map(|a| a.name).collect();
        assert_eq!(names, ["p2", "p3", "p4"]);
    }

    #[test]
    fn concurrent_requests_for_the_same_size_do_not_double_the_pool() {
        // The reason counting and creating share one lock. Two tabs setting up
        // at the same moment would otherwise both observe an empty pool and
        // both fill it.
        use std::sync::Arc;

        let registry = Arc::new(ActorRegistry::default());
        let threads: Vec<_> = (0..8)
            .map(|t| {
                let registry = Arc::clone(&registry);
                std::thread::spawn(move || {
                    registry.ensure_participants(7, |i| {
                        actor(Role::Participant, &format!("t{t}-p{i}"))
                    })
                })
            })
            .collect();

        let total_created: usize = threads
            .into_iter()
            .map(|h| h.join().expect("thread panicked").created.len())
            .sum();

        assert_eq!(participants(&registry), 7);
        assert_eq!(total_created, 7, "every participant is created exactly once");
    }

    #[test]
    fn concurrent_requests_for_different_sizes_settle_on_the_largest() {
        use std::sync::Arc;

        let registry = Arc::new(ActorRegistry::default());
        let threads: Vec<_> = [3, 9, 5, 7]
            .into_iter()
            .map(|want| {
                let registry = Arc::clone(&registry);
                std::thread::spawn(move || {
                    registry.ensure_participants(want, |i| {
                        actor(Role::Participant, &format!("w{want}-p{i}"))
                    })
                })
            })
            .collect();
        for h in threads {
            h.join().expect("thread panicked");
        }

        assert_eq!(participants(&registry), 9);
    }

    #[test]
    fn a_role_lookup_distinguishes_wrong_role_from_missing() {
        // The two map onto different status codes: naming a participant on a
        // replica route is a caller error (400), naming nothing at all is 404.
        let registry = ActorRegistry::default();
        let owner = actor(Role::Owner, "Alice");
        registry.register(owner.clone());
        let stranger = actor(Role::Replica, "nobody");

        assert_eq!(
            registry.get_with_role(&owner.id, Role::Replica).err(),
            Some(RoleMismatch::WrongRole { actual: Role::Owner })
        );
        assert_eq!(
            registry.get_with_role(&stranger.id, Role::Replica).err(),
            Some(RoleMismatch::NotFound)
        );
    }
}
