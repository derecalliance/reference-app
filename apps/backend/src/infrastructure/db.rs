// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Reaching the database: which URL, opened how, migrated when.
//!
//! One `AnyPool` over SQLite or Postgres. The scheme in the URL picks the
//! engine — there is deliberately no `database_type` setting, because a second
//! setting could only ever contradict the URL.

use sqlx::any::{install_default_drivers, AnyPoolOptions};

use crate::models::DatabaseUrl;

/// Why the database could not be reached or prepared.
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("could not connect to {url}: {source}")]
    Connect {
        /// Already redacted — this string reaches logs.
        url: String,
        #[source]
        source: sqlx::Error,
    },
    #[error("could not apply migrations to {url}: {source}")]
    Migrate {
        url: String,
        #[source]
        source: sqlx::migrate::MigrateError,
    },
    #[error("the database at {url} opened but cannot be written to: {source}")]
    ReadOnly {
        url: String,
        #[source]
        source: sqlx::Error,
    },
}

impl DbError {
    /// What usually causes this, when the cause is local enough to name.
    ///
    /// Only for file-backed SQLite: a Postgres connection failure has too many
    /// causes for a guess to help, while a SQLite file that cannot be opened or
    /// written is nearly always ownership, permissions, or a read-only mount.
    pub fn hint(&self, database_url: &str) -> Option<String> {
        let url = DatabaseUrl::from(database_url);
        let path = sqlite_file_path(&url)?;

        // First, because it is the cause behind both hints below and neither
        // fixes it: SQLite creates a missing *file* under `mode=rwc` but never
        // the directory it goes in, so "add ?mode=rwc" still fails and the
        // permissions guess sends people chowning a directory that is not
        // there.
        if matches!(self, Self::Connect { .. }) {
            if let Some(parent) = missing_parent(path) {
                return Some(format!(
                    "the directory {parent} does not exist, and SQLite never creates the \
                     directory a database goes in (only the file, with mode=rwc). Create it \
                     (mkdir -p {parent}), mount a volume there, or set DEREC_DATABASE_URL to \
                     a path in a directory that exists."
                ));
            }
        }

        // Checked before the permission guess below, which SQLite's "unable to
        // open database file" would otherwise trigger: an explicit `sqlite:`
        // URL opens read-write *without* create unless it says `mode=rwc`, so
        // a file that is simply not there yet fails exactly like one the
        // process may not open. Blaming permissions sent people chowning
        // directories that were fine.
        if matches!(self, Self::Connect { .. }) && missing_and_not_creatable(url.as_str(), path) {
            return Some(format!(
                "{path} does not exist, and this URL does not let SQLite create it. Append \
                 ?mode=rwc (sqlite://{path}?mode=rwc), or set DEREC_DATABASE_URL to the bare \
                 path ({path}), which creates the file on first boot."
            ));
        }

        let text = match self {
            Self::Connect { source, .. } | Self::ReadOnly { source, .. } => source.to_string(),
            Self::Migrate { source, .. } => source.to_string(),
        };
        let lowered = text.to_ascii_lowercase();
        let about_access = matches!(self, Self::ReadOnly { .. })
            || [
                "readonly",
                "read-only",
                "unable to open",
                "permission",
                "access",
            ]
            .iter()
            .any(|needle| lowered.contains(needle));
        if !about_access {
            return None;
        }

        let user = match current_uid() {
            Some(uid) => format!("this process runs as uid {uid}"),
            None => "check which user this process runs as".to_owned(),
        };
        Some(format!(
            "the server must be able to create and write {path} and the directory it is in \
             (SQLite writes a journal file beside it); {user}, and the image runs as uid \
             10001. Usual causes: a bind-mounted host directory owned by another user \
             (chown -R 10001 it on the host, or run with --user matching its owner), a volume \
             mounted :ro, or a read-only filesystem. Set DEREC_DATABASE_URL to a writable \
             path, or to sqlite::memory: for a throwaway node."
        ))
    }
}

/// Open a pool and bring the schema up to date.
///
/// `install_default_drivers` is what teaches `AnyPool` the `sqlite:` and
/// `postgres:` schemes; without it every URL fails with a driver-not-found
/// error that names neither. It is idempotent, so calling it per connect is
/// safe and keeps the requirement next to the code that needs it.
///
/// Migrations run on every boot. `sqlx::migrate!` embeds the files in the
/// binary at compile time — the image carries no `migrations/` directory — and
/// records what it has applied, so an existing database is left alone.
pub async fn connect(database_url: &str) -> Result<sqlx::AnyPool, DbError> {
    install_default_drivers();

    let url = DatabaseUrl::from(database_url);
    let safe = url.to_string();

    // An in-memory SQLite database belongs to its *connection*, not to the
    // process: a second pooled connection opens a second, empty database. So
    // migrations would run on one connection and every query after it could
    // land on another that has no tables. Capping the pool at one connection
    // is what makes `sqlite::memory:` behave like a database rather than like
    // a handful of unrelated ones.
    //
    // This costs nothing elsewhere — an ephemeral node is a single-developer
    // scratch node by definition.
    let ephemeral = url.is_ephemeral();
    let max_connections = if ephemeral { 1 } else { 5 };

    let mut options = AnyPoolOptions::new().max_connections(max_connections);

    if ephemeral {
        // Capping the pool at one connection is not enough on its own: that one
        // connection *is* the database, and sqlx recycles connections on its own
        // schedule — `idle_timeout` defaults to 10 minutes and `max_lifetime` to
        // 30. When it closes this one and opens a replacement, the replacement is
        // a brand-new, empty in-memory database, and every query from then on
        // fails with `no such table: actors`.
        //
        // That is not theoretical: a 30-minute end-to-end run produced 83 of
        // those errors, all after the ten-minute mark, on a node that had been
        // serving happily until then. Short runs never reach the timeout, which
        // is what made it look intermittent.
        //
        // `test_before_acquire` is the same hazard reached by cancellation. sqlx
        // pings an idle connection *after* taking it out of the pool, and if the
        // acquiring future is dropped during that await, the connection is
        // dropped with it — closed, not returned. Futures are dropped like that
        // routinely here: a browser hanging up mid-request drops its handler,
        // and deleting a helper stops its actor along with the call it had in
        // flight. An e2e run lost every table half a second after such a
        // deletion. Without the ping, acquiring an idle connection never
        // awaits, so there is no point at which it can be dropped in hand. The
        // ping has nothing to detect anyway: there is no server to hang up.
        options = options
            .idle_timeout(None)
            .max_lifetime(None)
            .test_before_acquire(false);
    }

    let pool = options
        .connect(url.as_str())
        .await
        .map_err(|source| DbError::Connect {
            url: safe.clone(),
            source,
        })?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .map_err(|source| DbError::Migrate {
            url: safe.clone(),
            source,
        })?;

    ensure_writable(&pool)
        .await
        .map_err(|source| DbError::ReadOnly { url: safe, source })?;

    Ok(pool)
}

/// Prove the database accepts writes, leaving no trace.
///
/// Migrations do not: on a database that is already up to date they only
/// read, so a read-only file — a volume mounted `:ro`, a bind mount owned by
/// another uid — opens, migrates, answers `/health`, and then fails the first
/// pairing with `attempt to write a readonly database`, far from the cause.
/// SQLite even opens such a file without complaint, silently falling back to
/// read-only mode.
///
/// On SQLite the probe rewrites `user_version` to the value it already holds,
/// inside a rolled-back transaction. That is a real page write, so it needs
/// both the write lock and the rollback journal beside the file — which is
/// what catches a writable file in an unwritable directory too. sqlx tracks
/// migrations in its own table, not in `user_version`, so nothing reads the
/// value it touches. On Postgres a no-op `UPDATE` is enough: a read-only
/// session or a missing grant rejects it before looking at any row.
pub async fn ensure_writable(pool: &sqlx::AnyPool) -> Result<(), sqlx::Error> {
    let sqlite = pool.connect_options().database_url.scheme() == "sqlite";
    let mut tx = crate::repositories::begin_write(pool).await?;

    if sqlite {
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&mut *tx)
            .await?;
        sqlx::query(&format!("PRAGMA user_version = {version}"))
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query("UPDATE _sqlx_migrations SET version = version WHERE version < 0")
            .execute(&mut *tx)
            .await?;
    }

    tx.rollback().await
}

/// The file a SQLite URL names, if it names one.
fn sqlite_file_path(url: &DatabaseUrl) -> Option<&str> {
    if url.is_ephemeral() {
        return None;
    }
    let url = url.as_str();
    let rest = url
        .strip_prefix("sqlite://")
        .or_else(|| url.strip_prefix("sqlite:"))?;
    let path = rest.split('?').next().unwrap_or(rest);
    (!path.is_empty()).then_some(path)
}

/// The directory `path` would live in, when that directory does not exist.
///
/// `None` for a bare file name, which lives in the working directory.
fn missing_parent(path: &str) -> Option<String> {
    let parent = std::path::Path::new(path).parent()?;
    if parent.as_os_str().is_empty() || parent.exists() {
        return None;
    }
    Some(parent.display().to_string())
}

/// Whether `path` is absent and `url` would not create it.
///
/// Only `mode=rwc` creates a missing file; SQLite's default for an explicit
/// URL, and `mode=rw`/`mode=ro`, open an existing one or fail.
fn missing_and_not_creatable(url: &str, path: &str) -> bool {
    let creates = url
        .split_once('?')
        .map(|(_, query)| query.split('&').any(|param| param == "mode=rwc"))
        .unwrap_or(false);
    !creates && !std::path::Path::new(path).exists()
}

/// The uid this process runs as, where the platform says so cheaply.
///
/// Read from procfs rather than through `libc::getuid`, which would be a new
/// dependency for one diagnostic line. The container is Linux, which is the
/// case that matters; elsewhere the hint simply omits it.
fn current_uid() -> Option<u32> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    status
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))
        .and_then(|ids| ids.split_whitespace().next())
        .and_then(|uid| uid.parse().ok())
}

/// Say clearly, once, that this node forgets everything when it stops.
///
/// Deliberately several lines and deliberately `warn`: the audience is a
/// developer scrolling `docker logs`, who will not infer the consequences from
/// seeing `sqlite::memory:` in a settings dump. Every actor, pairing, share and
/// vault on this node is gone on restart, and a browser that reconnects
/// afterwards will be holding channel state for peers the node no longer has.
pub fn warn_if_ephemeral(database_url: &str) {
    if !DatabaseUrl::from(database_url).is_ephemeral() {
        return;
    }
    tracing::warn!("╔══════════════════════════════════════════════════════════════════════╗");
    tracing::warn!("║  EPHEMERAL DATABASE — this node keeps nothing across a restart.      ║");
    tracing::warn!("║                                                                      ║");
    tracing::warn!("║  DEREC_DATABASE_URL names an in-memory SQLite database, so every     ║");
    tracing::warn!("║  actor, pairing, share and vault is lost when this process stops.    ║");
    tracing::warn!("║  A browser that reconnects after a restart will still hold channel   ║");
    tracing::warn!("║  state for peers this node no longer knows, and its flows will fail  ║");
    tracing::warn!("║  in ways that look like protocol bugs but are not.                   ║");
    tracing::warn!("║                                                                      ║");
    tracing::warn!("║  State can also vanish mid-run: the database lives in one pooled     ║");
    tracing::warn!("║  connection, and if that connection is ever dropped and reopened     ║");
    tracing::warn!("║  the replacement starts empty. Use this for short scratch sessions   ║");
    tracing::warn!("║  only.                                                               ║");
    tracing::warn!("║                                                                      ║");
    tracing::warn!("║  For anything you expect to survive, set DEREC_DATABASE_URL to a     ║");
    tracing::warn!("║  file path — e.g. /var/lib/derec/derec.db, which the image mounts.   ║");
    tracing::warn!("╚══════════════════════════════════════════════════════════════════════╝");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sqlite_url_yields_its_file_path_and_memory_yields_none() {
        assert_eq!(
            sqlite_file_path(&DatabaseUrl::from(
                "sqlite:///var/lib/derec/derec.db?mode=rwc"
            )),
            Some("/var/lib/derec/derec.db")
        );
        assert_eq!(
            sqlite_file_path(&DatabaseUrl::from("sqlite://./derec.db")),
            Some("./derec.db")
        );
        assert_eq!(
            sqlite_file_path(&DatabaseUrl::from("sqlite::memory:")),
            None
        );
        assert_eq!(
            sqlite_file_path(&DatabaseUrl::from("postgres://db/derec")),
            None
        );
    }

    /// A database that opens but cannot be written must not come up healthy.
    ///
    /// `mode=ro` stands in for the real-world causes — a `:ro` volume, a bind
    /// mount owned by another uid — because SQLite treats them the same way:
    /// it opens the file read-only without complaint. Without the probe, a
    /// migrated database in that state connected cleanly and failed only at
    /// the first write.
    #[tokio::test]
    async fn a_read_only_database_is_refused_at_connect() {
        let path = std::env::temp_dir().join(format!("derec-ro-{}.db", uuid::Uuid::new_v4()));
        let path_text = path.to_string_lossy().into_owned();

        // Create and migrate it writable first, so the read-only open below
        // has nothing left to migrate and only the probe can catch it.
        let pool = connect(&path_text).await.expect("a writable file connects");
        pool.close().await;

        let read_only = format!("sqlite://{path_text}?mode=ro");
        let outcome = connect(&read_only).await;

        let _ = std::fs::remove_file(&path);
        assert!(
            outcome.is_err(),
            "a read-only database must fail at connect, not at the first write"
        );
    }

    /// `sqlite:///path/x.db` for a file that is not there yet fails with
    /// SQLite's "unable to open database file" — the same words a permission
    /// problem produces. The hint must point at the missing `mode=rwc`.
    #[tokio::test]
    async fn a_missing_file_without_mode_rwc_is_hinted_as_missing_not_unwritable() {
        let path = std::env::temp_dir().join(format!("derec-missing-{}.db", uuid::Uuid::new_v4()));
        let url = format!("sqlite://{}", path.to_string_lossy());

        let error = connect(&url)
            .await
            .expect_err("a missing file without rwc cannot open");
        let hint = error.hint(&url).expect("a file-backed failure gets a hint");

        assert!(hint.contains("does not exist"), "{hint}");
        assert!(hint.contains("?mode=rwc"), "{hint}");
        assert!(
            !hint.contains("uid"),
            "permissions are not the cause: {hint}"
        );
        assert!(!path.exists(), "nothing may have been created on the way");
    }

    /// A file in a directory that does not exist cannot be created by any
    /// mode. The hint used to blame permissions under `mode=rwc` and suggest
    /// `mode=rwc` under `mode=rw` — neither of which helps.
    #[tokio::test]
    async fn a_missing_directory_is_named_whatever_the_mode() {
        let dir = std::env::temp_dir().join(format!("derec-nodir-{}", uuid::Uuid::new_v4()));
        let file = dir.join("derec.db");
        let path = file.to_string_lossy();

        for url in [
            format!("sqlite://{path}?mode=rwc"),
            format!("sqlite://{path}?mode=rw"),
            format!("sqlite://{path}"),
            path.to_string(),
        ] {
            let error = connect(&url)
                .await
                .expect_err("nothing can open a file in a missing directory");
            let hint = error.hint(&url).expect("a file-backed failure gets a hint");

            assert!(hint.contains("directory"), "{url}: {hint}");
            assert!(hint.contains(&dir.display().to_string()), "{url}: {hint}");
            assert!(
                !hint.contains("uid"),
                "permissions are not the cause: {hint}"
            );
            assert!(
                !hint.contains("Append"),
                "mode=rwc would not fix it: {hint}"
            );
        }
        assert!(!dir.exists(), "nothing may have been created on the way");
    }

    #[test]
    fn a_bare_file_name_has_no_missing_directory() {
        assert_eq!(missing_parent("derec.db"), None);
        assert_eq!(missing_parent("/"), None);
        assert_eq!(
            missing_parent("/nonexistent-derec-dir/derec.db"),
            Some("/nonexistent-derec-dir".to_owned())
        );
    }

    #[test]
    fn only_mode_rwc_counts_as_creating_the_file() {
        let absent = "/nonexistent/derec-hint-test.db";
        assert!(missing_and_not_creatable(
            &format!("sqlite://{absent}"),
            absent
        ));
        assert!(missing_and_not_creatable(
            &format!("sqlite://{absent}?mode=rw"),
            absent
        ));
        assert!(!missing_and_not_creatable(
            &format!("sqlite://{absent}?cache=shared&mode=rwc"),
            absent
        ));
    }

    /// The regression test for the bug that made a long run collapse.
    ///
    /// An in-memory database lives in its connection, so recycling that
    /// connection silently swaps in an empty one. sqlx recycles on a timer by
    /// default, which is why this only ever bit runs long enough to reach it.
    /// Asserting the schema is still there after a round-trip through the pool
    /// is the closest thing to proving the connection was not replaced.
    #[tokio::test]
    async fn an_ephemeral_pool_keeps_its_schema_across_reacquisitions() {
        let pool = connect("sqlite::memory:")
            .await
            .expect("in-memory connects");

        for _ in 0..5 {
            // Each iteration returns the connection to the pool and takes it
            // again; a pool that opened a fresh connection would have no tables.
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM actors")
                .fetch_one(&pool)
                .await
                .expect("the actors table survives reacquisition");
            assert_eq!(count, 0);
        }
    }

    /// The regression test for the participants e2e run that lost every
    /// table right after a helper was deleted.
    ///
    /// Deleting a helper stops its actor, which drops whatever call the actor
    /// had in flight; a browser that hangs up mid-request drops its handler
    /// the same way. If that call was inside `acquire()` while sqlx pinged the
    /// idle connection (`test_before_acquire`), the checked-out connection was
    /// dropped with it — and for an in-memory database, so was every table.
    ///
    /// `biased` polls the acquire exactly once, which parks it on that ping,
    /// and the ready branch then drops it there.
    #[tokio::test]
    async fn an_ephemeral_pool_survives_an_acquire_cancelled_mid_flight() {
        let pool = connect("sqlite::memory:")
            .await
            .expect("in-memory connects");

        for _ in 0..5 {
            tokio::select! {
                biased;
                _ = pool.acquire() => {}
                () = std::future::ready(()) => {}
            }
            // Let the pool's own spawned bookkeeping run, as it would between
            // two requests on a live node.
            tokio::task::yield_now().await;
        }

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM actors")
            .fetch_one(&pool)
            .await
            .expect("the actors table survives a cancelled acquire");
        assert_eq!(count, 0);
    }
}
