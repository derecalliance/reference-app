// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Rebuilding the node from the database at boot.
//!
//! Persisting state is only half of surviving a restart: rows with nothing
//! running against them are a node that lists helpers which never answer. This
//! turns the rows back into actors.
//!
//! What gets rebuilt depends on where the actor runs, which `role` already
//! records — `POST /helpers` provisions backend-run helpers, `POST /owners`
//! registers browser-run owners:
//!
//! * a [`Role::Helper`] becomes a running `ProvisionedActor` again, with the
//!   `replica_id` and protocol settings it had, every replica instance it ran
//!   (found from the store partitions they wrote), and the routes of contacts
//!   it minted that nobody has paired against yet, within their lifetime;
//! * a [`Role::Owner`] gets its browser mailbox back and nothing else. Its
//!   protocol lives in the page with its own keys, so there is nothing here to
//!   rebuild. The inbox matters anyway: without it, traffic arriving before the
//!   tab reclaims the actor is dropped as undeliverable rather than buffered.
//!   Messages that were already waiting when the node stopped are still there
//!   — the mailbox is a table, not process memory.
//!
//! Every actor is re-advertised at this node's *current* address first. The
//! address is stored with the row and was fixed when the actor was created, so
//! without this a node restarted on a new `base_url` or `public_port` — the
//! README's "start on localhost, then set your LAN address" path, or a
//! container republished on another port — keeps handing out an address
//! nothing listens on.
//!
//! The same rule — never advertise what nothing serves — covers a node
//! restarted with gRPC switched off. A `both` helper drops its gRPC endpoint;
//! a gRPC-only helper is re-advertised over HTTP, its mode changing, with a
//! warning naming it. Refusing to respawn it instead would take a helper that
//! still works over HTTP out of service to make a point.
//!
//! Every address the node advertised — now, and as stored on its actors before
//! re-advertising — is recorded too, so a message a peer still sends to an old
//! one is delivered here rather than dialled (see [`crate::addresses`]).
//!
//! One actor failing does not stop the rest. A node that recovers nine of ten
//! helpers is better than one that recovers none, and the count is reported so
//! the difference is visible.

use std::sync::Arc;

use tracing::{error, info, warn};

use uuid::Uuid;

use crate::actor::{AnnounceReport, AnnounceTransportsMsg};
use crate::models::{Actor, Role, TransportMode};
use crate::provisioning::{
    StoredInstances, load_stored_instances, register_browser_actor, spawn_restored,
};
use crate::sql::channel::SqlChannelStore;
use crate::state::AppState;

/// What a boot recovered.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct RecoveryReport {
    /// Backend-run helpers put back into service.
    pub helpers: usize,
    /// Replica instances those helpers had, rebuilt alongside them.
    pub replica_instances: usize,
    /// Contacts minted before the restart and not yet paired against, whose
    /// routes were restored so their first message still arrives.
    pub contacts: usize,
    /// Browser-run actors given their mailbox back.
    pub browser_actors: usize,
    /// Entries put back into the derived `helper_channels` index.
    pub channels: usize,
    /// Actors whose stored address was rewritten to this node's current one.
    pub readvertised: usize,
    /// Of those, the ones whose transport mode changed because gRPC is
    /// disabled on this node. Each is also warned about individually.
    pub grpc_dropped: usize,
    /// Actors that could not be rebuilt. Each is warned about individually.
    pub failed: usize,
    /// Respawned helpers whose address changed. Each must tell its paired
    /// peers, which [`announce_new_addresses`] does once the node is serving.
    pub announce: Vec<Uuid>,
    /// Browser-run actors whose address changed. Their protocol runs in a
    /// tab, so only that tab can tell their peers; this node cannot.
    pub browser_readvertised: usize,
}

/// Rebuild every actor this node had.
pub async fn recover(state: &Arc<AppState>) -> RecoveryReport {
    let mut report = RecoveryReport::default();

    let actors = match state.actors.all().await {
        Ok(actors) => actors,
        Err(e) => {
            error!(error = %e, "could not read the actor registry; nothing recovered");
            return report;
        }
    };

    // Before anything is re-advertised: the addresses the actors stored are
    // the ones their peers still hold, and once rewritten they are gone.
    remember_addresses(state, &actors).await;

    if actors.is_empty() {
        return report;
    }

    for actor in actors {
        let (actor, moved) = readvertise(state, actor, &mut report).await;
        match actor.role {
            Role::Owner => {
                register_browser_actor(state, actor.id);
                report.browser_actors += 1;
                if moved {
                    report.browser_readvertised += 1;
                }
            }
            Role::Helper => {
                let settings = match state.actors.settings(&actor.id).await {
                    Ok(Some(settings)) => settings,
                    Ok(None) => {
                        // Rebuilding with a fresh `replica_id` would be worse
                        // than leaving it down: the helper would answer as a
                        // member no replica group recognises, which looks like
                        // a protocol fault rather than a missing row.
                        warn!(
                            actor_id = %actor.id,
                            "helper has no stored protocol settings; not respawned"
                        );
                        report.failed += 1;
                        continue;
                    }
                    Err(e) => {
                        error!(
                            actor_id = %actor.id,
                            error = %e,
                            "could not read stored protocol settings; not respawned"
                        );
                        report.failed += 1;
                        continue;
                    }
                };

                // A read failure costs only the extras: the helper still comes
                // back with its own instance, which serves every helper-role
                // channel, rather than staying down over a replica.
                let stored = match load_stored_instances(state, &actor).await {
                    Ok(stored) => stored,
                    Err(e) => {
                        warn!(
                            actor_id = %actor.id,
                            error = %e,
                            "could not read this helper's replica instances and open contacts; \
                             respawning it without them"
                        );
                        StoredInstances::default()
                    }
                };

                if let Err(e) = spawn_restored(state, &actor, &settings, &stored) {
                    error!(actor_id = %actor.id, error = %e, "helper could not be respawned");
                    report.failed += 1;
                    continue;
                }
                report.helpers += 1;
                report.replica_instances += stored.replica_secret_ids.len();
                report.contacts += stored.unpaired_contacts.len();
                if moved {
                    report.announce.push(actor.id);
                }
            }
        }
    }

    report.channels = rebuild_channel_index(state).await;

    info!(
        helpers = report.helpers,
        replica_instances = report.replica_instances,
        contacts = report.contacts,
        browser_actors = report.browser_actors,
        channels = report.channels,
        readvertised = report.readvertised,
        grpc_dropped = report.grpc_dropped,
        failed = report.failed,
        "node recovered from the database"
    );
    if report.readvertised > 0 {
        // What happens next, per kind of actor — rather than the blanket "peers
        // hold the old address until they pair again" this used to say, which
        // stopped being true once helpers began announcing.
        warn!(
            actors = report.readvertised,
            helpers_announcing = report.announce.len(),
            browser_actors = report.browser_readvertised,
            base_url = %state.base_url,
            "this node's address changed since these actors were created, and they now \
             advertise the new one. Provisioned helpers announce it to their paired peers \
             once the node is serving (a summary follows); browser-run actors must announce \
             it from their own tab. A peer not told keeps dialling the old address, and \
             replica-group members are not covered by the announcement"
        );
    }

    report
}

/// Load every address this node advertised before, and add the ones it
/// advertises now and the ones its actors were stored with.
///
/// A peer that missed the announcement — a browser tab, which only its own
/// page can tell — keeps sending to an old address. Knowing it is this node is
/// what lets that message be delivered here instead of dialled into nothing
/// (see [`crate::addresses`]). The actors' own stored endpoints are included
/// so a database from before this record existed still yields its history.
async fn remember_addresses(state: &Arc<AppState>, actors: &[Actor]) {
    use crate::addresses::Listener;
    use crate::models::TransportProtocol;

    if let Err(e) = state.addresses.load(&state.pool).await {
        warn!(error = %e, "could not read the addresses this node advertised before");
    }

    let mut addresses: Vec<(Listener, String)> = vec![(Listener::Http, state.base_url.to_string())];
    if state.defaults.grpc_enabled {
        addresses.push((Listener::Grpc, state.grpc_authority()));
    }
    for transport in actors.iter().flat_map(|actor| actor.transports.iter()) {
        let listener = match transport.protocol {
            TransportProtocol::Https => Listener::Http,
            TransportProtocol::Grpc => Listener::Grpc,
        };
        addresses.push((listener, transport.uri.clone()));
    }

    for (listener, address) in addresses {
        if let Err(e) = state.addresses.remember(&state.pool, listener, &address).await {
            warn!(
                address = %address,
                error = %e,
                "could not record an address this node advertises; a message sent to it \
                 after the next address change will be dialled rather than delivered here"
            );
        }
    }
}

/// Have every helper in `helper_ids` tell its paired peers its new address.
///
/// Run once the node is serving: a peer answers an announcement by dialling
/// the address it was just told, which must be listening by then. Each helper
/// is asked in turn and the outcome logged per helper, then summarised: the
/// summary is the honest answer to "do peers paired before the change still
/// hold the old address?" — only the ones it counts as not told.
pub async fn announce_new_addresses(
    state: &Arc<AppState>,
    helper_ids: &[Uuid],
) -> AnnouncementSummary {
    let mut summary = AnnouncementSummary::default();

    for actor_id in helper_ids {
        let Some(addr) = crate::routes::actors::provisioned_addr(state, actor_id) else {
            warn!(actor_id = %actor_id, "helper is no longer running; its peers are not told its new address");
            summary.helpers_not_reached += 1;
            continue;
        };
        match addr.send(AnnounceTransportsMsg::default()).await {
            Ok(report) => {
                info!(
                    actor_id = %actor_id,
                    announced = report.announced,
                    failed = report.failed,
                    instances_skipped = report.instances_skipped,
                    "helper announced its new address to its paired peers"
                );
                summary.helpers += 1;
                summary.peers.absorb(report);
            }
            Err(e) => {
                warn!(actor_id = %actor_id, error = %e, "helper did not answer; its peers are not told its new address");
                summary.helpers_not_reached += 1;
            }
        }
    }

    if summary.everyone_told() {
        info!(
            helpers = summary.helpers,
            peers = summary.peers.announced,
            "every peer paired with a provisioned helper was told its new address"
        );
    } else {
        warn!(
            helpers = summary.helpers,
            peers_told = summary.peers.announced,
            peers_not_told = summary.peers.failed,
            instances_skipped = summary.peers.instances_skipped,
            helpers_not_reached = summary.helpers_not_reached,
            "some peers could not be told a provisioned helper's new address; those still \
             hold the old one and reach the helper again only once they re-pair (see the \
             warnings above for which)"
        );
    }

    summary
}

/// What [`announce_new_addresses`] achieved across every helper it asked.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct AnnouncementSummary {
    /// Helpers that ran the announcement.
    pub helpers: usize,
    /// Helpers that could not be asked — gone, or not answering.
    pub helpers_not_reached: usize,
    /// Their peers, summed.
    pub peers: AnnounceReport,
}

impl AnnouncementSummary {
    /// Whether no peer was left holding the old address.
    pub fn everyone_told(&self) -> bool {
        self.helpers_not_reached == 0 && self.peers.failed == 0 && self.peers.instances_skipped == 0
    }
}

/// Point `actor`'s stored endpoints at this node's current address, answering
/// the actor as it now advertises and whether that changed.
///
/// Same transport mode, new address: the endpoints are re-derived exactly as
/// provisioning derives them — unless gRPC is disabled here, in which case the
/// mode loses its gRPC half (see [`mode_served_here`]). A failed write keeps
/// the old endpoints — an actor reachable at a stale address is still better
/// than one not respawned.
async fn readvertise(
    state: &Arc<AppState>,
    mut actor: Actor,
    report: &mut RecoveryReport,
) -> (Actor, bool) {
    let stored = crate::registry::actors::mode_of(&actor);
    let mode = mode_served_here(stored, state.defaults.grpc_enabled);
    let current = mode.endpoints(&state.base_url, &state.grpc_authority(), actor.id);
    if current == actor.transports {
        return (actor, false);
    }

    if let Err(e) = state.actors.set_transports(&actor.id, &current).await {
        warn!(
            actor_id = %actor.id,
            error = %e,
            "could not store this actor's new address; it keeps advertising the old one"
        );
        return (actor, false);
    }

    if mode != stored {
        // Loud, and per actor: a peer paired over this helper's gRPC endpoint
        // will now find nothing there, and the operator needs to know which
        // helper that is. Re-enabling gRPC later does not restore the mode —
        // the row now says HTTP — so the helper must be re-provisioned for it.
        warn!(
            actor_id = %actor.id,
            name = %actor.name,
            from = ?stored,
            to = ?mode,
            "gRPC is disabled on this node, so this helper no longer advertises \
             a gRPC endpoint; peers that reach it over gRPC must pair again, and \
             re-enabling gRPC will not restore its stored mode"
        );
        report.grpc_dropped += 1;
    }

    info!(
        actor_id = %actor.id,
        from = ?actor.transports.iter().map(|t| t.uri.as_str()).collect::<Vec<_>>(),
        to = ?current.iter().map(|t| t.uri.as_str()).collect::<Vec<_>>(),
        "re-advertising at this node's current address"
    );
    // `endpoints` never yields an empty list for any mode.
    if let Some(first) = current.first() {
        actor.transport = first.clone();
    }
    actor.transports = current;
    report.readvertised += 1;
    (actor, true)
}

/// The mode an actor stored as `stored` can actually be served in here.
///
/// With gRPC enabled, the stored one. Without it, whatever is left once gRPC
/// is removed — which for a gRPC-only helper is HTTP, since every actor's HTTP
/// endpoint is always served. Never a mode advertising an endpoint nothing on
/// this node listens on.
fn mode_served_here(stored: TransportMode, grpc_enabled: bool) -> TransportMode {
    if grpc_enabled {
        stored
    } else {
        TransportMode::Http
    }
}

/// Repopulate the derived `helper_channels` index from the respawned actors.
///
/// The index is deliberately not persisted — every entry restates a channel the
/// actor's own channel store already holds — so this is where it comes back
/// from. Read straight from the stores, across every instance an actor ran,
/// and in the stores' `(created_at, channel_id)` order: that is the order the
/// pairing events appended them in, so the index after a restart is the index
/// before it rather than a reshuffle of it.
async fn rebuild_channel_index(state: &Arc<AppState>) -> usize {
    let mut total = 0;

    let actor_ids: Vec<uuid::Uuid> = state
        .actor_inboxes
        .iter()
        .filter(|entry| matches!(entry.value(), crate::state::ActorInbox::Provisioned(_)))
        .map(|entry| *entry.key())
        .collect();

    for actor_id in actor_ids {
        // One tick, awaited, before anything is served: it re-derives this
        // actor's gRPC routes from its stores (every instance, helper channels
        // and replica members alike). Nothing persists the router, so without
        // this a restarted gRPC helper refuses every message on a channel
        // paired before the restart. Done here rather than at actor start so no
        // request can find an instance borrowed by it.
        if let Some(addr) = crate::routes::actors::provisioned_addr(state, &actor_id) {
            if let Err(e) = addr.send(crate::actor::TickMsg).await {
                warn!(actor_id = %actor_id, error = %e, "actor did not answer the boot tick");
            }
        }

        let store = SqlChannelStore::new(state.pool.clone(), actor_id.to_string());
        let records = match store.helper_records_all_instances().await {
            Ok(records) => records,
            Err(e) => {
                warn!(actor_id = %actor_id, error = %e, "could not list channels for the index");
                continue;
            }
        };

        let mut ids: Vec<String> = Vec::with_capacity(records.len());
        for (_, record) in records {
            let id = record.channel_id.0.to_string();
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        if !ids.is_empty() {
            total += ids.len();
            state.helper_channels.insert(actor_id, ids);
        }
    }

    total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn with_grpc_enabled_every_mode_is_served_as_stored() {
        for mode in [TransportMode::Http, TransportMode::Grpc, TransportMode::Both] {
            assert_eq!(mode_served_here(mode, true), mode);
        }
    }

    #[test]
    fn with_grpc_disabled_nothing_keeps_a_grpc_endpoint() {
        // The listener is not running, so a gRPC endpoint would pair and then
        // black-hole every reply.
        for mode in [TransportMode::Http, TransportMode::Grpc, TransportMode::Both] {
            assert_eq!(mode_served_here(mode, false), TransportMode::Http);
        }
    }
}
