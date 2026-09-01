//! One actor holding an own instance plus a replica instance is what removes
//! the need for a separate replica actor kind.
//!
//! Driven directly against the actor rather than over HTTP: the route that mints
//! a replica-mode contact does not exist until plan 2.

use std::collections::HashMap;

use actix::prelude::*;
use derec_backend::actor::{
    build_protocol, EnsureReplicaInstanceMsg, ListInstanceSecretsMsg, ProtocolConfig,
    ProvisionedActor,
};
use derec_backend::models::{Role, UnpairAck};

const OWN_SECRET: u64 = 0xA1;
const ALICE_SECRET: u64 = 0x7F;
const CAROL_SECRET: u64 = 0xC3;

fn config(secret_id: u64) -> ProtocolConfig {
    ProtocolConfig {
        secret_id,
        transport_uri: "http://localhost:5000/derec/participants/test".to_owned(),
        communication_info: HashMap::from([("name".to_owned(), "Alex".to_owned())]),
        timeout_secs: 300,
        unpair_ack: UnpairAck::Required,
        threshold: 2,
        keep_versions_count: 3,
        replica_id: Some(0xAB),
        http_client: reqwest::Client::new(),
    }
}

fn spawn() -> Addr<ProvisionedActor> {
    let cfg = config(OWN_SECRET);
    let protocol = build_protocol(&cfg).expect("protocol builds");
    let state = derec_backend::test_support::app_state();
    ProvisionedActor::new(protocol, cfg, uuid::Uuid::new_v4(), Role::Participant, state).start()
}

#[actix_rt::test]
async fn an_actor_starts_with_only_its_own_instance() {
    let addr = spawn();

    let secrets = addr.send(ListInstanceSecretsMsg).await.expect("actor alive");

    assert_eq!(secrets, vec![OWN_SECRET]);
}

#[actix_rt::test]
async fn a_replica_instance_is_added_alongside_the_own_instance() {
    let addr = spawn();

    addr.send(EnsureReplicaInstanceMsg { owner_secret_id: ALICE_SECRET })
        .await
        .expect("actor alive")
        .expect("instance creation succeeds");

    let secrets = addr.send(ListInstanceSecretsMsg).await.expect("actor alive");

    assert_eq!(secrets.len(), 2, "own instance plus one replica instance");
    assert!(secrets.contains(&OWN_SECRET), "own instance survives");
    assert!(secrets.contains(&ALICE_SECRET));
}

#[actix_rt::test]
async fn ensuring_the_same_owner_twice_is_a_no_op() {
    // Not merely tidiness: a second create would install a fresh instance with
    // empty stores, silently discarding the shares this replica already holds.
    let addr = spawn();

    for _ in 0..2 {
        addr.send(EnsureReplicaInstanceMsg { owner_secret_id: ALICE_SECRET })
            .await
            .expect("actor alive")
            .expect("instance creation succeeds");
    }

    let secrets = addr.send(ListInstanceSecretsMsg).await.expect("actor alive");

    assert_eq!(secrets.len(), 2, "asking twice must not add an instance");
}

#[actix_rt::test]
async fn one_actor_replicates_for_two_owners_at_once() {
    let addr = spawn();

    for owner in [ALICE_SECRET, CAROL_SECRET] {
        addr.send(EnsureReplicaInstanceMsg { owner_secret_id: owner })
            .await
            .expect("actor alive")
            .expect("instance creation succeeds");
    }

    let secrets = addr.send(ListInstanceSecretsMsg).await.expect("actor alive");

    assert_eq!(secrets.len(), 3);
    assert!(secrets.contains(&ALICE_SECRET));
    assert!(secrets.contains(&CAROL_SECRET));
}
