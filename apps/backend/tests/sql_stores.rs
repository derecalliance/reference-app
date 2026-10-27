// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The conformance suite against the SQL stores, on every engine available.
//!
//! SQLite always — it is compiled into the binary, so it needs no service.
//! Postgres only when `TEST_DATABASE_URL` names a reachable database, and it
//! prints a skip otherwise: nobody should need a Postgres running to work on
//! this repo. That is the same bargain `tests/proto_drift.rs` already makes.
//!
//! Each case gets a fresh database. The conformance functions assume an empty
//! store and leave it dirty, so sharing one would make results depend on order.

use derec_backend::infrastructure::db;
use derec_backend::repositories::sdk::conformance;
use derec_backend::repositories::sdk::{
    channel::SqlChannelStore, secret::SqlSecretStore, share::SqlShareStore, state::SqlStateStore,
    user_secret::SqlUserSecretStore,
};
use derec_backend::repositories::sharing_rounds::{
    SharingRoundRepository, SqlSharingRoundRepository,
};
use derec_backend::models::HelperFault;
use derec_backend::repositories::helper_faults::{HelperFaultRepository, SqlHelperFaultRepository};
use derec_library::protocol::{
    CollectedShare, DeRecShareStore, DeRecStateStore, Share, ShareStoreError, StateItem,
};
use derec_library::types::ChannelId;
use prost::Message;

/// A distinct `PendingVerification` item per `n` — the same factory
/// `tests/store_conformance.rs` uses against the in-memory stores, so both
/// engines and both implementations are judged on identical input.
fn state_item(n: u64) -> StateItem {
    StateItem::PendingVerification {
        channel_id: ChannelId(n),
        request: derec_proto::VerifyShareRequestMessage::default(),
    }
}

/// Every engine this run can reach.
///
/// Returns `(label, url)`. SQLite in-memory is always present; the pool is
/// capped at one connection for it, which `db::connect` handles.
fn engines() -> Vec<(&'static str, String)> {
    let mut out = vec![("sqlite", "sqlite::memory:".to_owned())];

    match std::env::var("TEST_DATABASE_URL") {
        Ok(url) if !url.trim().is_empty() => out.push(("postgres", url)),
        _ => eprintln!(
            "SKIPPED postgres: set TEST_DATABASE_URL to a reachable database to \
             run the suite on it as well."
        ),
    }
    out
}

/// Run `body` against a fresh pool for every reachable engine.
///
/// Postgres keeps its tables between runs, so each case clears them; SQLite
/// in-memory is fresh by construction and the clear is a harmless no-op.
async fn on_every_engine<F, Fut>(body: F)
where
    F: Fn(sqlx::AnyPool) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    // Serialised across the whole binary, not just per engine.
    //
    // Every SQLite case gets a private in-memory database, so those are
    // independent whatever the scheduler does. A Postgres URL is one shared
    // database for all five cases, and they run concurrently by default — so
    // without this lock, one case's `reset` truncates another's rows midway
    // through it. That presented as `the_sql_user_secret_store_conforms`
    // failing on Postgres alone while every store was in fact correct.
    //
    // The whole body is held rather than just `reset`, because the window that
    // matters spans the writes and the reads that check them.
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;

    for (label, url) in engines() {
        let pool = db::connect(&url)
            .await
            .unwrap_or_else(|e| panic!("{label}: connect failed: {e}"));

        reset(&pool).await;

        eprintln!("running against {label}");
        body(pool).await;
    }
}

/// Empty every table, so one engine's leftovers cannot pass another's run.
async fn reset(pool: &sqlx::AnyPool) {
    for table in [
        "channels",
        "channel_links",
        "secrets",
        "user_secrets",
        "shares",
        "sharing_rounds",
        "state_items",
        "helper_faults",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("clearing {table}: {e}"));
    }
}

#[tokio::test]
async fn the_sql_channel_store_conforms() {
    on_every_engine(|pool| async move {
        let mut store = SqlChannelStore::new(pool, "actor-a");
        conformance::channel_store_conforms(&mut store).await;
    })
    .await;
}

#[tokio::test]
async fn the_sql_secret_store_conforms() {
    on_every_engine(|pool| async move {
        let mut store = SqlSecretStore::new(pool, "actor-a");
        conformance::secret_store_conforms(&mut store).await;
    })
    .await;
}

#[tokio::test]
async fn the_sql_share_store_conforms() {
    on_every_engine(|pool| async move {
        let mut store = SqlShareStore::new(pool, "actor-a");
        conformance::share_store_conforms(&mut store).await;
    })
    .await;
}

#[tokio::test]
async fn the_sql_user_secret_store_conforms() {
    on_every_engine(|pool| async move {
        let mut store = SqlUserSecretStore::new(pool, "actor-a");
        conformance::user_secret_store_conforms(&mut store).await;
    })
    .await;
}

#[tokio::test]
async fn the_sql_state_store_conforms() {
    on_every_engine(|pool| async move {
        let mut store = SqlStateStore::new(pool, "actor-a");
        conformance::state_store_conforms(&mut store, state_item).await;
    })
    .await;
}

#[tokio::test]
async fn two_instances_over_one_database_do_not_see_each_other() {
    // The regression this exists for: `secret_id` alone is not a partition,
    // because a replica instance is bound to the mirrored owner's secret and
    // two actors can mirror one owner. Caught in the pairing flow first, where
    // it presented as a handshake that never completed.
    on_every_engine(|pool| async move {
        let mut first = SqlChannelStore::new(pool.clone(), "actor-a");
        let mut second = SqlChannelStore::new(pool, "actor-b");
        conformance::channel_stores_are_isolated_per_instance(&mut first, &mut second).await;
    })
    .await;
}

/// `keep_list` answers from the round outcomes the actor recorded, and from
/// nothing else.
///
/// The decision rule itself is unit-tested beside `keep_list_from_rounds`; this
/// covers the part only an engine can get wrong — ids above `i64::MAX`, the
/// upsert, the `version <` bound and the per-actor partition.
#[tokio::test]
async fn the_sql_share_store_keeps_the_versions_it_saw_commit() {
    on_every_engine(|pool| async move {
        let secret = conformance::HIGH_ID;
        // Outcomes are the app's record, written by the actor through the
        // sharing-round repository; the store reads them back.
        let actor_a = uuid::Uuid::new_v4();
        let store = SqlShareStore::new(pool.clone(), actor_a.to_string());
        let other_actor = SqlShareStore::new(pool.clone(), "actor-b");
        let rounds = SqlSharingRoundRepository::new(pool);

        assert_eq!(
            store.keep_list(secret, 1).await.expect("readable"),
            None,
            "with no recorded round, helpers keep everything"
        );

        for (version, committed) in [(1, true), (2, false), (3, true)] {
            rounds
                .record(&actor_a, secret, version, committed)
                .await
                .expect("record");
        }
        assert_eq!(
            store.keep_list(secret, 4).await.expect("readable"),
            Some(vec![1, 3]),
            "every committed version is kept, the abandoned one is not"
        );

        // A second outcome for a version replaces the first.
        rounds
            .record(&actor_a, secret, 3, false)
            .await
            .expect("record");
        assert_eq!(
            store.keep_list(secret, 4).await.expect("readable"),
            Some(vec![1])
        );

        // Version 4 was never distributed here — another member's, say — so
        // whether it committed is unknown.
        assert_eq!(store.keep_list(secret, 5).await.expect("readable"), None);

        assert_eq!(
            other_actor.keep_list(secret, 4).await.expect("readable"),
            None,
            "one actor's rounds must not decide another's keep list"
        );
    })
    .await;
}

/// `PendingRecovery` records the channel each collected share came from
/// (SDK 0.0.7), and a row saved before that field existed still loads — as a
/// recovery with nothing collected, which re-collects its shares.
#[tokio::test]
async fn a_pending_recovery_keeps_its_share_channels_and_an_older_row_still_loads() {
    on_every_engine(|pool| async move {
        let mut store = SqlStateStore::new(pool.clone(), "actor-a");
        let channel = ChannelId(conformance::HIGH_ID);
        let item = StateItem::PendingRecovery {
            secret_id: conformance::SECRET_A,
            version: 3,
            shares: vec![CollectedShare {
                channel_id: channel,
                response: derec_proto::GetShareResponseMessage::default(),
            }],
        };
        let key = item.key();
        store.save(conformance::SECRET_A, item).await.expect("save");

        match store
            .load(conformance::SECRET_A, key.clone())
            .await
            .expect("readable")
        {
            Some(StateItem::PendingRecovery { shares, .. }) => assert_eq!(
                shares.iter().map(|s| s.channel_id).collect::<Vec<_>>(),
                vec![channel],
                "the share's channel must round-trip"
            ),
            other => panic!("expected a pending recovery, got {other:?}"),
        }

        // Rewrite the row the way a 0.0.6 backend wrote it.
        let (json,): (String,) =
            sqlx::query_as("SELECT item FROM state_items WHERE actor_id = 'actor-a'")
                .fetch_one(&pool)
                .await
                .expect("the row exists");
        let mut record: serde_json::Value = serde_json::from_str(&json).expect("the row is JSON");
        let removed = record
            .as_object_mut()
            .and_then(|fields| fields.remove("share_channels"));
        assert!(
            removed.is_some(),
            "the current shape carries share_channels: {json}"
        );
        sqlx::query("UPDATE state_items SET item = $1 WHERE actor_id = 'actor-a'")
            .bind(record.to_string())
            .execute(&pool)
            .await
            .expect("rewrite");

        match store
            .load(conformance::SECRET_A, key)
            .await
            .expect("an older row must still load")
        {
            Some(StateItem::PendingRecovery {
                version, shares, ..
            }) => {
                assert_eq!(version, 3);
                assert!(shares.is_empty(), "an older row re-collects its shares");
            }
            other => panic!("expected a pending recovery, got {other:?}"),
        }
    })
    .await;
}

/// A helper-side share as the SDK stores it: a `StoreShareRequestMessage`
/// wrapping a `CommittedDeRecShare` wrapping the `DeRecShare`.
fn stored_share_bytes() -> Vec<u8> {
    let inner = derec_proto::DeRecShare {
        encrypted_secret: vec![1, 2, 3],
        subshares: vec![derec_proto::de_rec_share::Subshare { x: vec![1], y: vec![9, 9, 9] }],
        secret_id: 20,
        version: 1,
    };
    let committed = derec_proto::CommittedDeRecShare {
        de_rec_share: inner.encode_to_vec(),
        commitment: vec![7; 32],
        ..Default::default()
    };
    derec_proto::StoreShareRequestMessage {
        share: committed.encode_to_vec(),
        version: 1,
        ..Default::default()
    }
    .encode_to_vec()
}

/// A simulated helper fault touches only the shares held for other owners —
/// never the store's own owner-side rows — and only what is read or accepted:
/// clearing it gives back exactly what was stored.
#[tokio::test]
async fn a_simulated_helper_fault_applies_to_shares_held_for_others_only() {
    on_every_engine(|pool| async move {
        const PARTITION: u64 = 10;
        let (held, own) = (ChannelId(7), ChannelId(8));
        let actor = uuid::Uuid::new_v4();
        let mut store = SqlShareStore::new(pool.clone(), actor.to_string());
        let faults = SqlHelperFaultRepository::new(pool);
        let original = stored_share_bytes();

        let share = |secret_id, bytes: Vec<u8>| Share { secret_id, version: 1, bytes, subshares: None, threshold: None };
        store.save(PARTITION, held, share(20, original.clone())).await.expect("save held");
        store.save(PARTITION, own, share(PARTITION, vec![42])).await.expect("save own");
        let secrets_of = |shares: Vec<Share>| shares.into_iter().map(|s| s.secret_id).collect::<Vec<_>>();

        faults.set_fault(&actor, HelperFault::LostShares).await.expect("set");
        assert!(store.load(PARTITION, held, &[1]).await.expect("load").is_empty(), "a lost share is not found");
        assert_eq!(secrets_of(store.load_all(PARTITION, &[held, own]).await.expect("load")), vec![PARTITION]);
        assert_eq!(secrets_of(store.load_many(PARTITION, &[held, own], &[1]).await.expect("load")), vec![PARTITION]);

        faults.set_fault(&actor, HelperFault::CorruptedShares).await.expect("set");
        let corrupted = store.load(PARTITION, held, &[1]).await.expect("load").remove(0).bytes;
        assert_ne!(corrupted, original, "a corrupted share is read back altered");
        let request = derec_proto::StoreShareRequestMessage::decode(corrupted.as_slice()).expect("still decodes");
        let committed = derec_proto::CommittedDeRecShare::decode(request.share.as_slice()).expect("still decodes");
        let inner = derec_proto::DeRecShare::decode(committed.de_rec_share.as_slice()).expect("still decodes");
        assert_eq!(inner.subshares[0].y, vec![9, 9, 0x09 ^ 0xFF], "one subshare byte is flipped");
        assert_eq!(store.load(PARTITION, own, &[1]).await.expect("load")[0].bytes, vec![42], "own rows are untouched");

        faults.set_fault(&actor, HelperFault::RefusesNewShares).await.expect("set");
        let refused = store.save(PARTITION, held, share(20, original.clone())).await;
        assert!(matches!(refused, Err(ShareStoreError::Refused(_))), "a share for another owner is refused");
        store.save(PARTITION, own, share(PARTITION, vec![43])).await.expect("an own row is still written");

        faults.set_fault(&actor, HelperFault::RefusesVerification).await.expect("set");
        let refused = store.record_verification(PARTITION, held, 1).await;
        assert!(matches!(refused, Err(ShareStoreError::Refused(_))), "the challenge is refused");

        faults.set_fault(&actor, HelperFault::None).await.expect("set");
        assert_eq!(store.load(PARTITION, held, &[1]).await.expect("load")[0].bytes, original, "cleared, the stored share is back");
        store.record_verification(PARTITION, held, 1).await.expect("accepted again");
    })
    .await;
}
