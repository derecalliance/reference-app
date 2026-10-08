// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Rebuilding the node from the database at boot.
//!
//! Persisting state is only half of surviving a restart: rows with nothing
//! running against them are a node that lists helpers which never answer. This
//! turns the rows back into actors.
//!
//! What gets rebuilt depends on where the actor runs, which `role` already
//! records — `POST /api/v1/helpers` provisions backend-run helpers, `POST /api/v1/owners`
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
//! one is delivered here rather than dialled (see [`super::addresses`]).
//!
//! One actor failing does not stop the rest. A node that recovers nine of ten
//! helpers is better than one that recovers none, and the count is reported so
//! the difference is visible.

use tracing::{error, info, warn};
use uuid::Uuid;

use super::actors::provisioned::AnnounceReport;
use super::actors::runtime::StoredInstances;
use super::bootstrap::Node;
use super::routing::PIN_TTL;
use crate::models::{Actor, Listener, Role, TransportMode, TransportProtocol};
use crate::services::ports::InboxDirectory;

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
pub async fn recover(state: &Node) -> RecoveryReport {
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
                state.inboxes.register_browser(actor.id);
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

                if let Err(e) = state.runtime.spawn_restored(&actor, &settings, &stored) {
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
            base_url = %state.config.base_url,
            "this node's address changed since these actors were created, and they now \
             advertise the new one. Provisioned helpers announce it to their paired peers \
             once the node is serving (a summary follows); browser-run actors must announce \
             it from their own tab. A peer not told keeps dialling the old address, and \
             replica-group members are not covered by the announcement"
        );
    }

    report
}

/// Read what `actor` had running from its stores: the replica instances it
/// ran, and the contacts it minted that nobody has paired against yet.
///
/// Contacts older than [`PIN_TTL`] are left out: the documented lifetime of a
/// contact is the same either side of a restart.
async fn load_stored_instances(
    state: &Node,
    actor: &Actor,
) -> Result<StoredInstances, crate::repositories::RepositoryError> {
    let own: Option<u64> = actor.secret_id.parse().ok();

    let replica_secret_ids = state
        .protocol_records
        .instance_secret_ids(&actor.id)
        .await?
        .into_iter()
        .filter(|secret_id| Some(*secret_id) != own)
        .collect();

    let ttl = i64::try_from(PIN_TTL.as_secs()).unwrap_or(i64::MAX);
    let since = crate::utils::time::now_unix_secs().saturating_sub(ttl);
    let unpaired_contacts = state
        .protocol_records
        .unpaired_contacts(&actor.id, since)
        .await?;

    Ok(StoredInstances {
        replica_secret_ids,
        unpaired_contacts,
    })
}

/// Load every address this node advertised before, and add the ones it
/// advertises now and the ones its actors were stored with.
///
/// A peer that missed the announcement — a browser tab, which only its own
/// page can tell — keeps sending to an old address. Knowing it is this node is
/// what lets that message be delivered here instead of dialled into nothing
/// (see [`super::addresses`]). The actors' own stored endpoints are included
/// so a database from before this record existed still yields its history.
async fn remember_addresses(state: &Node, actors: &[Actor]) {
    if let Err(e) = state.addresses.load().await {
        warn!(error = %e, "could not read the addresses this node advertised before");
    }

    let config = &state.config;
    let mut addresses: Vec<(Listener, String)> =
        vec![(Listener::Http, config.base_url.to_string())];
    if config.defaults.grpc_enabled {
        addresses.push((Listener::Grpc, config.grpc_authority()));
    }
    for transport in actors.iter().flat_map(|actor| actor.transports.iter()) {
        let listener = match transport.protocol {
            TransportProtocol::Https => Listener::Http,
            TransportProtocol::Grpc => Listener::Grpc,
        };
        addresses.push((listener, transport.uri.clone()));
    }

    for (listener, address) in addresses {
        if let Err(e) = state.addresses.remember(listener, &address).await {
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
pub async fn announce_new_addresses(state: &Node, helper_ids: &[Uuid]) -> AnnouncementSummary {
    let mut summary = AnnouncementSummary::default();

    for actor_id in helper_ids {
        if state.inboxes.provisioned(actor_id).is_none() {
            warn!(actor_id = %actor_id, "helper is no longer running; its peers are not told its new address");
            summary.helpers_not_reached += 1;
            continue;
        }
        match state.runtime.announce_transports(actor_id).await {
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
async fn readvertise(state: &Node, mut actor: Actor, report: &mut RecoveryReport) -> (Actor, bool) {
    let config = &state.config;
    let stored = actor.transport_mode();
    let mode = mode_served_here(stored, config.defaults.grpc_enabled);
    let current = mode.endpoints(&config.base_url, &config.grpc_authority(), actor.id);
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
async fn rebuild_channel_index(state: &Node) -> usize {
    let mut total = 0;

    for actor_id in state.runtime.provisioned_ids() {
        // One tick, awaited, before anything is served: it re-derives this
        // actor's gRPC routes from its stores (every instance, helper channels
        // and replica members alike). Nothing persists the router, so without
        // this a restarted gRPC helper refuses every message on a channel
        // paired before the restart. Done here rather than at actor start so no
        // request can find an instance borrowed by it.
        if let Err(e) = state.runtime.tick(&actor_id).await {
            warn!(actor_id = %actor_id, error = %e, "actor did not answer the boot tick");
        }

        let records = match state.protocol_records.helper_channels(&actor_id).await {
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
            state.helper_channels.replace(actor_id, ids);
        }
    }

    total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn with_grpc_enabled_every_mode_is_served_as_stored() {
        for mode in [
            TransportMode::Http,
            TransportMode::Grpc,
            TransportMode::Both,
        ] {
            assert_eq!(mode_served_here(mode, true), mode);
        }
    }

    #[test]
    fn with_grpc_disabled_nothing_keeps_a_grpc_endpoint() {
        // The listener is not running, so a gRPC endpoint would pair and then
        // black-hole every reply.
        for mode in [
            TransportMode::Http,
            TransportMode::Grpc,
            TransportMode::Both,
        ] {
            assert_eq!(mode_served_here(mode, false), TransportMode::Http);
        }
    }
}
