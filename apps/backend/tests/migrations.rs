// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The migration set has to apply cleanly to an empty database and be safe to
//! run again on a database that already has it — which is what every restart
//! does.
//!
//! SQLite in-memory only. The Postgres run is opt-in and arrives in Phase 4
//! with the SQL stores; nobody should need a Postgres to work on this repo.

use derec_backend::infrastructure::db;
use derec_backend::models::DatabaseUrl;

#[tokio::test]
async fn migrations_apply_to_an_empty_database() {
    let pool = db::connect("sqlite::memory:")
        .await
        .expect("an in-memory database always connects");

    // Every table the schema declares must exist afterwards.
    for table in [
        "channels",
        "channel_links",
        "secrets",
        "user_secrets",
        "shares",
        "sharing_rounds",
        "state_items",
        "actors",
        "actor_channels",
        "disabled_helpers",
        "participant_contacts",
        "mailbox",
    ] {
        let sql = format!("SELECT COUNT(*) FROM {table}");
        sqlx::query(&sql)
            .fetch_one(&pool)
            .await
            .unwrap_or_else(|e| panic!("table {table} is missing or unreadable: {e}"));
    }
}

#[tokio::test]
async fn connecting_twice_to_the_same_database_does_not_re_run_migrations() {
    // A restart against an existing volume takes this path. `sqlx::migrate!`
    // records what it has applied, so the second call must be a no-op rather
    // than a duplicate-table error.
    let dir = std::env::temp_dir().join(format!("derec-migr-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let path = dir.join("derec.db");
    let url = String::from(DatabaseUrl::from(path.to_string_lossy().as_ref()));

    let first = db::connect(&url).await.expect("first connect");
    drop(first);

    let second = db::connect(&url)
        .await
        .expect("second connect must succeed");
    drop(second);

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn an_in_memory_database_is_one_database_rather_than_one_per_connection() {
    // An in-memory SQLite database belongs to its connection. Without a pool
    // capped at one, a write and the read that follows it can land on two
    // different empty databases — which presents as "no such table" long after
    // migrations reported success.
    let pool = db::connect("sqlite::memory:").await.expect("connects");

    sqlx::query("INSERT INTO disabled_helpers (actor_id) VALUES ('a')")
        .execute(&pool)
        .await
        .expect("insert");

    // Deliberately a second round trip, which is where a multi-connection pool
    // would hand back a different database.
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM disabled_helpers")
        .fetch_one(&pool)
        .await
        .expect("count");

    assert_eq!(count, 1, "a write must be visible to the next read");
}

#[tokio::test]
async fn an_unreachable_database_is_an_error_rather_than_a_panic() {
    // A directory that does not exist, so SQLite cannot create the file.
    let result = db::connect("sqlite:///nonexistent-directory-here/derec.db?mode=rwc").await;

    assert!(result.is_err(), "expected an error, got a pool");
}

#[tokio::test]
async fn two_actors_cannot_share_a_registration_position() {
    // `seq` is the roster order. Two rows at one position would render in an
    // arbitrary order, so the schema refuses the second rather than storing it.
    let pool = db::connect("sqlite::memory:").await.expect("connects");

    insert_at_position_one(&pool, "a")
        .await
        .expect("the first actor takes position 1");
    assert!(
        insert_at_position_one(&pool, "b").await.is_err(),
        "a second actor at the same position must be refused"
    );
}

async fn insert_at_position_one(pool: &sqlx::AnyPool, actor_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO actors \
         (actor_id, seq, role, name, secret_id, transports, \
          replica_id, timeout_secs, unpair_ack, created_at) \
         VALUES ($1, 1, 'owner', 'n', '1', '[]', '1', 300, 'required', 1)",
    )
    .bind(actor_id.to_owned())
    .execute(pool)
    .await
    .map(|_| ())
}
