//! The conformance suite against the SQL stores, on every engine available.
//!
//! SQLite always — it is compiled into the binary, so it needs no service.
//! Postgres only when `TEST_DATABASE_URL` names a reachable database, and it
//! prints a skip otherwise: nobody should need a Postgres running to work on
//! this repo. That is the same bargain `tests/proto_drift.rs` already makes.
//!
//! Each case gets a fresh database. The conformance functions assume an empty
//! store and leave it dirty, so sharing one would make results depend on order.

use derec_backend::conformance;
use derec_backend::db;
use derec_backend::sql::{
    channel::SqlChannelStore, secret::SqlSecretStore, share::SqlShareStore, state::SqlStateStore,
    user_secret::SqlUserSecretStore,
};
use derec_library::protocol::StateItem;
use derec_library::types::ChannelId;

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
        "state_items",
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
