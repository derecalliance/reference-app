// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The server-wide actor list.
//!
//! One flat registry: the app runs as a single local node that developers point
//! browser contexts at, so there is no grouping above this.

use uuid::Uuid;

use super::RegistryError;
use crate::models::{
    Actor, Role, Transport, TransportBreakdown, TransportMode, TransportProtocol, UnpairAck,
};
use crate::sql::{id_to_text, text_to_id};
use crate::state::{EnsuredParticipants, RoleMismatch};

pub struct SqlActorRegistry {
    pool: sqlx::AnyPool,
    /// Serialises every insert — `register` and `ensure_participants_by_mode`
    /// — within this process.
    ///
    /// The count-and-create must be atomic so two browser contexts setting up
    /// at the same moment cannot each fill an empty pool — the guarantee the
    /// old `RwLock` gave. A transaction alone does not provide it portably: on
    /// Postgres two concurrent transactions can both count zero before either
    /// inserts. The same is true of `seq`, assigned as `MAX(seq) + 1`: two
    /// concurrent Postgres transactions can read the same maximum. Holding this
    /// across both kinds of insert restores exactly the previous guarantee —
    /// one process — and claims no more; across processes the unique index on
    /// `seq` (migration 0002) turns a collision into a refused insert rather
    /// than two actors sharing a position. When node separation lands, this
    /// needs a database-level lock instead, and that is the moment to add one.
    ensure_lock: tokio::sync::Mutex<()>,
}

/// A helper could not be registered: another helper already has its name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NameTaken;

/// Whether two display names would read as the same helper in a roster.
///
/// Trimmed and case-insensitive: `Alex` and ` alex ` side by side are no
/// easier to tell apart than two `Alex` rows.
pub fn names_match(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

/// The protocol settings an actor runs with, kept so a restart rebuilds the
/// same actor rather than a new one wearing its name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActorSettings {
    /// Stable per-device replica id.
    ///
    /// Every stored `ReplicaMember` row references it, so an actor rebuilt with
    /// a fresh one is a stranger to every replica group holding its old id.
    /// This is why the settings are persisted at all.
    pub replica_id: u64,
    pub timeout_secs: u32,
    pub unpair_ack: UnpairAck,
}

fn unpair_ack_text(ack: UnpairAck) -> &'static str {
    match ack {
        UnpairAck::Required => "required",
        UnpairAck::NotRequired => "not_required",
    }
}

fn unpair_ack_of(text: &str) -> Result<UnpairAck, RegistryError> {
    match text {
        "required" => Ok(UnpairAck::Required),
        "not_required" => Ok(UnpairAck::NotRequired),
        other => Err(RegistryError::message(format!(
            "unknown unpair_ack in actors table: {other:?}"
        ))),
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

fn role_of(text: &str) -> Result<Role, RegistryError> {
    match text {
        "owner" => Ok(Role::Owner),
        "helper" => Ok(Role::Helper),
        other => Err(RegistryError::message(format!(
            "unknown role in actors table: {other:?}"
        ))),
    }
}

/// Rebuild an `Actor` from its columns.
///
/// Field by field rather than `serde_json::from_str::<Actor>`: `Actor` derives
/// `Serialize` but deliberately **not** `Deserialize`, because the relay's
/// allowlist trusts `Actor.transports` by exact string match on the strength of
/// no request body being able to produce an `Actor` (see `models.rs`). Deriving
/// `Deserialize` to make this convenient would retire that guarantee for a
/// convenience. `Vec<Transport>` deserialises on its own, which is all that is
/// needed.
fn to_actor((actor_id, role, name, secret_id, transports): ActorColumns) -> Result<Actor, RegistryError> {
    let transports: Vec<Transport> =
        serde_json::from_str(&transports).map_err(RegistryError::new)?;

    // `Actor::transport` is the first of the list, kept because several
    // front-end call sites want "an address for this actor".
    let transport = transports
        .first()
        .cloned()
        .ok_or_else(|| RegistryError::message("an actor row names no endpoint"))?;

    Ok(Actor {
        id: actor_id.parse().map_err(RegistryError::new)?,
        role: role_of(&role)?,
        name,
        transport,
        transports,
        secret_id,
    })
}

impl SqlActorRegistry {
    pub fn new(pool: sqlx::AnyPool) -> Self {
        Self {
            pool,
            ensure_lock: tokio::sync::Mutex::new(()),
        }
    }

    /// Add an actor. Callers mint ids with `Uuid::new_v4`, so collisions are
    /// not a case worth handling.
    pub async fn register(
        &self,
        actor: Actor,
        settings: ActorSettings,
    ) -> Result<(), RegistryError> {
        // See the field's doc: `seq` is read-then-written.
        let _guard = self.ensure_lock.lock().await;
        let mut tx = crate::db::begin_write(&self.pool).await.map_err(RegistryError::new)?;
        insert_actor(&mut tx, &actor, &settings).await?;
        tx.commit().await.map_err(RegistryError::new)?;
        Ok(())
    }

    /// Add a helper, unless another helper already has its name.
    ///
    /// The check and the insert share [`Self::ensure_lock`] and one
    /// transaction, so two requests naming the same new helper at the same
    /// moment cannot both pass the check. Only helpers are compared: owners
    /// are named by their own browser tabs, and a helper sharing a name with
    /// one is not ambiguous in the pool.
    ///
    /// The inner `Result` is the refusal; the outer one is the database
    /// failing.
    pub async fn register_helper(
        &self,
        actor: Actor,
        settings: ActorSettings,
    ) -> Result<Result<(), NameTaken>, RegistryError> {
        let _guard = self.ensure_lock.lock().await;
        let mut tx = crate::db::begin_write(&self.pool)
            .await
            .map_err(RegistryError::new)?;

        let taken = fetch_all_in(&mut tx)
            .await?
            .iter()
            .any(|a| a.role == Role::Helper && names_match(&a.name, &actor.name));
        if taken {
            return Ok(Err(NameTaken));
        }

        insert_actor(&mut tx, &actor, &settings).await?;
        tx.commit().await.map_err(RegistryError::new)?;
        Ok(Ok(()))
    }

    /// Replace the endpoints an actor advertises.
    ///
    /// The row is the source a respawned actor builds its own transports from,
    /// so this is what makes a changed address stick across restarts.
    pub async fn set_transports(
        &self,
        actor_id: &Uuid,
        transports: &[Transport],
    ) -> Result<(), RegistryError> {
        let json = serde_json::to_string(transports).map_err(RegistryError::new)?;
        sqlx::query("UPDATE actors SET transports = $1 WHERE actor_id = $2")
            .bind(json)
            .bind(actor_id.to_string())
            .execute(&self.pool)
            .await
            .map_err(RegistryError::new)?;
        Ok(())
    }

    /// Give an owner a new display name.
    ///
    /// Restricted to owners in the statement itself rather than by a lookup
    /// first, so a concurrent delete or a helper id can never be renamed in
    /// the gap between the two. Answers whether a row matched: `false` means
    /// no such actor, or one that is not an owner.
    ///
    /// Helpers are not renamed here. A provisioned helper's name is sent to
    /// peers as `communication_info["name"]` by its running protocol instance,
    /// so renaming the row alone would make the two disagree.
    pub async fn rename_owner(&self, actor_id: &Uuid, name: &str) -> Result<bool, RegistryError> {
        let result = sqlx::query("UPDATE actors SET name = $1 WHERE actor_id = $2 AND role = $3")
            .bind(name)
            .bind(actor_id.to_string())
            .bind(role_text(Role::Owner))
            .execute(&self.pool)
            .await
            .map_err(RegistryError::new)?;
        Ok(result.rows_affected() > 0)
    }

    /// Stop listing this actor.
    ///
    /// Only the registry row goes; the participant's stores are cleared by
    /// [`crate::deletion`], which calls this last so a failure earlier in the
    /// erasure leaves the participant visible rather than listed-but-hollow.
    pub async fn remove(&self, actor_id: &Uuid) -> Result<(), RegistryError> {
        sqlx::query("DELETE FROM actors WHERE actor_id = $1")
            .bind(actor_id.to_string())
            .execute(&self.pool)
            .await
            .map_err(RegistryError::new)?;
        Ok(())
    }

    /// The actor with this id, if the server knows it.
    pub async fn get(&self, actor_id: &Uuid) -> Result<Option<Actor>, RegistryError> {
        let row: Option<ActorColumns> = sqlx::query_as(&format!(
            "SELECT {SELECT_COLUMNS} FROM actors WHERE actor_id = $1"
        ))
        .bind(actor_id.to_string())
        .fetch_optional(&self.pool)
        .await
        .map_err(RegistryError::new)?;

        row.map(to_actor).transpose()
    }

    /// The actor with this id, but only if it holds `role`.
    ///
    /// The inner `Result` distinguishes "no such actor" from "wrong kind of
    /// actor" so callers can map them onto different status codes; the outer
    /// one is the database failing.
    pub async fn get_with_role(
        &self,
        actor_id: &Uuid,
        role: Role,
    ) -> Result<Result<Actor, RoleMismatch>, RegistryError> {
        Ok(match self.get(actor_id).await? {
            None => Err(RoleMismatch::NotFound),
            Some(actor) if actor.role == role => Ok(actor),
            Some(actor) => Err(RoleMismatch::WrongRole { actual: actor.role }),
        })
    }

    pub async fn contains(&self, actor_id: &Uuid) -> Result<bool, RegistryError> {
        Ok(self.get(actor_id).await?.is_some())
    }

    /// The protocol settings this actor was provisioned with.
    ///
    /// `None` means no such actor. A helper without settings cannot be rebuilt
    /// faithfully, which recovery treats as a reason not to rebuild it at all.
    pub async fn settings(&self, actor_id: &Uuid) -> Result<Option<ActorSettings>, RegistryError> {
        let row: Option<(String, i64, String)> = sqlx::query_as(
            "SELECT replica_id, timeout_secs, unpair_ack FROM actors WHERE actor_id = $1",
        )
        .bind(actor_id.to_string())
        .fetch_optional(&self.pool)
        .await
        .map_err(RegistryError::new)?;

        row.map(|(replica_id, timeout_secs, unpair_ack)| {
            Ok(ActorSettings {
                replica_id: text_to_id(&replica_id).map_err(RegistryError::new)?,
                timeout_secs: u32::try_from(timeout_secs).map_err(RegistryError::new)?,
                unpair_ack: unpair_ack_of(&unpair_ack)?,
            })
        })
        .transpose()
    }

    /// Snapshot of the whole roster, in registration order.
    pub async fn all(&self) -> Result<Vec<Actor>, RegistryError> {
        let rows: Vec<ActorColumns> = sqlx::query_as(&format!(
            "SELECT {SELECT_COLUMNS} FROM actors ORDER BY seq"
        ))
        .fetch_all(&self.pool)
        .await
        .map_err(RegistryError::new)?;

        rows.into_iter().map(to_actor).collect()
    }

    /// Bring the pool up to a target composition, creating only the per-mode
    /// shortfall.
    ///
    /// Asking for fewer of a mode than exist removes nothing: another owner may
    /// be paired with one.
    ///
    /// `mint` receives two counters with distinct meanings, matching the two
    /// documented on [`crate::routes::helpers::helper_name`]:
    /// - `taken` is this call's creation order, across every mode combined.
    /// - `pool_index` is that helper's position in the whole shared pool at the
    ///   moment it is added, so it keeps climbing across separate calls.
    ///
    /// `mint` is also handed the pool as it stands — including helpers this
    /// call already created — so it can choose a name no helper has. It sees
    /// the pool under the same lock the insert happens under, which is what
    /// makes that choice stick.
    pub async fn ensure_participants_by_mode<F>(
        &self,
        want: TransportBreakdown,
        mut mint: F,
    ) -> Result<EnsuredParticipants, RegistryError>
    where
        F: FnMut(usize, usize, TransportMode, &[Actor]) -> (Actor, ActorSettings),
    {
        // Held across the whole count-and-create; see the field's doc.
        let _guard = self.ensure_lock.lock().await;

        let mut tx = crate::db::begin_write(&self.pool).await.map_err(RegistryError::new)?;

        let mut helpers: Vec<Actor> = fetch_all_in(&mut tx)
            .await?
            .into_iter()
            .filter(|a| a.role == Role::Helper)
            .collect();

        let mut created = Vec::new();
        let mut taken = 0usize;

        for (mode, target) in want.modes() {
            let have = helpers.iter().filter(|a| mode_of(a) == mode).count();
            for _ in have..target {
                let pool_index = helpers.len();
                let (actor, settings) = mint(taken, pool_index, mode, &helpers);
                insert_actor(&mut tx, &actor, &settings).await?;
                helpers.push(actor.clone());
                created.push(actor);
                taken += 1;
            }
        }

        tx.commit().await.map_err(RegistryError::new)?;

        Ok(EnsuredParticipants {
            created,
            participants: helpers,
        })
    }
}

/// Insert one actor, assigning the next `seq` inside the caller's transaction.
///
/// `MAX(seq) + 1` rather than `AUTOINCREMENT`/`SERIAL`, neither of which is
/// portable across both engines. Safe because every writer holds
/// `ensure_lock` and a write transaction, and the unique index on `seq`
/// refuses what slips past both.
async fn insert_actor(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    actor: &Actor,
    settings: &ActorSettings,
) -> Result<(), RegistryError> {
    let transports = serde_json::to_string(&actor.transports).map_err(RegistryError::new)?;

    let (next,): (i64,) = sqlx::query_as("SELECT COALESCE(MAX(seq), 0) + 1 FROM actors")
        .fetch_one(&mut **tx)
        .await
        .map_err(RegistryError::new)?;

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
    .await
    .map_err(RegistryError::new)?;

    Ok(())
}

async fn fetch_all_in(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
) -> Result<Vec<Actor>, RegistryError> {
    let rows: Vec<ActorColumns> = sqlx::query_as(&format!(
        "SELECT {SELECT_COLUMNS} FROM actors ORDER BY seq"
    ))
    .fetch_all(&mut **tx)
    .await
    .map_err(RegistryError::new)?;

    rows.into_iter().map(to_actor).collect()
}

/// Which mode an actor's advertised endpoints correspond to.
pub(crate) fn mode_of(actor: &Actor) -> TransportMode {
    let has_grpc = actor
        .transports
        .iter()
        .any(|t| t.protocol == TransportProtocol::Grpc);
    let has_http = actor
        .transports
        .iter()
        .any(|t| t.protocol == TransportProtocol::Https);
    match (has_grpc, has_http) {
        (true, true) => TransportMode::Both,
        (true, false) => TransportMode::Grpc,
        _ => TransportMode::Http,
    }
}
