// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The node's SQL repositories for its own state, on every engine available.
//!
//! Follows `tests/sql_stores.rs`: SQLite always, Postgres when
//! `TEST_DATABASE_URL` names one, serialised by a binary-wide lock because a
//! shared Postgres would otherwise let one case truncate another's rows.

use std::sync::Arc;

use derec_backend::infrastructure::db;
use derec_backend::models::{
    Actor, ActorSettings, NewActor, Role, TransportBreakdown, TransportMode, UnpairAck,
};
use derec_backend::repositories::actors::{ActorRepository, SqlActorRepository};
use derec_backend::repositories::browser_contacts::{
    BrowserContactRepository, SqlBrowserContactRepository,
};
use derec_backend::repositories::disabled_helpers::{
    DisabledHelperRepository, SqlDisabledHelperRepository,
};
use derec_backend::services::helpers::plan_shortfall;

fn engines() -> Vec<(&'static str, String)> {
    let mut out = vec![("sqlite", "sqlite::memory:".to_owned())];
    match std::env::var("TEST_DATABASE_URL") {
        Ok(url) if !url.trim().is_empty() => out.push(("postgres", url)),
        _ => eprintln!("SKIPPED postgres: set TEST_DATABASE_URL to run on it too."),
    }
    out
}

async fn on_every_engine<F, Fut>(body: F)
where
    F: Fn(sqlx::AnyPool) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;

    for (label, url) in engines() {
        let pool = db::connect(&url)
            .await
            .unwrap_or_else(|e| panic!("{label}: connect failed: {e}"));

        for table in ["actors", "disabled_helpers", "participant_contacts"] {
            sqlx::query(&format!("DELETE FROM {table}"))
                .execute(&pool)
                .await
                .unwrap_or_else(|e| panic!("clearing {table}: {e}"));
        }

        eprintln!("running against {label}");
        body(pool).await;
    }
}

/// Stock settings for a fixture actor. Individual tests override when the
/// value is what they are asserting on.
fn settings() -> ActorSettings {
    ActorSettings {
        replica_id: rand::random::<u64>(),
        timeout_secs: 300,
        unpair_ack: UnpairAck::Required,
    }
}

fn actor(name: &str, role: Role) -> Actor {
    Actor::mint(
        role,
        name,
        "http://localhost:5000",
        "localhost:50051",
        TransportMode::Http,
    )
}

/// Bring the pool up to `want` through the repository's atomic primitive, the
/// way the helper service does, naming each new helper `{prefix}{taken}`.
async fn ensure(
    registry: &SqlActorRepository,
    want: TransportBreakdown,
    prefix: &str,
) -> (Vec<Actor>, Vec<Actor>) {
    let plan = |roster: &[Actor]| -> Vec<NewActor> {
        plan_shortfall(want, roster, |taken, _pool_index, mode, _pool| {
            let helper = Actor::mint(
                Role::Helper,
                &format!("{prefix}{taken}"),
                "http://localhost:5000",
                "localhost:50051",
                mode,
            );
            (helper, settings())
        })
    };
    let registration = registry.register_planned(&plan).await.expect("ensure");
    let pool = registration
        .roster
        .into_iter()
        .filter(|a| a.role == Role::Helper)
        .collect();
    (registration.registered, pool)
}

#[tokio::test]
async fn registration_order_is_preserved() {
    // The front end polls GET /actors and renders a list; an unordered result
    // reshuffles the roster on every poll. `seq` is what carries this, because
    // `created_at` is too coarse — these three are registered in one second.
    on_every_engine(|pool| async move {
        let registry = SqlActorRepository::new(pool);
        for name in ["first", "second", "third"] {
            registry
                .register(actor(name, Role::Helper), settings())
                .await
                .expect("register");
        }

        let names: Vec<String> = registry
            .all()
            .await
            .expect("readable")
            .into_iter()
            .map(|a| a.name)
            .collect();
        assert_eq!(names, vec!["first", "second", "third"]);
    })
    .await;
}

#[tokio::test]
async fn an_actor_round_trips_with_its_endpoints() {
    on_every_engine(|pool| async move {
        let registry = SqlActorRepository::new(pool);
        let original = actor("Alex", Role::Helper);
        registry
            .register(original.clone(), settings())
            .await
            .expect("register");

        let loaded = registry
            .get(&original.id)
            .await
            .expect("readable")
            .expect("the actor is there");

        assert_eq!(loaded.id, original.id);
        assert_eq!(loaded.name, original.name);
        assert_eq!(loaded.role, original.role);
        assert_eq!(loaded.secret_id, original.secret_id);
        assert_eq!(
            loaded.transports, original.transports,
            "the endpoint list is what the relay allowlist matches on, so it \
             has to survive exactly"
        );
        assert_eq!(
            loaded.transport, original.transport,
            "`transport` is the first of the list"
        );
    })
    .await;
}

#[tokio::test]
async fn an_absent_actor_is_none() {
    on_every_engine(|pool| async move {
        let registry = SqlActorRepository::new(pool);
        assert!(registry
            .get(&uuid::Uuid::new_v4())
            .await
            .expect("readable")
            .is_none());
    })
    .await;
}

#[tokio::test]
async fn a_rename_only_matches_the_role_it_names() {
    // The role is part of the statement, so a helper's id can never rename it
    // through the owner route, however the two requests interleave.
    on_every_engine(|pool| async move {
        let registry = SqlActorRepository::new(pool);
        let helper = actor("Alex", Role::Helper);
        registry
            .register(helper.clone(), settings())
            .await
            .expect("register");

        assert!(!registry
            .rename(&helper.id, Role::Owner, "Bob")
            .await
            .expect("writable"));
        assert!(registry
            .rename(&helper.id, Role::Helper, "Bob")
            .await
            .expect("writable"));
        assert_eq!(
            registry
                .get(&helper.id)
                .await
                .expect("readable")
                .map(|a| a.name),
            Some("Bob".to_owned())
        );
        assert!(!registry
            .rename(&uuid::Uuid::new_v4(), Role::Owner, "Nobody")
            .await
            .expect("writable"));
    })
    .await;
}

#[tokio::test]
async fn ensure_creates_only_the_shortfall() {
    on_every_engine(|pool| async move {
        let registry = SqlActorRepository::new(pool);
        let want = TransportBreakdown {
            http: 3,
            grpc: 0,
            both: 0,
        };

        let (created, participants) = ensure(&registry, want, "h").await;
        assert_eq!(created.len(), 3);
        assert_eq!(participants.len(), 3);

        let (created, participants) = ensure(&registry, want, "x").await;
        assert!(
            created.is_empty(),
            "the pool is already at the target; nothing to create"
        );
        assert_eq!(participants.len(), 3);
    })
    .await;
}

#[tokio::test]
async fn asking_for_fewer_removes_nothing() {
    // Another owner may be paired with one.
    on_every_engine(|pool| async move {
        let registry = SqlActorRepository::new(pool);
        ensure(
            &registry,
            TransportBreakdown {
                http: 3,
                grpc: 0,
                both: 0,
            },
            "h",
        )
        .await;

        let (created, participants) = ensure(
            &registry,
            TransportBreakdown {
                http: 1,
                grpc: 0,
                both: 0,
            },
            "y",
        )
        .await;

        assert!(created.is_empty());
        assert_eq!(participants.len(), 3, "nothing is removed");
    })
    .await;
}

#[tokio::test]
async fn an_owner_is_not_counted_as_a_participant() {
    // The pool is helpers only; an owner sharing the registry must not satisfy
    // a helper target.
    on_every_engine(|pool| async move {
        let registry = SqlActorRepository::new(pool);
        registry
            .register(actor("Alice", Role::Owner), settings())
            .await
            .expect("register");

        let (created, participants) = ensure(
            &registry,
            TransportBreakdown {
                http: 2,
                grpc: 0,
                both: 0,
            },
            "h",
        )
        .await;

        assert_eq!(created.len(), 2, "the owner does not count");
        assert_eq!(participants.len(), 2, "participants are helpers only");
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_requests_for_the_same_size_do_not_double_the_pool() {
    // The reason the count and the create are one step. Two tabs setting up at
    // the same moment would otherwise both observe an empty pool and both
    // fill it.
    let pool = db::connect("sqlite::memory:").await.expect("connect");
    let registry = Arc::new(SqlActorRepository::new(pool));
    let want = TransportBreakdown {
        http: 7,
        grpc: 0,
        both: 0,
    };

    let mut tasks = Vec::new();
    for t in 0..8 {
        let registry = Arc::clone(&registry);
        tasks.push(tokio::spawn(async move {
            ensure(&registry, want, &format!("t{t}-")).await.0.len()
        }));
    }
    let mut total_created = 0;
    for task in tasks {
        total_created += task.await.expect("task");
    }

    assert_eq!(
        total_created, 7,
        "every participant is created exactly once"
    );
    let helpers = registry
        .all()
        .await
        .expect("readable")
        .into_iter()
        .filter(|a| a.role == Role::Helper)
        .count();
    assert_eq!(helpers, 7);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_requests_for_different_sizes_settle_on_the_largest() {
    let pool = db::connect("sqlite::memory:").await.expect("connect");
    let registry = Arc::new(SqlActorRepository::new(pool));

    let mut tasks = Vec::new();
    for want in [3u8, 9, 5, 7] {
        let registry = Arc::clone(&registry);
        tasks.push(tokio::spawn(async move {
            ensure(
                &registry,
                TransportBreakdown {
                    http: want,
                    grpc: 0,
                    both: 0,
                },
                "w",
            )
            .await;
        }));
    }
    for task in tasks {
        task.await.expect("task");
    }

    assert_eq!(registry.all().await.expect("readable").len(), 9);
}

#[tokio::test]
async fn disabling_a_helper_is_a_toggle() {
    on_every_engine(|pool| async move {
        let disabled = SqlDisabledHelperRepository::new(pool);
        let id = uuid::Uuid::new_v4();

        assert!(!disabled.is_disabled(&id).await.expect("readable"));

        disabled.set_disabled(&id, true).await.expect("set");
        assert!(disabled.is_disabled(&id).await.expect("readable"));

        // Setting it twice must not fail on the primary key.
        disabled.set_disabled(&id, true).await.expect("set again");
        assert!(disabled.is_disabled(&id).await.expect("readable"));

        disabled.set_disabled(&id, false).await.expect("clear");
        assert!(!disabled.is_disabled(&id).await.expect("readable"));

        // Clearing an absent one is not an error.
        disabled
            .set_disabled(&id, false)
            .await
            .expect("clear again");
    })
    .await;
}

#[tokio::test]
async fn a_participant_contact_is_read_not_taken() {
    // `GET /helpers/:id/browser-contact` may be polled more than once, and the
    // `DashMap::get` it replaces left the entry in place.
    on_every_engine(|pool| async move {
        let contacts = SqlBrowserContactRepository::new(pool);
        let id = uuid::Uuid::new_v4();

        assert!(contacts.get(&id).await.expect("readable").is_none());

        contacts.put(&id, "contact-one").await.expect("put");
        assert_eq!(
            contacts.get(&id).await.expect("readable").as_deref(),
            Some("contact-one")
        );
        assert_eq!(
            contacts.get(&id).await.expect("readable").as_deref(),
            Some("contact-one"),
            "reading must not consume"
        );

        contacts.put(&id, "contact-two").await.expect("put");
        assert_eq!(
            contacts.get(&id).await.expect("readable").as_deref(),
            Some("contact-two"),
            "a second put replaces"
        );
    })
    .await;
}
