//! Reaching the database: which URL, opened how, migrated when.
//!
//! One `AnyPool` over SQLite or Postgres. The scheme in the URL picks the
//! engine — there is deliberately no `database_type` setting, because a second
//! setting could only ever contradict the URL.

use sqlx::any::{AnyPoolOptions, install_default_drivers};

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

    let url = resolve_url(database_url);
    let safe = redact_url(&url);

    // An in-memory SQLite database belongs to its *connection*, not to the
    // process: a second pooled connection opens a second, empty database. So
    // migrations would run on one connection and every query after it could
    // land on another that has no tables. Capping the pool at one connection
    // is what makes `sqlite::memory:` behave like a database rather than like
    // a handful of unrelated ones.
    //
    // This costs nothing elsewhere — an ephemeral node is a single-developer
    // scratch node by definition.
    let max_connections = if is_in_memory(&url) { 1 } else { 5 };

    let pool = AnyPoolOptions::new()
        .max_connections(max_connections)
        .connect(&url)
        .await
        .map_err(|source| DbError::Connect {
            url: safe.clone(),
            source,
        })?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .map_err(|source| DbError::Migrate { url: safe, source })?;

    Ok(pool)
}

/// Where the database lives when nothing says otherwise.
///
/// Relative, so `cargo run` works in a fresh checkout with no configuration —
/// the primary way this repo is developed, and the e2e harness starts the
/// backend exactly that way.
///
/// The container does **not** rely on this: the image sets
/// `DEREC_DATABASE_URL=/var/lib/derec/derec.db` explicitly, under its `VOLUME`,
/// which is what makes an unconfigured `docker run` survive a restart. Putting
/// that absolute path here instead would make the image case work by default
/// and the local case fail by default — the wrong way round, since the image
/// is the one that can state its own environment.
pub const DEFAULT_DATABASE_URL: &str = "derec.db";

/// Turn an operator-supplied `database_url` into a connection string.
///
/// | Input | Result |
/// | --- | --- |
/// | empty | the default, resolved as a bare path |
/// | `sqlite::memory:` | passed through — an explicitly ephemeral node |
/// | contains `://` | passed through untouched |
/// | anything else | a bare path; `sqlite://<path>?mode=rwc` |
///
/// `mode=rwc` is on the derived form only. A URL the operator spelled out is
/// theirs, including the absence of a mode.
pub fn resolve_url(raw: &str) -> String {
    let trimmed = raw.trim();

    if trimmed.is_empty() {
        return resolve_url(DEFAULT_DATABASE_URL);
    }
    // Checked before `://` so the in-memory spelling, which has no authority
    // component, is not mistaken for a bare path.
    if trimmed.starts_with("sqlite:") || trimmed.contains("://") {
        return trimmed.to_owned();
    }
    format!("sqlite://{trimmed}?mode=rwc")
}

/// Whether this URL names an in-memory SQLite database.
///
/// Both spellings count: the bare `sqlite::memory:` and the `mode=memory`
/// query parameter a tuned URL may use instead.
fn is_in_memory(url: &str) -> bool {
    url.contains(":memory:") || url.contains("mode=memory")
}

/// Replace the password in a URL's credentials with `***`.
///
/// Hand-written rather than via a URL parser: this runs on a value that may be
/// malformed — that is often *why* it is being logged — and a parser that
/// rejects the input would suppress the line that explains the failure.
///
/// Only the section between `://` and the first `@` is considered, so a colon
/// in a host, port, path or query is untouched.
pub fn redact_url(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_owned();
    };
    let Some((credentials, host)) = rest.split_once('@') else {
        return url.to_owned();
    };
    let Some((user, _password)) = credentials.split_once(':') else {
        return url.to_owned();
    };
    format!("{scheme}://{user}:***@{host}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_path_becomes_a_sqlite_url_that_may_create_the_file() {
        // `mode=rwc` is the difference between a fresh container booting and a
        // fresh container failing on a database nobody has created yet.
        assert_eq!(resolve_url("./derec.db"), "sqlite://./derec.db?mode=rwc");
        assert_eq!(
            resolve_url("/var/lib/derec/derec.db"),
            "sqlite:///var/lib/derec/derec.db?mode=rwc"
        );
    }

    #[test]
    fn anything_with_a_scheme_is_passed_through_untouched() {
        // A tuned SQLite URL and a Postgres URL arrive the same way: the
        // operator has spelled out what they want and we must not edit it.
        for url in [
            "postgres://user:pw@db:5432/derec",
            "postgresql://db/derec",
            "sqlite://./derec.db?mode=rwc&cache=shared",
        ] {
            assert_eq!(resolve_url(url), url);
        }
    }

    #[test]
    fn the_in_memory_spelling_survives_resolution() {
        // `sqlite::memory:` contains `:` but not `://`. Treating it as a bare
        // path would produce `sqlite://sqlite::memory:?mode=rwc`, which names a
        // file called `sqlite::memory:` — an ephemeral node that silently
        // persists is the exact opposite of what was asked for.
        assert_eq!(resolve_url("sqlite::memory:"), "sqlite::memory:");
    }

    #[test]
    fn surrounding_whitespace_is_ignored() {
        // `DEREC_DATABASE_URL=" ./derec.db"` out of a compose file is a typo
        // that should not produce a database named " ./derec.db".
        assert_eq!(resolve_url("  ./derec.db  "), "sqlite://./derec.db?mode=rwc");
    }

    #[test]
    fn an_empty_value_falls_back_to_the_built_in_default() {
        assert_eq!(resolve_url(""), resolve_url(DEFAULT_DATABASE_URL));
        assert_eq!(resolve_url("   "), resolve_url(DEFAULT_DATABASE_URL));
    }

    #[test]
    fn a_password_is_replaced_rather_than_shortened() {
        // Not a truncation: the length of a secret is itself information.
        assert_eq!(
            redact_url("postgres://user:hunter2@db:5432/derec"),
            "postgres://user:***@db:5432/derec"
        );
    }

    #[test]
    fn a_url_with_no_password_is_left_alone() {
        for url in [
            "postgres://user@db:5432/derec",
            "postgres://db:5432/derec",
            "sqlite://./derec.db?mode=rwc",
            "sqlite::memory:",
        ] {
            assert_eq!(redact_url(url), url, "{url} should be unchanged");
        }
    }

    #[test]
    fn only_the_credentials_section_is_touched() {
        // A colon in the path or query is not a password. Redacting on any
        // colon would mangle `:5432` and make the banner useless for the one
        // thing it is for — seeing what was actually configured.
        assert_eq!(
            redact_url("postgres://user:pw@db:5432/derec?opt=a:b"),
            "postgres://user:***@db:5432/derec?opt=a:b"
        );
    }
}
