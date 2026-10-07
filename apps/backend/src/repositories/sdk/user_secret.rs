// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! `DeRecUserSecretStore` over SQL.
//!
//! `UserSecrets` has no serde of its own — unlike `ChannelRecord` and
//! `SecretValue` — and its `secrets` and `replicas` fields are prost messages.
//! So the payload is a small local row type: the scalars directly, the prost
//! parts encoded and base64'd.
//!
//! This deliberately differs from the SDK's WASM adapter
//! (`interop/wasm/protocol/stores.rs:816`), which hand-maps the fields and
//! drops `replicas`. That field is the Owner-side cached replica composite;
//! losing it across a restart forces a re-derivation of share material, which
//! is exactly the cost persistence exists to avoid.

use derec_library::protocol::types::UserSecret;
use derec_library::protocol::{
    DeRecUserSecretStore, ShareStoreError, ShareStoreFuture, UserSecrets,
};
use prost::Message as _;
use serde::{Deserialize, Serialize};

use super::{from_base64, id_to_text, to_base64};

fn backend<E: std::error::Error + Send + Sync + 'static>(e: E) -> ShareStoreError {
    ShareStoreError::Backend(Box::new(e))
}

/// The stored shape of a `UserSecrets`.
///
/// Prost parts are base64 of their encoded bytes; the scalars are themselves.
#[derive(Serialize, Deserialize)]
struct UserSecretsRow {
    version: u32,
    description: Option<String>,
    secrets: Vec<String>,
    /// The replica member that published this version, as a decimal string —
    /// what the library compares to tell a re-send from a conflicting copy.
    /// Absent on rows written before SDK 0.0.6, which carried a `replicas`
    /// field instead (ignored on read: the library rebuilds the group from the
    /// channel store every round and never read it back).
    #[serde(default)]
    author_replica_id: Option<String>,
}

impl UserSecretsRow {
    fn from_secrets(value: &UserSecrets) -> Result<Self, ShareStoreError> {
        Ok(Self {
            version: value.version,
            description: value.description.clone(),
            secrets: value
                .secrets
                .iter()
                .map(|s| to_base64(&s.encode_to_vec()))
                .collect(),
            author_replica_id: value.author_replica_id.map(|id| id.to_string()),
        })
    }

    fn into_secrets(self) -> Result<UserSecrets, ShareStoreError> {
        let mut secrets = Vec::with_capacity(self.secrets.len());
        for encoded in &self.secrets {
            let bytes = from_base64(encoded).map_err(backend)?;
            secrets.push(UserSecret::decode(bytes.as_slice()).map_err(backend)?);
        }

        let author_replica_id = self
            .author_replica_id
            .as_deref()
            .map(str::parse::<u64>)
            .transpose()
            .map_err(backend)?;

        Ok(UserSecrets {
            version: self.version,
            secrets,
            description: self.description,
            author_replica_id,
        })
    }
}

pub struct SqlUserSecretStore {
    pool: sqlx::AnyPool,
    /// Which actor's instance this store belongs to. See the migration's
    /// header: (actor_id, secret_id) identifies an instance, because two
    /// actors can hold instances bound to the same secret.
    actor_id: String,
}

impl SqlUserSecretStore {
    pub fn new(pool: sqlx::AnyPool, actor_id: impl Into<String>) -> Self {
        Self {
            pool,
            actor_id: actor_id.into(),
        }
    }
}

impl DeRecUserSecretStore for SqlUserSecretStore {
    fn load_latest(&self, secret_id: u64) -> ShareStoreFuture<'_, Option<UserSecrets>> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let actor = self.actor_id.clone();

        Box::pin(async move {
            let row: Option<(String,)> =
                sqlx::query_as(
                    "SELECT payload FROM user_secrets \
                     WHERE secret_id = $1 AND actor_id = $2",
                )
                    .bind(secret)
                    .bind(actor)
                    .fetch_optional(&pool)
                    .await
                    .map_err(backend)?;

            match row {
                Some((json,)) => {
                    let row: UserSecretsRow = serde_json::from_str(&json).map_err(backend)?;
                    Ok(Some(row.into_secrets()?))
                }
                None => Ok(None),
            }
        })
    }

    fn save_latest(&mut self, secret_id: u64, value: UserSecrets) -> ShareStoreFuture<'_, ()> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let actor = self.actor_id.clone();

        Box::pin(async move {
            let json =
                serde_json::to_string(&UserSecretsRow::from_secrets(&value)?).map_err(backend)?;

            // Replace, never accumulate: there is one current snapshot per
            // secret, which is what "latest" means.
            let mut tx = crate::repositories::begin_write(&pool).await.map_err(backend)?;

            sqlx::query("DELETE FROM user_secrets WHERE secret_id = $1 AND actor_id = $2")
                .bind(&secret)
                .bind(&actor)
                .execute(&mut *tx)
                .await
                .map_err(backend)?;

            sqlx::query(
                "INSERT INTO user_secrets (secret_id, payload, actor_id) VALUES ($1, $2, $3)",
            )
                .bind(&secret)
                .bind(&json)
                .bind(&actor)
                .execute(&mut *tx)
                .await
                .map_err(backend)?;

            tx.commit().await.map_err(backend)?;
            Ok(())
        })
    }

    fn remove(&mut self, secret_id: u64) -> ShareStoreFuture<'_, ()> {
        let pool = self.pool.clone();
        let secret = id_to_text(secret_id);
        let actor = self.actor_id.clone();

        Box::pin(async move {
            sqlx::query("DELETE FROM user_secrets WHERE secret_id = $1 AND actor_id = $2")
                .bind(secret)
                .bind(actor)
                .execute(&pool)
                .await
                .map_err(backend)?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_field_survives_the_row_encoding_including_the_author() {
        // `author_replica_id` is what tells a replica a re-send from a
        // conflicting copy of the same version; dropping it would make every
        // copy after a restart look authorless. Above i64::MAX on purpose, so a
        // signed or float encoding would come back a different number.
        let original = UserSecrets {
            version: 9,
            secrets: vec![UserSecret {
                id: vec![1, 2, 3],
                name: "a name".to_owned(),
                data: vec![0xff, 0x00],
            }],
            description: Some("a description".to_owned()),
            author_replica_id: Some(u64::MAX - 7),
        };

        let row = UserSecretsRow::from_secrets(&original).expect("encodes");
        let back = row.into_secrets().expect("decodes");

        assert_eq!(back.version, original.version);
        assert_eq!(back.author_replica_id, Some(u64::MAX - 7));
        assert_eq!(back.description, original.description);
        assert_eq!(back.secrets.len(), 1);
        assert_eq!(back.secrets[0].name, "a name");
        assert_eq!(
            back.secrets[0].data,
            vec![0xff, 0x00],
            "binary must survive exactly"
        );
    }

    #[test]
    fn an_empty_snapshot_round_trips() {
        let original = UserSecrets {
            version: 0,
            secrets: Vec::new(),
            description: None,
            author_replica_id: None,
        };

        let back = UserSecretsRow::from_secrets(&original)
            .expect("encodes")
            .into_secrets()
            .expect("decodes");

        assert_eq!(back.version, 0);
        assert!(back.secrets.is_empty());
        assert_eq!(back.description, None);
        assert_eq!(back.author_replica_id, None);
    }

    #[test]
    fn a_row_written_before_sdk_0_0_6_still_reads() {
        // Those rows carried a base64 `replicas` blob and no author. The blob is
        // ignored — the library never read it back — and the author is absent,
        // which the library treats as "not published by a group member".
        let json = r#"{"version":3,"description":null,"secrets":[],"replicas":"AAAA"}"#;
        let row: UserSecretsRow = serde_json::from_str(json).expect("an old row parses");

        let back = row.into_secrets().expect("decodes");
        assert_eq!(back.version, 3);
        assert_eq!(back.author_replica_id, None);
    }
}
