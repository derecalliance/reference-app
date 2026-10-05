// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! SQL-backed implementations of the SDK store traits.
//!
//! One struct per store, each holding a clone of the process `AnyPool`. The
//! pool is itself a handle — cloning is cheap and every clone shares the same
//! connections — so an actor owning its stores costs nothing beyond the struct.
//!
//! # Why the queries look repetitive
//!
//! One dialect has to run on SQLite and Postgres unmodified. That rules out
//! `INSERT OR REPLACE` (SQLite only), `ON CONFLICT DO UPDATE` with differing
//! syntax, and `RETURNING`. Upsert is therefore `DELETE` then `INSERT` inside a
//! transaction, which both engines accept and which matches the in-memory
//! stores' `HashMap::insert` semantics exactly.
//!
//! # Why ids are strings
//!
//! Every `secret_id`, `channel_id` and `replica_id` is a `u64`. `AnyPool` binds
//! `i64` and has no unsigned type, and an `i64` bit-cast makes ordering and
//! equality wrong above `i64::MAX` while staying invisible below it. They are
//! decimal-encoded `TEXT` instead — the same decision the HTTP layer already
//! made for `Actor::secret_id`.

pub mod channel;
pub mod secret;
pub mod share;
pub mod state;
pub mod user_secret;

use base64::Engine as _;

/// Decimal-encode a `u64` id for a `TEXT` column.
pub fn id_to_text(id: u64) -> String {
    id.to_string()
}

/// Why an id column could not be read back.
#[derive(Debug, thiserror::Error)]
#[error("{value:?} is not a valid id")]
pub struct ParseIdError {
    value: String,
}

/// Read a `u64` id back out of a `TEXT` column.
///
/// An error rather than a default: a corrupted id that decoded to `0` would
/// silently read another partition, which is the one failure mode the
/// partitioning assertions in the conformance suite exist to catch.
pub fn text_to_id(text: &str) -> Result<u64, ParseIdError> {
    text.parse::<u64>().map_err(|_| ParseIdError {
        value: text.to_owned(),
    })
}

/// The `secret_id` of every protocol instance `actor_id` has stored anything
/// under, ascending.
///
/// Every store table is partitioned by `(actor_id, secret_id)`, and that pair
/// identifies an instance exactly (see `migrations/0001_initial.sql`), so the
/// distinct partitions are the instances. That includes replica instances,
/// which are created on demand and recorded nowhere else: this is how a
/// restart finds them again. An instance that was created but never wrote a
/// row has nothing to restore and is not listed; the next request for it
/// creates it afresh, exactly as the first one did.
pub async fn stored_instance_secret_ids(
    pool: &sqlx::AnyPool,
    actor_id: &str,
) -> Result<Vec<u64>, sqlx::Error> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT secret_id FROM channels WHERE actor_id = $1 \
         UNION SELECT secret_id FROM secrets WHERE actor_id = $2 \
         UNION SELECT secret_id FROM shares WHERE actor_id = $3 \
         UNION SELECT secret_id FROM state_items WHERE actor_id = $4 \
         UNION SELECT secret_id FROM user_secrets WHERE actor_id = $5",
    )
    // One bind per placeholder rather than a reused `$1`: SQLite reads `$1`
    // as a named parameter and Postgres as a positional one, and only
    // distinct placeholders mean the same thing to both.
    .bind(actor_id)
    .bind(actor_id)
    .bind(actor_id)
    .bind(actor_id)
    .bind(actor_id)
    .fetch_all(pool)
    .await?;

    let mut ids: Vec<u64> = rows
        .iter()
        .filter_map(|(text,)| match text_to_id(text) {
            Ok(id) => Some(id),
            Err(e) => {
                // Skipped rather than fatal: one corrupt row must not keep
                // every other instance of this actor down.
                tracing::warn!(actor_id, error = %e, "unreadable secret_id; instance skipped");
                None
            }
        })
        .collect();
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

/// Encode binary for a `TEXT` column.
pub fn to_base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Decode binary from a `TEXT` column.
pub fn from_base64(text: &str) -> Result<Vec<u8>, base64::DecodeError> {
    base64::engine::general_purpose::STANDARD.decode(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_above_i64_max_round_trips_exactly() {
        // The whole reason ids are TEXT. Bit-cast to i64 this comes back
        // negative; decimal-encoded it comes back itself.
        let id = u64::MAX - 7;

        assert_eq!(text_to_id(&id_to_text(id)).expect("parses"), id);
    }

    #[test]
    fn ordinary_ids_round_trip_too() {
        for id in [0u64, 1, 5000, u64::MAX] {
            assert_eq!(text_to_id(&id_to_text(id)).expect("parses"), id, "id {id}");
        }
    }

    #[test]
    fn a_non_numeric_id_is_an_error_rather_than_a_silent_zero() {
        // A row whose id column has been corrupted must surface, not decode to
        // secret 0 and quietly read another partition.
        assert!(text_to_id("").is_err());
        assert!(text_to_id("not-a-number").is_err());
        assert!(text_to_id("-1").is_err());
    }

    #[test]
    fn binary_round_trips_through_base64_including_edge_bytes() {
        for bytes in [
            vec![],
            vec![0x00],
            vec![0xff],
            vec![0x00, 0xff, 0x00, 0xff],
            (0u8..=255).collect::<Vec<u8>>(),
        ] {
            assert_eq!(
                from_base64(&to_base64(&bytes)).expect("decodes"),
                bytes,
                "failed for {} bytes",
                bytes.len()
            );
        }
    }

    #[test]
    fn malformed_base64_is_an_error() {
        assert!(from_base64("!!!not base64!!!").is_err());
    }
}
