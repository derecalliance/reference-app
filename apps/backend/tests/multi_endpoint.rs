// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! A peer advertising two endpoints must land two on the channel record, and
//! failover must use the second without rewriting what the peer advertised.

use derec_backend::models::TransportMode;
use derec_library::protocol::{ChannelQuery, ChannelRecord, DeRecChannelStore};

mod common;

#[actix_rt::test]
async fn pairing_with_a_both_helper_records_both_endpoints_in_the_advertised_order() {
    // Neither may be dropped by `admit_peer_endpoints`, and neither may be
    // collapsed by the deprecated singular-field compatibility path.
    let rig = common::owner_paired_with(TransportMode::Both).await;

    let record = rig
        .owner
        .protocol
        .channel_store
        .load(
            rig.secret_id,
            ChannelQuery::Helper {
                channel_id: rig.channel_id,
            },
        )
        .await
        .expect("the in-memory channel store is readable")
        .expect("the channel exists after pairing");

    let ChannelRecord::Helper(helper) = record else {
        panic!("a helper pairing writes a helper record");
    };

    assert_eq!(helper.transports.len(), 2, "both endpoints must survive");
    assert_eq!(
        helper.transports[0].protocol,
        derec_proto::Protocol::Grpc as i32,
        "the peer's order must be preserved verbatim"
    );
    assert_eq!(
        helper.transports[1].protocol,
        derec_proto::Protocol::Https as i32
    );
}

#[actix_rt::test]
async fn a_grpc_only_helper_records_exactly_one_endpoint() {
    let rig = common::owner_paired_with(TransportMode::Grpc).await;

    let ChannelRecord::Helper(helper) = rig
        .owner
        .protocol
        .channel_store
        .load(
            rig.secret_id,
            ChannelQuery::Helper {
                channel_id: rig.channel_id,
            },
        )
        .await
        .expect("readable")
        .expect("paired")
    else {
        panic!("a helper pairing writes a helper record");
    };

    assert_eq!(helper.transports.len(), 1);
    assert_eq!(
        helper.transports[0].protocol,
        derec_proto::Protocol::Grpc as i32
    );
}

#[actix_rt::test]
async fn failover_leaves_the_recorded_endpoints_untouched() {
    // Choosing between endpoints is the transport's business. It must not
    // rewrite the roster: the next attempt should still start at the peer's
    // first preference.
    let mut rig = common::owner_paired_with(TransportMode::Both).await;
    let before = common::recorded_transports(&rig).await;

    common::send_with_first_endpoint_unreachable(&mut rig).await;

    assert_eq!(
        common::recorded_transports(&rig).await,
        before,
        "a failover must not mutate what the peer advertised"
    );
}
