// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use actix::prelude::*;
use tracing::{error, info, warn};
use uuid::Uuid;

use derec_library::protocol::types::{HelperFilter, ReplicaFilter};
use derec_library::protocol::{
    ChannelQuery, ChannelRecord, ChannelStatus, DeRecChannelStore, DeRecEvent, DeRecFlow,
    ProcessError,
};
use derec_library::types::ChannelId;
use derec_proto::SenderKind;

use super::instances::InstanceMap;
use super::protocol::{build_protocol, rebuild_with_stores, ActorProtocol, ProtocolConfig};
use super::{MAX_REPLICA_INSTANCES, PENDING_CHANNEL_TTL_SECS};
use crate::infrastructure::routing::ChannelRouter;
use crate::models::{ChannelSummary, EnvelopeMeta, Role, Side, UnpairAck};
use crate::repositories::helper_channels::HelperChannelIndex;
use crate::repositories::sharing_rounds::SharingRoundRepository;

/// How often each actor advances its own time-driven state.
///
/// `process()` is the only other thing that moves protocol time forward, so a
/// round whose peers all go quiet has nothing left to close it — no
/// `SharingComplete`, no unpair timeout, ever. This must stay well below the
/// configured protocol timeout for those deadlines to land on time.
const TICK_INTERVAL: Duration = Duration::from_secs(15);

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

/// How many confirmation attempts on one channel may *fail* before the tick
/// backstop stops retrying it.
///
/// A borrowed instance is retried by [`AUTO_CONFIRM_ATTEMPTS`]; this bounds the
/// other case, where the attempt runs and the SDK refuses — a channel whose
/// shared key never arrived, say. Retrying that every tick until the hour-long
/// expiry sweep logged the same ERROR 240 times and changed nothing. After this
/// many the channel is left to the sweep, said once.
const AUTO_CONFIRM_MAX_FAILURES: u8 = 3;

/// Every channel an instance holds, as [`held_channels_of`] read them.
#[derive(Debug, Default)]
struct HeldChannels {
    /// Every id, sorted and deduplicated.
    ids: Vec<u64>,
    /// Those of `ids` the instance holds only as the *owner's* side of a
    /// helper channel (`peer_role == Helper`) and in no other record. In a
    /// replica instance these are the source's helper channels the roster
    /// hydrated: copies, not channels the replica is an end of.
    owner_side: HashSet<u64>,
}

/// Every channel an instance currently holds, or `None` if the enumeration
/// was incomplete.
///
/// Both halves matter: `helpers()` lists channels where this instance is one
/// side of an Owner↔Helper relationship, and `replicas()` lists replica-group
/// members. A message may arrive on either, so routing needs both. Which side
/// of a helper channel the instance is on is kept too, for the server-wide
/// router: see [`ProvisionedActor::reconcile_instance`].
///
/// A partial result is not returned: if either read fails, this returns
/// `None` rather than the ids the other half found. `InstanceMap::reconcile`
/// replaces *all* of an instance's bindings with whatever list it is given,
/// so a partial list would make it prune the valid bindings for the half that
/// failed, not merely leave them stale. Callers must skip `reconcile`
/// entirely on `None`, leaving the previous index in place for the next
/// reconcile to repair — a stale index is recoverable, a pruned one drops
/// live routes until something re-creates the channel.
async fn held_channels_of(protocol: &ActorProtocol, secret_id: u64) -> Option<HeldChannels> {
    let mut ok = true;
    let mut ids = Vec::new();
    let mut owner_side = HashSet::new();
    let mut endpoint = HashSet::new();

    match protocol
        .channel_store
        .helpers(secret_id, HelperFilter::default())
        .await
    {
        Ok(channels) => {
            for channel in &channels {
                let id = channel.channel_id.0;
                ids.push(id);
                if channel.peer_role == SenderKind::Helper {
                    owner_side.insert(id);
                } else {
                    endpoint.insert(id);
                }
            }
        }
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
        Ok(members) => {
            for member in &members {
                ids.push(member.channel_id.0);
                endpoint.insert(member.channel_id.0);
            }
        }
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
    owner_side.retain(|id| !endpoint.contains(id));
    Some(HeldChannels { ids, owner_side })
}

/// Channel ids on `secret_id` still awaiting fingerprint confirmation.
///
/// Unlike [`held_channels_of`], a partial read is returned rather than
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

/// The events a `process()` call produced, whether or not it failed.
///
/// A failing call still settles the expired sharing-round and unpair deadlines
/// it swept before handling the message. Those are saved already and never
/// reported again, so they are handled exactly like a successful call's events
/// — dropping them with the error would lose them for good.
fn events_of(result: &Result<Vec<DeRecEvent>, ProcessError>) -> &[DeRecEvent] {
    match result {
        Ok(events) => events,
        Err(e) => &e.events,
    }
}

/// Persist how every sharing round in `events` ended, for
/// [`DeRecShareStore::keep_list`](derec_library::protocol::DeRecShareStore::keep_list)
/// to answer from.
///
/// Called inside the async half of a handler, before the instance is put back:
/// the next round this instance starts asks `keep_list` first, and recording
/// the outcome before anything else can borrow the instance is what guarantees
/// that round sees it. `handle_events` runs too late for that guarantee.
///
/// A failed write is logged and otherwise ignored. It costs nothing unsafe: a
/// version with no recorded outcome makes `keep_list` answer `None`, and
/// helpers keep every version.
async fn record_round_outcomes(
    rounds: &dyn SharingRoundRepository,
    actor_id: &Uuid,
    secret_id: u64,
    events: &[DeRecEvent],
) {
    for event in events {
        let DeRecEvent::SharingComplete {
            version,
            threshold_met,
            ..
        } = event
        else {
            continue;
        };
        if let Err(e) = rounds
            .record(actor_id, secret_id, *version, *threshold_met)
            .await
        {
            warn!(
                secret_id = secret_id,
                version = version,
                error = %e,
                "could not record a sharing round's outcome; helpers will keep every version"
            );
        }
    }
}

/// What a provisioned actor shares with the rest of the node: the indexes it
/// keeps current as its channels change, and where it records how each
/// sharing round ended. Narrow on purpose — an actor never sees the services
/// or the HTTP layer.
#[derive(Clone)]
pub struct ActorDependencies {
    /// Routes gRPC ingress *to* this actor by channel id.
    pub channel_router: Arc<ChannelRouter>,
    /// The roster's index of the channels each helper holds.
    pub helper_channels: Arc<dyn HelperChannelIndex>,
    /// How each sharing round ended, for the share store's `keep_list`.
    pub sharing_rounds: Arc<dyn SharingRoundRepository>,
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
    /// [`super::instances`] for why an actor needs more than one.
    instances: InstanceMap<ActorProtocol>,
    /// The config every instance was built from, so an instance can be rebuilt
    /// with changed settings without losing its stores.
    config: ProtocolConfig,
    actor_id: Uuid,
    role: Role,
    deps: ActorDependencies,
    /// Failed auto-confirmations per `(secret_id, channel_id)`; see
    /// [`AUTO_CONFIRM_MAX_FAILURES`]. Cleared once a channel confirms or turns
    /// out not to need it. In memory on purpose: a restart is a fresh chance.
    auto_confirm_failures: HashMap<(u64, u64), u8>,
}

impl ProvisionedActor {
    pub fn new(
        protocol: ActorProtocol,
        config: ProtocolConfig,
        actor_id: Uuid,
        role: Role,
        deps: ActorDependencies,
    ) -> Self {
        let own_secret_id = protocol.secret_id();
        Self {
            instances: InstanceMap::new(own_secret_id, protocol),
            config,
            actor_id,
            role,
            deps,
            auto_confirm_failures: HashMap::new(),
        }
    }

    /// Put back what a restart took away: the replica instances this actor
    /// ran, and the routes of contacts it minted that nobody has paired
    /// against yet (`(channel_id, secret_id)`).
    ///
    /// Channels already in a store need nothing here — the boot tick
    /// reconciles every instance, replica ones included. What it cannot see is
    /// a replica instance that does not exist, and a contact, which lives only
    /// in the secret store until its peer's first message; both are why a
    /// message arriving after a restart used to be dropped as "no instance
    /// owns this channel".
    pub fn with_restored(
        mut self,
        replicas: Vec<(u64, ActorProtocol)>,
        contact_pins: Vec<(u64, u64)>,
    ) -> Self {
        for (secret_id, protocol) in replicas {
            if secret_id != self.instances.own_secret_id() {
                self.instances.insert(secret_id, protocol);
            }
        }
        for (channel_id, secret_id) in contact_pins {
            if self.instances.contains(secret_id) {
                self.instances.pin_channel(channel_id, secret_id);
            }
        }
        self
    }

    /// Bring both channel indexes in line with one instance's store.
    ///
    /// The per-instance map routes *within* this actor; the server-wide
    /// router routes gRPC ingress *to* it. Both are derived, never persisted,
    /// so both are re-read from the store here — which is what lets a node
    /// that restarted route gRPC for channels paired before it went down.
    ///
    /// The router also learns which side of each channel this actor is on. A
    /// replica instance holds its source's helper channels — the owner's view
    /// of each, hydrated from the roster — and the helpers serving them may
    /// live on this node too. Those copies are bound as [`Side::Mirror`], so
    /// a peer's message on one reaches the helper rather than tying with it.
    /// Everything else, and every channel of the own instance, is an
    /// [`Side::Endpoint`]: a provisioned actor holding the owner's side there
    /// started that pairing itself.
    fn reconcile_instance(&mut self, secret_id: u64, held: &HeldChannels) {
        self.instances.reconcile(secret_id, &held.ids);
        let replica_instance = secret_id != self.instances.own_secret_id();
        for &channel_id in &held.ids {
            let side = if replica_instance && held.owner_side.contains(&channel_id) {
                Side::Mirror
            } else {
                Side::Endpoint
            };
            self.deps
                .channel_router
                .bind(channel_id, self.actor_id, side);
        }
    }

    /// Whether the backstop has stopped retrying this channel.
    fn auto_confirm_exhausted(&self, secret_id: u64, channel_id: u64) -> bool {
        self.auto_confirm_failures
            .get(&(secret_id, channel_id))
            .is_some_and(|failures| *failures >= AUTO_CONFIRM_MAX_FAILURES)
    }

    /// Count one failed confirmation, returning the new total.
    fn record_auto_confirm_failure(&mut self, secret_id: u64, channel_id: u64) -> u8 {
        let failures = self
            .auto_confirm_failures
            .entry((secret_id, channel_id))
            .or_insert(0);
        *failures = failures.saturating_add(1);
        *failures
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
                    self.deps.channel_router.rotate(
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
                            self.deps.helper_channels.push(self.actor_id, cid);

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

                // The `UpdateChannelInfo` lifecycle. This actor starts one
                // only to announce a changed address (see
                // `AnnounceTransportsMsg`), and peers may start one to announce
                // theirs; the store is already updated by the time these fire,
                // so logging is all that is left to do.
                DeRecEvent::ChannelInfoUpdated { channel_id } => {
                    info!(
                        actor_id = %self.actor_id,
                        channel_id = channel_id.0,
                        "channel info updated with the peer"
                    );
                }
                DeRecEvent::ChannelInfoUpdateRejected {
                    channel_id,
                    status,
                    memo,
                } => {
                    warn!(
                        actor_id = %self.actor_id,
                        channel_id = channel_id.0,
                        status = status,
                        memo = %memo,
                        "peer refused a channel info update; it keeps what it had"
                    );
                }
                DeRecEvent::UpdateChannelInfoFailed { channel_id, error } => {
                    warn!(
                        actor_id = %self.actor_id,
                        channel_id = channel_id.0,
                        error = %error,
                        "channel info update could not be exchanged with the peer"
                    );
                }

                // Owner-side outcomes. A provisioned actor rarely runs a round
                // of its own, but an instance holding a vault — a replica
                // destination that adopted one — publishes to its helpers on
                // pairing and confirmation, so these can reach it. The outcome
                // itself is already recorded by `record_round_outcomes`.
                DeRecEvent::SharingComplete {
                    version,
                    confirmed_count,
                    failed_count,
                    threshold_met,
                } => {
                    info!(
                        actor_id = %self.actor_id,
                        secret_id = secret_id,
                        version = version,
                        confirmed = confirmed_count,
                        failed = failed_count,
                        threshold_met = threshold_met,
                        "sharing round settled"
                    );
                }
                DeRecEvent::ShareVerifyRejected {
                    channel_id,
                    version,
                    status,
                    memo,
                } => {
                    warn!(
                        actor_id = %self.actor_id,
                        channel_id = channel_id.0,
                        version = version,
                        status = status,
                        memo = %memo,
                        "helper refused a verification challenge"
                    );
                }
                DeRecEvent::RecoveryShareRefused {
                    channel_id,
                    version,
                    status,
                    memo,
                } => {
                    warn!(
                        actor_id = %self.actor_id,
                        channel_id = channel_id.0,
                        version = version,
                        status = status,
                        memo = %memo,
                        "helper refused a recovery share request; the others may still complete it"
                    );
                }
                // An honest helper never sends one, so this is worth an error:
                // the helper's storage, its transport, or the helper itself is
                // suspect. The share is already set aside by the library.
                DeRecEvent::RecoveryShareCorrupted {
                    channel_id,
                    version,
                    reason,
                } => {
                    error!(
                        actor_id = %self.actor_id,
                        channel_id = channel_id.0,
                        version = version,
                        reason = ?reason,
                        "helper sent a recovery share that cannot be part of the secret"
                    );
                }
                // Nothing here resolves a conflict, and these actors only
                // publish when the library does so on their behalf; the log is
                // what tells an operator why two members disagree.
                DeRecEvent::ReplicaVersionConflict {
                    channel_id,
                    from_replica_id,
                    version,
                    ..
                } => {
                    warn!(
                        actor_id = %self.actor_id,
                        channel_id = channel_id.0,
                        from_replica_id = from_replica_id,
                        version = version,
                        "replica version conflict: another member published a different copy"
                    );
                }

                DeRecEvent::Unpaired { channel_id } => {
                    let cid = channel_id.0.to_string();
                    // Drop the channel from the per-actor index so the roster
                    // enrichment stops reporting this actor as paired on a
                    // channel that no longer exists.
                    self.deps.helper_channels.remove(&self.actor_id, &cid);
                    // Only this actor's route: when the peer is also on this
                    // node, it unpairs (or not) on its own schedule.
                    self.deps.channel_router.remove(channel_id.0, self.actor_id);
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
/// caller removes it from the inbox table in the same breath, so nothing can
/// reach it either way.
///
/// Public so an integration test can end an actor the way deletion does —
/// standing in for the process that ran it stopping — before exercising
/// recovery over the same database.
#[derive(Message)]
#[rtype(result = "()")]
pub struct ShutdownMsg;

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
///
/// Public so recovery can run one to completion at boot: the tick is what
/// re-derives an actor's gRPC routes from its stores, and doing it there —
/// before either listener serves — means no request can find the instance
/// borrowed by it. Scheduling one at actor start instead raced the first
/// requests after a restart.
#[derive(Message)]
#[rtype(result = "()")]
pub struct TickMsg;

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
        let rounds = Arc::clone(&self.deps.sharing_rounds);
        let actor_id = self.actor_id;

        Box::pin(
            async move {
                let mut done = Vec::with_capacity(borrowed.len());
                for (secret_id, mut protocol) in borrowed {
                    let events = protocol.tick().await;
                    record_round_outcomes(rounds.as_ref(), &actor_id, secret_id, &events).await;
                    let swept = protocol
                        .remove_expired_channels(PENDING_CHANNEL_TTL_SECS)
                        .await;
                    let channel_ids = held_channels_of(&protocol, secret_id).await;
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
                        actor.reconcile_instance(secret_id, &channel_ids);
                    }

                    // The backstop. `PairingCompleted` is the fast path, but a
                    // single self-notify is not a guarantee: the instance can
                    // stay borrowed past the retry window, the confirmation can
                    // fail on a transient error, and neither leaves anything to
                    // try again. Without this, both outcomes are a channel that
                    // sits `Pending` until the hour-long expiry sweep drops it.
                    // Re-notifying is free on the happy path — the handler reads
                    // the recorded status and short-circuits on `NotPending`.
                    //
                    // Failure counts for channels no longer pending — confirmed,
                    // or swept — are forgotten first, so the map tracks only
                    // live ones.
                    actor
                        .auto_confirm_failures
                        .retain(|(s, c), _| *s != secret_id || pending.contains(c));

                    for channel_id in pending {
                        // Given up on — see `AUTO_CONFIRM_MAX_FAILURES`. The
                        // expiry sweep is what clears it now.
                        if actor.auto_confirm_exhausted(secret_id, channel_id) {
                            continue;
                        }
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

/// Why a call into a provisioned actor failed.
#[derive(Debug, thiserror::Error)]
pub enum ActorError {
    /// The instance the call needs is out on another call — or, for a contact
    /// minted from a replica instance, does not exist; the two are told apart
    /// only by waiting. Transient from the caller's side.
    #[error("the instance is busy with another call")]
    Busy,
    #[error(transparent)]
    Protocol(#[from] derec_library::Error),
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

/// An [`IncomingMessage`] that found its instance borrowed, scheduled again.
///
/// Self-addressed only, like [`AutoConfirmFingerprintMsg`]: nothing outside
/// the actor can make it wait for an instance.
#[derive(Message)]
#[rtype(result = "()")]
struct RetryIncomingMessage {
    bytes: Vec<u8>,
    /// How many times this message has already found the instance borrowed.
    attempt: u8,
}

/// How many times an inbound message waits for a borrowed instance before it
/// is dropped.
///
/// It used to be dropped on the first try ("instance busy; dropping
/// message"), and the peer never learned why: it saw its delivery accepted and
/// then silence. That was observed dropping an `UpdateChannelInfo` while a
/// restored helper was still busy with its boot tick. The same contention the
/// contact path waits out ([`CONTACT_BORROW_RETRIES`]) is waited out here.
///
/// The budget is longer than the contact path's, deliberately. An instance
/// processing an inbound message may be making an outbound delivery of its
/// own, which can take up to the HTTP client's request timeout (15 s, see
/// `OUTBOUND_REQUEST_TIMEOUT` in `main.rs`); giving up any sooner would drop
/// messages behind one slow peer. With [`incoming_retry_delay`] doubling from
/// 25 ms to a 1 s ceiling, twenty attempts wait just over 15 s in total.
const INCOMING_BORROW_RETRIES: u8 = 20;

/// How long to wait before attempt `attempt + 1` of a borrowed-instance retry.
///
/// Doubling from 25 ms, so the common millisecond overlap is retried almost at
/// once, capped at one second so a long wait polls rather than sleeps blind.
fn incoming_retry_delay(attempt: u8) -> Duration {
    const FIRST: Duration = Duration::from_millis(25);
    const CEILING: Duration = Duration::from_secs(1);
    FIRST
        .checked_mul(1u32 << attempt.min(6))
        .map_or(CEILING, |delay| delay.min(CEILING))
}

/// Create an out-of-band contact, selecting the instance bound to
/// `replica_for_owner_secret` when set, or the own instance otherwise. This
/// does not instantiate a protocol for a secret this actor has not seen
/// before; send [`EnsureReplicaInstanceMsg`] first to guarantee the replica
/// instance exists.
#[derive(Message)]
#[rtype(result = "Result<derec_proto::ContactMessage, ActorError>")]
pub struct CreateContactMsg {
    pub contact_mode: derec_proto::ContactMode,
    pub nonce: Option<u64>,
    /// When set, mint from the instance bound to this owner's secret rather than
    /// from the own instance — a replica-mode pairing.
    pub replica_for_owner_secret: Option<u64>,
    /// How many times this message has already found the instance borrowed.
    ///
    /// Callers leave it at zero; the handler re-sends with it incremented. See
    /// [`CONTACT_BORROW_RETRIES`].
    pub attempt: u8,
}

/// How many times [`CreateContactMsg`] waits for a borrowed instance.
///
/// An instance is borrowed only for the duration of one in-flight call — a
/// message being processed, or the periodic tick advancing protocol time — and
/// both release in milliseconds. Failing instead of waiting turned a routine
/// overlap into a 500, which the front end surfaced as a pairing that could not
/// be started at all.
///
/// The tick already takes the tolerant view of the same contention ("One
/// borrowed by an in-flight call advances time itself; skipping it is safe
/// because the next interval picks it up"); this makes contact minting agree.
///
/// Bounded rather than unbounded so a genuinely missing instance — a secret this
/// actor has no instance for — still fails, and fails quickly.
const CONTACT_BORROW_RETRIES: u8 = 10;

/// How long to wait before asking again for a borrowed instance.
///
/// Ten attempts at 20ms is a 200ms ceiling: comfortably longer than any single
/// protocol call this contends with, and short enough that a real failure does
/// not look like a hang.
const CONTACT_BORROW_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(20);

#[derive(Message)]
#[rtype(result = "Result<Vec<DeRecEvent>, ActorError>")]
pub struct StartFlowMsg {
    pub flow: DeRecFlow,
}

#[derive(Message)]
#[rtype(result = "Result<Vec<ChannelSummary>, ActorError>")]
pub struct ListChannelsMsg;

/// Record that two channels belong to the same owner. Undirected and
/// idempotent; the operator stands in for the authentication a real helper
/// would perform before making this claim.
#[derive(Message)]
#[rtype(result = "Result<(), ActorError>")]
pub struct LinkChannelsMsg {
    pub channel_id: u64,
    pub link_to_channel_id: u64,
}

#[derive(Message)]
#[rtype(result = "Result<String, ActorError>")]
pub struct GetFingerprintMsg {
    pub channel_id: u64,
}

#[derive(Message)]
#[rtype(result = "Result<bool, ActorError>")]
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
#[rtype(result = "Result<(), ActorError>")]
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
#[rtype(result = "Result<bool, EnsureReplicaError>")]
pub struct EnsureReplicaInstanceMsg {
    pub owner_secret_id: u64,
}

/// Why [`EnsureReplicaInstanceMsg`] could not provide an instance.
#[derive(Debug, thiserror::Error)]
pub enum EnsureReplicaError {
    /// The actor already mirrors [`MAX_REPLICA_INSTANCES`] owners. A caller
    /// error rather than a fault: the request named one secret too many.
    #[error("this actor already mirrors {max} owners, the most it will hold")]
    LimitReached { max: usize },
    /// The secret named is this actor's own, which is not a replica of
    /// anything — minting from it would be an ordinary contact in disguise.
    #[error("the secret named is this actor's own, not another owner's")]
    OwnSecret,
    #[error(transparent)]
    Build(#[from] derec_library::Error),
}

/// Tell every peer on this actor's helper channels where it can be reached
/// now, via the protocol's `UpdateChannelInfo` flow.
///
/// Sent once at boot, by recovery, to a helper whose stored address was
/// rewritten because the node's own address changed. The respawned instances
/// were already built advertising the new endpoints, so what is announced is
/// exactly what `own_transports` holds — but a peer paired before the change
/// still dials the old address until it is told. This is the telling.
///
/// Every instance is covered: the own one and each replica one. Within each,
/// the flow reaches the `Paired` helper channels (see [`announce_on`]);
/// replica *group members* are not covered by `UpdateChannelInfo` at all,
/// which the boot log says.
///
/// Construct with `AnnounceTransportsMsg::default()`; the field counts the
/// handler's own retries while an instance is borrowed.
#[derive(Message, Default)]
#[rtype(result = "AnnounceReport")]
pub struct AnnounceTransportsMsg {
    attempt: u8,
}

/// What one [`AnnounceTransportsMsg`] achieved.
///
/// `announced` counts requests *dispatched*; each peer's acknowledgement
/// arrives later as `ChannelInfoUpdated` and is logged when it does.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct AnnounceReport {
    /// Peers the announcement was sent to.
    pub announced: usize,
    /// Peers it could not be sent to; each is logged with the reason. They
    /// still hold the old address.
    pub failed: usize,
    /// Instances that could not run the flow at all — borrowed through every
    /// retry, or refused by the SDK. Their peers were not told.
    pub instances_skipped: usize,
}

impl AnnounceReport {
    /// Add `other`'s counts to these.
    pub fn absorb(&mut self, other: AnnounceReport) {
        self.announced += other.announced;
        self.failed += other.failed;
        self.instances_skipped += other.instances_skipped;
    }
}

/// How many times [`AnnounceTransportsMsg`] waits for a borrowed instance, and
/// how long between tries. Ten attempts at 100 ms: at boot the only contention
/// is the recovery tick and the first inbound traffic, both short.
const ANNOUNCE_BORROW_RETRIES: u8 = 10;
const ANNOUNCE_BORROW_RETRY_DELAY: Duration = Duration::from_millis(100);

impl Handler<IncomingMessage> for ProvisionedActor {
    type Result = ResponseActFuture<Self, ()>;

    fn handle(&mut self, msg: IncomingMessage, ctx: &mut Context<Self>) -> Self::Result {
        self.process_incoming(msg.0, 0, ctx)
    }
}

impl Handler<RetryIncomingMessage> for ProvisionedActor {
    type Result = ResponseActFuture<Self, ()>;

    fn handle(&mut self, msg: RetryIncomingMessage, ctx: &mut Context<Self>) -> Self::Result {
        self.process_incoming(msg.bytes, msg.attempt, ctx)
    }
}

impl ProvisionedActor {
    /// Route inbound bytes to the instance that owns their channel and process
    /// them there.
    ///
    /// `attempt` counts how many times these bytes already found that
    /// instance borrowed. A borrowed instance is transient — one in-flight
    /// call holds it — so the bytes are rescheduled rather than dropped, and
    /// only given up on, loudly, once [`INCOMING_BORROW_RETRIES`] is spent.
    ///
    /// A retried message may be overtaken by one that arrives while it waits
    /// and finds the instance free. The protocol does not depend on delivery
    /// order between separate exchanges, and dropping was strictly worse.
    fn process_incoming(
        &mut self,
        bytes: Vec<u8>,
        attempt: u8,
        ctx: &mut Context<Self>,
    ) -> ResponseActFuture<Self, ()> {
        let meta = match EnvelopeMeta::try_from(bytes.as_slice()) {
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
            if attempt < INCOMING_BORROW_RETRIES {
                ctx.notify_later(
                    RetryIncomingMessage {
                        bytes,
                        attempt: attempt + 1,
                    },
                    incoming_retry_delay(attempt),
                );
            } else {
                error!(
                    actor_id = %self.actor_id,
                    channel_id = meta.channel_id,
                    sequence = meta.sequence,
                    trace_id = meta.trace_id,
                    secret_id = owner,
                    attempts = attempt,
                    "instance stayed busy through every retry; dropping message"
                );
            }
            return Box::pin(actix::fut::ready(()));
        };
        if attempt > 0 {
            info!(
                actor_id = %self.actor_id,
                channel_id = meta.channel_id,
                attempts = attempt,
                "inbound message delivered after waiting for a busy instance"
            );
        }
        let secret_id = owner;
        let rounds = Arc::clone(&self.deps.sharing_rounds);
        let actor_id = self.actor_id;

        Box::pin(
            async move {
                let result = protocol.process(&bytes).await;
                record_round_outcomes(rounds.as_ref(), &actor_id, secret_id, events_of(&result))
                    .await;
                let channel_ids = held_channels_of(&protocol, secret_id).await;
                (protocol, result, channel_ids)
            }
            .into_actor(self)
            .map(move |(protocol, result, channel_ids), actor, ctx| {
                actor.instances.restore(secret_id, protocol);
                if let Some(channel_ids) = channel_ids {
                    actor.reconcile_instance(secret_id, &channel_ids);
                }
                // Handled before the error is reported, failure or not — see
                // `events_of`.
                actor.handle_events(secret_id, events_of(&result), ctx);
                if let Err(e) = &result {
                    error!(
                        actor_id = %actor.actor_id,
                        channel_id = ?e.channel_id.map(|c| c.0),
                        settled_events = e.events.len(),
                        error = %e,
                        "actor process() failed"
                    );
                }
            }),
        )
    }
}

impl Handler<ListChannelsMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, Result<Vec<ChannelSummary>, ActorError>>;

    fn handle(&mut self, _msg: ListChannelsMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let Some(protocol) = self.take_own() else {
            return Box::pin(actix::fut::ready(Err(ActorError::Busy)));
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
                    Err(e) => Err(ActorError::Protocol(derec_library::Error::from(e))),
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
    type Result = ResponseActFuture<Self, Result<(), ActorError>>;

    fn handle(&mut self, msg: LinkChannelsMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let Some(mut protocol) = self.take_own() else {
            return Box::pin(actix::fut::ready(Err(ActorError::Busy)));
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
                    .map_err(|e| ActorError::Protocol(derec_library::Error::from(e)));
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
    type Result = ResponseActFuture<Self, Result<derec_proto::ContactMessage, ActorError>>;

    fn handle(&mut self, msg: CreateContactMsg, ctx: &mut Context<Self>) -> Self::Result {
        let secret_id = msg
            .replica_for_owner_secret
            .unwrap_or_else(|| self.instances.own_secret_id());

        let Some(mut protocol) = self.instances.take(secret_id) else {
            // Either there is no such instance, or one exists and is borrowed by
            // an in-flight call. `take` cannot tell them apart, and the second is
            // transient — so wait and ask again rather than failing a request
            // that would have succeeded a moment later.
            if !self.instances.contains(secret_id) || msg.attempt >= CONTACT_BORROW_RETRIES {
                if msg.attempt > 0 {
                    warn!(
                        actor_id = %self.actor_id,
                        secret_id,
                        attempts = msg.attempt,
                        "contact minting gave up waiting for the instance"
                    );
                }
                return Box::pin(actix::fut::ready(Err(ActorError::Busy)));
            }

            // Re-send to self rather than looping here: `take` needs `&mut self`,
            // which is only available in a handler, and holding the actor across
            // the wait would block the very call we are waiting for.
            let addr = ctx.address();
            let next = CreateContactMsg {
                contact_mode: msg.contact_mode,
                nonce: msg.nonce,
                replica_for_owner_secret: msg.replica_for_owner_secret,
                attempt: msg.attempt + 1,
            };
            return Box::pin(
                async move {
                    tokio::time::sleep(CONTACT_BORROW_RETRY_DELAY).await;
                    addr.send(next).await.unwrap_or(Err(ActorError::Protocol(
                        derec_library::Error::Invariant(
                            "actor stopped while waiting to mint a contact",
                        ),
                    )))
                }
                .into_actor(self),
            );
        };
        let contact_mode = msg.contact_mode;
        let nonce = msg.nonce;

        Box::pin(
            async move {
                let result = protocol
                    .create_contact(None, contact_mode, nonce)
                    .await
                    .map_err(ActorError::from);
                let channel_ids = held_channels_of(&protocol, secret_id).await;
                (protocol, result, channel_ids)
            }
            .into_actor(self)
            .map(move |(protocol, result, channel_ids), actor, _ctx| {
                actor.instances.restore(secret_id, protocol);
                if let Some(channel_ids) = channel_ids {
                    actor.reconcile_instance(secret_id, &channel_ids);
                }
                // `create_contact` persists to the secret store only — never
                // to the channel store — so `held_channels_of` above cannot see
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
    type Result = ResponseActFuture<Self, Result<Vec<DeRecEvent>, ActorError>>;

    fn handle(&mut self, msg: StartFlowMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let Some(mut protocol) = self.take_own() else {
            return Box::pin(actix::fut::ready(Err(ActorError::Busy)));
        };
        let secret_id = protocol.secret_id();
        let flow = msg.flow;
        let rounds = Arc::clone(&self.deps.sharing_rounds);
        let actor_id = self.actor_id;

        Box::pin(
            async move {
                let result = protocol.start(flow).await.map_err(ActorError::from);
                if let Ok(events) = &result {
                    record_round_outcomes(rounds.as_ref(), &actor_id, secret_id, events).await;
                }
                let channel_ids = held_channels_of(&protocol, secret_id).await;
                (protocol, result, channel_ids)
            }
            .into_actor(self)
            .map(move |(protocol, result, channel_ids), actor, ctx| {
                actor.restore_own(protocol);
                if let Some(channel_ids) = channel_ids {
                    actor.reconcile_instance(secret_id, &channel_ids);
                }
                if let Ok(events) = &result {
                    actor.handle_events(secret_id, events, ctx);
                }
                result
            }),
        )
    }
}

impl Handler<GetFingerprintMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, Result<String, ActorError>>;

    fn handle(&mut self, msg: GetFingerprintMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let channel_id = msg.channel_id;
        let secret_id = self.owning_secret_for(channel_id);
        let Some(protocol) = self.instances.take(secret_id) else {
            return Box::pin(actix::fut::ready(Err(ActorError::Busy)));
        };

        Box::pin(
            async move {
                let result = protocol
                    .get_fingerprint(channel_id.into())
                    .await
                    .map_err(ActorError::from);
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
    type Result = ResponseActFuture<Self, Result<bool, ActorError>>;

    fn handle(&mut self, msg: VerifyFingerprintMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let channel_id = msg.channel_id;
        let secret_id = self.owning_secret_for(channel_id);
        let Some(mut protocol) = self.instances.take(secret_id) else {
            return Box::pin(actix::fut::ready(Err(ActorError::Busy)));
        };
        let fingerprint = msg.fingerprint;

        Box::pin(
            async move {
                let result = protocol
                    .verify_fingerprint(channel_id.into(), &fingerprint)
                    .await
                    .map_err(ActorError::from);
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
        let AutoConfirmFingerprintMsg {
            secret_id,
            channel_id,
            attempts_left,
        } = msg;
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
                    AutoConfirmOutcome::NotPending => {
                        actor.auto_confirm_failures.remove(&(secret_id, channel_id));
                    }
                    AutoConfirmOutcome::NoRecord => {
                        warn!(
                            actor_id = %actor_id,
                            secret_id = secret_id,
                            channel_id = channel_id,
                            "asked to confirm a channel the owning instance has no record of"
                        );
                    }
                    AutoConfirmOutcome::Confirmed => {
                        actor.auto_confirm_failures.remove(&(secret_id, channel_id));
                        info!(
                            actor_id = %actor_id,
                            secret_id = secret_id,
                            channel_id = channel_id,
                            "helper auto-confirmed its own fingerprint; channel paired"
                        );
                    }
                    AutoConfirmOutcome::Rejected => {
                        // Counted like a failure: retrying cannot change a
                        // comparison of the instance's key against itself.
                        let failures = actor.record_auto_confirm_failure(secret_id, channel_id);
                        if failures <= AUTO_CONFIRM_MAX_FAILURES {
                            error!(
                                actor_id = %actor_id,
                                secret_id = secret_id,
                                channel_id = channel_id,
                                attempts = failures,
                                "auto-confirmation rejected a locally derived fingerprint; \
                                 channel left pending"
                            );
                        }
                    }
                    AutoConfirmOutcome::Failed(e) => {
                        let failures = actor.record_auto_confirm_failure(secret_id, channel_id);
                        if failures >= AUTO_CONFIRM_MAX_FAILURES {
                            // Said once, then silence: the tick skips this
                            // channel from here on and the expiry sweep
                            // removes it if nothing else does.
                            if failures == AUTO_CONFIRM_MAX_FAILURES {
                                error!(
                                    actor_id = %actor_id,
                                    secret_id = secret_id,
                                    channel_id = channel_id,
                                    error = %e,
                                    attempts = failures,
                                    "auto-confirmation keeps failing; giving up on this \
                                     channel, which stays pending until the expiry sweep"
                                );
                            }
                        } else {
                            warn!(
                                actor_id = %actor_id,
                                secret_id = secret_id,
                                channel_id = channel_id,
                                error = %e,
                                attempt = failures,
                                // Deliberately not "channel left pending":
                                // `verify_fingerprint` writes the promotion
                                // before it publishes to the newly usable
                                // peer, so a failure here may mean either.
                                "auto-confirmation failed; the tick will retry"
                            );
                        }
                    }
                }
            }),
        )
    }
}

impl Handler<ReconfigureMsg> for ProvisionedActor {
    type Result = Result<(), ActorError>;

    fn handle(&mut self, msg: ReconfigureMsg, _ctx: &mut Context<Self>) -> Self::Result {
        self.config.timeout_secs = msg.timeout_secs;
        self.config.unpair_ack = msg.unpair_ack;

        for secret_id in self.instances.secret_ids() {
            let Some(old) = self.instances.take(secret_id) else {
                // Borrowed by an in-flight call. Leaving that instance on the
                // old settings would be a silent partial apply, so report it.
                return Err(ActorError::Busy);
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
                    return Err(ActorError::Protocol(e));
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
    type Result = Result<bool, EnsureReplicaError>;

    fn handle(&mut self, msg: EnsureReplicaInstanceMsg, _ctx: &mut Context<Self>) -> Self::Result {
        if msg.owner_secret_id == self.instances.own_secret_id() {
            return Err(EnsureReplicaError::OwnSecret);
        }
        if self.instances.contains(msg.owner_secret_id) {
            return Ok(false);
        }
        // `secret_ids` includes the own instance, which does not count.
        let replicas = self.instances.secret_ids().len().saturating_sub(1);
        if replicas >= MAX_REPLICA_INSTANCES {
            warn!(
                actor_id = %self.actor_id,
                owner_secret_id = msg.owner_secret_id,
                limit = MAX_REPLICA_INSTANCES,
                "refused a replica instance: this actor is at its limit"
            );
            return Err(EnsureReplicaError::LimitReached {
                max: MAX_REPLICA_INSTANCES,
            });
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

impl Handler<AnnounceTransportsMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, AnnounceReport>;

    fn handle(&mut self, msg: AnnounceTransportsMsg, ctx: &mut Context<Self>) -> Self::Result {
        let secret_ids = self.instances.secret_ids();
        let mut borrowed: Vec<(u64, ActorProtocol)> = Vec::with_capacity(secret_ids.len());
        for secret_id in &secret_ids {
            if let Some(protocol) = self.instances.take(*secret_id) {
                borrowed.push((*secret_id, protocol));
            }
        }
        let busy = secret_ids.len() - borrowed.len();

        // Wait for every instance rather than announce piecemeal: a peer left
        // out here is never told, while a short wait costs nothing at boot.
        // Re-sent through the address rather than `notify_later`, because the
        // report has to travel back to the original sender.
        if busy > 0 && msg.attempt < ANNOUNCE_BORROW_RETRIES {
            for (secret_id, protocol) in borrowed {
                self.instances.restore(secret_id, protocol);
            }
            let addr = ctx.address();
            let next = AnnounceTransportsMsg {
                attempt: msg.attempt + 1,
            };
            return Box::pin(
                async move {
                    tokio::time::sleep(ANNOUNCE_BORROW_RETRY_DELAY).await;
                    addr.send(next).await.unwrap_or_default()
                }
                .into_actor(self),
            );
        }
        if busy > 0 {
            warn!(
                actor_id = %self.actor_id,
                instances = busy,
                "instances stayed busy; their peers are not told this helper's new address"
            );
        }

        let own_transports: Vec<derec_proto::TransportProtocol> = self
            .config
            .own_transports
            .iter()
            .map(crate::models::Transport::to_proto)
            .collect();
        let actor_id = self.actor_id;
        let rounds = Arc::clone(&self.deps.sharing_rounds);

        Box::pin(
            async move {
                let mut done = Vec::with_capacity(borrowed.len());
                for (secret_id, mut protocol) in borrowed {
                    let result = announce_on(&mut protocol, secret_id, &own_transports).await;
                    if let Ok(events) = &result {
                        record_round_outcomes(rounds.as_ref(), &actor_id, secret_id, events).await;
                    }
                    done.push((secret_id, protocol, result));
                }
                done
            }
            .into_actor(self)
            .map(move |done, actor, ctx| {
                let mut report = AnnounceReport {
                    instances_skipped: busy,
                    ..AnnounceReport::default()
                };
                for (secret_id, protocol, result) in done {
                    actor.instances.restore(secret_id, protocol);
                    match result {
                        Ok(events) => {
                            report.absorb(count_announcement(&events));
                            actor.handle_events(secret_id, &events, ctx);
                        }
                        Err(e) => {
                            warn!(
                                actor_id = %actor_id,
                                secret_id,
                                error = %e,
                                "could not announce the new address on this instance; \
                                 its peers still hold the old one"
                            );
                            report.instances_skipped += 1;
                        }
                    }
                }
                report
            }),
        )
    }
}

/// Run the announcement on one instance, to its `Paired` helper channels.
///
/// Named explicitly rather than `Target::All`, which also resolves channels
/// still mid-handshake: one of those has no shared key yet, and the SDK fails
/// the whole start on a missing key — so a single half-paired channel would
/// have cost every other peer on the instance its announcement. A `Pending`
/// peer is left out too; it has not confirmed this channel, would drop the
/// update unread, and learns the address when it pairs.
async fn announce_on(
    protocol: &mut ActorProtocol,
    secret_id: u64,
    own_transports: &[derec_proto::TransportProtocol],
) -> Result<Vec<DeRecEvent>, derec_library::Error> {
    let paired = HelperFilter {
        status: vec![ChannelStatus::Paired],
        ..Default::default()
    };
    let channel_ids: Vec<ChannelId> = protocol
        .channel_store
        .helpers(secret_id, paired)
        .await
        .map_err(derec_library::Error::from)?
        .iter()
        .map(|c| c.channel_id)
        .collect();
    if channel_ids.is_empty() {
        return Ok(Vec::new());
    }

    protocol
        .start(DeRecFlow::UpdateChannelInfo {
            target: derec_library::protocol::types::Target::Many(channel_ids),
            communication_info: None,
            own_transports: own_transports.to_vec(),
        })
        .await
}

/// Tally the events one `UpdateChannelInfo` start produced.
fn count_announcement(events: &[DeRecEvent]) -> AnnounceReport {
    let mut report = AnnounceReport::default();
    for event in events {
        match event {
            DeRecEvent::UpdateChannelInfoStarted { .. } => report.announced += 1,
            DeRecEvent::UpdateChannelInfoFailed { .. } => report.failed += 1,
            _ => {}
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::models::{Transport, TransportProtocol, UnpairAck};
    use crate::repositories::sharing_rounds::SqlSharingRoundRepository;
    use derec_library::protocol::DeRecShareStore;

    const SECRET_ID: u64 = 0xA1;
    const CHANNEL_ID: u64 = 0xC0FFEE;

    /// A private in-memory database per test. A shared one would let two tests
    /// see each other's rows.
    async fn pool() -> sqlx::AnyPool {
        crate::infrastructure::db::connect("sqlite::memory:")
            .await
            .expect("an in-memory database always connects")
    }

    fn config(pool: sqlx::AnyPool) -> ProtocolConfig {
        ProtocolConfig {
            secret_id: SECRET_ID,
            own_transports: vec![Transport {
                protocol: TransportProtocol::Https,
                uri: "http://localhost:5000/derec/00000000-0000-0000-0000-000000000001".to_owned(),
            }],
            communication_info: HashMap::from([("name".to_owned(), "Alex".to_owned())]),
            timeout_secs: 300,
            unpair_ack: UnpairAck::Required,
            threshold: 2,
            replica_id: Some(0xAB),
            http_client: reqwest::Client::new(),
            pool,
            actor_id: uuid::Uuid::new_v4(),
            local_delivery: None,
        }
    }

    /// The retry budget for an inbound message must outlast one outbound
    /// delivery at the HTTP client's 15 s timeout, or a message behind one
    /// slow peer is dropped anyway — while still giving up in bounded time.
    #[test]
    fn a_busy_instance_is_waited_for_just_past_one_outbound_timeout() {
        let total: Duration = (0..INCOMING_BORROW_RETRIES).map(incoming_retry_delay).sum();

        assert!(total > Duration::from_secs(15), "{total:?}");
        assert!(total < Duration::from_secs(20), "{total:?}");
        assert_eq!(incoming_retry_delay(0), Duration::from_millis(25));
        assert_eq!(incoming_retry_delay(u8::MAX), Duration::from_secs(1));
    }

    /// A failing `process()` still carries the rounds its timeout sweep
    /// settled (SDK 0.0.7), and those are the only report of them there will
    /// be. If the inbound path dropped them with the error, the round's outcome
    /// would never be recorded and the next `keep_list` could not list it.
    #[actix_rt::test]
    async fn a_failed_process_still_records_the_rounds_it_settled() {
        let config = config(pool().await);
        let protocol = build_protocol(&config).expect("the baseline config builds");
        let settled = DeRecEvent::SharingComplete {
            version: 1,
            confirmed_count: 2,
            failed_count: 0,
            threshold_met: true,
        };
        let result: Result<Vec<DeRecEvent>, ProcessError> = Err(ProcessError {
            channel_id: Some(ChannelId(CHANNEL_ID)),
            source: derec_library::Error::Invariant("the message itself failed"),
            events: vec![settled],
        });

        let events = events_of(&result);
        assert!(
            matches!(events, [DeRecEvent::SharingComplete { version: 1, .. }]),
            "the events settled before the failure must be handed on: {events:?}"
        );

        let rounds = SqlSharingRoundRepository::new(config.pool.clone());
        record_round_outcomes(&rounds, &config.actor_id, SECRET_ID, events).await;

        assert_eq!(
            protocol
                .share_store
                .keep_list(SECRET_ID, 2)
                .await
                .expect("readable"),
            Some(vec![1]),
            "the committed round settled by the failing call must be kept"
        );
    }
}
