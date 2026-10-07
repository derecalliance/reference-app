// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! A helper mints a replica-mode contact from an instance bound to the named
//! owner's secret — the route-level half of "any helper can be a replica".

use std::collections::HashMap;

use actix::prelude::*;
use derec_backend::infrastructure::actors::provisioned::{CreateContactMsg, InstanceForChannelMsg, ListInstanceSecretsMsg, ProvisionedActor};
use derec_backend::infrastructure::actors::protocol::{build_protocol, ProtocolConfig};
use derec_backend::models::{Role, Transport, TransportProtocol, UnpairAck};

const OWN_SECRET: u64 = 0xA1;
const ALICE_SECRET: u64 = 0x7F;

fn config(secret_id: u64, pool: sqlx::AnyPool, actor_id: uuid::Uuid) -> ProtocolConfig {
    ProtocolConfig {
        secret_id,
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

async fn spawn() -> Addr<ProvisionedActor> {
    // The actor's stores and the state share one pool, as they do in
    // production — provisioning builds every `ProtocolConfig` from
    // `state.pool`.
    let state = derec_backend::infrastructure::test_support::node().await;
    // One id for both: the stores are keyed by it, and the actor must be the
    // same actor its own stores were built for.
    let actor_id = uuid::Uuid::new_v4();
    let cfg = config(OWN_SECRET, state.pool.clone(), actor_id);
    let protocol = build_protocol(&cfg).expect("protocol builds");
    ProvisionedActor::new(protocol, cfg, actor_id, Role::Helper, state.actor_dependencies()).start()
}

#[actix_rt::test]
async fn a_replica_mode_contact_is_minted_from_the_owners_instance() {
    let addr = spawn().await;

    addr.send(derec_backend::infrastructure::actors::provisioned::EnsureReplicaInstanceMsg {
        owner_secret_id: ALICE_SECRET,
    })
    .await
    .expect("actor alive")
    .expect("instance creation succeeds");

    let contact = addr
        .send(CreateContactMsg {
            contact_mode: derec_proto::ContactMode::InlineKeys,
            nonce: None,
            replica_for_owner_secret: Some(ALICE_SECRET),
            attempt: 0,
        })
        .await
        .expect("actor alive")
        .expect("contact minted");

    // The decisive assertion: the minted channel routes to the replica
    // instance, not the helper's own. If it resolved to OWN_SECRET the peer's
    // reply would be handed to the wrong vault.
    let owner = addr
        .send(InstanceForChannelMsg { channel_id: contact.channel_id })
        .await
        .expect("actor alive");

    assert_eq!(owner, Some(ALICE_SECRET));
}

#[actix_rt::test]
async fn an_ordinary_contact_still_mints_from_the_own_instance() {
    let addr = spawn().await;

    let contact = addr
        .send(CreateContactMsg {
            contact_mode: derec_proto::ContactMode::InlineKeys,
            nonce: None,
            replica_for_owner_secret: None,
            attempt: 0,
        })
        .await
        .expect("actor alive")
        .expect("contact minted");

    let owner = addr
        .send(InstanceForChannelMsg { channel_id: contact.channel_id })
        .await
        .expect("actor alive");

    assert_eq!(owner, Some(OWN_SECRET));
    assert_eq!(
        addr.send(ListInstanceSecretsMsg).await.expect("actor alive"),
        vec![OWN_SECRET],
        "an ordinary contact must not create a second instance"
    );
}
