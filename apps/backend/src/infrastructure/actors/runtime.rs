// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Starting, stopping and calling provisioned actors — the actix side of
//! [`ActorGateway`].

use std::sync::Arc;

use actix::{Addr, MailboxError};
use async_trait::async_trait;
use derec_library::protocol::{DeRecEvent, DeRecFlow};
use uuid::Uuid;

use super::inboxes::{ActorInbox, ActorInboxes};
use super::protocol::{build_protocol, ProtocolConfig};
use super::provisioned::{
    ActorDependencies, ActorError, AnnounceReport, AnnounceTransportsMsg, CreateContactMsg,
    EnsureReplicaError, EnsureReplicaInstanceMsg, GetFingerprintMsg, LinkChannelsMsg,
    ListChannelsMsg, ListInstanceSecretsMsg, ProvisionedActor, ShutdownMsg, StartFlowMsg, TickMsg,
    VerifyFingerprintMsg,
};
use crate::infrastructure::transport::is_unreachable;
use crate::models::{Actor, ActorSettings, ChannelSummary, ContactRequest, UnpairedContact};
use crate::services::delivery::LocalDelivery;
use crate::services::ports::{ActorCallError, ActorGateway, SpawnError};

/// What a respawned actor had running before the restart, beyond its own
/// instance.
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

/// The provisioned actors on this node.
pub struct ActorRuntime {
    arbiter: actix_rt::ArbiterHandle,
    inboxes: Arc<ActorInboxes>,
    deps: ActorDependencies,
    pool: sqlx::AnyPool,
    http_client: reqwest::Client,
    local_delivery: Arc<dyn LocalDelivery>,
}

impl ActorRuntime {
    pub fn new(
        arbiter: actix_rt::ArbiterHandle,
        inboxes: Arc<ActorInboxes>,
        deps: ActorDependencies,
        pool: sqlx::AnyPool,
        http_client: reqwest::Client,
        local_delivery: Arc<dyn LocalDelivery>,
    ) -> Self {
        Self {
            arbiter,
            inboxes,
            deps,
            pool,
            http_client,
            local_delivery,
        }
    }

    /// What every actor on this node is built with.
    pub fn dependencies(&self) -> ActorDependencies {
        self.deps.clone()
    }

    /// Spawn a backend-managed actor, putting back what it had running.
    ///
    /// The own instance, bound to `secret_id`, is always built here. A replica
    /// instance — bound to a different owner's secret — is otherwise added on
    /// demand; a respawn rebuilds every one `stored` names, so the channels
    /// they hold keep routing. The settings come from the caller rather than
    /// being minted here, so a respawn rebuilds the actor it had rather than a
    /// new one: `replica_id` in particular is the id every stored
    /// `ReplicaMember` row references.
    ///
    /// Nothing is left running on failure of the own instance: it is built
    /// before the actor starts, so an error means no actor and no inbox. A
    /// replica instance that fails to build is warned about and skipped
    /// instead — the helper still serves every other channel, and a later
    /// replica pairing with that owner creates the instance afresh.
    pub fn spawn_restored(
        &self,
        actor: &Actor,
        settings: &ActorSettings,
        stored: &StoredInstances,
    ) -> Result<(), SpawnError> {
        let actor_id = actor.id;
        let role = actor.role;
        let Ok(secret_id) = actor.secret_id.parse::<u64>() else {
            tracing::error!(actor_id = %actor_id, "actor has an unparseable secret_id; not spawning");
            return Err(SpawnError::SecretId);
        };

        let config = ProtocolConfig {
            secret_id,
            own_transports: actor.transports.clone(),
            communication_info: std::collections::HashMap::from([(
                "name".to_owned(),
                actor.name.clone(),
            )]),
            timeout_secs: settings.timeout_secs,
            unpair_ack: settings.unpair_ack,
            threshold: 2,
            // Every actor may take part in replica-mode pairing: the source is
            // an Owner, the destination a Replica. Both sides need a stable
            // id, so it is assigned unconditionally rather than by role.
            replica_id: Some(settings.replica_id),
            http_client: self.http_client.clone(),
            pool: self.pool.clone(),
            actor_id,
            local_delivery: Some(Arc::clone(&self.local_delivery)),
        };

        let protocol = build_protocol(&config).map_err(|e| {
            tracing::error!(actor_id = %actor_id, error = %e, "failed to build protocol; not spawning");
            SpawnError::Protocol(e)
        })?;

        let mut replicas = Vec::with_capacity(stored.replica_secret_ids.len());
        for &replica_secret in &stored.replica_secret_ids {
            let mut replica_config = config.clone();
            replica_config.secret_id = replica_secret;
            match build_protocol(&replica_config) {
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
            tracing::info!(actor_id = %actor_id, replicas = replicas.len(), "replica instances restored");
        }

        // The gRPC half of a contact's route. Taken here, before the actor can
        // receive anything, and dated from when the contact was minted so it
        // expires when it would have without the restart. HTTP needs no such
        // route — the actor is in the URL — but the instance-level pin below.
        if actor.advertises_grpc() {
            let now = crate::utils::time::now_unix_secs();
            for contact in &stored.unpaired_contacts {
                let age = u64::try_from(now.saturating_sub(contact.minted_at)).unwrap_or(0);
                self.deps.channel_router.pin_aged(
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

        // The actor keeps the config so it can rebuild an instance in place
        // when settings change. Supervised: a panicking handler would
        // otherwise stop this actor for the rest of the process's life, and
        // the only symptom is a peer whose messages stop being answered. The
        // actor value is reused on restart, so its protocol instances and
        // their stores come back with it.
        let deps = self.deps.clone();
        let addr = actix::Supervisor::start_in_arbiter(&self.arbiter, move |_ctx| {
            ProvisionedActor::new(protocol, config, actor_id, role, deps)
                .with_restored(replicas, contact_pins)
        });

        self.inboxes.insert_provisioned(actor_id, addr);
        Ok(())
    }

    /// Run one tick on `actor_id` to completion. The tick re-derives an
    /// actor's gRPC routes from its stores, which is why boot runs one before
    /// anything is served.
    pub async fn tick(&self, actor_id: &Uuid) -> Result<(), ActorCallError> {
        self.addr(actor_id)?
            .send(TickMsg)
            .await
            .map_err(not_running)
    }

    /// Have `actor_id` tell every peer on its helper channels where it can be
    /// reached now.
    pub async fn announce_transports(
        &self,
        actor_id: &Uuid,
    ) -> Result<AnnounceReport, ActorCallError> {
        self.addr(actor_id)?
            .send(AnnounceTransportsMsg::default())
            .await
            .map_err(not_running)
    }

    /// Every backend-run actor.
    pub fn provisioned_ids(&self) -> Vec<Uuid> {
        self.inboxes.provisioned_ids()
    }

    fn addr(&self, actor_id: &Uuid) -> Result<Addr<ProvisionedActor>, ActorCallError> {
        self.inboxes
            .provisioned(actor_id)
            .ok_or(ActorCallError::NotProvisioned)
    }
}

#[async_trait]
impl ActorGateway for ActorRuntime {
    fn spawn(&self, actor: &Actor, settings: &ActorSettings) -> Result<(), SpawnError> {
        self.spawn_restored(actor, settings, &StoredInstances::default())
    }

    fn shutdown(&self, actor_id: &Uuid) {
        if let Some(ActorInbox::Provisioned(addr)) = self.inboxes.remove(actor_id) {
            // Dropping the `Addr` is not enough: the actor's repeating tick
            // would keep writing rows back into the tables about to be
            // cleared. See `ShutdownMsg`.
            addr.do_send(ShutdownMsg);
        }
        // A browser-managed actor is driven by a page, not by us; its queued
        // mail is a mailbox row, erased with the rest of its data.
    }

    async fn ensure_replica_instance(
        &self,
        actor_id: &Uuid,
        owner_secret_id: u64,
    ) -> Result<bool, ActorCallError> {
        match self
            .addr(actor_id)?
            .send(EnsureReplicaInstanceMsg { owner_secret_id })
            .await
            .map_err(not_running)?
        {
            Ok(created) => Ok(created),
            Err(EnsureReplicaError::LimitReached { max }) => {
                Err(ActorCallError::ReplicaLimitReached { max })
            }
            Err(EnsureReplicaError::OwnSecret) => Err(ActorCallError::OwnSecret),
            Err(EnsureReplicaError::Build(e)) => Err(classify(ActorError::Protocol(e))),
        }
    }

    async fn create_contact(
        &self,
        actor_id: &Uuid,
        request: ContactRequest,
    ) -> Result<derec_proto::ContactMessage, ActorCallError> {
        let msg = CreateContactMsg {
            contact_mode: request.contact_mode,
            nonce: request.nonce,
            replica_for_owner_secret: request.replica_for_owner_secret,
            attempt: 0,
        };
        self.addr(actor_id)?
            .send(msg)
            .await
            .map_err(not_running)?
            .map_err(classify)
    }

    async fn start_flow(
        &self,
        actor_id: &Uuid,
        flow: DeRecFlow,
    ) -> Result<Vec<DeRecEvent>, ActorCallError> {
        self.addr(actor_id)?
            .send(StartFlowMsg { flow })
            .await
            .map_err(not_running)?
            .map_err(classify)
    }

    async fn fingerprint(
        &self,
        actor_id: &Uuid,
        channel_id: u64,
    ) -> Result<String, ActorCallError> {
        self.addr(actor_id)?
            .send(GetFingerprintMsg { channel_id })
            .await
            .map_err(not_running)?
            .map_err(classify)
    }

    async fn verify_fingerprint(
        &self,
        actor_id: &Uuid,
        channel_id: u64,
        fingerprint: String,
    ) -> Result<bool, ActorCallError> {
        self.addr(actor_id)?
            .send(VerifyFingerprintMsg {
                channel_id,
                fingerprint,
            })
            .await
            .map_err(not_running)?
            .map_err(classify)
    }

    async fn list_channels(&self, actor_id: &Uuid) -> Result<Vec<ChannelSummary>, ActorCallError> {
        self.addr(actor_id)?
            .send(ListChannelsMsg)
            .await
            .map_err(not_running)?
            .map_err(classify)
    }

    async fn link_channels(
        &self,
        actor_id: &Uuid,
        channel_id: u64,
        link_to_channel_id: u64,
    ) -> Result<(), ActorCallError> {
        self.addr(actor_id)?
            .send(LinkChannelsMsg {
                channel_id,
                link_to_channel_id,
            })
            .await
            .map_err(not_running)?
            .map_err(classify)
    }

    async fn instance_secret_ids(&self, actor_id: &Uuid) -> Vec<u64> {
        match self.addr(actor_id) {
            Ok(addr) => addr.send(ListInstanceSecretsMsg).await.unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    }
}

/// The actor's mailbox refused or dropped the call — it stopped, or is
/// shutting down ahead of deletion.
fn not_running(e: MailboxError) -> ActorCallError {
    ActorCallError::NotRunning(e.to_string())
}

/// What an actor's own error means to a caller.
fn classify(e: ActorError) -> ActorCallError {
    match e {
        ActorError::Busy => ActorCallError::Busy,
        ActorError::Protocol(e) if is_unreachable(&e) => ActorCallError::PeerUnreachable,
        ActorError::Protocol(e) => ActorCallError::Protocol(e),
    }
}

/// The actix system on its own OS thread, and what it takes to stop it.
///
/// Actix actors are `!Send`, so they need their own single-threaded runtime;
/// the rest of the node spawns actors onto it from the Tokio pool through the
/// arbiter handle.
pub struct ActorThread {
    arbiter: actix_rt::Arbiter,
    shutdown: Arc<tokio::sync::Notify>,
}

/// The actor runtime thread did not come up.
#[derive(Debug, thiserror::Error)]
#[error("the actor runtime thread failed to start")]
pub struct ActorThreadError;

impl ActorThread {
    /// Start the actix system and hand back an arbiter handle on it.
    pub fn start() -> Result<(actix_rt::ArbiterHandle, Self), ActorThreadError> {
        let shutdown = Arc::new(tokio::sync::Notify::new());
        let (tx, rx) = std::sync::mpsc::channel();

        let thread_shutdown = Arc::clone(&shutdown);
        std::thread::spawn(move || {
            let system = actix_rt::System::new();
            system.block_on(async {
                let arbiter = actix_rt::Arbiter::new();
                // A failed send means `start` already gave up waiting, so
                // there is nobody left to tell.
                if tx.send((arbiter.handle(), arbiter)).is_err() {
                    return;
                }
                // Keep the system alive until the node stops.
                thread_shutdown.notified().await;
            });
        });

        let (handle, arbiter) = rx.recv().map_err(|_| ActorThreadError)?;
        Ok((handle, Self { arbiter, shutdown }))
    }

    pub fn stop(self) {
        self.arbiter.stop();
        // `notify_one` stores a permit if the thread is not waiting yet, so
        // the stop cannot be missed.
        self.shutdown.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_busy_instance_is_reported_as_busy() {
        assert!(matches!(classify(ActorError::Busy), ActorCallError::Busy));
    }

    #[test]
    fn a_transport_failure_is_reported_as_an_unreachable_peer() {
        let e =
            derec_library::Error::Invariant(crate::infrastructure::transport::NO_ENDPOINT_ACCEPTED);

        assert!(matches!(
            classify(ActorError::Protocol(e)),
            ActorCallError::PeerUnreachable
        ));
    }

    #[test]
    fn any_other_protocol_failure_is_passed_through() {
        let e = derec_library::Error::InvalidInput("nope");

        assert!(matches!(
            classify(ActorError::Protocol(e)),
            ActorCallError::Protocol(derec_library::Error::InvalidInput("nope"))
        ));
    }
}
