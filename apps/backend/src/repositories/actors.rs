// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The server-wide actor list.
//!
//! One flat registry: the app runs as a single local node that developers point
//! browser contexts at, so there is no grouping above this.

use async_trait::async_trait;
use uuid::Uuid;

use super::sdk::{id_to_text, text_to_id};
use super::{begin_write, RepositoryError};
use crate::models::{
    Actor, ActorSettings, NewActor, PlannedRegistration, Role, Transport, UnpairAck,
};

type Result<T> = std::result::Result<T, RepositoryError>;

/// Decides, from the roster as it stands, which actors to register. See
/// [`ActorRepository::register_planned`].
pub type RegistrationPlan<'a> = &'a (dyn Fn(&[Actor]) -> Vec<NewActor> + Sync);

#[async_trait]
pub trait ActorRepository: Send + Sync {
    /// Add an actor. Callers mint ids with `Uuid::new_v4`, so collisions are
    /// not a case worth handling.
    async fn register(&self, actor: Actor, settings: ActorSettings) -> Result<()>;

    /// The atomic primitive behind every count-then-create rule.
    ///
    /// `plan` is shown the whole roster, in registration order, and answers
    /// what to register; everything it answers is registered, in that order.
    /// Reading the roster, running the plan and inserting happen as one step:
    /// no other registration on this node can land in between, so a rule the
    /// plan applies to the roster it was shown — "only the shortfall", "no two
    /// helpers with one name" — still holds once the actors are in.
    ///
    /// The plan runs once, and holds the registry while it does, so it must
    /// not block or call back into this repository.
    async fn register_planned(&self, plan: RegistrationPlan<'_>) -> Result<PlannedRegistration>;

    /// Replace the endpoints an actor advertises.
    ///
    /// The row is the source a respawned actor builds its own transports from,
    /// so this is what makes a changed address stick across restarts.
    async fn set_transports(&self, actor_id: &Uuid, transports: &[Transport]) -> Result<()>;

    /// Give the actor with this id *and* role a new display name, answering
    /// whether one matched.
    ///
    /// The role is part of the statement rather than checked by a lookup
    /// first, so a concurrent delete or an actor of another role can never be
    /// renamed in the gap between the two.
    async fn rename(&self, actor_id: &Uuid, role: Role, name: &str) -> Result<bool>;

    /// Stop listing this actor. Only the registry row goes.
    async fn remove(&self, actor_id: &Uuid) -> Result<()>;

    /// The actor with this id, if the server knows it.
    async fn get(&self, actor_id: &Uuid) -> Result<Option<Actor>>;

    /// The protocol settings this actor was provisioned with. `None` means no
    /// such actor.
    async fn settings(&self, actor_id: &Uuid) -> Result<Option<ActorSettings>>;

    /// Snapshot of the whole roster, in registration order.
    async fn all(&self) -> Result<Vec<Actor>>;
}

pub struct SqlActorRepository {
    pool: sqlx::AnyPool,
    /// Serialises every insert within this process.
    ///
    /// A planned registration's count-and-create must be atomic so two
    /// browser contexts setting up at the same moment cannot each fill an
    /// empty pool. A transaction alone does not provide it portably: on
    /// Postgres two concurrent transactions can both count zero before either
    /// inserts. The same is true of `seq`, assigned as `MAX(seq) + 1`: two
    /// concurrent Postgres transactions can read the same maximum. Holding this
    /// across every insert restores exactly the guarantee an in-process lock
    /// gives — one process — and claims no more; across processes the unique
    /// index on `seq` (migration 0002) turns a collision into a refused insert
    /// rather than two actors sharing a position. When node separation lands,
    /// this needs a database-level lock instead, and that is the moment to add
    /// one.
    insert_lock: tokio::sync::Mutex<()>,
}

impl SqlActorRepository {
    pub fn new(pool: sqlx::AnyPool) -> Self {
        Self {
            pool,
            insert_lock: tokio::sync::Mutex::new(()),
        }
    }
}

#[async_trait]
impl ActorRepository for SqlActorRepository {
    async fn register(&self, actor: Actor, settings: ActorSettings) -> Result<()> {
        // See the field's doc: `seq` is read-then-written.
        let _guard = self.insert_lock.lock().await;
        let mut tx = begin_write(&self.pool).await?;
        insert_actor(&mut tx, &actor, &settings).await?;
        tx.commit().await?;
        Ok(())
    }

    async fn register_planned(&self, plan: RegistrationPlan<'_>) -> Result<PlannedRegistration> {
        // Held across the whole read-plan-insert; see the field's doc.
        let _guard = self.insert_lock.lock().await;
        let mut tx = begin_write(&self.pool).await?;

        let mut roster = fetch_all_in(&mut tx).await?;
        let planned = plan(&roster);

        let mut registered = Vec::with_capacity(planned.len());
        for (actor, settings) in planned {
            insert_actor(&mut tx, &actor, &settings).await?;
            roster.push(actor.clone());
            registered.push(actor);
        }

        tx.commit().await?;
        Ok(PlannedRegistration { registered, roster })
    }

    async fn set_transports(&self, actor_id: &Uuid, transports: &[Transport]) -> Result<()> {
        let json = serde_json::to_string(transports).map_err(RepositoryError::corrupt)?;
        sqlx::query("UPDATE actors SET transports = $1 WHERE actor_id = $2")
            .bind(json)
            .bind(actor_id.to_string())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn rename(&self, actor_id: &Uuid, role: Role, name: &str) -> Result<bool> {
        let result = sqlx::query("UPDATE actors SET name = $1 WHERE actor_id = $2 AND role = $3")
            .bind(name)
            .bind(actor_id.to_string())
            .bind(role_text(role))
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    async fn remove(&self, actor_id: &Uuid) -> Result<()> {
        sqlx::query("DELETE FROM actors WHERE actor_id = $1")
            .bind(actor_id.to_string())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn get(&self, actor_id: &Uuid) -> Result<Option<Actor>> {
        let row: Option<ActorColumns> = sqlx::query_as(&format!(
            "SELECT {SELECT_COLUMNS} FROM actors WHERE actor_id = $1"
        ))
        .bind(actor_id.to_string())
        .fetch_optional(&self.pool)
        .await?;

        row.map(to_actor).transpose()
    }

    async fn settings(&self, actor_id: &Uuid) -> Result<Option<ActorSettings>> {
        let row: Option<(String, i64, String)> = sqlx::query_as(
            "SELECT replica_id, timeout_secs, unpair_ack FROM actors WHERE actor_id = $1",
        )
        .bind(actor_id.to_string())
        .fetch_optional(&self.pool)
        .await?;

        row.map(|(replica_id, timeout_secs, unpair_ack)| {
            Ok(ActorSettings {
                replica_id: text_to_id(&replica_id).map_err(RepositoryError::corrupt)?,
                timeout_secs: u32::try_from(timeout_secs).map_err(RepositoryError::corrupt)?,
                unpair_ack: unpair_ack_of(&unpair_ack)?,
            })
        })
        .transpose()
    }

    async fn all(&self) -> Result<Vec<Actor>> {
        let rows: Vec<ActorColumns> =
            sqlx::query_as(&format!("SELECT {SELECT_COLUMNS} FROM actors ORDER BY seq"))
                .fetch_all(&self.pool)
                .await?;

        rows.into_iter().map(to_actor).collect()
    }
}

/// The columns an `Actor` is rebuilt from.
type ActorColumns = (String, String, String, String, String);

const SELECT_COLUMNS: &str = "actor_id, role, name, secret_id, transports";

fn role_text(role: Role) -> &'static str {
    match role {
        Role::Owner => "owner",
        Role::Helper => "helper",
    }
}

fn role_of(text: &str) -> Result<Role> {
    match text {
        "owner" => Ok(Role::Owner),
        "helper" => Ok(Role::Helper),
        other => Err(RepositoryError::Corrupt(format!(
            "unknown role in actors table: {other:?}"
        ))),
    }
}

fn unpair_ack_text(ack: UnpairAck) -> &'static str {
    match ack {
        UnpairAck::Required => "required",
        UnpairAck::NotRequired => "not_required",
    }
}

fn unpair_ack_of(text: &str) -> Result<UnpairAck> {
    match text {
        "required" => Ok(UnpairAck::Required),
        "not_required" => Ok(UnpairAck::NotRequired),
        other => Err(RepositoryError::Corrupt(format!(
            "unknown unpair_ack in actors table: {other:?}"
        ))),
    }
}

/// Rebuild an `Actor` from its columns.
///
/// Field by field rather than `serde_json::from_str::<Actor>`: `Actor` derives
/// `Serialize` but deliberately **not** `Deserialize`, because the relay's
/// allowlist trusts `Actor.transports` by exact string match on the strength of
/// no request body being able to produce an [`Actor`] (see its `transports` docs).
/// Deriving `Deserialize` to make this convenient would retire that guarantee
/// for a convenience. `Vec<Transport>` deserialises on its own, which is all
/// that is needed.
fn to_actor((actor_id, role, name, secret_id, transports): ActorColumns) -> Result<Actor> {
    let transports: Vec<Transport> =
        serde_json::from_str(&transports).map_err(RepositoryError::corrupt)?;

    // `Actor::transport` is the first of the list, kept because several
    // front-end call sites want "an address for this actor".
    let transport = transports
        .first()
        .cloned()
        .ok_or_else(|| RepositoryError::Corrupt("an actor row names no endpoint".to_owned()))?;

    Ok(Actor {
        id: actor_id.parse().map_err(RepositoryError::corrupt)?,
        role: role_of(&role)?,
        name,
        transport,
        transports,
        secret_id,
    })
}

/// Insert one actor, assigning the next `seq` inside the caller's transaction.
///
/// `MAX(seq) + 1` rather than `AUTOINCREMENT`/`SERIAL`, neither of which is
/// portable across both engines. Safe because every writer holds
/// `insert_lock` and a write transaction, and the unique index on `seq`
/// refuses what slips past both.
async fn insert_actor(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    actor: &Actor,
    settings: &ActorSettings,
) -> Result<()> {
    let transports = serde_json::to_string(&actor.transports).map_err(RepositoryError::corrupt)?;

    let (next,): (i64,) = sqlx::query_as("SELECT COALESCE(MAX(seq), 0) + 1 FROM actors")
        .fetch_one(&mut **tx)
        .await?;

    sqlx::query(
        "INSERT INTO actors \
         (actor_id, seq, role, name, secret_id, transports, \
          replica_id, timeout_secs, unpair_ack, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(actor.id.to_string())
    .bind(next)
    .bind(role_text(actor.role))
    .bind(&actor.name)
    .bind(&actor.secret_id)
    .bind(&transports)
    .bind(id_to_text(settings.replica_id))
    .bind(i64::from(settings.timeout_secs))
    .bind(unpair_ack_text(settings.unpair_ack))
    .bind(next)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

async fn fetch_all_in(tx: &mut sqlx::Transaction<'_, sqlx::Any>) -> Result<Vec<Actor>> {
    let rows: Vec<ActorColumns> =
        sqlx::query_as(&format!("SELECT {SELECT_COLUMNS} FROM actors ORDER BY seq"))
            .fetch_all(&mut **tx)
            .await?;

    rows.into_iter().map(to_actor).collect()
}
