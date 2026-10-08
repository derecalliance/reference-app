// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Concurrent writers against a file-backed SQLite database — the default, and
//! what the Docker image runs.
//!
//! Every other registry test runs on `sqlite::memory:`, whose pool holds one
//! connection, so writers there can never overlap and this failure mode is
//! invisible to them. With a file and the real pool size, two transactions that
//! each read before they write used to deadlock on the lock upgrade, and SQLite
//! broke the tie by failing one immediately with `database is locked` — two
//! browser tabs registering at the same moment lost about half their requests.

use std::sync::Arc;

use derec_backend::infrastructure::db;
use derec_backend::models::ActorSettings;
use derec_backend::models::DatabaseUrl;
use derec_backend::models::{Actor, Role, TransportMode, UnpairAck};
use derec_backend::repositories::actors::{ActorRepository, SqlActorRepository};

const WRITERS: usize = 24;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_registrations_on_a_file_database_all_succeed() {
    let dir = std::env::temp_dir().join(format!("derec-concurrent-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let url = String::from(DatabaseUrl::from(
        dir.join("derec.db").to_string_lossy().as_ref(),
    ));

    let pool = db::connect(&url).await.expect("connect");
    let registry = Arc::new(SqlActorRepository::new(pool.clone()));

    // All released together, so the transactions genuinely overlap.
    let start = Arc::new(tokio::sync::Barrier::new(WRITERS));
    let mut writers = Vec::with_capacity(WRITERS);
    for i in 0..WRITERS {
        let registry = Arc::clone(&registry);
        let start = Arc::clone(&start);
        writers.push(tokio::spawn(async move {
            let owner = Actor::mint(
                Role::Owner,
                &format!("Tab {i}"),
                "http://localhost:5000",
                "localhost:50051",
                TransportMode::Http,
            );
            start.wait().await;
            registry
                .register(
                    owner,
                    ActorSettings {
                        replica_id: rand::random::<u64>(),
                        timeout_secs: 300,
                        unpair_ack: UnpairAck::Required,
                    },
                )
                .await
        }));
    }

    let mut failures = Vec::new();
    for writer in writers {
        if let Err(e) = writer.await.expect("writer task") {
            failures.push(e.to_string());
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {WRITERS} concurrent registrations failed: {failures:?}",
        failures.len()
    );

    let listed = registry.all().await.expect("list");
    assert_eq!(
        listed.len(),
        WRITERS,
        "every registration must be persisted"
    );

    pool.close().await;
    std::fs::remove_dir_all(&dir).ok();
}
