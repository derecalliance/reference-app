//! Reconfiguring a live actor must not cost it its channels.
//!
//! The SDK exposes `timeouts` and `unpair_ack` on the builder only, so the
//! instance is rebuilt. If the stores did not move across, every established
//! pairing would silently vanish — which is the failure these tests exist to
//! catch.

use std::collections::HashMap;

use actix::prelude::*;
use derec_backend::actor::{
    build_protocol, ListChannelsMsg, ListInstanceSecretsMsg, ProtocolConfig, ProvisionedActor,
    ReconfigureMsg,
};
use derec_backend::models::{Role, UnpairAck};
use derec_backend::stores::ActorProtocol;
use derec_library::protocol::{ChannelRecord, DeRecChannelStore, HelperChannel};
use derec_library::types::ChannelId;

const SECRET_ID: u64 = 0xA1;
const CHANNEL_ID: u64 = 0xC0FFEE;

fn config() -> ProtocolConfig {
    ProtocolConfig {
        secret_id: SECRET_ID,
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

fn protocol() -> ActorProtocol {
    build_protocol(&config()).expect("protocol builds")
}

fn spawn(protocol: ActorProtocol) -> Addr<ProvisionedActor> {
    let state = derec_backend::test_support::app_state();

    ProvisionedActor::new(
        protocol,
        config(),
        uuid::Uuid::new_v4(),
        Role::Participant,
        state,
    )
    .start()
}

/// A helper-channel row, as the pairing handshake writes one.
fn helper_channel() -> HelperChannel {
    HelperChannel {
        channel_id: ChannelId(CHANNEL_ID),
        transport: Default::default(),
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
    let addr = spawn(protocol());

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
    let mut protocol = protocol();
    protocol
        .channel_store
        .save(SECRET_ID, ChannelRecord::Helper(helper_channel()))
        .await
        .expect("the channel store accepts a helper record");
    let addr = spawn(protocol);

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
