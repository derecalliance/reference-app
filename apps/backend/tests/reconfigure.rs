// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Reconfiguring a live actor must not cost it its channels.
//!
//! The SDK exposes `timeouts` and `unpair_ack` on the builder only, so the
//! instance is rebuilt. If the rebuilt instance could not see the established
//! pairings, every one of them would silently vanish — which is the failure
//! these tests exist to catch.
//!
//! What makes them survive changed when the stores moved to SQL. It used to be
//! the moves in `rebuild_with_stores`, because each store carried its own
//! in-memory map. It is now the database: both the original and the rebuilt
//! instance are handles on the same pool. These tests therefore no longer fail
//! if those moves are deleted — but they *do* still fail if a rebuild points
//! the new instance at a different database, which is the mistake now worth
//! catching, and why `spawn` takes the pool rather than reaching for the
//! state's.

use std::collections::HashMap;

use actix::prelude::*;
use derec_backend::infrastructure::actors::provisioned::{ListChannelsMsg, ListInstanceSecretsMsg, ProvisionedActor, ReconfigureMsg};
use derec_backend::infrastructure::actors::protocol::{build_protocol, ProtocolConfig};
use derec_backend::models::{Role, Transport, TransportProtocol, UnpairAck};
use derec_backend::infrastructure::actors::protocol::ActorProtocol;
use derec_library::protocol::{ChannelRecord, DeRecChannelStore, HelperChannel};
use derec_library::types::ChannelId;

const SECRET_ID: u64 = 0xA1;
const CHANNEL_ID: u64 = 0xC0FFEE;

fn config(pool: sqlx::AnyPool, actor_id: uuid::Uuid) -> ProtocolConfig {
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
        actor_id,
        local_delivery: None,
    }
}

/// A private in-memory database per test. A shared one would let two tests see
/// each other's rows.
async fn pool() -> sqlx::AnyPool {
    derec_backend::infrastructure::db::connect("sqlite::memory:")
        .await
        .expect("an in-memory database always connects")
}

fn protocol(pool: sqlx::AnyPool, actor_id: uuid::Uuid) -> ActorProtocol {
    build_protocol(&config(pool, actor_id)).expect("protocol builds")
}

/// The pool is passed in rather than taken from the state, so the instance and
/// the config it will be rebuilt from name the *same* database. Two pools here
/// would make the rebuild read somewhere the seeded channel was never written.
async fn spawn(
    protocol: ActorProtocol,
    pool: sqlx::AnyPool,
    actor_id: uuid::Uuid,
) -> Addr<ProvisionedActor> {
    let state = derec_backend::infrastructure::test_support::node().await;

    // The same `actor_id` the instance's stores were built with. Two different
    // ones would point the rebuild at a partition the seeded channel is not in.
    ProvisionedActor::new(protocol, config(pool, actor_id), actor_id, Role::Helper, state.actor_dependencies()).start()
}

/// A helper-channel row, as the pairing handshake writes one.
///
/// `transports` must name at least one endpoint. The library refuses to load a
/// record whose endpoints were all filtered away — a channel that looks paired
/// and is unreachable is worse than one that fails loudly — and it enforces
/// that on *deserialization*. An empty list survived the in-memory store only
/// because nothing there ever serialised it.
fn helper_channel() -> HelperChannel {
    HelperChannel {
        channel_id: ChannelId(CHANNEL_ID),
        transports: vec![derec_proto::TransportProtocol {
            uri: "https://example.test/derec/helper".to_owned(),
            protocol: derec_proto::Protocol::Https as i32,
        }],
        communication_info: HashMap::from([("name".to_owned(), "Bob".to_owned())]),
        // This actor is the helper, so the peer is the owner.
        peer_role: derec_proto::SenderKind::Owner,
        status: Default::default(),
        created_at: 0,
    }
}

fn reconfigure() -> ReconfigureMsg {
    ReconfigureMsg {
        timeout_secs: 60,
        unpair_ack: UnpairAck::NotRequired,
    }
}

#[actix_rt::test]
async fn reconfigure_keeps_every_instance() {
    let pool = pool().await;
    let actor_id = uuid::Uuid::new_v4();
    let addr = spawn(protocol(pool.clone(), actor_id), pool, actor_id).await;

    let before = addr
        .send(ListInstanceSecretsMsg)
        .await
        .expect("actor alive");

    addr.send(reconfigure())
        .await
        .expect("actor alive")
        .expect("reconfigure succeeds");

    let after = addr
        .send(ListInstanceSecretsMsg)
        .await
        .expect("actor alive");

    assert_eq!(
        before,
        vec![SECRET_ID],
        "the own instance is present to begin with"
    );
    assert_eq!(before, after, "no instance may be lost to a rebuild");
}

#[actix_rt::test]
async fn reconfigure_keeps_the_channels_an_instance_already_holds() {
    // The instance-id check above still passes if every store is thrown away,
    // so this is the one that pins the state transfer down: seed the channel
    // store with an established pairing and require it to survive the rebuild.
    let pool = pool().await;
    let actor_id = uuid::Uuid::new_v4();
    let mut protocol = protocol(pool.clone(), actor_id);
    protocol
        .channel_store
        .save(SECRET_ID, ChannelRecord::Helper(helper_channel()))
        .await
        .expect("the channel store accepts a helper record");
    let addr = spawn(protocol, pool, actor_id).await;

    let before = addr
        .send(ListChannelsMsg)
        .await
        .expect("actor alive")
        .expect("channels are listable");
    let before: Vec<String> = before.into_iter().map(|c| c.channel_id).collect();
    assert_eq!(
        before,
        vec![CHANNEL_ID.to_string()],
        "the seeded channel is there"
    );

    addr.send(reconfigure())
        .await
        .expect("actor alive")
        .expect("reconfigure succeeds");

    let after = addr
        .send(ListChannelsMsg)
        .await
        .expect("actor alive")
        .expect("channels are listable");
    let after: Vec<String> = after.into_iter().map(|c| c.channel_id).collect();

    assert_eq!(
        before, after,
        "the channel store must move into the rebuilt instance"
    );
}
