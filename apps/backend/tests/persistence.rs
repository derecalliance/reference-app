// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

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

use derec_backend::infrastructure::bootstrap::Node;
use derec_backend::infrastructure::db;
use derec_backend::models::Actor;
use derec_backend::models::ActorSettings;
use derec_backend::models::DatabaseUrl;
use derec_backend::models::{Role, TransportMode, UnpairAck};
use derec_backend::repositories::sdk::channel::SqlChannelStore;
use derec_backend::repositories::sdk::conformance::{HIGH_ID, SECRET_A};
use derec_backend::services::ports::{ActorGateway, InboxDirectory};
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
    let url = String::from(DatabaseUrl::from(
        dir.join("derec.db").to_string_lossy().as_ref(),
    ));

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

/// An `Node` over a given pool, as `main` builds one.
fn state_over(pool: sqlx::AnyPool) -> std::sync::Arc<Node> {
    std::sync::Arc::new(Node::new(
        derec_backend::models::NodeConfig::new(
            "http://localhost:5000",
            derec_backend::models::Defaults::default(),
        ),
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
    let url = String::from(DatabaseUrl::from(
        dir.join("derec.db").to_string_lossy().as_ref(),
    ));

    let (actor_id, replica_id) = {
        let pool = db::connect(&url).await.expect("connect");
        let state = state_over(pool);

        let helper = Actor::mint(
            Role::Helper,
            "Alex",
            &state.config.base_url,
            &state.config.grpc_authority(),
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
        state
            .runtime
            .spawn(&helper, &settings)
            .expect("the helper starts");

        (helper.id, settings.replica_id)
    };

    // A new "process": a fresh pool and a fresh state over the same file, with
    // none of the previous one's in-memory maps.
    {
        let pool = db::connect(&url).await.expect("reconnect");
        let state = state_over(pool);

        assert!(
            !state.inboxes.contains(&actor_id),
            "a fresh state starts with no inboxes; otherwise this proves nothing"
        );

        let report = derec_backend::infrastructure::recovery::recover(&state).await;

        assert_eq!(report.helpers, 1, "the helper must be respawned");
        assert_eq!(report.failed, 0, "nothing should fail to recover");
        assert!(
            state.inboxes.contains(&actor_id),
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
    let url = String::from(DatabaseUrl::from(
        dir.join("derec.db").to_string_lossy().as_ref(),
    ));

    let actor_id = {
        let pool = db::connect(&url).await.expect("connect");
        let state = state_over(pool);

        let owner = Actor::mint(
            Role::Owner,
            "Alice",
            &state.config.base_url,
            &state.config.grpc_authority(),
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

        let report = derec_backend::infrastructure::recovery::recover(&state).await;

        assert_eq!(report.browser_actors, 1);
        assert_eq!(
            report.helpers, 0,
            "a browser-run owner must not be respawned as a backend actor"
        );
        assert!(
            (state.inboxes.kind(&actor_id) == Some(derec_backend::models::InboxKind::Browser)),
            "its mailbox must be back, so traffic buffers until the tab reclaims it"
        );
    }

    std::fs::remove_dir_all(&dir).ok();
}

#[actix_rt::test]
async fn a_recovered_helper_routes_grpc_for_channels_paired_before_the_restart() {
    // gRPC carries no actor in its URI, so ingress resolves the actor from the
    // envelope's channel id via the in-memory router. Nothing persists that
    // router, and the pairing events that filled it happened before the
    // restart — so unless recovery re-derives it from the stores, every gRPC
    // helper goes silent after `docker restart` while still listing its
    // channels.
    let dir = std::env::temp_dir().join(format!("derec-restart-grpc-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let url = String::from(DatabaseUrl::from(
        dir.join("derec.db").to_string_lossy().as_ref(),
    ));

    let actor_id = {
        let pool = db::connect(&url).await.expect("connect");
        let state = state_over(pool.clone());

        let helper = Actor::mint(
            Role::Helper,
            "Grace",
            &state.config.base_url,
            &state.config.grpc_authority(),
            TransportMode::Grpc,
        );
        state
            .actors
            .register(
                helper.clone(),
                ActorSettings {
                    replica_id: rand::random::<u64>(),
                    timeout_secs: 300,
                    unpair_ack: UnpairAck::Required,
                },
            )
            .await
            .expect("register");

        // A channel this helper paired before the "process" ended, written
        // where its protocol instance keeps it.
        let secret_id: u64 = helper.secret_id.parse().expect("numeric secret id");
        let mut store = SqlChannelStore::new(pool, helper.id.to_string());
        store
            .save(secret_id, ChannelRecord::Helper(helper_channel(HIGH_ID)))
            .await
            .expect("save channel");

        helper.id
    };

    {
        let pool = db::connect(&url).await.expect("reconnect");
        let state = state_over(pool);
        assert_eq!(
            state.channel_router.resolve(HIGH_ID),
            None,
            "a fresh state starts with no routes; otherwise this proves nothing"
        );

        let report = derec_backend::infrastructure::recovery::recover(&state).await;
        assert_eq!(report.helpers, 1);

        // The respawned actor re-derives its routes on its first tick, which
        // it runs at start rather than a full interval later.
        let mut routed = None;
        for _ in 0..50 {
            routed = state.channel_router.resolve(HIGH_ID);
            if routed.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert_eq!(
            routed,
            Some(actor_id),
            "a channel paired before the restart must route to its helper again"
        );
    }

    std::fs::remove_dir_all(&dir).ok();
}

#[actix_rt::test]
async fn a_node_restarted_on_a_new_address_re_advertises_its_existing_actors() {
    // The address is stored with each actor when it is created. A node first
    // run on `localhost` and then given its LAN address — or a container
    // republished on another port — used to keep advertising the old one for
    // every existing helper, so the whole pool was unreachable.
    let dir = std::env::temp_dir().join(format!("derec-readvertise-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let url = String::from(DatabaseUrl::from(
        dir.join("derec.db").to_string_lossy().as_ref(),
    ));

    let state_at = |pool, base: &str| {
        std::sync::Arc::new(Node::new(
            derec_backend::models::NodeConfig::new(
                base,
                derec_backend::models::Defaults::default(),
            ),
            reqwest::Client::new(),
            actix_rt::Arbiter::current(),
            pool,
        ))
    };

    let actor_id = {
        let pool = db::connect(&url).await.expect("connect");
        let state = state_at(pool, "http://localhost:5000");
        let helper = Actor::mint(
            Role::Helper,
            "Alex",
            &state.config.base_url,
            &state.config.grpc_authority(),
            TransportMode::Both,
        );
        state
            .actors
            .register(
                helper.clone(),
                ActorSettings {
                    replica_id: rand::random::<u64>(),
                    timeout_secs: 300,
                    unpair_ack: UnpairAck::Required,
                },
            )
            .await
            .expect("register");
        helper.id
    };

    let uris = |state: &Node| {
        let state = state.actors.clone();
        async move {
            let actor = state
                .get(&actor_id)
                .await
                .expect("readable")
                .expect("still listed");
            actor
                .transports
                .into_iter()
                .map(|t| t.uri)
                .collect::<Vec<_>>()
        }
    };

    {
        let pool = db::connect(&url).await.expect("reconnect");
        let state = state_at(pool, "http://192.168.0.28:5300");
        let report = derec_backend::infrastructure::recovery::recover(&state).await;

        assert_eq!(report.readvertised, 1);
        assert_eq!(
            report.announce,
            vec![actor_id],
            "a respawned helper whose address moved must be queued to tell its peers"
        );
        assert_eq!(report.browser_readvertised, 0);
        assert_eq!(
            uris(&state).await,
            vec![
                "grpc://192.168.0.28:50051".to_owned(),
                format!("http://192.168.0.28:5300/derec/{actor_id}"),
            ],
            "same mode, new address — in the order provisioning would give it"
        );
    }

    // And it sticks: the next restart at the same address changes nothing.
    {
        let pool = db::connect(&url).await.expect("reconnect again");
        let state = state_at(pool, "http://192.168.0.28:5300");
        let report = derec_backend::infrastructure::recovery::recover(&state).await;
        assert_eq!(report.readvertised, 0);
        assert!(
            report.announce.is_empty(),
            "nothing moved, so nothing to announce"
        );
    }

    std::fs::remove_dir_all(&dir).ok();
}

#[actix_rt::test]
async fn mail_queued_for_a_browser_owner_survives_a_restart() {
    // A browser cannot listen, so its messages wait in the node until the tab
    // polls. They used to wait in process memory, and a restart — or a tab
    // closed across one — lost every reply that had not been collected.
    let dir = std::env::temp_dir().join(format!("derec-restart-mail-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let url = String::from(DatabaseUrl::from(
        dir.join("derec.db").to_string_lossy().as_ref(),
    ));

    let first = vec![0x20, 0x07];
    let second = vec![0x20, 0x08];

    let actor_id = {
        let pool = db::connect(&url).await.expect("connect");
        let state = state_over(pool);

        let owner = Actor::mint(
            Role::Owner,
            "Alice",
            &state.config.base_url,
            &state.config.grpc_authority(),
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
        state.inboxes.register_browser(owner.id);

        for message in [&first, &second] {
            assert_eq!(
                state
                    .state
                    .delivery
                    .dispatch(
                        owner.id,
                        derec_backend::models::Carrier::Http,
                        message.clone(),
                    )
                    .await,
                derec_backend::models::DispatchOutcome::Delivered
            );
        }

        owner.id
    };

    {
        let pool = db::connect(&url).await.expect("reconnect");
        let state = state_over(pool);
        derec_backend::infrastructure::recovery::recover(&state).await;

        let drained = state.mailboxes.drain(&actor_id).await.expect("readable");
        assert_eq!(
            drained,
            vec![first, second],
            "every queued message comes back, in the order it arrived"
        );
        assert!(
            state
                .mailboxes
                .drain(&actor_id)
                .await
                .expect("readable")
                .is_empty(),
            "draining is destructive: each message is delivered once"
        );
    }

    std::fs::remove_dir_all(&dir).ok();
}

#[actix_rt::test]
async fn a_node_restarted_with_grpc_disabled_stops_advertising_grpc() {
    // Nothing listens on the gRPC port once it is disabled, so an endpoint
    // there pairs and then black-holes every reply. A `both` helper keeps its
    // HTTP half; a gRPC-only helper is re-advertised over HTTP.
    let dir = std::env::temp_dir().join(format!("derec-grpc-off-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let url = String::from(DatabaseUrl::from(
        dir.join("derec.db").to_string_lossy().as_ref(),
    ));

    let ids = {
        let pool = db::connect(&url).await.expect("connect");
        let state = state_over(pool);
        let mut ids = Vec::new();
        for mode in [TransportMode::Grpc, TransportMode::Both] {
            let helper = Actor::mint(
                Role::Helper,
                "Grace",
                &state.config.base_url,
                &state.config.grpc_authority(),
                mode,
            );
            state
                .actors
                .register(
                    helper.clone(),
                    ActorSettings {
                        replica_id: rand::random::<u64>(),
                        timeout_secs: 300,
                        unpair_ack: UnpairAck::Required,
                    },
                )
                .await
                .expect("register");
            ids.push(helper.id);
        }
        ids
    };

    {
        let pool = db::connect(&url).await.expect("reconnect");
        let state = std::sync::Arc::new(Node::new(
            derec_backend::models::NodeConfig::new(
                "http://localhost:5000",
                derec_backend::models::Defaults {
                    grpc_enabled: false,
                    ..derec_backend::models::Defaults::default()
                },
            ),
            reqwest::Client::new(),
            actix_rt::Arbiter::current(),
            pool,
        ));

        let report = derec_backend::infrastructure::recovery::recover(&state).await;

        assert_eq!(report.helpers, 2, "both helpers stay in service");
        assert_eq!(report.grpc_dropped, 2);
        for id in ids {
            let actor = state
                .actors
                .get(&id)
                .await
                .expect("readable")
                .expect("listed");
            assert_eq!(
                actor
                    .transports
                    .iter()
                    .map(|t| t.uri.clone())
                    .collect::<Vec<_>>(),
                vec![format!("http://localhost:5000/derec/{id}")],
                "only the endpoint this node serves is advertised"
            );
        }
    }

    std::fs::remove_dir_all(&dir).ok();
}

// ── What a restart used to forget ────────────────────────────────────────────

/// The running actor's address in `state`.
fn running(
    state: &Node,
    actor_id: uuid::Uuid,
) -> actix::Addr<derec_backend::infrastructure::actors::provisioned::ProvisionedActor> {
    state
        .inboxes
        .provisioned(&actor_id)
        .expect("a running actor has an inbox")
}

/// Provision a helper in `mode` over `state`, as `POST /helpers` does.
async fn provision(state: &Node, mode: TransportMode) -> derec_backend::models::Actor {
    let helper = Actor::mint(
        Role::Helper,
        "Alex",
        &state.config.base_url,
        &state.config.grpc_authority(),
        mode,
    );
    let settings = ActorSettings {
        replica_id: rand::random::<u64>(),
        timeout_secs: 300,
        unpair_ack: UnpairAck::Required,
    };
    state
        .actors
        .register(helper.clone(), settings.clone())
        .await
        .expect("register");
    state
        .runtime
        .spawn(&helper, &settings)
        .expect("the helper starts");
    helper
}

async fn mint(
    addr: &actix::Addr<derec_backend::infrastructure::actors::provisioned::ProvisionedActor>,
    replica_for_owner_secret: Option<u64>,
) -> u64 {
    addr.send(
        derec_backend::infrastructure::actors::provisioned::CreateContactMsg {
            contact_mode: derec_proto::ContactMode::InlineKeys,
            nonce: None,
            replica_for_owner_secret,
            attempt: 0,
        },
    )
    .await
    .expect("the actor is alive")
    .expect("a contact is minted")
    .channel_id
}

#[actix_rt::test]
async fn a_helpers_replica_instances_come_back_with_it() {
    // Replica instances are created on demand and recorded nowhere but in the
    // rows they write, so a restart used to bring back only the own instance:
    // every replica channel was then dropped as "no instance owns this
    // channel".
    const OWNER_SECRET: u64 = 0x0A11CE;
    const REPLICA_CHANNEL: u64 = 0xBEEF;

    let dir = std::env::temp_dir().join(format!("derec-restart-replica-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let url = String::from(DatabaseUrl::from(
        dir.join("derec.db").to_string_lossy().as_ref(),
    ));

    let (helper_id, own_secret, contact) = {
        let pool = db::connect(&url).await.expect("connect");
        let state = state_over(pool.clone());
        let helper = provision(&state, TransportMode::Http).await;
        let addr = running(&state, helper.id);

        addr.send(
            derec_backend::infrastructure::actors::provisioned::EnsureReplicaInstanceMsg {
                owner_secret_id: OWNER_SECRET,
            },
        )
        .await
        .expect("the actor is alive")
        .expect("the replica instance is created");
        // A contact the owner has not paired against yet, and a channel it
        // already paired, both on the replica instance.
        let contact = mint(&addr, Some(OWNER_SECRET)).await;
        SqlChannelStore::new(pool, helper.id.to_string())
            .save(
                OWNER_SECRET,
                ChannelRecord::Helper(helper_channel(REPLICA_CHANNEL)),
            )
            .await
            .expect("save channel");

        let own: u64 = helper.secret_id.parse().expect("numeric secret id");
        addr.send(derec_backend::infrastructure::actors::provisioned::ShutdownMsg)
            .await
            .expect("alive");
        (helper.id, own, contact)
    };

    {
        let pool = db::connect(&url).await.expect("reconnect");
        let state = state_over(pool);
        let report = derec_backend::infrastructure::recovery::recover(&state).await;
        assert_eq!(report.helpers, 1);
        assert_eq!(report.replica_instances, 1, "{report:?}");
        assert_eq!(report.contacts, 1, "{report:?}");

        let addr = running(&state, helper_id);
        let mut expected = vec![own_secret, OWNER_SECRET];
        expected.sort_unstable();
        assert_eq!(
            addr.send(derec_backend::infrastructure::actors::provisioned::ListInstanceSecretsMsg)
                .await
                .expect("alive"),
            expected,
            "the replica instance must be running again"
        );

        let owner_of = |channel_id| {
            addr.send(
                derec_backend::infrastructure::actors::provisioned::InstanceForChannelMsg {
                    channel_id,
                },
            )
        };
        assert_eq!(
            owner_of(REPLICA_CHANNEL).await.expect("alive"),
            Some(OWNER_SECRET),
            "a replica channel paired before the restart routes to its instance"
        );
        assert_eq!(
            owner_of(contact).await.expect("alive"),
            Some(OWNER_SECRET),
            "a replica contact minted before the restart routes to its instance"
        );
    }

    std::fs::remove_dir_all(&dir).ok();
}

#[actix_rt::test]
async fn an_open_contact_still_routes_after_a_restart_until_its_lifetime_ends() {
    // A browser starts pairing with a provisioned gRPC helper and the node
    // restarts before its first message lands. The contact was persisted but
    // its routes were not, so the reply was dropped — contradicting the
    // documented one-hour contact lifetime.
    let dir = std::env::temp_dir().join(format!("derec-restart-contact-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let url = String::from(DatabaseUrl::from(
        dir.join("derec.db").to_string_lossy().as_ref(),
    ));

    let (helper_id, own_secret, fresh, expired) = {
        let pool = db::connect(&url).await.expect("connect");
        let state = state_over(pool.clone());
        let helper = provision(&state, TransportMode::Grpc).await;
        let addr = running(&state, helper.id);

        let fresh = mint(&addr, None).await;
        let expired = mint(&addr, None).await;
        // Minted just over an hour ago: past its lifetime.
        let stale = derec_backend::utils::time::now_unix_secs()
            - derec_backend::infrastructure::routing::PIN_TTL.as_secs() as i64
            - 5;
        sqlx::query("UPDATE secrets SET created_at = $1 WHERE channel_id = $2")
            .bind(stale)
            .bind(expired.to_string())
            .execute(&pool)
            .await
            .expect("backdate");

        let own: u64 = helper.secret_id.parse().expect("numeric secret id");
        addr.send(derec_backend::infrastructure::actors::provisioned::ShutdownMsg)
            .await
            .expect("alive");
        (helper.id, own, fresh, expired)
    };

    {
        let pool = db::connect(&url).await.expect("reconnect");
        let state = state_over(pool);
        assert_eq!(
            state.channel_router.resolve(fresh),
            None,
            "proves nothing otherwise"
        );

        let report = derec_backend::infrastructure::recovery::recover(&state).await;
        assert_eq!(report.contacts, 1, "only the live contact: {report:?}");

        // gRPC ingress resolves the actor from the channel id alone.
        assert_eq!(state.channel_router.resolve(fresh), Some(helper_id));
        assert_eq!(state.channel_router.resolve(expired), None);

        // HTTP carries the actor, but the actor still needs the instance.
        let addr = running(&state, helper_id);
        let owner_of = |channel_id| {
            addr.send(
                derec_backend::infrastructure::actors::provisioned::InstanceForChannelMsg {
                    channel_id,
                },
            )
        };
        assert_eq!(owner_of(fresh).await.expect("alive"), Some(own_secret));
        assert_eq!(owner_of(expired).await.expect("alive"), None);
    }

    std::fs::remove_dir_all(&dir).ok();
}

#[actix_rt::test]
async fn every_address_the_node_advertised_survives_the_restart_that_changes_it() {
    // The restart that moves the port is exactly the one that must not forget
    // the old port: peers still hold it.
    let dir = std::env::temp_dir().join(format!("derec-restart-addresses-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let url = String::from(DatabaseUrl::from(
        dir.join("derec.db").to_string_lossy().as_ref(),
    ));

    let helper_id = {
        let pool = db::connect(&url).await.expect("connect");
        let state = std::sync::Arc::new(Node::new(
            derec_backend::models::NodeConfig::new(
                "http://192.168.0.28:8080",
                derec_backend::models::Defaults::default(),
            )
            .with_public_grpc_port(8081),
            reqwest::Client::new(),
            actix_rt::Arbiter::current(),
            pool,
        ));
        let helper = provision(&state, TransportMode::Both).await;
        running(&state, helper.id)
            .send(derec_backend::infrastructure::actors::provisioned::ShutdownMsg)
            .await
            .expect("alive");
        helper.id
    };

    {
        let pool = db::connect(&url).await.expect("reconnect");
        let state = std::sync::Arc::new(Node::new(
            derec_backend::models::NodeConfig::new(
                "http://192.168.0.28:9090",
                derec_backend::models::Defaults::default(),
            )
            .with_public_grpc_port(9091),
            reqwest::Client::new(),
            actix_rt::Arbiter::current(),
            pool,
        ));
        derec_backend::infrastructure::recovery::recover(&state).await;

        use derec_backend::models::OwnTarget;
        assert_eq!(
            state.addresses.own_target("grpc://192.168.0.28:8081"),
            Some(OwnTarget::GrpcListener { served: true }),
            "the old public gRPC port is still this node"
        );
        assert_eq!(
            state
                .addresses
                .own_target(&format!("http://192.168.0.28:8080/derec/{helper_id}")),
            Some(OwnTarget::Actor(helper_id)),
            "and so is the old public HTTP port"
        );
        assert_eq!(state.addresses.own_target("grpc://192.168.0.28:7000"), None);
    }

    std::fs::remove_dir_all(&dir).ok();
}
