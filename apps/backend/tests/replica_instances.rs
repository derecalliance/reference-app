//! One actor holding an own instance plus a replica instance is what removes
//! the need for a separate replica actor kind.
//!
//! Driven directly against the actor rather than over HTTP: the route that mints
//! a replica-mode contact does not exist until plan 2.

use std::collections::HashMap;

use actix::prelude::*;
use derec_backend::actor::{
    build_protocol, CreateContactMsg, EnsureReplicaInstanceMsg, InstanceForChannelMsg,
    ListInstanceSecretsMsg, ProtocolConfig, ProvisionedActor,
};
use derec_backend::models::{Role, Transport, TransportProtocol, UnpairAck};

const OWN_SECRET: u64 = 0xA1;
const ALICE_SECRET: u64 = 0x7F;
const CAROL_SECRET: u64 = 0xC3;

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
        keep_versions_count: 3,
        replica_id: Some(0xAB),
        http_client: reqwest::Client::new(),
        pool,
        actor_id,
    }
}

async fn spawn() -> Addr<ProvisionedActor> {
    // The actor's stores and the state share one pool, as they do in
    // production — provisioning builds every `ProtocolConfig` from
    // `state.pool`.
    let state = derec_backend::test_support::app_state().await;
    // One id for both: the stores are keyed by it, and the actor must be the
    // same actor its own stores were built for.
    let actor_id = uuid::Uuid::new_v4();
    let cfg = config(OWN_SECRET, state.pool.clone(), actor_id);
    let protocol = build_protocol(&cfg).expect("protocol builds");
    ProvisionedActor::new(protocol, cfg, actor_id, Role::Helper, state).start()
}

#[actix_rt::test]
async fn an_actor_starts_with_only_its_own_instance() {
    let addr = spawn().await;

    let secrets = addr.send(ListInstanceSecretsMsg).await.expect("actor alive");

    assert_eq!(secrets, vec![OWN_SECRET]);
}

#[actix_rt::test]
async fn a_replica_instance_is_added_alongside_the_own_instance() {
    let addr = spawn().await;

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
    //
    // A key-count assertion alone cannot see that: `InstanceMap::insert` writes
    // into a map keyed by secret_id, so a second, non-idempotent create would
    // *overwrite* the entry and the map would still hold exactly two keys. The
    // `bool` result is what actually distinguishes "created" from "reused", so
    // it is what this test asserts on.
    let addr = spawn().await;

    let mut created = Vec::new();
    for _ in 0..2 {
        let was_created = addr
            .send(EnsureReplicaInstanceMsg { owner_secret_id: ALICE_SECRET })
            .await
            .expect("actor alive")
            .expect("instance creation succeeds");
        created.push(was_created);
    }

    assert_eq!(created, [true, false], "first call creates, second reuses");

    let secrets = addr.send(ListInstanceSecretsMsg).await.expect("actor alive");
    assert_eq!(secrets.len(), 2, "asking twice must not add an instance");
}

#[actix_rt::test]
async fn a_contact_is_minted_from_the_selected_replica_instance() {
    // Discriminates real instance selection from an accidental own-instance
    // fallback: if `replica_for_owner_secret` were ignored (or defaulted to
    // the own instance on a missing entry), minting before the replica
    // instance exists would succeed anyway. Requiring failure before and
    // success after is what proves the selection is real.
    let addr = spawn().await;

    let contact = |replica_for_owner_secret| CreateContactMsg {
        contact_mode: derec_proto::ContactMode::InlineKeys,
        nonce: None,
        replica_for_owner_secret,
    };

    let before = addr
        .send(contact(Some(ALICE_SECRET)))
        .await
        .expect("actor alive");
    assert!(
        before.is_err(),
        "no instance exists for ALICE_SECRET yet, so minting must not silently \
         fall back to the own instance"
    );

    addr.send(EnsureReplicaInstanceMsg { owner_secret_id: ALICE_SECRET })
        .await
        .expect("actor alive")
        .expect("instance creation succeeds");

    let after = addr
        .send(contact(Some(ALICE_SECRET)))
        .await
        .expect("actor alive");
    assert!(
        after.is_ok(),
        "the replica instance now exists and can mint a contact"
    );
}

#[actix_rt::test]
async fn a_minted_contacts_channel_routes_back_to_the_instance_that_minted_it() {
    // Inbound routing resolves an envelope's cleartext channel id against the
    // actor's routing index, and a freshly minted contact is precisely the
    // channel a channel-store read cannot see: `create_contact` writes to the
    // secret store only. If minting leaves no binding, the peer's opening reply
    // is dropped as unroutable and first-contact pairing never starts — which
    // is exactly how this shipped once.
    //
    // Minting from both instances also pins down *which* instance answers: a
    // routing index that lumped every channel under the own instance would
    // still resolve the replica's channel, just to the wrong protocol.
    let addr = spawn().await;

    addr.send(EnsureReplicaInstanceMsg { owner_secret_id: ALICE_SECRET })
        .await
        .expect("actor alive")
        .expect("instance creation succeeds");

    let mint = |replica_for_owner_secret| CreateContactMsg {
        contact_mode: derec_proto::ContactMode::InlineKeys,
        nonce: None,
        replica_for_owner_secret,
    };

    let own_contact = addr
        .send(mint(None))
        .await
        .expect("actor alive")
        .expect("own instance mints a contact");
    let replica_contact = addr
        .send(mint(Some(ALICE_SECRET)))
        .await
        .expect("actor alive")
        .expect("replica instance mints a contact");

    assert_ne!(
        own_contact.channel_id, replica_contact.channel_id,
        "the two instances must mint distinct channels for the assertions below \
         to distinguish them"
    );

    let owner_of = |channel_id| addr.send(InstanceForChannelMsg { channel_id });

    assert_eq!(
        owner_of(own_contact.channel_id).await.expect("actor alive"),
        Some(OWN_SECRET),
        "the own instance's contact must route to the own instance"
    );
    assert_eq!(
        owner_of(replica_contact.channel_id)
            .await
            .expect("actor alive"),
        Some(ALICE_SECRET),
        "the replica instance's contact must route to that replica instance, \
         not to the own instance"
    );
}

#[actix_rt::test]
async fn one_actor_replicates_for_two_owners_at_once() {
    let addr = spawn().await;

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
