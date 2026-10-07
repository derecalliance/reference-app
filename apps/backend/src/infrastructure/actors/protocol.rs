// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Building a provisioned actor's protocol instances.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use derec_library::protocol::types::Timeouts;
use derec_library::protocol::{AutoAcceptPolicy, DeRecProtocolBuilder, ExpiredChannelCleanup};
use uuid::Uuid;

use crate::infrastructure::transport::{CompositeTransport, GrpcTransport, HttpTransport};
use crate::models::{Transport, UnpairAck};
use crate::repositories::sdk::{
    channel::SqlChannelStore, secret::SqlSecretStore, share::SqlShareStore, state::SqlStateStore,
    user_secret::SqlUserSecretStore,
};
use crate::services::delivery::LocalDelivery;

/// The protocol type every actor runs.
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
    pub own_transports: Vec<Transport>,
    pub communication_info: HashMap<String, String>,
    pub timeout_secs: u32,
    pub unpair_ack: UnpairAck,
    pub threshold: usize,
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
    /// The node's own delivery, so a send to one of its own actors — under
    /// its current address or one it advertised before — is delivered
    /// in-process instead of dialled. `None` for an instance built outside a
    /// node, as test fixtures standing in for a browser are.
    pub local_delivery: Option<Arc<dyn LocalDelivery>>,
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
        .with_unsafe_connection(
            config
                .own_transports
                .iter()
                .any(|t| t.uri.starts_with("http://") || t.uri.starts_with("grpc://")),
        )
        .with_threshold(config.threshold)
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
        .with_transport(transport_for(config))
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

/// The transport an instance built from `config` sends with.
fn transport_for(config: &ProtocolConfig) -> CompositeTransport {
    let transport = CompositeTransport::new(
        HttpTransport::new(config.http_client.clone()),
        // Stamped with this actor, so when the peer is another actor on
        // this node the shared gRPC ingress can tell the two ends apart.
        GrpcTransport::for_actor(config.actor_id),
    );
    match &config.local_delivery {
        Some(local) => transport.delivering_locally_on(Arc::clone(local)),
        None => transport,
    }
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
// The large `Err` is the point: it hands the caller's instance back by value.
// This runs once per reconfigure, so boxing it would buy nothing measurable.
#[allow(clippy::result_large_err)]
pub(super) fn rebuild_with_stores(
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

#[cfg(test)]
mod tests {
    use super::*;

    use derec_library::protocol::{DeRecSecretStore, SecretKind, SecretValue};
    use derec_library::types::ChannelId;

    const SECRET_ID: u64 = 0xA1;
    const CHANNEL_ID: u64 = 0xC0FFEE;
    const SHARED_KEY: [u8; 32] = [7u8; 32];

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
                protocol: crate::models::TransportProtocol::Https,
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
        let stored = old
            .secret_store
            .load(SECRET_ID, ChannelId(CHANNEL_ID), SecretKind::SharedKey)
            .await
            .expect("the store is readable");
        assert!(
            matches!(stored, Some(SecretValue::SharedKey(key)) if key == SHARED_KEY),
            "the instance handed back must still see the key it stored"
        );
    }
}
