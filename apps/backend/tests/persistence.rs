//! State written by one protocol instance is readable by the next one over the
//! same database.
//!
//! Every other test in this repo uses `sqlite::memory:`, which dies with its
//! pool — so none of them can tell a store that persists from one that does
//! not. This one uses a file, drops everything, and reopens.
//!
//! Two levels are covered. The first pair works at the store level, proving a
//! row outlives the pool that wrote it. The second pair works at the *node*
//! level: a helper provisioned by one state is running again under a new one
//! over the same file, keeping the `replica_id` every replica-group membership
//! references — and a browser-run owner gets its mailbox back without being
//! respawned as a backend actor, because its protocol lives in the page.

use derec_backend::conformance::{HIGH_ID, SECRET_A};
use derec_backend::models::{Role, TransportMode, UnpairAck};
use derec_backend::provisioning::{provisioned_actor, spawn_provisioned};
use derec_backend::registry::actors::ActorSettings;
use derec_backend::state::AppState;
use derec_backend::db;
use derec_backend::sql::channel::SqlChannelStore;
use derec_library::protocol::types::ChannelStatus;
use derec_library::protocol::{ChannelQuery, ChannelRecord, DeRecChannelStore, HelperChannel};
use derec_library::types::ChannelId;

const ACTOR: &str = "11111111-1111-1111-1111-111111111111";

fn helper_channel(channel_id: u64) -> HelperChannel {
    HelperChannel {
        channel_id: ChannelId(channel_id),
        // At least one endpoint: the library refuses to load a record whose
        // endpoints were all filtered away.
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

fn query() -> ChannelQuery {
    ChannelQuery::Helper {
        channel_id: ChannelId(HIGH_ID),
    }
}

#[tokio::test]
async fn a_channel_written_before_a_restart_is_there_after_one() {
    let dir = std::env::temp_dir().join(format!("derec-persist-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let url = db::resolve_url(&dir.join("derec.db").to_string_lossy());

    // First "process": write a channel, then drop everything.
    {
        let pool = db::connect(&url).await.expect("first connect");
        let mut store = SqlChannelStore::new(pool.clone(), ACTOR);
        store
            .save(SECRET_A, ChannelRecord::Helper(helper_channel(HIGH_ID)))
            .await
            .expect("save");
        pool.close().await;
    }

    // Second "process": a brand new pool over the same file.
    {
        let pool = db::connect(&url).await.expect("second connect");
        let store = SqlChannelStore::new(pool.clone(), ACTOR);

        let loaded = store
            .load(SECRET_A, query())
            .await
            .expect("readable")
            .expect("the channel must survive the restart");

        match loaded {
            ChannelRecord::Helper(h) => {
                // An id above i64::MAX, so this also pins the TEXT encoding:
                // a bit-cast would come back a different number.
                assert_eq!(h.channel_id.0, HIGH_ID, "the id must survive exactly");
                assert_eq!(h.status, ChannelStatus::Paired);
            }
            ChannelRecord::Replica(_) => panic!("expected a helper record"),
        }
        pool.close().await;
    }

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn an_in_memory_database_deliberately_does_not_survive() {
    // The counterpart, so the test above is known to be measuring persistence
    // rather than something that would pass either way.
    let first = db::connect("sqlite::memory:").await.expect("connect");
    let mut store = SqlChannelStore::new(first.clone(), ACTOR);
    store
        .save(SECRET_A, ChannelRecord::Helper(helper_channel(HIGH_ID)))
        .await
        .expect("save");
    first.close().await;

    let second = db::connect("sqlite::memory:").await.expect("connect");
    let store = SqlChannelStore::new(second.clone(), ACTOR);

    assert!(
        store
            .load(SECRET_A, query())
            .await
            .expect("readable")
            .is_none(),
        "`sqlite::memory:` must forget — that is what it is for"
    );
    second.close().await;
}

/// An `AppState` over a given pool, as `main` builds one.
fn state_over(pool: sqlx::AnyPool) -> std::sync::Arc<AppState> {
    std::sync::Arc::new(AppState::new(
        "http://localhost:5000",
        derec_backend::config::Defaults::default(),
        reqwest::Client::new(),
        actix_rt::Arbiter::current(),
        pool,
    ))
}

#[actix_rt::test]
async fn a_helper_provisioned_before_a_restart_comes_back_with_its_identity() {
    // The point of the phase. A helper is provisioned, the "process" ends, and
    // a new state over the same database rebuilds it — with the same
    // `replica_id`, because every ReplicaMember row in a group references it
    // and a fresh one would make this helper a stranger to its own group.
    let dir = std::env::temp_dir().join(format!("derec-restart-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let url = db::resolve_url(&dir.join("derec.db").to_string_lossy());

    let (actor_id, replica_id) = {
        let pool = db::connect(&url).await.expect("connect");
        let state = state_over(pool);

        let helper = provisioned_actor(
            Role::Helper,
            "Alex",
            &state.base_url,
            &state.grpc_authority(),
            TransportMode::Http,
        );
        let settings = ActorSettings {
            replica_id: u64::MAX - 11,
            timeout_secs: 300,
            unpair_ack: UnpairAck::Required,
        };

        state
            .actors
            .register(helper.clone(), settings.clone())
            .await
            .expect("register");
        spawn_provisioned(&state, &helper, &settings);

        (helper.id, settings.replica_id)
    };

    // A new "process": a fresh pool and a fresh state over the same file, with
    // none of the previous one's in-memory maps.
    {
        let pool = db::connect(&url).await.expect("reconnect");
        let state = state_over(pool);

        assert!(
            !state.actor_inboxes.contains_key(&actor_id),
            "a fresh state starts with no inboxes; otherwise this proves nothing"
        );

        let report = derec_backend::recovery::recover(&state).await;

        assert_eq!(report.helpers, 1, "the helper must be respawned");
        assert_eq!(report.failed, 0, "nothing should fail to recover");
        assert!(
            state.actor_inboxes.contains_key(&actor_id),
            "a respawned helper needs an inbox, or nothing can reach it"
        );

        let settings = state
            .actors
            .settings(&actor_id)
            .await
            .expect("readable")
            .expect("settings survive the restart");
        assert_eq!(
            settings.replica_id, replica_id,
            "the replica id must be the one it had — a fresh one makes this \
             actor a stranger to every group holding its old id"
        );
    }

    std::fs::remove_dir_all(&dir).ok();
}

#[actix_rt::test]
async fn a_browser_run_owner_gets_its_inbox_back_and_is_not_respawned() {
    // A browser-run actor's protocol lives in the page with its own keys, so
    // there is nothing here to rebuild. The inbox still matters: without it,
    // traffic arriving before the tab reclaims the actor is dropped as
    // undeliverable rather than buffered.
    let dir = std::env::temp_dir().join(format!("derec-restart-owner-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let url = db::resolve_url(&dir.join("derec.db").to_string_lossy());

    let actor_id = {
        let pool = db::connect(&url).await.expect("connect");
        let state = state_over(pool);

        let owner = provisioned_actor(
            Role::Owner,
            "Alice",
            &state.base_url,
            &state.grpc_authority(),
            TransportMode::Http,
        );
        state
            .actors
            .register(
                owner.clone(),
                ActorSettings {
                    replica_id: rand::random::<u64>(),
                    timeout_secs: 300,
                    unpair_ack: UnpairAck::Required,
                },
            )
            .await
            .expect("register");

        owner.id
    };

    {
        let pool = db::connect(&url).await.expect("reconnect");
        let state = state_over(pool);

        let report = derec_backend::recovery::recover(&state).await;

        assert_eq!(report.browser_actors, 1);
        assert_eq!(
            report.helpers, 0,
            "a browser-run owner must not be respawned as a backend actor"
        );
        assert!(
            state.browser_receivers.contains_key(&actor_id),
            "its mailbox must be back, so traffic buffers until the tab reclaims it"
        );
    }

    std::fs::remove_dir_all(&dir).ok();
}
