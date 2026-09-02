use std::sync::{Arc, RwLock};

use actix::Addr;
use dashmap::DashMap;
use tokio::sync::{Mutex, mpsc};
use uuid::Uuid;

use crate::actor::ProvisionedActor;
use crate::config::Defaults;
use crate::models::{Actor, Role, TransportBreakdown, TransportMode, TransportProtocol};

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

    /// Bring the pool up to a target composition, creating only the per-mode
    /// shortfall.
    ///
    /// The whole count-and-create happens under one lock, so two browser
    /// contexts setting up at the same moment cannot each fill an empty pool.
    /// Asking for fewer of a mode than exist removes nothing: another owner
    /// may be paired with one.
    ///
    /// `mint` receives two counters with distinct meanings, matching the two
    /// documented on [`crate::routes::helpers::helper_name`]:
    /// - `taken` is this call's creation order, across every mode combined —
    ///   the first helper minted anywhere in this call is `0`, the second `1`,
    ///   regardless of which mode each belongs to.
    /// - `pool_index` is that helper's position in the whole shared pool
    ///   (every role-`Helper` actor, of any mode) at the moment it is added,
    ///   so it keeps climbing across separate `ensure` calls rather than
    ///   restarting at zero per mode.
    pub fn ensure_participants_by_mode<F>(
        &self,
        want: TransportBreakdown,
        mut mint: F,
    ) -> EnsuredParticipants
    where
        F: FnMut(usize, usize, TransportMode) -> Actor,
    {
        let mut actors = self.write();
        let mut created: Vec<Actor> = Vec::new();
        let mut taken = 0usize;

        for (mode, target) in want.modes() {
            let existing = actors
                .iter()
                .filter(|a| a.role == Role::Helper && mode_of(a) == mode)
                .count();
            for _ in existing..target {
                let pool_index = actors.iter().filter(|a| a.role == Role::Helper).count();
                let actor = mint(taken, pool_index, mode);
                actors.push(actor.clone());
                created.push(actor);
                taken += 1;
            }
        }

        let participants = actors
            .iter()
            .filter(|a| a.role == Role::Helper)
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

/// Outcome of [`ActorRegistry::ensure_participants_by_mode`].
pub struct EnsuredParticipants {
    /// Only the participants this call brought into existence. The caller
    /// spawns a protocol instance for each — outside the registry lock.
    pub created: Vec<Actor>,
    /// The whole pool afterwards, which is what the caller actually wanted.
    pub participants: Vec<Actor>,
}

/// Which mode an actor's advertised endpoints correspond to.
fn mode_of(actor: &Actor) -> TransportMode {
    let has_grpc = actor
        .transports
        .iter()
        .any(|t| t.protocol == TransportProtocol::Grpc);
    let has_http = actor
        .transports
        .iter()
        .any(|t| t.protocol == TransportProtocol::Https);
    match (has_grpc, has_http) {
        (true, true) => TransportMode::Both,
        (true, false) => TransportMode::Grpc,
        _ => TransportMode::Http,
    }
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
    /// Helper-side channel IDs per actor (one entry per paired owner).
    pub helper_channels: Arc<DashMap<Uuid, Vec<String>>>,
    pub disabled_helpers: Arc<DashMap<Uuid, ()>>,
    /// Contact messages posted by browser-managed participants for the owner to fetch.
    pub browser_participant_contacts: Arc<DashMap<Uuid, String>>,
    /// Operator-supplied starting values for the front end. Read once at boot
    /// and never mutated — the backend serves them, the front end owns them.
    pub defaults: Arc<Defaults>,
    pub base_url: Arc<str>,
    pub http_client: reqwest::Client,
    pub arbiter: actix_rt::ArbiterHandle,
    /// `channel_id` → actor, for gRPC ingress only. See [`crate::routing`].
    pub channel_router: Arc<crate::routing::ChannelRouter>,
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
            helper_channels: Arc::new(DashMap::new()),
            disabled_helpers: Arc::new(DashMap::new()),
            browser_participant_contacts: Arc::new(DashMap::new()),
            defaults: Arc::new(defaults),
            base_url: base_url.into(),
            http_client,
            arbiter,
            channel_router: Arc::new(crate::routing::ChannelRouter::new()),
        }
    }

    /// Host and port peers dial for gRPC, derived from `base_url`'s host and
    /// the configured gRPC port so a LAN `BASE_URL` produces a LAN gRPC
    /// endpoint rather than an unreachable `localhost` one.
    ///
    /// Handles a bracketed IPv6 literal (`[::1]:5000`) as one unit: naively
    /// splitting the authority on `:` would cut a `[::1]` host apart at its
    /// first colon and produce `grpc://[:50051`, which nothing can dial.
    pub fn grpc_authority(&self) -> String {
        let host = self
            .base_url
            .split("://")
            .nth(1)
            .and_then(|rest| rest.split('/').next())
            .map(host_from_authority)
            .unwrap_or_else(|| "localhost".to_owned());
        format!("{host}:{}", self.defaults.grpc_port)
    }
}

/// The host portion of a `host:port` or bracketed `[host]:port` authority.
///
/// A bracketed IPv6 literal is kept whole rather than split at its first
/// colon, which would otherwise land on one of the address's own colons
/// instead of the port separator.
fn host_from_authority(authority: &str) -> String {
    if let Some(rest) = authority.strip_prefix('[') {
        if let Some(host) = rest.split(']').next() {
            return format!("[{host}]");
        }
    }
    authority
        .split(':')
        .next()
        .unwrap_or("localhost")
        .to_owned()
}

/// Fixtures for integration tests under `tests/`.
///
/// Not `#[cfg(test)]`: that attribute only covers unit tests compiled into this
/// crate, and integration tests link against the ordinary library build.
pub mod test_support {
    use std::sync::Arc;

    use super::AppState;
    use crate::config::Defaults;

    /// An `AppState` wired to the arbiter of the currently running actix
    /// system.
    ///
    /// Must be called from inside an actix runtime — `#[actix_rt::test]` or an
    /// equivalent — because there is no arbiter to hand out otherwise.
    pub fn app_state() -> Arc<AppState> {
        Arc::new(AppState::new(
            "http://localhost:5000",
            Defaults::default(),
            reqwest::Client::new(),
            actix_rt::Arbiter::current(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::TransportMode;
    use crate::provisioning::provisioned_actor;

    fn actor(role: Role, name: &str) -> Actor {
        provisioned_actor(role, name, "http://localhost", "localhost:50051", TransportMode::Http)
    }

    fn helper_with_mode(mode: TransportMode) -> Actor {
        crate::provisioning::provisioned_actor(
            Role::Helper,
            "pool",
            "http://localhost:5000",
            "localhost:50051",
            mode,
        )
    }

    fn owner_actor() -> Actor {
        crate::provisioning::provisioned_actor(
            Role::Owner,
            "owner",
            "http://localhost:5000",
            "localhost:50051",
            TransportMode::Http,
        )
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
            registry.register(actor(Role::Helper, name));
        }

        let names: Vec<String> = registry.all().into_iter().map(|a| a.name).collect();

        assert_eq!(names, ["first", "second", "third", "fourth"]);
    }

    #[test]
    fn a_role_lookup_accepts_the_matching_role() {
        let registry = ActorRegistry::default();
        let helper = actor(Role::Helper, "Alex");
        registry.register(helper.clone());

        assert_eq!(
            registry.get_with_role(&helper.id, Role::Helper).map(|a| a.id),
            Ok(helper.id)
        );
    }

    // ── Shared participant pool ──────────────────────────────────────────────
    //
    // Provisioned participants belong to the server, not to whoever asked for
    // them. Every owner pairs with the same fixtures, so a request for seven is
    // a target for the pool rather than an order to create seven more.

    fn participants(registry: &ActorRegistry) -> usize {
        registry.all().iter().filter(|a| a.role == Role::Helper).count()
    }

    /// A single-mode `ensure_participants_by_mode` call, naming each minted
    /// helper by its pool position — the direct analogue of the old
    /// single-mode `ensure_participants(desired, |i| ...)` this ports from.
    fn ensure(registry: &ActorRegistry, desired: u8) -> EnsuredParticipants {
        let want = TransportBreakdown { http: desired, grpc: 0, both: 0 };
        registry.ensure_participants_by_mode(want, |_, pool_index, mode| {
            provisioned_actor(
                Role::Helper,
                &format!("p{pool_index}"),
                "http://localhost:5000",
                "localhost:50051",
                mode,
            )
        })
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
    fn mint_is_told_which_pool_position_it_is_filling() {
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
                    let want = TransportBreakdown { http: 7, grpc: 0, both: 0 };
                    registry.ensure_participants_by_mode(want, move |_, pool_index, mode| {
                        provisioned_actor(
                            Role::Helper,
                            &format!("t{t}-p{pool_index}"),
                            "http://localhost:5000",
                            "localhost:50051",
                            mode,
                        )
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
        let threads: Vec<_> = [3u8, 9, 5, 7]
            .into_iter()
            .map(|want| {
                let registry = Arc::clone(&registry);
                std::thread::spawn(move || {
                    let breakdown = TransportBreakdown { http: want, grpc: 0, both: 0 };
                    registry.ensure_participants_by_mode(breakdown, move |_, pool_index, mode| {
                        provisioned_actor(
                            Role::Helper,
                            &format!("w{want}-p{pool_index}"),
                            "http://localhost:5000",
                            "localhost:50051",
                            mode,
                        )
                    })
                })
            })
            .collect();
        for h in threads {
            h.join().expect("thread panicked");
        }

        assert_eq!(participants(&registry), 9);
    }

    // ── Pool composition by transport mode ───────────────────────────────────

    #[test]
    fn only_the_per_mode_shortfall_is_created() {
        // The pool is shared and the request states a target composition, not
        // a quantity to add — the existing rule, now partitioned by mode.
        let registry = ActorRegistry::default();
        registry.register(helper_with_mode(TransportMode::Http));
        registry.register(helper_with_mode(TransportMode::Http));

        let want = TransportBreakdown { http: 3, grpc: 1, both: 0 };
        let result =
            registry.ensure_participants_by_mode(want, |_, _, mode| helper_with_mode(mode));

        assert_eq!(result.created.len(), 2, "one http short, one grpc short");
        assert_eq!(result.participants.len(), 4);
    }

    #[test]
    fn asking_for_fewer_of_a_mode_than_exist_removes_nothing() {
        let registry = ActorRegistry::default();
        for _ in 0..3 {
            registry.register(helper_with_mode(TransportMode::Grpc));
        }

        let want = TransportBreakdown { http: 0, grpc: 1, both: 0 };
        let result =
            registry.ensure_participants_by_mode(want, |_, _, mode| helper_with_mode(mode));

        assert!(result.created.is_empty());
        assert_eq!(result.participants.len(), 3);
    }

    #[test]
    fn a_breakdown_reports_its_total() {
        let want = TransportBreakdown { http: 1, grpc: 2, both: 3 };

        assert_eq!(want.total(), 6);
    }

    #[test]
    fn owners_still_do_not_count_towards_the_pool() {
        let registry = ActorRegistry::default();
        registry.register(owner_actor());

        let want = TransportBreakdown { http: 1, grpc: 0, both: 0 };
        let result =
            registry.ensure_participants_by_mode(want, |_, _, mode| helper_with_mode(mode));

        assert_eq!(result.created.len(), 1);
        assert_eq!(result.participants.len(), 1);
    }

    #[test]
    fn a_mixed_shortfall_gives_every_mint_call_distinct_counters() {
        // Reproduces the wizard's "1 http, 1 grpc, 1 both" request against an
        // empty pool: `ensure_participants_by_mode` restarts its per-mode loop
        // variable at zero for each mode, so a caller naming helpers off that
        // alone would mint every helper under the same name. `taken` (creation
        // order) and `pool_index` (position in the whole shared pool) must both
        // come out distinct across the three mints.
        let registry = ActorRegistry::default();

        let want = TransportBreakdown { http: 1, grpc: 1, both: 1 };
        let mut calls: Vec<(usize, usize)> = Vec::new();
        let result = registry.ensure_participants_by_mode(want, |taken, pool_index, mode| {
            calls.push((taken, pool_index));
            helper_with_mode(mode)
        });

        assert_eq!(result.created.len(), 3);

        let taken: Vec<usize> = calls.iter().map(|(t, _)| *t).collect();
        assert_eq!(taken, vec![0, 1, 2], "creation order must not restart per mode");

        let pool_indices: Vec<usize> = calls.iter().map(|(_, p)| *p).collect();
        let mut sorted = pool_indices.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), 3, "pool position must be unique across modes too");
    }

    #[test]
    fn a_role_lookup_distinguishes_wrong_role_from_missing() {
        // The two map onto different status codes: naming an owner on a
        // helper route is a caller error (400), naming nothing at all is 404.
        let registry = ActorRegistry::default();
        let owner = actor(Role::Owner, "Alice");
        registry.register(owner.clone());
        let stranger = actor(Role::Helper, "nobody");

        assert_eq!(
            registry.get_with_role(&owner.id, Role::Helper).err(),
            Some(RoleMismatch::WrongRole { actual: Role::Owner })
        );
        assert_eq!(
            registry.get_with_role(&stranger.id, Role::Helper).err(),
            Some(RoleMismatch::NotFound)
        );
    }

    // ── gRPC authority derivation ─────────────────────────────────────────────
    //
    // This exists so a LAN `BASE_URL` yields a reachable gRPC endpoint rather
    // than an unreachable `localhost` one — an IPv6 `BASE_URL` must get the
    // same treatment.

    #[actix_rt::test]
    async fn grpc_authority_combines_the_base_url_host_with_the_configured_port() {
        let state = AppState::new(
            "http://192.168.0.28:5000",
            Defaults::default(),
            reqwest::Client::new(),
            actix_rt::Arbiter::current(),
        );

        assert_eq!(state.grpc_authority(), "192.168.0.28:50051");
    }

    #[actix_rt::test]
    async fn grpc_authority_keeps_a_bracketed_ipv6_host_whole() {
        // Naively splitting the authority on its first `:` lands inside the
        // address itself (`[`) and produces `grpc://[:50051`, which nothing
        // can dial.
        let state = AppState::new(
            "http://[::1]:5000",
            Defaults::default(),
            reqwest::Client::new(),
            actix_rt::Arbiter::current(),
        );

        assert_eq!(state.grpc_authority(), "[::1]:50051");
    }

    #[test]
    fn host_from_authority_strips_the_port_from_a_plain_host() {
        assert_eq!(host_from_authority("example.com:5000"), "example.com");
    }

    #[test]
    fn host_from_authority_keeps_brackets_around_an_ipv6_literal() {
        assert_eq!(host_from_authority("[2001:db8::1]:5000"), "[2001:db8::1]");
    }
}
