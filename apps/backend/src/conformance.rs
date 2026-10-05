// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Behaviour every store implementation must have, independent of engine.
//!
//! Written against the in-memory stores first, so it is proven to catch real
//! breakage before any SQL exists — a suite that has only ever run against the
//! implementation it was written from is not evidence of anything.
//!
//! Each function takes an empty store and leaves it dirty. Callers construct a
//! fresh one per call.
//!
//! Two properties matter more than the individual assertions and are checked
//! throughout: every operation is partitioned by `secret_id`, and a `u64` id
//! near `u64::MAX` round-trips exactly. The second is what an `i64` bit-cast
//! would break invisibly.
//!
//! Every store method returns a future of `Result`, so each call ends in
//! `.expect(...)`: an in-memory store cannot fail, and a SQL store failing
//! here is a test failure rather than something to handle. Note also that
//! `SecretValue` derives only `Clone` — no `Debug` — so its mismatches are
//! reported with written-out messages rather than `{:?}`.

use derec_library::protocol::types::{ChannelStatus, HelperFilter};
use derec_library::protocol::{
    ChannelQuery, ChannelRecord, DeRecChannelStore, DeRecSecretStore, DeRecShareStore,
    DeRecStateStore, DeRecUserSecretStore, HelperChannel, SecretKind, SecretValue, Share, StateItem,
    UserSecrets,
};
use derec_library::types::ChannelId;

/// An id above `i64::MAX`. Stored as TEXT it round-trips; bit-cast to `i64` it
/// comes back negative and sorts wrong.
pub const HIGH_ID: u64 = u64::MAX - 7;

/// Two secrets, to prove partitioning.
pub const SECRET_A: u64 = 11;
pub const SECRET_B: u64 = 22;

/// A helper channel with a single HTTPS endpoint.
///
/// Every field is written out: `HelperChannel` has no `Default`, which the
/// existing unit tests in `stores.rs` also work around this way.
fn helper_channel(channel_id: u64) -> HelperChannel {
    HelperChannel {
        channel_id: ChannelId(channel_id),
        transports: vec![derec_proto::TransportProtocol {
            uri: format!("https://example.test/derec/{channel_id}"),
            protocol: derec_proto::Protocol::Https as i32,
        }],
        communication_info: Default::default(),
        peer_role: derec_proto::SenderKind::Owner,
        status: ChannelStatus::Paired,
        created_at: 0,
    }
}

/// Two stores that represent *different instances* must not see each other's
/// rows, even when both are asked about the same `secret_id`.
///
/// This is not the same property as `secret_id` partitioning, and checking one
/// does not check the other. An actor runs its own instance plus one replica
/// instance per owner it mirrors, and a replica instance is bound to the
/// *mirrored owner's* secret — so two actors mirroring one owner legitimately
/// hold instances carrying an identical `secret_id`. Two helpers acting as
/// replicas for one owner is the ordinary case.
///
/// While each instance owned a private in-memory map this held by accident, and
/// a shared database removes the accident. It first goes wrong in *listings*:
/// `helpers(secret_id, ..)` returns every row for that secret regardless of
/// which instance wrote it.
///
/// Callers pass two stores built for different instances over the same backing
/// store. An implementation that ignores instance identity fails here.
pub async fn channel_stores_are_isolated_per_instance<S: DeRecChannelStore>(
    first: &mut S,
    second: &mut S,
) {
    first
        .save(SECRET_A, ChannelRecord::Helper(helper_channel(HIGH_ID)))
        .await
        .expect("save");

    assert!(
        second
            .load(
                SECRET_A,
                ChannelQuery::Helper {
                    channel_id: ChannelId(HIGH_ID)
                }
            )
            .await
            .expect("readable")
            .is_none(),
        "one instance must not load another's channel, even under the same secret_id"
    );

    assert!(
        second
            .helpers(SECRET_A, HelperFilter::default())
            .await
            .expect("readable")
            .is_empty(),
        "listing is where this goes wrong first: one instance must not see \
         another's channels under the same secret_id"
    );

    // And the writer still sees its own.
    assert_eq!(
        first
            .helpers(SECRET_A, HelperFilter::default())
            .await
            .expect("readable")
            .len(),
        1,
        "isolation must not cost the writer its own row"
    );
}

/// Every `DeRecChannelStore` behaviour the protocol relies on.
pub async fn channel_store_conforms<S: DeRecChannelStore>(store: &mut S) {
    let query = |id: u64| ChannelQuery::Helper {
        channel_id: ChannelId(id),
    };

    // Absent before saved.
    assert!(
        store
            .load(SECRET_A, query(HIGH_ID))
            .await
            .expect("readable")
            .is_none(),
        "an unsaved channel must not load"
    );

    store
        .save(SECRET_A, ChannelRecord::Helper(helper_channel(HIGH_ID)))
        .await
        .expect("save");

    // Round-trips, including an id above i64::MAX.
    let loaded = store
        .load(SECRET_A, query(HIGH_ID))
        .await
        .expect("readable")
        .expect("a saved channel loads");
    match loaded {
        ChannelRecord::Helper(h) => assert_eq!(h.channel_id.0, HIGH_ID, "id must survive exactly"),
        _ => panic!("expected a helper record, got a replica one"),
    }

    // Partitioned: the same channel id under another secret is a different row.
    assert!(
        store
            .load(SECRET_B, query(HIGH_ID))
            .await
            .expect("readable")
            .is_none(),
        "channels must be partitioned by secret_id"
    );

    // Save is upsert, not insert: re-saving replaces rather than duplicating.
    store
        .save(SECRET_A, ChannelRecord::Helper(helper_channel(HIGH_ID)))
        .await
        .expect("save");
    assert_eq!(
        store
            .helpers(SECRET_A, HelperFilter::default())
            .await
            .expect("readable")
            .len(),
        1,
        "saving the same channel twice must not duplicate it"
    );

    // An unlinked channel is linked to itself, not to nothing.
    //
    // Callers use this as the channel set to read shares over: a helper
    // answering a recovery request asks for the linked set of the channel it
    // was reached on, then looks for shares across it. Returning an empty list
    // there makes the helper report that it holds no shares at all, which
    // presents as a recovery that discovers every helper and finds no versions.
    assert_eq!(
        store
            .linked_channels(SECRET_A, ChannelId(HIGH_ID))
            .await
            .expect("readable"),
        vec![ChannelId(HIGH_ID)],
        "an unlinked channel must return itself"
    );

    // Links are bidirectional.
    store
        .save(SECRET_A, ChannelRecord::Helper(helper_channel(5)))
        .await
        .expect("save");
    store
        .link_channel(SECRET_A, ChannelId(HIGH_ID), ChannelId(5))
        .await
        .expect("link");

    let from_high = store
        .linked_channels(SECRET_A, ChannelId(HIGH_ID))
        .await
        .expect("readable");
    let from_five = store
        .linked_channels(SECRET_A, ChannelId(5))
        .await
        .expect("readable");
    assert!(
        from_high.iter().any(|c| c.0 == 5),
        "link must be visible from the channel it was made on"
    );
    assert!(
        from_five.iter().any(|c| c.0 == HIGH_ID),
        "link must be visible from the other side"
    );
    // Each side still includes itself, so the set is usable directly as "every
    // channel that may carry this owner's shares".
    assert!(
        from_high.iter().any(|c| c.0 == HIGH_ID),
        "a linked channel must still include itself"
    );
    assert!(
        from_five.iter().any(|c| c.0 == 5),
        "a linked channel must still include itself"
    );

    // Remove reports whether it removed anything.
    assert!(
        store
            .remove(SECRET_A, query(HIGH_ID))
            .await
            .expect("remove"),
        "removing a present channel reports true"
    );
    assert!(
        !store
            .remove(SECRET_A, query(HIGH_ID))
            .await
            .expect("remove"),
        "removing an absent channel reports false"
    );
}

/// Every `DeRecShareStore` behaviour the protocol relies on.
///
/// Note the signatures: `save` takes `(secret_id, channel_id, share)` with no
/// replica argument, and both `load_all` and `load` take a channel-id slice or
/// channel. The key is `(secret_id, channel_id, version)`.
pub async fn share_store_conforms<S: DeRecShareStore>(store: &mut S) {
    let channel = ChannelId(HIGH_ID);

    assert_eq!(
        store.latest_version(SECRET_A).await.expect("readable"),
        None,
        "no shares means no latest version"
    );

    for version in [1u32, 2, 3] {
        store
            .save(
                SECRET_A,
                channel,
                Share {
                    secret_id: SECRET_A,
                    version,
                    bytes: vec![version as u8, 0xff, 0x00],
                },
            )
            .await
            .expect("save");
    }

    assert_eq!(
        store.latest_version(SECRET_A).await.expect("readable"),
        Some(3),
        "latest_version must be the maximum, not the most recently written"
    );

    // Binary survives the round trip byte for byte — base64 encoding is an
    // implementation detail that must not be observable.
    let all = store
        .load_all(SECRET_A, &[channel])
        .await
        .expect("readable");
    let three = all
        .iter()
        .find(|s| s.version == 3)
        .expect("version 3 was saved");
    assert_eq!(
        three.bytes,
        vec![3u8, 0xff, 0x00],
        "share bytes must round-trip exactly, including 0xff and 0x00"
    );

    // An explicit version filter narrows; an empty one means "every version".
    let filtered = store
        .load(SECRET_A, channel, &[2])
        .await
        .expect("readable");
    assert_eq!(filtered.len(), 1, "a version filter must narrow the result");
    assert_eq!(filtered[0].version, 2);

    // A `Share` is self-describing: its own `secret_id` is the secret the share
    // belongs to, which is NOT necessarily the partition it is filed under. On
    // a helper the partition is the helper's own instance while the share
    // belongs to the *owner's* secret, so a store that reconstructs this field
    // from the partition argument corrupts every share a helper holds.
    //
    // Saved under SECRET_A, belonging to SECRET_B — deliberately different, so
    // reconstructing from the partition cannot accidentally pass.
    store
        .save(
            SECRET_A,
            channel,
            Share {
                secret_id: SECRET_B,
                version: 9,
                bytes: vec![9],
            },
        )
        .await
        .expect("save");

    let foreign = store
        .load(SECRET_A, channel, &[9])
        .await
        .expect("readable");
    assert_eq!(foreign.len(), 1, "the share is filed under the partition");
    assert_eq!(
        foreign[0].secret_id, SECRET_B,
        "a share's own secret_id must round-trip, not be replaced by the \
         partition it was filed under"
    );

    assert_eq!(
        store.latest_version(SECRET_B).await.expect("readable"),
        None,
        "shares must be partitioned by secret_id"
    );

    store
        .remove_channel(SECRET_A, channel)
        .await
        .expect("remove_channel");
    assert!(
        store
            .load_all(SECRET_A, &[channel])
            .await
            .expect("readable")
            .is_empty(),
        "removing the channel removes its shares"
    );
}

/// Every `DeRecUserSecretStore` behaviour the protocol relies on.
pub async fn user_secret_store_conforms<S: DeRecUserSecretStore>(store: &mut S) {
    assert!(
        store
            .load_latest(SECRET_A)
            .await
            .expect("readable")
            .is_none(),
        "nothing saved means nothing loads"
    );

    store
        .save_latest(
            SECRET_A,
            UserSecrets {
                version: 4,
                secrets: Vec::new(),
                description: Some("first".to_owned()),
                author_replica_id: None,
            },
        )
        .await
        .expect("save_latest");

    let loaded = store
        .load_latest(SECRET_A)
        .await
        .expect("readable")
        .expect("saved snapshot");
    assert_eq!(loaded.version, 4);
    assert_eq!(loaded.description.as_deref(), Some("first"));

    // save_latest replaces rather than accumulating.
    store
        .save_latest(
            SECRET_A,
            UserSecrets {
                version: 5,
                secrets: Vec::new(),
                description: Some("second".to_owned()),
                author_replica_id: None,
            },
        )
        .await
        .expect("save_latest");
    assert_eq!(
        store
            .load_latest(SECRET_A)
            .await
            .expect("readable")
            .expect("snapshot")
            .version,
        5,
        "save_latest must replace the previous snapshot"
    );

    assert!(
        store
            .load_latest(SECRET_B)
            .await
            .expect("readable")
            .is_none(),
        "user secrets must be partitioned by secret_id"
    );

    store.remove(SECRET_A).await.expect("remove");
    assert!(
        store
            .load_latest(SECRET_A)
            .await
            .expect("readable")
            .is_none(),
        "remove must clear the snapshot"
    );
}

/// Every `DeRecSecretStore` behaviour the protocol relies on.
///
/// Keyed by `(secret_id, channel_id, kind)`. `save` takes no `kind` — it is
/// derived from the `SecretValue` variant, so a store that keys on anything
/// else will overwrite one kind with another.
pub async fn secret_store_conforms<S: DeRecSecretStore>(store: &mut S) {
    let channel = ChannelId(HIGH_ID);

    assert!(
        store
            .load(SECRET_A, channel, SecretKind::SharedKey)
            .await
            .expect("readable")
            .is_none(),
        "an unsaved secret must not load"
    );

    store
        .save(SECRET_A, channel, SecretValue::SharedKey([7u8; 32]))
        .await
        .expect("save");

    match store
        .load(SECRET_A, channel, SecretKind::SharedKey)
        .await
        .expect("readable")
        .expect("a saved secret loads")
    {
        SecretValue::SharedKey(key) => assert_eq!(key, [7u8; 32], "key must round-trip exactly"),
        _ => panic!("expected a shared key, got another secret kind"),
    }

    // A different kind on the same channel is a different row, not an
    // overwrite. This is what keying on the value's own variant buys.
    assert!(
        store
            .load(SECRET_A, channel, SecretKind::PairingSecret)
            .await
            .expect("readable")
            .is_none(),
        "kinds must not collide on one channel"
    );

    assert!(
        store
            .load(SECRET_B, channel, SecretKind::SharedKey)
            .await
            .expect("readable")
            .is_none(),
        "secrets must be partitioned by secret_id"
    );

    // Save is upsert.
    store
        .save(SECRET_A, channel, SecretValue::SharedKey([9u8; 32]))
        .await
        .expect("save");
    match store
        .load(SECRET_A, channel, SecretKind::SharedKey)
        .await
        .expect("readable")
        .expect("still present")
    {
        SecretValue::SharedKey(key) => assert_eq!(key, [9u8; 32], "save must replace in place"),
        _ => panic!("expected a shared key, got another secret kind"),
    }

    store
        .remove(SECRET_A, channel, SecretKind::SharedKey)
        .await
        .expect("remove");
    assert!(
        store
            .load(SECRET_A, channel, SecretKind::SharedKey)
            .await
            .expect("readable")
            .is_none(),
        "remove must clear the row"
    );
}

/// Every `DeRecStateStore` behaviour the protocol relies on.
///
/// `save` takes only `(secret_id, item)` — the key comes from `item.key()`,
/// so a store must derive it rather than expect one to be passed.
///
/// `state_item` is supplied by the caller because `StateItem`'s variants are
/// protocol internals rather than part of the store contract. `n` must vary
/// the key, so `state_item(1)` and `state_item(2)` are two distinct rows of
/// the same kind.
pub async fn state_store_conforms<S: DeRecStateStore>(
    store: &mut S,
    state_item: impl Fn(u64) -> StateItem,
) {
    let first = state_item(1);
    // `StateKey` is not `Copy`, so each call takes its own clone.
    let key = first.key();
    let kind = key.kind();

    assert!(
        store
            .load(SECRET_A, key.clone())
            .await
            .expect("readable")
            .is_none(),
        "an unsaved item must not load"
    );

    store.save(SECRET_A, first).await.expect("save");

    assert!(
        store
            .load(SECRET_A, key.clone())
            .await
            .expect("readable")
            .is_some(),
        "a saved item loads"
    );

    assert!(
        store
            .load(SECRET_B, key.clone())
            .await
            .expect("readable")
            .is_none(),
        "state must be partitioned by secret_id"
    );

    // Save is upsert on the item's own key.
    store.save(SECRET_A, state_item(1)).await.expect("save");
    assert_eq!(
        store
            .load_all(SECRET_A, kind)
            .await
            .expect("readable")
            .len(),
        1,
        "saving the same key twice must not duplicate it"
    );

    // A second, distinct key is a second row under the same kind.
    store.save(SECRET_A, state_item(2)).await.expect("save");
    assert_eq!(
        store
            .load_all(SECRET_A, kind)
            .await
            .expect("readable")
            .len(),
        2,
        "load_all must return every item of the kind"
    );

    assert!(
        store
            .remove(SECRET_A, key.clone())
            .await
            .expect("remove"),
        "removing a present item reports true"
    );
    assert!(
        !store.remove(SECRET_A, key).await.expect("remove"),
        "removing an absent item reports false"
    );
}
