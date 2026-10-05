// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Minting actors and wiring up their inboxes.
//!
//! Kept out of the route modules so the HTTP layer stays thin: handlers decide
//! *whether* to provision and with what, this decides *how*.

use std::sync::Arc;

use uuid::Uuid;

use crate::{
    actor::{ProtocolConfig, ProvisionedActor},
    models::{Actor, Role, TransportMode},
    sql::secret::{SqlSecretStore, UnpairedContact},
    state::{ActorInbox, AppState},
};

/// Mark an actor as browser-run, so traffic for it queues in its mailbox until
/// a tab polls.
///
/// Idempotent, and deliberately so: the claim flow calls this for an actor
/// that already has a mailbox, and recovery calls it for every owner at boot.
/// The queue itself lives in the database ([`crate::registry::mailbox`]) and
/// belongs to the actor, not to a tab — so registering again never discards
/// what is waiting. A reclaiming tab drains the backlog on its first poll; a
/// previous tab still polling the same actor competes for messages, which is
/// the documented cost of an unauthenticated claim.
pub fn register_browser_actor(state: &AppState, actor_id: Uuid) {
    state
        .actor_inboxes
        .entry(actor_id)
        .or_insert(ActorInbox::Browser);
}

/// Why [`spawn_provisioned`] could not start an actor.
#[derive(Debug, thiserror::Error)]
pub enum SpawnError {
    #[error("actor has an unparseable secret_id")]
    SecretId,
    #[error("could not build the protocol instance: {0}")]
    Protocol(#[from] derec_library::Error),
}

/// What a respawned actor had running before the restart, beyond its own
/// instance. Read from the stores by [`load_stored_instances`].
#[derive(Debug, Clone, Default)]
pub struct StoredInstances {
    /// Replica instances: one per owner this actor mirrors. Created on demand
    /// and recorded nowhere but in the rows they wrote, so without this a
    /// restart brought back only the own instance and every replica channel
    /// was dropped as "no instance owns this channel".
    pub replica_secret_ids: Vec<u64>,
    /// Contacts minted and still inside their lifetime, whose first inbound
    /// message has not arrived. Their routes lived only in memory.
    pub unpaired_contacts: Vec<UnpairedContact>,
}

/// Read what `actor` had running from its stores.
///
/// Contacts older than [`crate::routing::PIN_TTL`] are left out: the documented
/// lifetime of a contact is the same either side of a restart.
pub async fn load_stored_instances(
    state: &AppState,
    actor: &Actor,
) -> Result<StoredInstances, String> {
    let actor_key = actor.id.to_string();
    let own: Option<u64> = actor.secret_id.parse().ok();

    let replica_secret_ids = crate::sql::stored_instance_secret_ids(&state.pool, &actor_key)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|secret_id| Some(*secret_id) != own)
        .collect();

    let ttl = i64::try_from(crate::routing::PIN_TTL.as_secs()).unwrap_or(i64::MAX);
    let since = crate::sql::secret::now_secs().saturating_sub(ttl);
    let unpaired_contacts = SqlSecretStore::new(state.pool.clone(), actor_key)
        .unpaired_contacts(since)
        .await
        .map_err(|e| e.to_string())?;

    Ok(StoredInstances {
        replica_secret_ids,
        unpaired_contacts,
    })
}

/// Spawn a backend-managed actor with nothing to restore — a new one.
///
/// See [`spawn_restored`].
pub fn spawn_provisioned(
    state: &AppState,
    actor: &Actor,
    settings: &crate::registry::actors::ActorSettings,
) -> Result<(), SpawnError> {
    spawn_restored(state, actor, settings, &StoredInstances::default())
}

/// Spawn a backend-managed actor, putting back what it had running.
///
/// The own instance, bound to `secret_id`, is always built here. A replica
/// instance — bound to a different owner's secret — is otherwise added on
/// demand via `EnsureReplicaInstanceMsg` (see [`ProvisionedActor`]); a respawn
/// rebuilds every one `stored` names, so the channels they hold keep routing.
/// The settings come from the caller rather than being minted here, so a
/// respawn rebuilds the actor it had rather than a new one: `replica_id` in
/// particular is the id every stored `ReplicaMember` row references.
///
/// Nothing is left running on failure of the own instance: it is built before
/// the actor starts, so an error means no actor and no inbox. A replica
/// instance that fails to build is warned about and skipped instead — the
/// helper still serves every other channel, and a later replica pairing with
/// that owner creates the instance afresh.
pub fn spawn_restored(
    state: &AppState,
    actor: &Actor,
    settings: &crate::registry::actors::ActorSettings,
    stored: &StoredInstances,
) -> Result<(), SpawnError> {
    let actor_id = actor.id;
    let role = actor.role;
    let secret_id: u64 = match actor.secret_id.parse() {
        Ok(v) => v,
        Err(_) => {
            tracing::error!(actor_id = %actor_id, "actor has an unparseable secret_id; not spawning");
            return Err(SpawnError::SecretId);
        }
    };

    let communication_info =
        std::collections::HashMap::from([("name".to_owned(), actor.name.clone())]);
    let app_state = Arc::new(state.clone());

    let config = ProtocolConfig {
        secret_id,
        own_transports: actor.transports.clone(),
        communication_info,
        timeout_secs: settings.timeout_secs,
        unpair_ack: settings.unpair_ack,
        threshold: 2,
        keep_versions_count: 3,
        // Every actor may take part in replica-mode pairing: the source is an
        // Owner, the destination a Replica. Both sides need a stable id, so it
        // is assigned unconditionally rather than by role.
        replica_id: Some(settings.replica_id),
        http_client: state.http_client.clone(),
        pool: state.pool.clone(),
        actor_id,
        local_node: Some(Arc::clone(&app_state)),
    };

    let protocol = match crate::actor::build_protocol(&config) {
        Ok(p) => p,
        Err(e) => {
            tracing::error!(actor_id = %actor_id, error = %e, "failed to build protocol; not spawning");
            return Err(SpawnError::Protocol(e));
        }
    };

    let mut replicas = Vec::with_capacity(stored.replica_secret_ids.len());
    for &replica_secret in &stored.replica_secret_ids {
        let mut replica_config = config.clone();
        replica_config.secret_id = replica_secret;
        match crate::actor::build_protocol(&replica_config) {
            Ok(protocol) => replicas.push((replica_secret, protocol)),
            Err(e) => tracing::warn!(
                actor_id = %actor_id,
                owner_secret_id = replica_secret,
                error = %e,
                "replica instance could not be rebuilt; its channels stay unrouted until \
                 the owner pairs again"
            ),
        }
    }
    if !replicas.is_empty() {
        tracing::info!(
            actor_id = %actor_id,
            replicas = replicas.len(),
            "replica instances restored"
        );
    }

    // The gRPC half of a contact's route. Taken here, before the actor can
    // receive anything, and dated from when the contact was minted so it
    // expires when it would have without the restart. HTTP needs no such
    // route — the actor is in the URL — but the instance-level pin below.
    if advertises_grpc(actor) {
        let now = crate::sql::secret::now_secs();
        for contact in &stored.unpaired_contacts {
            let age = u64::try_from(now.saturating_sub(contact.minted_at)).unwrap_or(0);
            state.channel_router.pin_aged(
                contact.channel_id,
                actor_id,
                std::time::Duration::from_secs(age),
            );
        }
    }
    let contact_pins: Vec<(u64, u64)> = stored
        .unpaired_contacts
        .iter()
        .map(|c| (c.channel_id, c.secret_id))
        .collect();

    // The actor keeps the config so it can rebuild an instance in place when
    // settings change — see `ReconfigureMsg`.
    // Supervised: a panicking handler would otherwise stop this actor for the
    // rest of the process's life, and the only symptom is a peer whose messages
    // stop being answered. The actor value is reused on restart, so its
    // protocol instances and their stores come back with it.
    let addr = actix::Supervisor::start_in_arbiter(&state.arbiter, move |_ctx| {
        ProvisionedActor::new(protocol, config, actor_id, role, app_state)
            .with_restored(replicas, contact_pins)
    });

    state.actor_inboxes.insert(actor_id, ActorInbox::Provisioned(addr));
    Ok(())
}

/// Whether `actor` can receive over gRPC — the only transport whose ingress
/// routes by channel id, and so the only one a router pin is any use to.
pub(crate) fn advertises_grpc(actor: &Actor) -> bool {
    actor
        .transports
        .iter()
        .any(|t| t.protocol == crate::models::TransportProtocol::Grpc)
}

/// Every actor protects its own secret. A replica relationship no longer
/// changes this: it is an extra protocol *instance* bound to the mirrored
/// owner's secret, added on demand by `EnsureReplicaInstanceMsg`, not a
/// different actor with a different identity.
fn actor_secret_id() -> u64 {
    rand::random::<u64>()
}

/// Mint a new actor.
pub fn provisioned_actor(
    role: Role,
    name: &str,
    base_url: &str,
    grpc_authority: &str,
    mode: TransportMode,
) -> Actor {
    let actor_id = Uuid::new_v4();
    let transports = mode.endpoints(base_url, grpc_authority, actor_id);
    Actor {
        id: actor_id,
        role,
        name: name.to_owned(),
        transport: transports[0].clone(),
        transports,
        secret_id: actor_secret_id().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::TransportProtocol;

    #[test]
    fn every_actor_gets_its_own_freshly_drawn_secret_id() {
        let first = actor_secret_id();
        let second = actor_secret_id();

        assert_ne!(first, 0);
        assert_ne!(first, second, "each actor must get a fresh id");
    }

    #[test]
    fn an_http_helper_advertises_only_its_http_endpoint() {
        // The URI is what peers post to, and `deliver_message` parses the id
        // back out of it, so the two must agree on the shape.
        let actor = provisioned_actor(
            Role::Helper,
            "test",
            "http://localhost:5000",
            "localhost:50051",
            TransportMode::Http,
        );

        assert_eq!(actor.transports.len(), 1);
        assert_eq!(
            actor.transports[0].uri,
            format!("http://localhost:5000/derec/{}", actor.id)
        );
        assert_eq!(actor.transports[0].protocol, TransportProtocol::Https);
    }

    #[test]
    fn a_grpc_helper_advertises_an_authority_with_no_actor_path() {
        // gRPC has no path to carry an actor id — the id is recovered from the
        // envelope's channel id instead.
        let actor = provisioned_actor(
            Role::Helper,
            "test",
            "http://localhost:5000",
            "localhost:50051",
            TransportMode::Grpc,
        );

        assert_eq!(actor.transports.len(), 1);
        assert_eq!(actor.transports[0].uri, "grpc://localhost:50051");
        assert_eq!(actor.transports[0].protocol, TransportProtocol::Grpc);
    }

    #[test]
    fn a_both_helper_advertises_grpc_first() {
        // An arbitrary but fixed app preference: the order carries no protocol
        // meaning, and the library takes no view on which a dialer picks.
        let actor = provisioned_actor(
            Role::Helper,
            "test",
            "http://localhost:5000",
            "localhost:50051",
            TransportMode::Both,
        );

        assert_eq!(actor.transports.len(), 2);
        assert_eq!(actor.transports[0].protocol, TransportProtocol::Grpc);
        assert_eq!(actor.transports[1].protocol, TransportProtocol::Https);
    }

    #[test]
    fn the_singular_transport_mirrors_the_first_entry() {
        // Four front-end call sites read `transport.uri` as "an address for
        // this actor"; it must never disagree with the head of the list.
        let actor = provisioned_actor(
            Role::Helper,
            "test",
            "http://localhost:5000",
            "localhost:50051",
            TransportMode::Both,
        );

        assert_eq!(actor.transport, actor.transports[0]);
    }
}
