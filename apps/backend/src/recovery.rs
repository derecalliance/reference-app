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
//!   `replica_id` and protocol settings it had;
//! * a [`Role::Owner`] gets its browser mailbox back and nothing else. Its
//!   protocol lives in the page with its own keys, so there is nothing here to
//!   rebuild. The inbox matters anyway: without it, traffic arriving before the
//!   tab reclaims the actor is dropped as undeliverable rather than buffered.
//!
//! One actor failing does not stop the rest. A node that recovers nine of ten
//! helpers is better than one that recovers none, and the count is reported so
//! the difference is visible.

use std::sync::Arc;

use tracing::{error, info, warn};

use crate::models::Role;
use crate::provisioning::{register_browser_actor, spawn_provisioned};
use crate::state::AppState;

/// What a boot recovered.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct RecoveryReport {
    /// Backend-run helpers put back into service.
    pub helpers: usize,
    /// Browser-run actors given their mailbox back.
    pub browser_actors: usize,
    /// Entries put back into the derived `helper_channels` index.
    pub channels: usize,
    /// Actors that could not be rebuilt. Each is warned about individually.
    pub failed: usize,
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

    if actors.is_empty() {
        return report;
    }

    for actor in actors {
        match actor.role {
            Role::Owner => {
                register_browser_actor(state, actor.id);
                report.browser_actors += 1;
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

                spawn_provisioned(state, &actor, &settings);
                report.helpers += 1;
            }
        }
    }

    report.channels = rebuild_channel_index(state).await;

    info!(
        helpers = report.helpers,
        browser_actors = report.browser_actors,
        channels = report.channels,
        failed = report.failed,
        "node recovered from the database"
    );

    report
}

/// Repopulate the derived `helper_channels` index from the respawned actors.
///
/// The index is deliberately not persisted — every entry restates a channel the
/// actor's own channel store already holds — so this is where it comes back
/// from. Asking the actors rather than reading a table keeps one source of
/// truth for it.
async fn rebuild_channel_index(state: &Arc<AppState>) -> usize {
    let mut total = 0;

    let actor_ids: Vec<uuid::Uuid> = state
        .actor_inboxes
        .iter()
        .map(|entry| *entry.key())
        .collect();

    for actor_id in actor_ids {
        // Browser-run actors have no backend instance to ask, and no channels
        // in this index either.
        let Some(addr) = crate::routes::actors::provisioned_addr(state, &actor_id) else {
            continue;
        };

        let channels = match addr.send(crate::actor::ListChannelsMsg).await {
            Ok(Ok(channels)) => channels,
            Ok(Err(e)) => {
                warn!(actor_id = %actor_id, error = %e, "could not list channels for the index");
                continue;
            }
            Err(e) => {
                warn!(actor_id = %actor_id, error = %e, "actor did not answer the channel listing");
                continue;
            }
        };

        let ids: Vec<String> = channels.into_iter().map(|c| c.channel_id).collect();
        if !ids.is_empty() {
            total += ids.len();
            state.helper_channels.insert(actor_id, ids);
        }
    }

    total
}
