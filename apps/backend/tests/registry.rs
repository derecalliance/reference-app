//! The node's registries, on every engine available.
//!
//! Follows `tests/sql_stores.rs`: SQLite always, Postgres when
//! `TEST_DATABASE_URL` names one, serialised by a binary-wide lock because a
//! shared Postgres would otherwise let one case truncate another's rows.

use derec_backend::db;
use derec_backend::models::{Actor, Role, TransportBreakdown, TransportMode};
use derec_backend::models::UnpairAck;
use derec_backend::registry::actors::{ActorSettings, SqlActorRegistry};
use derec_backend::registry::flags::{DisabledHelpers, HelperChannels, ParticipantContacts};
use derec_backend::state::RoleMismatch;

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

        for table in ["actors", "actor_channels", "disabled_helpers", "participant_contacts"] {
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
    derec_backend::provisioning::provisioned_actor(
        role,
        name,
        "http://localhost:5000",
        "localhost:50051",
        TransportMode::Http,
    )
}

#[tokio::test]
async fn registration_order_is_preserved() {
    // The front end polls GET /actors and renders a list; an unordered result
    // reshuffles the roster on every poll. `seq` is what carries this, because
    // `created_at` is too coarse — these three are registered in one second.
    on_every_engine(|pool| async move {
        let registry = SqlActorRegistry::new(pool);
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
        let registry = SqlActorRegistry::new(pool);
        let original = actor("Alex", Role::Helper);
        registry.register(original.clone(), settings()).await.expect("register");

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
        let registry = SqlActorRegistry::new(pool);
        assert!(registry
            .get(&uuid::Uuid::new_v4())
            .await
            .expect("readable")
            .is_none());
        assert!(!registry
            .contains(&uuid::Uuid::new_v4())
            .await
            .expect("readable"));
    })
    .await;
}

#[tokio::test]
async fn a_role_mismatch_is_distinguishable_from_an_absence() {
    // Callers map these onto different status codes.
    on_every_engine(|pool| async move {
        let registry = SqlActorRegistry::new(pool);
        let helper = actor("Alex", Role::Helper);
        registry.register(helper.clone(), settings()).await.expect("register");

        let wrong = registry
            .get_with_role(&helper.id, Role::Owner)
            .await
            .expect("readable");
        assert!(
            matches!(wrong, Err(RoleMismatch::WrongRole { .. })),
            "a helper asked for as an owner is a mismatch, not an absence"
        );

        let absent = registry
            .get_with_role(&uuid::Uuid::new_v4(), Role::Helper)
            .await
            .expect("readable");
        assert!(matches!(absent, Err(RoleMismatch::NotFound)));
    })
    .await;
}

#[tokio::test]
async fn ensure_creates_only_the_shortfall() {
    on_every_engine(|pool| async move {
        let registry = SqlActorRegistry::new(pool);
        let want = TransportBreakdown { http: 3, grpc: 0, both: 0 };

        let first = registry
            .ensure_participants_by_mode(want, |taken, _pool_index, _mode| {
                (actor(&format!("h{taken}"), Role::Helper), settings())
            })
            .await
            .expect("ensure");
        assert_eq!(first.created.len(), 3);
        assert_eq!(first.participants.len(), 3);

        let second = registry
            .ensure_participants_by_mode(want, |taken, _pool_index, _mode| {
                (actor(&format!("x{taken}"), Role::Helper), settings())
            })
            .await
            .expect("ensure");
        assert!(
            second.created.is_empty(),
            "the pool is already at the target; nothing to create"
        );
        assert_eq!(second.participants.len(), 3);
    })
    .await;
}

#[tokio::test]
async fn asking_for_fewer_removes_nothing() {
    // Another owner may be paired with one.
    on_every_engine(|pool| async move {
        let registry = SqlActorRegistry::new(pool);
        registry
            .ensure_participants_by_mode(
                TransportBreakdown { http: 3, grpc: 0, both: 0 },
                |taken, _p, _m| (actor(&format!("h{taken}"), Role::Helper), settings()),
            )
            .await
            .expect("ensure");

        let fewer = registry
            .ensure_participants_by_mode(
                TransportBreakdown { http: 1, grpc: 0, both: 0 },
                |taken, _p, _m| (actor(&format!("y{taken}"), Role::Helper), settings()),
            )
            .await
            .expect("ensure");

        assert!(fewer.created.is_empty());
        assert_eq!(fewer.participants.len(), 3, "nothing is removed");
    })
    .await;
}

#[tokio::test]
async fn an_owner_is_not_counted_as_a_participant() {
    // The pool is helpers only; an owner sharing the registry must not satisfy
    // a helper target.
    on_every_engine(|pool| async move {
        let registry = SqlActorRegistry::new(pool);
        registry
            .register(actor("Alice", Role::Owner), settings())
            .await
            .expect("register");

        let ensured = registry
            .ensure_participants_by_mode(
                TransportBreakdown { http: 2, grpc: 0, both: 0 },
                |taken, _p, _m| (actor(&format!("h{taken}"), Role::Helper), settings()),
            )
            .await
            .expect("ensure");

        assert_eq!(ensured.created.len(), 2, "the owner does not count");
        assert_eq!(ensured.participants.len(), 2, "participants are helpers only");
    })
    .await;
}

#[tokio::test]
async fn helper_channels_are_per_actor_and_idempotent() {
    on_every_engine(|pool| async move {
        let channels = HelperChannels::new(pool);
        let a = uuid::Uuid::new_v4();
        let b = uuid::Uuid::new_v4();

        assert!(channels.get(&a).await.expect("readable").is_empty());

        channels.push(&a, "111").await.expect("push");
        channels.push(&a, "222").await.expect("push");
        // The pairing path can run twice for one channel; the old `Vec` grew a
        // duplicate where this must not.
        channels.push(&a, "111").await.expect("push");

        let mut got = channels.get(&a).await.expect("readable");
        got.sort();
        assert_eq!(got, vec!["111", "222"]);

        assert!(
            channels.get(&b).await.expect("readable").is_empty(),
            "channels must be per actor"
        );

        channels.remove(&a, "111").await.expect("remove");
        assert_eq!(channels.get(&a).await.expect("readable"), vec!["222"]);
    })
    .await;
}

#[tokio::test]
async fn disabling_a_helper_is_a_toggle() {
    on_every_engine(|pool| async move {
        let disabled = DisabledHelpers::new(pool);
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
        disabled.set_disabled(&id, false).await.expect("clear again");
    })
    .await;
}

#[tokio::test]
async fn a_participant_contact_is_read_not_taken() {
    // `GET /helpers/:id/browser-contact` may be polled more than once, and the
    // `DashMap::get` it replaces left the entry in place.
    on_every_engine(|pool| async move {
        let contacts = ParticipantContacts::new(pool);
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
