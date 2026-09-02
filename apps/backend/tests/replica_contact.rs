//! A helper mints a replica-mode contact from an instance bound to the named
//! owner's secret — the route-level half of "any helper can be a replica".

use std::collections::HashMap;

use actix::prelude::*;
use derec_backend::actor::{
    build_protocol, CreateContactMsg, InstanceForChannelMsg, ListInstanceSecretsMsg,
    ProtocolConfig, ProvisionedActor,
};
use derec_backend::models::{Role, UnpairAck};

const OWN_SECRET: u64 = 0xA1;
const ALICE_SECRET: u64 = 0x7F;

fn config(secret_id: u64) -> ProtocolConfig {
    ProtocolConfig {
        secret_id,
        transport_uri: "http://localhost:5000/derec/00000000-0000-0000-0000-000000000001"
            .to_owned(),
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
    ProvisionedActor::new(protocol, cfg, uuid::Uuid::new_v4(), Role::Helper, state).start()
}

#[actix_rt::test]
async fn a_replica_mode_contact_is_minted_from_the_owners_instance() {
    let addr = spawn();

    addr.send(derec_backend::actor::EnsureReplicaInstanceMsg {
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
    let addr = spawn();

    let contact = addr
        .send(CreateContactMsg {
            contact_mode: derec_proto::ContactMode::InlineKeys,
            nonce: None,
            replica_for_owner_secret: None,
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
