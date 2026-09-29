use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use actix::prelude::*;
use tracing::{error, info, warn};
use uuid::Uuid;

use derec_library::protocol::{
    AutoAcceptPolicy, ChannelQuery, ChannelRecord, ChannelStatus, DeRecChannelStore, DeRecEvent,
    DeRecFlow, DeRecProtocolBuilder, ExpiredChannelCleanup,
};
use derec_library::protocol::types::{HelperFilter, ReplicaFilter, Timeouts};
use derec_library::types::ChannelId;

/// How often each actor advances its own time-driven state.
///
/// `process()` is the only other thing that moves protocol time forward, so a
/// round whose peers all go quiet has nothing left to close it — no
/// `SharingComplete`, no unpair timeout, ever. This must stay well below the
/// configured protocol timeout for those deadlines to land on time.
const TICK_INTERVAL: Duration = Duration::from_secs(15);

/// How long a `Pending` channel may wait for out-of-band confirmation.
///
/// The library's automatic sweep is disabled in favour of this, because its
/// default (5 minutes) is also the budget a *human* gets to compare a
/// fingerprint out of band — every `NoKeys` pairing and every replica pairing
/// waits in `Pending` for exactly that. Five minutes is far too short for an
/// interop session where the operator is reading codes between two browsers.
const PENDING_CHANNEL_TTL_SECS: u64 = 3600;

/// How long to wait before retrying an auto-confirmation whose instance was
/// borrowed by an in-flight call, and how many times.
///
/// Handlers on this actor answer with futures that keep running while the next
/// message is dispatched, so the instance a freshly paired channel belongs to
/// can legitimately be borrowed at the moment the confirmation runs. Skipping
/// silently there would leave the channel `Pending` forever — the exact failure
/// this whole mechanism exists to remove — so the attempt is rescheduled
/// instead, and only gives up loudly.
const AUTO_CONFIRM_RETRY: Duration = Duration::from_millis(250);
const AUTO_CONFIRM_ATTEMPTS: u8 = 8;

use crate::models::{Role, UnpairAck};
use crate::sql::{
    channel::SqlChannelStore, secret::SqlSecretStore, share::SqlShareStore,
    state::SqlStateStore, user_secret::SqlUserSecretStore,
};
use crate::state::AppState;
use crate::transport::{CompositeTransport, GrpcTransport, HttpTransport};

/// The protocol type every actor runs.
///
/// Lives here rather than in `stores.rs` because it is about what an actor
/// *is*, not about how one storage backend is written — and because the
/// in-memory stores it used to name are on their way out.
///
/// Parameter order is channel, share, secret, user-secret, state, transport.
pub type ActorProtocol = derec_library::protocol::DeRecProtocol<
    SqlChannelStore,
    SqlShareStore,
    SqlSecretStore,
    SqlUserSecretStore,
    SqlStateStore,
    CompositeTransport,
>;

/// Everything needed to build this actor's protocol instance.
#[derive(Clone)]
pub struct ProtocolConfig {
    /// The secret this actor protects as Owner. Helper-role channels share
    /// the same instance and carry their own Owner's id on each share record.
    /// On a config clone that builds or rebuilds a *replica* instance this is
    /// instead the mirrored owner's secret, because a replica instance is bound
    /// to the vault it mirrors rather than to this actor's own.
    pub secret_id: u64,
    /// Every endpoint this actor advertises, in preference order.
    pub own_transports: Vec<crate::models::Transport>,
    pub communication_info: HashMap<String, String>,
    pub timeout_secs: u32,
    pub unpair_ack: UnpairAck,
    pub threshold: usize,
    pub keep_versions_count: usize,
    /// Stable per-device replica id. Required for this actor to take part in
    /// any replica-mode pairing; `None` for plain participants.
    pub replica_id: Option<u64>,
    pub http_client: reqwest::Client,
    /// The database every store for this instance reads and writes.
    ///
    /// A handle, like `http_client` beside it — cloning shares connections
    /// rather than opening them, so an actor owning one costs nothing.
    pub pool: sqlx::AnyPool,
    /// The actor these stores belong to.
    ///
    /// Part of every store's key alongside `secret_id`, because `secret_id`
    /// alone does not identify an instance: a replica instance is bound to the
    /// *mirrored owner's* secret, so two actors mirroring one owner would
    /// otherwise share rows. See the header of `migrations/0001_initial.sql`.
    ///
    /// Carried on the config rather than passed separately so a replica
    /// instance — built from a clone of this config with `secret_id` changed —
    /// keeps the actor it belongs to.
    pub actor_id: Uuid,
}

/// The settings half of the builder chain, shared by fresh construction and
/// in-place rebuild.
///
/// Stores are *not* set here, and neither is the own-transport URI: those
/// setters are the ones that move the builder's typestate, so a helper generic
/// over the slots cannot call them. A fresh instance gets empty stores, a
/// rebuild moves the live ones across — everything else is identical, and
/// keeping it in one place is what stops a settings change from being applied
/// to one path and forgotten in the other.
fn configure_builder<Cs, Sh, Se, Us, St, T, O>(
    builder: DeRecProtocolBuilder<Cs, Sh, Se, Us, St, T, O>,
    config: &ProtocolConfig,
) -> DeRecProtocolBuilder<Cs, Sh, Se, Us, St, T, O> {
    let builder = builder
        // Derived, not hardcoded: serving every advertised endpoint over a
        // secure scheme turns the guardrail back on by itself.
        //
        // Loopback alone is not enough. The library exempts plaintext loopback
        // only for the endpoints a node configures for *itself*; a peer's
        // endpoint may never be plaintext by default, and every peer these
        // actors talk to is `http://localhost:5000/derec/...`.
        .with_unsafe_connection(config.own_transports.iter().any(|t| {
            t.uri.starts_with("http://") || t.uri.starts_with("grpc://")
        }))
        .with_threshold(config.threshold)
        .with_keep_versions_count(config.keep_versions_count)
        .with_timeouts(Timeouts {
            // The front end's single configured "protocol timeout" is the
            // replay window — how stale an inbound envelope may be and still
            // be accepted. The liveness budgets below answer a different
            // question (how long to keep hoping a silent peer answers), so
            // they keep the library's defaults rather than inheriting it.
            inbound_message: Duration::from_secs(config.timeout_secs as u64),
            // Cleanup is driven from this actor's own tick instead, at
            // `PENDING_CHANNEL_TTL_SECS` — see that constant for why the
            // default is unusable once fingerprint-gated pairing is in play.
            expired_channels: ExpiredChannelCleanup::Disabled,
            ..Timeouts::default()
        })
        .with_communication_info(config.communication_info.clone())
        .with_unpair_ack(config.unpair_ack.to_library())
        // These actors exist to be interoperated against, and a peer that sends
        // something this node cannot process — wrong format, undecryptable,
        // unknown channel — learns nothing from silence. Answering with a
        // failure response is what makes a fixture debuggable from the other
        // side of an interop test. An unattended fixture also has no user to
        // decide otherwise, which is the case the default (`false`) exists for.
        .with_auto_respond_on_failure(true)
        .with_auto_accept(AutoAcceptPolicy::all());

    match config.replica_id {
        Some(replica_id) => builder.with_replica_id(replica_id),
        None => builder,
    }
}

/// Build a provisioned actor's protocol instance.
///
/// Provisioned actors are interoperability-test fixtures with no user to
/// prompt, so every inbound action is auto-accepted by the library rather than
/// by a hand-rolled accept loop.
pub fn build_protocol(config: &ProtocolConfig) -> Result<ActorProtocol, derec_library::Error> {
    // Every store is keyed by this alongside `secret_id`; see `ProtocolConfig`.
    let actor = config.actor_id.to_string();
    let actor = actor.as_str();

    let builder = DeRecProtocolBuilder::new(config.secret_id)
        .with_channel_store(SqlChannelStore::new(config.pool.clone(), actor))
        .with_share_store(SqlShareStore::new(config.pool.clone(), actor))
        .with_secret_store(SqlSecretStore::new(config.pool.clone(), actor))
        .with_user_secret_store(SqlUserSecretStore::new(config.pool.clone(), actor))
        .with_state_store(SqlStateStore::new(config.pool.clone(), actor))
        .with_transport(CompositeTransport::new(
            HttpTransport::new(config.http_client.clone()),
            GrpcTransport::new(),
        ))
        // The singular setter is deprecated; the whole list is what gets
        // advertised in `supportedTransports` at pairing.
        .with_own_transports(
            config
                .own_transports
                .iter()
                .map(|t| t.uri.as_str())
                .collect::<Vec<_>>(),
        );

    configure_builder(builder, config).build()
}

/// Build a fresh instance from `config`, moving `old`'s stores into it.
///
/// The SDK exposes `timeouts` and `unpair_ack` on the builder only — there is
/// no runtime setter for either — so changing them on a live instance means
/// rebuilding it.
///
/// **Channels, shares and in-flight orchestrator state survive because they are
/// in the database**, not because of the moves below: every store is a handle
/// on the same pool, so the freshly built ones already read exactly what
/// `old`'s did. The moves are kept because `transport` genuinely must carry
/// over — it holds live clients — and because moving all six together keeps
/// this honest if a store ever regains per-instance state.
///
/// On failure `old` comes back untouched, so a rejected rebuild costs the
/// caller its settings change and nothing else. That is why the new instance is
/// built first and `old`'s parts are moved in afterwards rather than handed to
/// the builder: `build()` consumes the builder, so a failure with `old`'s
/// transport already inside it would destroy it with no way to hand it back.
/// Everything the builder validates (`threshold`, the own-transport URI and its
/// plaintext policy) comes from `config` alone, never from the stores, so the
/// outcome is the same either way.
fn rebuild_with_stores(
    config: &ProtocolConfig,
    old: ActorProtocol,
) -> Result<ActorProtocol, (ActorProtocol, derec_library::Error)> {
    let mut rebuilt = match build_protocol(config) {
        Ok(rebuilt) => rebuilt,
        Err(e) => return Err((old, e)),
    };

    rebuilt.channel_store = old.channel_store;
    rebuilt.share_store = old.share_store;
    rebuilt.secret_store = old.secret_store;
    rebuilt.user_secret_store = old.user_secret_store;
    rebuilt.state_store = old.state_store;
    rebuilt.transport = old.transport;

    Ok(rebuilt)
}

/// Every channel id an instance currently holds, or `None` if the enumeration
/// was incomplete.
///
/// Both halves matter: `helpers()` lists channels where this instance is one
/// side of an Owner↔Helper relationship, and `replicas()` lists replica-group
/// members. A message may arrive on either, so routing needs both.
///
/// A partial result is not returned: if either read fails, this returns
/// `None` rather than the ids the other half found. `InstanceMap::reconcile`
/// replaces *all* of an instance's bindings with whatever list it is given,
/// so a partial list would make it prune the valid bindings for the half that
/// failed, not merely leave them stale. Callers must skip `reconcile`
/// entirely on `None`, leaving the previous index in place for the next
/// reconcile to repair — a stale index is recoverable, a pruned one drops
/// live routes until something re-creates the channel.
async fn channel_ids_of(protocol: &ActorProtocol, secret_id: u64) -> Option<Vec<u64>> {
    let mut ok = true;
    let mut ids = Vec::new();

    match protocol
        .channel_store
        .helpers(secret_id, HelperFilter::default())
        .await
    {
        Ok(channels) => ids.extend(channels.iter().map(|c| c.channel_id.0)),
        Err(e) => {
            ok = false;
            warn!(secret_id = secret_id, error = %e, "helper channel read failed during reconcile");
        }
    }

    match protocol
        .channel_store
        .replicas(secret_id, ReplicaFilter::default())
        .await
    {
        Ok(members) => ids.extend(members.iter().map(|m| m.channel_id.0)),
        Err(e) => {
            ok = false;
            warn!(secret_id = secret_id, error = %e, "replica member read failed during reconcile");
        }
    }

    if !ok {
        return None;
    }

    ids.sort_unstable();
    ids.dedup();
    Some(ids)
}

/// Channel ids on `secret_id` still awaiting fingerprint confirmation.
///
/// Unlike [`channel_ids_of`], a partial read is returned rather than
/// suppressed. Nothing is pruned from this answer — it only ever *adds* a
/// confirmation attempt, and the attempt is idempotent — so the worst a missing
/// half can do is defer a channel to the next tick, where a `None` would defer
/// it forever.
async fn pending_channel_ids(protocol: &ActorProtocol, secret_id: u64) -> Vec<u64> {
    let mut ids = Vec::new();

    let pending_helpers = HelperFilter {
        status: vec![ChannelStatus::Pending],
        ..Default::default()
    };
    let pending_replicas = ReplicaFilter {
        status: vec![ChannelStatus::Pending],
        ..Default::default()
    };

    match protocol
        .channel_store
        .helpers(secret_id, pending_helpers)
        .await
    {
        Ok(channels) => ids.extend(channels.iter().map(|c| c.channel_id.0)),
        Err(e) => {
            warn!(secret_id = secret_id, error = %e, "helper channel read failed during pending sweep");
        }
    }

    match protocol
        .channel_store
        .replicas(secret_id, pending_replicas)
        .await
    {
        Ok(members) => ids.extend(members.iter().map(|m| m.channel_id.0)),
        Err(e) => {
            warn!(secret_id = secret_id, error = %e, "replica member read failed during pending sweep");
        }
    }

    ids.sort_unstable();
    ids.dedup();
    ids
}

/// A backend-managed protocol participant.
///
/// A `DeRecProtocol` instance is bound to one `secret_id` because that is the
/// secret it protects as Owner. Helper-role channels for this actor's own
/// secret all live in the own instance: shares are separated by `channel_id`
/// and each carries its own Owner's `secret_id` on the record. Replica mode is
/// the exception — a replica mirrors one named owner's vault, and the share
/// store keys on `(secret_id, channel_id, version, replica_id)`, so mirroring
/// several owners takes one instance per owner. `instances` below holds
/// exactly that: the own instance plus any replica instances added on demand
/// via `EnsureReplicaInstanceMsg`.
pub struct ProvisionedActor {
    /// Protocol instances by the `secret_id` each is bound to. See
    /// [`crate::instances`] for why an actor needs more than one.
    instances: crate::instances::InstanceMap<ActorProtocol>,
    /// The config every instance was built from, so an instance can be rebuilt
    /// with changed settings without losing its stores.
    config: ProtocolConfig,
    actor_id: Uuid,
    role: Role,
    state: Arc<AppState>,
}

impl ProvisionedActor {
    pub fn new(
        protocol: ActorProtocol,
        config: ProtocolConfig,
        actor_id: Uuid,
        role: Role,
        state: Arc<AppState>,
    ) -> Self {
        let own_secret_id = protocol.secret_id();
        Self {
            instances: crate::instances::InstanceMap::new(own_secret_id, protocol),
            config,
            actor_id,
            role,
            state,
        }
    }

    /// The instance bound to this actor's own secret — the one that serves every
    /// helper-role channel.
    fn take_own(&mut self) -> Option<ActorProtocol> {
        self.instances.take(self.instances.own_secret_id())
    }

    fn restore_own(&mut self, protocol: ActorProtocol) {
        let own = self.instances.own_secret_id();
        self.instances.restore(own, protocol);
    }

    /// The secret whose instance holds `channel_id`.
    ///
    /// A replica-mode channel lives on the instance bound to the *mirrored
    /// owner's* secret, not on this actor's own — so anything that reaches for
    /// [`Self::take_own`] cannot see it. Resolving through the same routing
    /// index an inbound envelope goes through is what lets one handler serve
    /// both pairing modes.
    ///
    /// Falls back to the own secret when the index has no entry: an unrouted
    /// channel id is either unknown (the call fails either way) or a
    /// freshly-created own-instance channel the index has not caught up with,
    /// and the own instance is the right answer for the latter.
    fn owning_secret_for(&self, channel_id: u64) -> u64 {
        self.instances
            .secret_for_channel(channel_id)
            .unwrap_or_else(|| self.instances.own_secret_id())
    }

    /// React to the events one instance just produced.
    ///
    /// `secret_id` is the instance those events came out of. It is passed in
    /// rather than looked up per channel because it is the same answer the
    /// routing index would give — every channel an instance reports on is a
    /// channel that instance owns — without depending on `reconcile` having
    /// already caught up with a channel created moments ago inside the call
    /// that produced these events.
    fn handle_events(&mut self, secret_id: u64, events: &[DeRecEvent], ctx: &mut Context<Self>) {
        for event in events {
            match event {
                DeRecEvent::PairingCompleted {
                    channel_id,
                    pairing_channel_id,
                    peer_communication_info,
                    ..
                } => {
                    // The handshake atomically rotates to a new long-term id;
                    // the library refuses traffic on the transient one from
                    // here on, so all state keys on the new value.
                    //
                    // Drop any pin on the old id explicitly: the store never
                    // lists a rotated-away channel again, so `reconcile`'s
                    // store-catch-up cleanup can never see it and remove it —
                    // this is the only path that ever will.
                    self.instances.unpin_channel(pairing_channel_id.0);
                    // The per-instance index above routes *within* this actor;
                    // this one routes *to* it, and only gRPC ingress reads it.
                    self.state.channel_router.rotate(
                        pairing_channel_id.0,
                        channel_id.0,
                        self.actor_id,
                    );
                    let cid = channel_id.0.to_string();
                    let peer_name = peer_communication_info
                        .get("name")
                        .cloned()
                        .unwrap_or_default();

                    // One index for both pairing modes. A helper paired in
                    // replica mode is still this same actor — what separates
                    // the two is the *instance* the channel lives in, not the
                    // kind of actor holding it — so there is nothing left for a
                    // second map to distinguish.
                    match self.role {
                        Role::Helper => {
                            self.state
                                .helper_channels
                                .entry(self.actor_id)
                                .or_default()
                                .push(cid);

                            // Channels are deliberately *not* auto-linked here.
                            // Deciding that a new channel belongs to an owner we
                            // already help is an authentication step, and no
                            // field on the wire carries a trustworthy identity —
                            // a matching display name least of all. An operator
                            // links explicitly via the link endpoint.
                            info!(
                                actor_id = %self.actor_id,
                                channel_id = channel_id.0,
                                pairing_channel_id = pairing_channel_id.0,
                                peer_name = %peer_name,
                                secret_id = secret_id,
                                "helper pairing complete — channel recorded"
                            );

                            // Helpers are unattended bots: there is no operator
                            // to compare a fingerprint on this side, so one
                            // confirming here would model nothing real. The
                            // owner-side confirmation is retained and is what
                            // the protocol's out-of-band check actually
                            // protects. See `AutoConfirmFingerprintMsg`.
                            ctx.notify(AutoConfirmFingerprintMsg {
                                secret_id,
                                channel_id: channel_id.0,
                                attempts_left: AUTO_CONFIRM_ATTEMPTS,
                            });
                        }
                        Role::Owner => {}
                    }
                }

                DeRecEvent::ReplicaPaired {
                    channel_id,
                    peer_replica_id,
                } => {
                    info!(
                        actor_id = %self.actor_id,
                        channel_id = channel_id.0,
                        peer_replica_id = peer_replica_id,
                        "replica pair handshake complete"
                    );
                }

                DeRecEvent::ReplicaSecretReceived {
                    channel_id,
                    from_replica_id,
                    version,
                    shares,
                    ..
                } => {
                    info!(
                        actor_id = %self.actor_id,
                        channel_id = channel_id.0,
                        from_replica_id = from_replica_id,
                        version = version,
                        share_count = shares.len(),
                        "replica secret sync received"
                    );
                }

                DeRecEvent::ReplicaSecretAcked {
                    channel_id,
                    version,
                    status,
                    memo,
                    ..
                } => {
                    info!(
                        actor_id = %self.actor_id,
                        channel_id = channel_id.0,
                        version = version,
                        status = status,
                        memo = %memo,
                        "replica secret sync acknowledged"
                    );
                }

                DeRecEvent::AutoAccepted {
                    channel_id,
                    action_kind,
                } => {
                    info!(
                        actor_id = %self.actor_id,
                        channel_id = channel_id.0,
                        action = ?action_kind,
                        "auto-accepted inbound action"
                    );
                }

                // With `AutoAcceptPolicy::all()` the library accepts every
                // inbound action itself, so reaching here means a flow was
                // added that the policy does not yet cover.
                DeRecEvent::ActionRequired { channel_id, .. } => {
                    warn!(
                        actor_id = %self.actor_id,
                        channel_id = channel_id.0,
                        "ActionRequired surfaced despite auto-accept-all; action dropped"
                    );
                }

                DeRecEvent::Unpaired { channel_id } => {
                    let cid = channel_id.0.to_string();
                    // Drop the channel from the per-actor index so the roster
                    // enrichment stops reporting this actor as paired on a
                    // channel that no longer exists.
                    if let Some(mut entry) = self.state.helper_channels.get_mut(&self.actor_id)
                    {
                        entry.retain(|c| c != &cid);
                    }
                    self.state.channel_router.remove(channel_id.0);
                    info!(
                        actor_id = %self.actor_id,
                        channel_id = channel_id.0,
                        "channel torn down via unpair flow"
                    );
                }

                _ => {}
            }
        }
    }
}

impl actix::Supervised for ProvisionedActor {
    /// Called instead of `stopped` when a handler panics.
    ///
    /// The actor value survives — actix reuses it rather than constructing a
    /// new one — so the protocol instances, their stores and this actor's
    /// inbox binding all come back with it. There is nothing to rebuild here.
    ///
    /// What this exists for is visibility. Without supervision a panicking
    /// handler removes the helper for the rest of the process's life, and the
    /// only symptom is a peer whose messages stop being answered; with it, the
    /// helper keeps serving and the panic is on the record.
    fn restarting(&mut self, _ctx: &mut Context<Self>) {
        warn!(
            actor_id = %self.actor_id,
            "actor restarted after a panic; protocol state is retained"
        );
    }
}

impl Actor for ProvisionedActor {
    type Context = Context<Self>;

    fn started(&mut self, ctx: &mut Self::Context) {
        info!(
            actor_id = %self.actor_id,
            role = ?self.role,
            "provisioned actor started"
        );
        // An actor handles one message at a time, so scheduling the tick as a
        // message is what serializes it against `process()` — both mutate the
        // same round state, and interleaving them would lose an update.
        ctx.run_interval(TICK_INTERVAL, |_actor, ctx| ctx.notify(TickMsg));
    }
}

/// Stop this actor for good, ahead of its data being erased.
///
/// Dropping the `Addr` is not enough. A supervisor outlives its actor only
/// while the actor "is not performing any tasks", and this one schedules a
/// repeating tick in `started` — so it would keep advancing protocol time and
/// **writing rows back** into the tables the caller is about to delete, leaving
/// a participant half-deleted.
///
/// The instances are dropped before terminating rather than relying on
/// termination alone: a supervised actor that stops is restarted, and restart
/// reuses this same value. Draining them means that even if the supervisor
/// brings it back, its tick finds nothing to advance and writes nothing. The
/// caller removes it from `actor_inboxes` in the same breath, so nothing can
/// reach it either way.
#[derive(Message)]
#[rtype(result = "()")]
pub(crate) struct ShutdownMsg;

impl Handler<ShutdownMsg> for ProvisionedActor {
    type Result = ();

    fn handle(&mut self, _msg: ShutdownMsg, ctx: &mut Context<Self>) {
        for secret_id in self.instances.secret_ids() {
            // An instance borrowed by an in-flight call is already out of the
            // map; that call's future is dropped with the actor, and the
            // instance with it.
            drop(self.instances.take(secret_id));
        }
        info!(actor_id = %self.actor_id, "actor shut down before deletion");
        ctx.terminate();
    }
}

/// Advance time-driven state: sharing-round and unpair timeouts, plus the
/// `Pending`-channel sweep the library's automatic cleanup was disabled for.
#[derive(Message)]
#[rtype(result = "()")]
struct TickMsg;

impl Handler<TickMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, ()>;

    fn handle(&mut self, _msg: TickMsg, _ctx: &mut Context<Self>) -> Self::Result {
        // Collect the instances that are free right now. One borrowed by an
        // in-flight call advances time itself; skipping it is safe because the
        // next interval picks it up.
        let mut borrowed: Vec<(u64, ActorProtocol)> = Vec::new();
        for secret_id in self.instances.secret_ids() {
            if let Some(protocol) = self.instances.take(secret_id) {
                borrowed.push((secret_id, protocol));
            }
        }

        if borrowed.is_empty() {
            return Box::pin(actix::fut::ready(()));
        }

        // Only helpers confirm their own fingerprints, so only they need the
        // backstop below. Captured here because the async block has no `self`.
        let auto_confirms = self.role == Role::Helper;

        Box::pin(
            async move {
                let mut done = Vec::with_capacity(borrowed.len());
                for (secret_id, mut protocol) in borrowed {
                    let events = protocol.tick().await;
                    let swept = protocol
                        .remove_expired_channels(PENDING_CHANNEL_TTL_SECS)
                        .await;
                    let channel_ids = channel_ids_of(&protocol, secret_id).await;
                    let pending = if auto_confirms {
                        pending_channel_ids(&protocol, secret_id).await
                    } else {
                        Vec::new()
                    };
                    done.push((secret_id, protocol, events, swept, channel_ids, pending));
                }
                done
            }
            .into_actor(self)
            .map(|done, actor, ctx| {
                for (secret_id, protocol, events, swept, channel_ids, pending) in done {
                    actor.instances.restore(secret_id, protocol);
                    if let Some(channel_ids) = channel_ids {
                        actor.instances.reconcile(secret_id, &channel_ids);
                    }

                    // The backstop. `PairingCompleted` is the fast path, but a
                    // single self-notify is not a guarantee: the instance can
                    // stay borrowed past the retry window, the confirmation can
                    // fail on a transient error, and neither leaves anything to
                    // try again. Without this, both outcomes are a channel that
                    // sits `Pending` until the hour-long expiry sweep drops it.
                    // Re-notifying is free on the happy path — the handler reads
                    // the recorded status and short-circuits on `NotPending`.
                    for channel_id in pending {
                        ctx.notify(AutoConfirmFingerprintMsg {
                            secret_id,
                            channel_id,
                            attempts_left: AUTO_CONFIRM_ATTEMPTS,
                        });
                    }

                    if !events.is_empty() {
                        actor.handle_events(secret_id, &events, ctx);
                    }
                    match swept {
                        Ok(removed) if !removed.is_empty() => {
                            warn!(
                                actor_id = %actor.actor_id,
                                secret_id = secret_id,
                                count = removed.len(),
                                "swept pending channels that were never confirmed"
                            );
                        }
                        Ok(_) => {}
                        Err(e) => {
                            error!(
                                actor_id = %actor.actor_id,
                                secret_id = secret_id,
                                error = %e,
                                "expired-channel sweep failed"
                            );
                        }
                    }
                }
            }),
        )
    }
}

/// Incoming protocol bytes from a peer, routed to the instance that owns the
/// envelope's channel.
///
/// Processed as soon as the actor reaches it. This used to sit behind a random
/// 500-3000ms delay standing in for a human deciding — but a provisioned actor
/// is a fixture, not a person, and the only thing the delay actually bought was
/// latency: an actor handles one message at a time, so ordering is the
/// mailbox's job, not a sleep's. Every round trip paid it, several times over,
/// which is why verification across three helpers took minutes rather than
/// seconds.
#[derive(Message)]
#[rtype(result = "()")]
pub struct IncomingMessage(pub Vec<u8>);

/// Create an out-of-band contact, selecting the instance bound to
/// `replica_for_owner_secret` when set, or the own instance otherwise. This
/// does not instantiate a protocol for a secret this actor has not seen
/// before; send [`EnsureReplicaInstanceMsg`] first to guarantee the replica
/// instance exists.
#[derive(Message)]
#[rtype(result = "Result<derec_proto::ContactMessage, derec_library::Error>")]
pub struct CreateContactMsg {
    pub contact_mode: derec_proto::ContactMode,
    pub nonce: Option<u64>,
    /// When set, mint from the instance bound to this owner's secret rather than
    /// from the own instance — a replica-mode pairing.
    pub replica_for_owner_secret: Option<u64>,
}

#[derive(Message)]
#[rtype(result = "Result<Vec<DeRecEvent>, derec_library::Error>")]
pub struct StartFlowMsg {
    pub flow: DeRecFlow,
}

#[derive(Message)]
#[rtype(result = "Option<[u8; 32]>")]
pub struct LoadSharedKeyMsg {
    pub channel_id: u64,
}

/// One channel this actor holds, for the operator's link picker.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ChannelSummary {
    pub channel_id: String,
    /// Peer's app-level display name, from `communication_info["name"]`.
    /// Informational only — never an identity the actor acts on.
    pub peer_name: String,
    /// This actor's role on the channel: "owner" or "helper".
    pub role: String,
    /// Channels already linked to this one, itself excluded.
    pub linked_channel_ids: Vec<String>,
}

#[derive(Message)]
#[rtype(result = "Result<Vec<ChannelSummary>, derec_library::Error>")]
pub struct ListChannelsMsg;

/// Record that two channels belong to the same owner. Undirected and
/// idempotent; the operator stands in for the authentication a real helper
/// would perform before making this claim.
#[derive(Message)]
#[rtype(result = "Result<(), derec_library::Error>")]
pub struct LinkChannelsMsg {
    pub channel_id: u64,
    pub link_to_channel_id: u64,
}

#[derive(Message)]
#[rtype(result = "Result<String, derec_library::Error>")]
pub struct GetFingerprintMsg {
    pub channel_id: u64,
}

#[derive(Message)]
#[rtype(result = "Result<bool, derec_library::Error>")]
pub struct VerifyFingerprintMsg {
    pub channel_id: u64,
    pub fingerprint: String,
}

/// Confirm this actor's own side of a channel the library left `Pending`.
///
/// Every replica pairing and every `NoKeys` pairing completes in
/// `ChannelStatus::Pending` on **both** sides, and only `verify_fingerprint`
/// promotes a side to `Paired`. Fingerprint comparison is an owner-side
/// affordance: a developer controls their own app, and the actors on this
/// server are unattended interop fixtures with no operator to read a code back
/// to. A helper waiting for one would wait forever, so it confirms itself.
///
/// This does not skip the protocol step. `verify_fingerprint` derives the
/// channel's fingerprint from its own shared key and compares; handing it the
/// locally derived value runs that comparison for real. What the helper gives
/// up is the *out-of-band* half of the check, which on this side would compare
/// a value against itself in any case. The owner-side dialog is untouched.
///
/// Self-addressed only: the actor posts this to itself when one of its own
/// pairings completes. Nothing external can ask an actor to confirm a channel.
#[derive(Message)]
#[rtype(result = "()")]
struct AutoConfirmFingerprintMsg {
    /// The instance that produced the `PairingCompleted` event, and therefore
    /// the one that owns `channel_id`. A helper holds one instance per
    /// replicated owner on top of its own, and only this one has the channel's
    /// shared key — deriving the fingerprint from the own instance is the bug
    /// this field exists to prevent.
    secret_id: u64,
    channel_id: u64,
    /// Retries left for the case where the instance is borrowed; see
    /// [`AUTO_CONFIRM_RETRY`].
    attempts_left: u8,
}

/// What one auto-confirmation attempt did, so the handler can say so.
enum AutoConfirmOutcome {
    /// The channel was not waiting on a fingerprint — an `InlineKeys` or
    /// `HashedKeys` helper pairing, which the library pairs outright.
    NotPending,
    /// The owning instance holds no record of the channel at all.
    ///
    /// Unreachable today: every pairing persists its channel record before the
    /// events announcing it are returned, and the tick backstop reads the ids
    /// it sweeps out of that same store. Kept distinct from `NotPending` so
    /// that a future channel kind which persists differently shows up as a
    /// warning rather than as a silent "nothing to do".
    NoRecord,
    /// The channel was promoted out of `Pending`.
    Confirmed,
    /// `verify_fingerprint` rejected the fingerprint this instance itself
    /// derived. Not reachable through any input a peer controls, so it means
    /// the two derivations disagree — a library-level invariant breach.
    Rejected,
    Failed(derec_library::Error),
}

/// The status `protocol` records for `channel_id`, or `None` if it holds no
/// record of that channel under `secret_id`.
///
/// Both record kinds are consulted, because a pairing may write either or
/// both: a helper-mode pairing leaves only a helper-channel row, while a
/// replica-mode pairing leaves that row *and* a group-member row per
/// participant. A `Pending` on either record wins — the channel is held back
/// until every record it has is promoted, so that is the honest summary.
async fn read_channel_status(
    protocol: &ActorProtocol,
    secret_id: u64,
    channel_id: u64,
) -> Result<Option<ChannelStatus>, derec_library::Error> {
    let channel_id = ChannelId(channel_id);
    let mut statuses: Vec<ChannelStatus> = Vec::new();

    let helper = protocol
        .channel_store
        .load(secret_id, ChannelQuery::Helper { channel_id })
        .await
        .map_err(derec_library::Error::from)?;
    if let Some(ChannelRecord::Helper(helper)) = helper {
        statuses.push(helper.status);
    }

    // `ReplicaFilter` addresses members by `replica_id`, and what is wanted here
    // is every member sitting on one *channel* — which the filter cannot
    // express — so the narrowing stays local.
    let members = protocol
        .channel_store
        .replicas(secret_id, ReplicaFilter::default())
        .await
        .map_err(derec_library::Error::from)?;
    statuses.extend(
        members
            .iter()
            .filter(|m| m.channel_id == channel_id)
            .map(|m| m.status),
    );

    if statuses.contains(&ChannelStatus::Pending) {
        return Ok(Some(ChannelStatus::Pending));
    }
    Ok(statuses.first().copied())
}

/// Run the confirmation step against the instance that owns the channel.
async fn auto_confirm_fingerprint(
    protocol: &mut ActorProtocol,
    secret_id: u64,
    channel_id: u64,
) -> AutoConfirmOutcome {
    match read_channel_status(protocol, secret_id, channel_id).await {
        Ok(Some(ChannelStatus::Pending)) => {}
        Ok(Some(_)) => return AutoConfirmOutcome::NotPending,
        Ok(None) => return AutoConfirmOutcome::NoRecord,
        Err(e) => return AutoConfirmOutcome::Failed(e),
    }

    let local = match protocol.get_fingerprint(channel_id.into()).await {
        Ok(fingerprint) => fingerprint,
        Err(e) => return AutoConfirmOutcome::Failed(e),
    };

    match protocol.verify_fingerprint(channel_id.into(), &local).await {
        Ok(true) => AutoConfirmOutcome::Confirmed,
        Ok(false) => AutoConfirmOutcome::Rejected,
        Err(e) => AutoConfirmOutcome::Failed(e),
    }
}

/// Change protocol settings on every instance this actor holds, in place.
#[derive(Message)]
#[rtype(result = "Result<(), derec_library::Error>")]
pub struct ReconfigureMsg {
    pub timeout_secs: u32,
    pub unpair_ack: UnpairAck,
}

/// The `secret_id` of every instance this actor holds, ascending. Test and
/// admin observability; carries no key material.
#[derive(Message)]
#[rtype(result = "Vec<u64>")]
pub struct ListInstanceSecretsMsg;

/// The `secret_id` of the instance that owns `channel_id`, or `None` if no
/// instance claims it.
///
/// This is the same routing-index lookup an inbound envelope goes through in
/// the `IncomingMessage` handler, exposed so a test can assert on it without
/// standing up a peer. Test and admin observability; carries no key material.
#[derive(Message)]
#[rtype(result = "Option<u64>")]
pub struct InstanceForChannelMsg {
    pub channel_id: u64,
}

/// The status the owning instance records for `channel_id`.
///
/// The owning instance is resolved through the same routing index an inbound
/// envelope goes through, so this reports on the instance that actually holds
/// the channel rather than on the actor's own. Test and admin observability;
/// carries no key material.
///
/// `None` covers three cases a caller cannot tell apart: no instance claims the
/// channel, the owning instance is borrowed by an in-flight call, or its store
/// holds no record. All three are transient or uninteresting for the intended
/// use, so callers should poll rather than treat `None` as an answer.
#[derive(Message)]
#[rtype(result = "Option<ChannelStatus>")]
pub struct ChannelStatusMsg {
    pub channel_id: u64,
}

/// Every channel this actor holds that is still awaiting fingerprint
/// confirmation, across all its instances, ascending.
///
/// The same list the tick backstop acts on, exposed so a test can assert both
/// halves of that mechanism — that a channel was left `Pending`, and that the
/// tick then cleared it — without knowing an id the library minted internally.
/// Test and admin observability; carries no key material.
#[derive(Message)]
#[rtype(result = "Vec<u64>")]
pub struct PendingChannelIdsMsg;

/// Ensure this actor holds an instance bound to `owner_secret_id`.
///
/// A replica mirrors one named owner's vault, and the share store keys on
/// `(secret_id, channel_id, version, replica_id)` — an instance under a
/// different secret would miss every lookup. Replica-mode pairing therefore
/// needs an instance bound to that owner's secret, which this creates on demand.
///
/// Idempotent: a second pairing with the same owner reuses the instance rather
/// than resetting its stores. The `bool` result reports which happened —
/// `true` for created, `false` for reused — so a caller (and its tests) can
/// tell a fresh instance from a no-op rebuild that would silently discard the
/// shares an existing replica instance already holds.
#[derive(Message)]
#[rtype(result = "Result<bool, derec_library::Error>")]
pub struct EnsureReplicaInstanceMsg {
    pub owner_secret_id: u64,
}

impl Handler<IncomingMessage> for ProvisionedActor {
    type Result = ResponseActFuture<Self, ()>;

    fn handle(&mut self, msg: IncomingMessage, _ctx: &mut Context<Self>) -> Self::Result {
        let bytes = msg.0;

        let meta = match crate::envelope::decode(&bytes) {
            Ok(meta) => meta,
            Err(e) => {
                error!(
                    actor_id = %self.actor_id,
                    error = %e,
                    bytes_len = bytes.len(),
                    "undecodable envelope; dropping message"
                );
                return Box::pin(actix::fut::ready(()));
            }
        };

        // Channel 0 is the proto3 default, so an empty or truncated body decodes
        // to it. Routing on that would hand the message to whichever instance
        // happened to hold channel 0.
        if meta.channel_id == 0 {
            error!(
                actor_id = %self.actor_id,
                bytes_len = bytes.len(),
                "envelope carries no channel id; dropping message"
            );
            return Box::pin(actix::fut::ready(()));
        }

        let Some(owner) = self.instances.secret_for_channel(meta.channel_id) else {
            error!(
                actor_id = %self.actor_id,
                channel_id = meta.channel_id,
                sequence = meta.sequence,
                trace_id = meta.trace_id,
                "no instance owns this channel; dropping message"
            );
            return Box::pin(actix::fut::ready(()));
        };
        let Some(mut protocol) = self.instances.take(owner) else {
            error!(
                actor_id = %self.actor_id,
                channel_id = meta.channel_id,
                sequence = meta.sequence,
                trace_id = meta.trace_id,
                secret_id = owner,
                "instance busy; dropping message"
            );
            return Box::pin(actix::fut::ready(()));
        };
        let secret_id = owner;

        Box::pin(
            async move {
                let result = protocol.process(&bytes).await;
                let channel_ids = channel_ids_of(&protocol, secret_id).await;
                (protocol, result, channel_ids)
            }
            .into_actor(self)
            .map(move |(protocol, result, channel_ids), actor, ctx| {
                actor.instances.restore(secret_id, protocol);
                if let Some(channel_ids) = channel_ids {
                    actor.instances.reconcile(secret_id, &channel_ids);
                }
                match result {
                    Ok(events) => actor.handle_events(secret_id, &events, ctx),
                    Err(e) => {
                        error!(
                            actor_id = %actor.actor_id,
                            error = %e,
                            "actor process() failed"
                        );
                    }
                }
            }),
        )
    }
}

impl Handler<ListChannelsMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, Result<Vec<ChannelSummary>, derec_library::Error>>;

    fn handle(&mut self, _msg: ListChannelsMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let Some(protocol) = self.take_own() else {
            return Box::pin(actix::fut::ready(Err(derec_library::Error::Invariant(
                "protocol already borrowed",
            ))));
        };
        let secret_id = protocol.secret_id();

        Box::pin(
            async move {
                // Helper channels only. Linking records that two channels
                // belong to the same Owner identity, which is a helper-side
                // concern; replica-group members share one channel and are
                // listed by `replicas()` instead.
                let result = match protocol
                    .channel_store
                    .helpers(secret_id, HelperFilter::default())
                    .await
                {
                    Ok(channels) => {
                        let mut summaries = Vec::with_capacity(channels.len());
                        for ch in &channels {
                            let linked = protocol
                                .channel_store
                                .linked_channels(secret_id, ch.channel_id)
                                .await
                                .unwrap_or_default()
                                .into_iter()
                                .filter(|c| c.0 != ch.channel_id.0)
                                .map(|c| c.0.to_string())
                                .collect();
                            summaries.push(ChannelSummary {
                                channel_id: ch.channel_id.0.to_string(),
                                peer_name: ch
                                    .communication_info
                                    .get("name")
                                    .cloned()
                                    .unwrap_or_default(),
                                // The channel row records the *peer's* role;
                                // this actor's own is always the inverse.
                                role: match ch.peer_role {
                                    derec_proto::SenderKind::Owner => "helper".to_owned(),
                                    _ => "owner".to_owned(),
                                },
                                linked_channel_ids: linked,
                            });
                        }
                        Ok(summaries)
                    }
                    Err(e) => Err(derec_library::Error::from(e)),
                };
                (protocol, result)
            }
            .into_actor(self)
            .map(|(protocol, result), actor, _ctx| {
                actor.restore_own(protocol);
                result
            }),
        )
    }
}

impl Handler<LinkChannelsMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, Result<(), derec_library::Error>>;

    fn handle(&mut self, msg: LinkChannelsMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let Some(mut protocol) = self.take_own() else {
            return Box::pin(actix::fut::ready(Err(derec_library::Error::Invariant(
                "protocol already borrowed",
            ))));
        };
        let secret_id = protocol.secret_id();
        let (a, b) = (msg.channel_id, msg.link_to_channel_id);
        let actor_id = self.actor_id;

        Box::pin(
            async move {
                let result = protocol
                    .channel_store
                    .link_channel(secret_id, ChannelId(a), ChannelId(b))
                    .await
                    .map_err(derec_library::Error::from);
                if result.is_ok() {
                    info!(
                        actor_id = %actor_id,
                        channel_id = a,
                        link_to_channel_id = b,
                        "channels linked by operator"
                    );
                }
                (protocol, result)
            }
            .into_actor(self)
            .map(|(protocol, result), actor, _ctx| {
                actor.restore_own(protocol);
                result
            }),
        )
    }
}

impl Handler<CreateContactMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, Result<derec_proto::ContactMessage, derec_library::Error>>;

    fn handle(&mut self, msg: CreateContactMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let secret_id = msg
            .replica_for_owner_secret
            .unwrap_or_else(|| self.instances.own_secret_id());

        let Some(mut protocol) = self.instances.take(secret_id) else {
            return Box::pin(actix::fut::ready(Err(derec_library::Error::Invariant(
                "no instance for the requested secret, or it is borrowed",
            ))));
        };
        let contact_mode = msg.contact_mode;
        let nonce = msg.nonce;

        Box::pin(
            async move {
                let result = protocol.create_contact(None, contact_mode, nonce).await;
                let channel_ids = channel_ids_of(&protocol, secret_id).await;
                (protocol, result, channel_ids)
            }
            .into_actor(self)
            .map(move |(protocol, result, channel_ids), actor, _ctx| {
                actor.instances.restore(secret_id, protocol);
                if let Some(channel_ids) = channel_ids {
                    actor.instances.reconcile(secret_id, &channel_ids);
                }
                // `create_contact` persists to the secret store only — never
                // to the channel store — so `channel_ids_of` above cannot see
                // this channel yet, and reconcile has nothing to bind it to.
                // Pin it directly. Pinning after reconcile means ordering
                // cannot matter: even if the store somehow already reported
                // this channel, `reconcile` already dropped any pin for it,
                // and this call would just re-establish a binding that
                // `secret_for_channel` already resolved via `channel_owner`.
                if let Ok(contact) = &result {
                    actor.instances.pin_channel(contact.channel_id, secret_id);
                }
                result
            }),
        )
    }
}

impl Handler<StartFlowMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, Result<Vec<DeRecEvent>, derec_library::Error>>;

    fn handle(&mut self, msg: StartFlowMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let Some(mut protocol) = self.take_own() else {
            return Box::pin(actix::fut::ready(Err(derec_library::Error::Invariant(
                "protocol already borrowed",
            ))));
        };
        let secret_id = protocol.secret_id();
        let flow = msg.flow;

        Box::pin(
            async move {
                let result = protocol.start(flow).await;
                let channel_ids = channel_ids_of(&protocol, secret_id).await;
                (protocol, result, channel_ids)
            }
            .into_actor(self)
            .map(move |(protocol, result, channel_ids), actor, ctx| {
                actor.restore_own(protocol);
                if let Some(channel_ids) = channel_ids {
                    actor.instances.reconcile(secret_id, &channel_ids);
                }
                if let Ok(events) = &result {
                    actor.handle_events(secret_id, events, ctx);
                }
                result
            }),
        )
    }
}

impl Handler<LoadSharedKeyMsg> for ProvisionedActor {
    // A future now, not a plain value: the key lives in the database, so
    // reading it is async. `Message::Result` is unchanged, so senders still
    // await an `Option<[u8; 32]>` and no call site moves.
    type Result = ResponseActFuture<Self, Option<[u8; 32]>>;

    fn handle(&mut self, msg: LoadSharedKeyMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let Some(protocol) = self.take_own() else {
            return Box::pin(actix::fut::ready(None));
        };
        let secret_id = protocol.secret_id();
        let channel_id = msg.channel_id;

        Box::pin(
            async move {
                // A read failure is reported as "no key" rather than
                // propagated: the caller's type has no error channel, and the
                // store already logs nothing useful that a caller could act on
                // here. The fingerprint flow treats absence as "cannot
                // confirm", which is the safe reading either way.
                let key = protocol
                    .secret_store
                    .load_shared_key(secret_id, channel_id)
                    .await
                    .unwrap_or(None);
                (protocol, key)
            }
            .into_actor(self)
            .map(move |(protocol, key), actor, _ctx| {
                actor.restore_own(protocol);
                key
            }),
        )
    }
}

impl Handler<GetFingerprintMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, Result<String, derec_library::Error>>;

    fn handle(&mut self, msg: GetFingerprintMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let channel_id = msg.channel_id;
        let secret_id = self.owning_secret_for(channel_id);
        let Some(protocol) = self.instances.take(secret_id) else {
            return Box::pin(actix::fut::ready(Err(derec_library::Error::Invariant(
                "protocol already borrowed",
            ))));
        };

        Box::pin(
            async move {
                let result = protocol.get_fingerprint(channel_id.into()).await;
                (protocol, result)
            }
            .into_actor(self)
            .map(move |(protocol, result), actor, _ctx| {
                actor.instances.restore(secret_id, protocol);
                result
            }),
        )
    }
}

impl Handler<VerifyFingerprintMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, Result<bool, derec_library::Error>>;

    fn handle(&mut self, msg: VerifyFingerprintMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let channel_id = msg.channel_id;
        let secret_id = self.owning_secret_for(channel_id);
        let Some(mut protocol) = self.instances.take(secret_id) else {
            return Box::pin(actix::fut::ready(Err(derec_library::Error::Invariant(
                "protocol already borrowed",
            ))));
        };
        let fingerprint = msg.fingerprint;

        Box::pin(
            async move {
                let result = protocol
                    .verify_fingerprint(channel_id.into(), &fingerprint)
                    .await;
                (protocol, result)
            }
            .into_actor(self)
            .map(move |(protocol, result), actor, _ctx| {
                actor.instances.restore(secret_id, protocol);
                result
            }),
        )
    }
}

impl Handler<AutoConfirmFingerprintMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, ()>;

    fn handle(&mut self, msg: AutoConfirmFingerprintMsg, ctx: &mut Context<Self>) -> Self::Result {
        let AutoConfirmFingerprintMsg { secret_id, channel_id, attempts_left } = msg;
        let actor_id = self.actor_id;

        let Some(mut protocol) = self.instances.take(secret_id) else {
            if attempts_left > 0 {
                ctx.notify_later(
                    AutoConfirmFingerprintMsg {
                        secret_id,
                        channel_id,
                        attempts_left: attempts_left - 1,
                    },
                    AUTO_CONFIRM_RETRY,
                );
            } else {
                error!(
                    actor_id = %actor_id,
                    secret_id = secret_id,
                    channel_id = channel_id,
                    "instance stayed borrowed; channel left awaiting fingerprint confirmation"
                );
            }
            return Box::pin(actix::fut::ready(()));
        };

        Box::pin(
            async move {
                let outcome = auto_confirm_fingerprint(&mut protocol, secret_id, channel_id).await;
                (protocol, outcome)
            }
            .into_actor(self)
            .map(move |(protocol, outcome), actor, _ctx| {
                // Restored before the outcome is even inspected: a failed
                // confirmation must not cost the actor the instance.
                actor.instances.restore(secret_id, protocol);

                match outcome {
                    AutoConfirmOutcome::NotPending => {}
                    AutoConfirmOutcome::NoRecord => {
                        warn!(
                            actor_id = %actor_id,
                            secret_id = secret_id,
                            channel_id = channel_id,
                            "asked to confirm a channel the owning instance has no record of"
                        );
                    }
                    AutoConfirmOutcome::Confirmed => {
                        info!(
                            actor_id = %actor_id,
                            secret_id = secret_id,
                            channel_id = channel_id,
                            "helper auto-confirmed its own fingerprint; channel paired"
                        );
                    }
                    AutoConfirmOutcome::Rejected => {
                        error!(
                            actor_id = %actor_id,
                            secret_id = secret_id,
                            channel_id = channel_id,
                            "auto-confirmation rejected a locally derived fingerprint; \
                             channel left pending"
                        );
                    }
                    AutoConfirmOutcome::Failed(e) => {
                        error!(
                            actor_id = %actor_id,
                            secret_id = secret_id,
                            channel_id = channel_id,
                            error = %e,
                            // Deliberately not "channel left pending":
                            // `verify_fingerprint` writes the promotion before
                            // it publishes to the newly usable peer, so a
                            // failure here may mean either.
                            "auto-confirmation failed"
                        );
                    }
                }
            }),
        )
    }
}

impl Handler<ReconfigureMsg> for ProvisionedActor {
    type Result = Result<(), derec_library::Error>;

    fn handle(&mut self, msg: ReconfigureMsg, _ctx: &mut Context<Self>) -> Self::Result {
        self.config.timeout_secs = msg.timeout_secs;
        self.config.unpair_ack = msg.unpair_ack;

        for secret_id in self.instances.secret_ids() {
            let Some(old) = self.instances.take(secret_id) else {
                // Borrowed by an in-flight call. Leaving that instance on the
                // old settings would be a silent partial apply, so report it.
                return Err(derec_library::Error::Invariant(
                    "instance borrowed during reconfigure",
                ));
            };

            // Every instance shares this actor's settings but keeps its own
            // binding: a replica instance is bound to the mirrored owner's
            // secret, not to this actor's.
            let mut config = self.config.clone();
            config.secret_id = secret_id;

            // A rebuild failure puts the original instance back before
            // reporting, so the worst case is "these settings did not apply to
            // this instance" rather than "this instance is gone". Dropping it
            // would not even leave a clean absence: `take` empties the slot but
            // keeps the key, so the actor would answer `contains` with `true`
            // for an instance that no longer exists, skip it on every tick, and
            // fail every later reconfigure on the same empty slot until the
            // process restarts.
            match rebuild_with_stores(&config, old) {
                Ok(rebuilt) => self.instances.restore(secret_id, rebuilt),
                Err((old, e)) => {
                    self.instances.restore(secret_id, old);
                    return Err(e);
                }
            }
        }

        info!(
            actor_id = %self.actor_id,
            timeout_secs = msg.timeout_secs,
            "actor reconfigured in place"
        );
        Ok(())
    }
}

impl Handler<ListInstanceSecretsMsg> for ProvisionedActor {
    type Result = Vec<u64>;

    fn handle(&mut self, _msg: ListInstanceSecretsMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let mut ids = self.instances.secret_ids();
        ids.sort_unstable();
        ids
    }
}

impl Handler<InstanceForChannelMsg> for ProvisionedActor {
    type Result = Option<u64>;

    fn handle(&mut self, msg: InstanceForChannelMsg, _ctx: &mut Context<Self>) -> Self::Result {
        self.instances.secret_for_channel(msg.channel_id)
    }
}

impl Handler<ChannelStatusMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, Option<ChannelStatus>>;

    fn handle(&mut self, msg: ChannelStatusMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let channel_id = msg.channel_id;
        let Some(secret_id) = self.instances.secret_for_channel(channel_id) else {
            return Box::pin(actix::fut::ready(None));
        };
        let Some(protocol) = self.instances.take(secret_id) else {
            return Box::pin(actix::fut::ready(None));
        };

        Box::pin(
            async move {
                let status = read_channel_status(&protocol, secret_id, channel_id)
                    .await
                    .unwrap_or(None);
                (protocol, status)
            }
            .into_actor(self)
            .map(move |(protocol, status), actor, _ctx| {
                actor.instances.restore(secret_id, protocol);
                status
            }),
        )
    }
}

impl Handler<PendingChannelIdsMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, Vec<u64>>;

    fn handle(&mut self, _msg: PendingChannelIdsMsg, _ctx: &mut Context<Self>) -> Self::Result {
        // Borrowed instances are skipped rather than waited for, exactly as the
        // tick does — see `TickMsg`.
        let mut borrowed: Vec<(u64, ActorProtocol)> = Vec::new();
        for secret_id in self.instances.secret_ids() {
            if let Some(protocol) = self.instances.take(secret_id) {
                borrowed.push((secret_id, protocol));
            }
        }

        Box::pin(
            async move {
                let mut done = Vec::with_capacity(borrowed.len());
                for (secret_id, protocol) in borrowed {
                    let pending = pending_channel_ids(&protocol, secret_id).await;
                    done.push((secret_id, protocol, pending));
                }
                done
            }
            .into_actor(self)
            .map(|done, actor, _ctx| {
                let mut ids = Vec::new();
                for (secret_id, protocol, pending) in done {
                    actor.instances.restore(secret_id, protocol);
                    ids.extend(pending);
                }
                ids.sort_unstable();
                ids.dedup();
                ids
            }),
        )
    }
}

impl Handler<EnsureReplicaInstanceMsg> for ProvisionedActor {
    type Result = Result<bool, derec_library::Error>;

    fn handle(&mut self, msg: EnsureReplicaInstanceMsg, _ctx: &mut Context<Self>) -> Self::Result {
        if self.instances.contains(msg.owner_secret_id) {
            return Ok(false);
        }

        let mut config = self.config.clone();
        config.secret_id = msg.owner_secret_id;

        let protocol = build_protocol(&config)?;
        self.instances.insert(msg.owner_secret_id, protocol);

        info!(
            actor_id = %self.actor_id,
            owner_secret_id = msg.owner_secret_id,
            "replica instance created"
        );
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::models::{Transport, TransportProtocol};
    use derec_library::protocol::{DeRecSecretStore, SecretValue};

    const SECRET_ID: u64 = 0xA1;
    const CHANNEL_ID: u64 = 0xC0FFEE;
    const SHARED_KEY: [u8; 32] = [7u8; 32];

    /// A private in-memory database per test. A shared one would let two tests
    /// see each other's rows.
    async fn pool() -> sqlx::AnyPool {
        crate::db::connect("sqlite::memory:")
            .await
            .expect("an in-memory database always connects")
    }

    fn config(pool: sqlx::AnyPool) -> ProtocolConfig {
        ProtocolConfig {
            secret_id: SECRET_ID,
            own_transports: vec![Transport {
                protocol: TransportProtocol::Https,
                uri: "http://localhost:5000/derec/00000000-0000-0000-0000-000000000001"
                    .to_owned(),
            }],
            communication_info: HashMap::from([("name".to_owned(), "Alex".to_owned())]),
            timeout_secs: 300,
            unpair_ack: UnpairAck::Required,
            threshold: 2,
            keep_versions_count: 3,
            replica_id: Some(0xAB),
            http_client: reqwest::Client::new(),
            pool,
            actor_id: uuid::Uuid::new_v4(),
        }
    }

    /// A rejected rebuild must not cost the caller its instance.
    ///
    /// `ReconfigureMsg` has already taken the instance out of the map by the
    /// time it calls this, and `InstanceMap::take` empties the slot but keeps
    /// the key — so an instance consumed here is not merely absent, it wedges
    /// the actor: `contains` still answers `true`, every tick skips the empty
    /// slot, and every later reconfigure fails on it until the process restarts.
    ///
    /// No live configuration change can reach this today (`ReconfigureMsg`
    /// touches neither `threshold` nor `own_transports`), which is exactly why
    /// the guarantee needs a test rather than a caller to demonstrate it.
    #[actix_rt::test]
    async fn a_rejected_rebuild_hands_the_original_instance_back_with_its_stores() {
        let mut config = config(pool().await);
        let mut protocol = build_protocol(&config).expect("the baseline config builds");
        protocol
            .secret_store
            .save(
                SECRET_ID,
                ChannelId(CHANNEL_ID),
                SecretValue::SharedKey(SHARED_KEY),
            )
            .await
            .expect("the in-memory secret store accepts a shared key");

        // Rejected by the builder: a threshold below 2 lets a single helper
        // reconstruct the secret.
        config.threshold = 1;

        let Err((old, _)) = rebuild_with_stores(&config, protocol) else {
            panic!("a threshold below 2 must be rejected");
        };

        assert_eq!(old.secret_id(), SECRET_ID);

        // What this assertion proves changed when the stores moved to SQL.
        //
        // It used to distinguish the original instance from a freshly built
        // stand-in, because a stand-in carried its own empty in-memory store.
        // Every store is now a handle on one database, so a stand-in would
        // answer identically and this can no longer tell them apart.
        //
        // It is kept because the guarantee it half-covers still matters: the
        // instance handed back on a rejected rebuild must be usable and must
        // still see its own data. The "is it literally the same instance" half
        // is no longer observable through a store — and the reason it is not is
        // the point of moving them, so this is a loss worth taking rather than
        // a gap to paper over with a weaker stand-in check.
        assert_eq!(
            old.secret_store
                .load_shared_key(SECRET_ID, CHANNEL_ID)
                .await
                .expect("the store is readable"),
            Some(SHARED_KEY),
            "the instance handed back must still see the key it stored"
        );
    }
}
