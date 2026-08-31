use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use tracing::info;
use uuid::Uuid;

use crate::{
    actor::{GetFingerprintMsg, VerifyFingerprintMsg},
    models::{Actor, AddReplicaRequest, AddReplicaResponse, Role},
    provisioning::{provisioned_actor, spawn_provisioned},
    routes::actor_guard::{bad_request, ensure_actor_role, not_found},
    routes::actors::provisioned_addr,
    routes::participants::{SetStatusRequest, ToggleStatusResponse},
    state::{ActorRegistry, AppState, RoleMismatch},
};

/// Why the `owner_actor_id` on an `add_replica` request could not be used.
#[derive(Debug, PartialEq, Eq)]
pub enum OwnerTargetError {
    NotFound,
    NotAnOwner,
    /// The stored `secret_id` is not a `u64` — a backend invariant violation,
    /// not a caller error.
    UnparseableSecretId,
}

/// The `secret_id` a new replica must bind its protocol instance to.
///
/// A replica mirrors **one named owner's** vault, and the share store keys on
/// `(secret_id, channel_id, version, replica_id)` — so a replica seeded from
/// the wrong owner would not error, it would silently miss every subsequent
/// lookup. Several `Role::Owner` actors may legitimately be registered at once
/// (one per browser context), so the owner is named by the caller and resolved
/// here rather than guessed from the roster.
fn resolve_owner_secret_id(
    actors: &ActorRegistry,
    owner_actor_id: &Uuid,
) -> Result<u64, OwnerTargetError> {
    let owner = actors
        .get_with_role(owner_actor_id, Role::Owner)
        .map_err(|e| match e {
            RoleMismatch::NotFound => OwnerTargetError::NotFound,
            RoleMismatch::WrongRole { .. } => OwnerTargetError::NotAnOwner,
        })?;

    owner
        .secret_id
        .parse()
        .map_err(|_| OwnerTargetError::UnparseableSecretId)
}

/// POST /replicas
///
/// Mints a **provisioned** (backend-run) replica fixture. A replica mirrors one
/// specific owner's vault, not "the owner": several `Role::Owner` actors may be
/// registered at once — one per browser context — so the caller names which one
/// explicitly via `owner_actor_id`. Falling back to "the" owner would silently
/// mis-key the replica's shares.
pub async fn add(State(state): State<Arc<AppState>>, Json(req): Json<AddReplicaRequest>) -> Response {
    let owner_secret_id = match resolve_owner_secret_id(&state.actors, &req.owner_actor_id) {
        Ok(id) => id,
        Err(OwnerTargetError::NotFound) => {
            return not_found("owner_actor_id is not a registered actor");
        }
        Err(OwnerTargetError::NotAnOwner) => {
            return bad_request("owner_actor_id does not refer to an owner actor");
        }
        Err(OwnerTargetError::UnparseableSecretId) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "owner actor has an invalid secret id" })),
            )
                .into_response();
        }
    };

    let (timeout_secs, unpair_ack) = req.settings.resolve(&state.defaults);

    let replica = provisioned_actor(Role::Replica, &req.name, &state.base_url, Some(owner_secret_id));

    spawn_provisioned(&state, &replica, timeout_secs, unpair_ack);
    state.actors.register(replica.clone());

    info!(
        replica_id = %replica.id,
        owner_actor_id = %req.owner_actor_id,
        "replica provisioned"
    );

    (StatusCode::CREATED, Json(AddReplicaResponse { actor: replica })).into_response()
}

#[derive(Debug, Serialize)]
pub struct GetFingerprintResponse {
    pub fingerprint: String,
}

#[derive(Debug, Deserialize)]
pub struct ConfirmFingerprintRequest {
    pub channel_id: String,
    pub fingerprint: String,
}

/// The replica's current channel, or the response explaining why it has none.
///
/// Both fingerprint endpoints need the same thing: a registered replica that
/// has actually paired, with a channel id the backend can parse.
fn paired_channel_id(state: &AppState, replica_id: &Uuid) -> Result<(String, u64), Response> {
    let channel_id_str = state
        .replica_channels
        .get(replica_id)
        .and_then(|v| v.value().last().cloned())
        .ok_or_else(|| {
            (
                StatusCode::CONFLICT,
                Json(serde_json::json!({ "error": "replica not yet paired" })),
            )
                .into_response()
        })?;

    let channel_id = channel_id_str.parse::<u64>().map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "invalid channel ID" })),
        )
            .into_response()
    })?;

    Ok((channel_id_str, channel_id))
}

/// Resolve a replica endpoint's target: a registered `Role::Replica` actor that
/// has a backend protocol instance to answer for it.
///
/// A second browser device mirroring an owner is not one — it registers as an
/// ordinary `Role::Owner` and derives fingerprints in its own context.
fn replica_with_instance(
    state: &AppState,
    replica_id: &Uuid,
) -> Result<(Actor, actix::Addr<crate::actor::ProvisionedActor>), Response> {
    let replica = ensure_actor_role(state, replica_id, Role::Replica)?;

    let addr = provisioned_addr(state, replica_id)
        .ok_or_else(|| bad_request("replica has no backend protocol instance"))?;

    Ok((replica, addr))
}

/// GET /replicas/:replica_id/fingerprint
///
/// The backend computes this from its own protocol instance for the replica, so
/// a replica with no such instance cannot be queried here.
pub async fn get_fingerprint(
    State(state): State<Arc<AppState>>,
    Path(replica_id): Path<Uuid>,
) -> Response {
    let addr = match replica_with_instance(&state, &replica_id) {
        Ok((_, addr)) => addr,
        Err(response) => return response,
    };

    let (channel_id_str, channel_id) = match paired_channel_id(&state, &replica_id) {
        Ok(ids) => ids,
        Err(response) => return response,
    };

    match addr.send(GetFingerprintMsg { channel_id }).await {
        Ok(Ok(fingerprint)) => {
            info!(
                replica_id = %replica_id,
                channel_id = %channel_id_str,
                "replica fingerprint retrieved"
            );
            (StatusCode::OK, Json(GetFingerprintResponse { fingerprint })).into_response()
        }
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("get_fingerprint failed: {e}") })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("actor mailbox error: {e}") })),
        )
            .into_response(),
    }
}

/// POST /replicas/:replica_id/confirm-fingerprint
///
/// Transitions the replica channel from `Pending` to `Paired` once this side
/// verifies the peer's fingerprint matches the locally derived one. A
/// mismatch is a normal, retryable outcome (`400`), not a server error.
pub async fn confirm_fingerprint(
    State(state): State<Arc<AppState>>,
    Path(replica_id): Path<Uuid>,
    Json(req): Json<ConfirmFingerprintRequest>,
) -> Response {
    let addr = match replica_with_instance(&state, &replica_id) {
        Ok((_, addr)) => addr,
        Err(response) => return response,
    };

    let (stored_channel_id, channel_id) = match paired_channel_id(&state, &replica_id) {
        Ok(ids) => ids,
        Err(response) => return response,
    };

    if req.channel_id != stored_channel_id {
        return bad_request("channel_id mismatch");
    }

    match addr
        .send(VerifyFingerprintMsg { channel_id, fingerprint: req.fingerprint.clone() })
        .await
    {
        Ok(Ok(true)) => {
            state.replica_confirmed.insert(replica_id, ());
            info!(
                replica_id = %replica_id,
                channel_id = %stored_channel_id,
                "replica fingerprint confirmed"
            );
            (StatusCode::OK, Json(serde_json::json!({ "confirmed": true }))).into_response()
        }
        Ok(Ok(false)) => bad_request("fingerprint mismatch"),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("verify_fingerprint failed: {e}") })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("actor mailbox error: {e}") })),
        )
            .into_response(),
    }
}

/// POST /replicas/:replica_id/toggle-status
///
/// Simulates the replica going offline/online. The role check matters:
/// `disabled_replicas` is consulted by `deliver_message` for every actor, so
/// writing an owner's id into it would silently drop that owner's mail.
pub async fn toggle_status(
    State(state): State<Arc<AppState>>,
    Path(replica_id): Path<Uuid>,
    body: Option<Json<SetStatusRequest>>,
) -> Response {
    if let Err(response) = ensure_actor_role(&state, &replica_id, Role::Replica) {
        return response;
    }

    let want_disabled = match body {
        Some(Json(req)) => req.disabled,
        None => !state.disabled_replicas.contains_key(&replica_id),
    };

    if want_disabled {
        state.disabled_replicas.insert(replica_id, ());
    } else {
        state.disabled_replicas.remove(&replica_id);
    }

    info!(
        replica_id = %replica_id,
        disabled = want_disabled,
        "replica status updated"
    );

    (
        StatusCode::OK,
        Json(ToggleStatusResponse { disabled: want_disabled }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry_with(actors: Vec<Actor>) -> ActorRegistry {
        let registry = ActorRegistry::default();
        for a in actors {
            registry.register(a);
        }
        registry
    }

    fn actor(role: Role) -> Actor {
        provisioned_actor(role, "test", "http://localhost", Some(42))
    }

    /// An owner with an explicitly chosen `secret_id`, so a test can assert
    /// *which* owner a replica inherited from rather than merely "some u64".
    fn owner_with_secret(secret_id: u64) -> Actor {
        let mut owner = actor(Role::Owner);
        owner.secret_id = secret_id.to_string();
        owner
    }

    // ── `owner_actor_id` with several owners registered ──────────────────────
    //
    // The entire reason `AddReplicaRequest` carries `owner_actor_id`: several
    // independent `Role::Owner` actors are routinely registered at once (one per
    // browser context), so "the owner" is not a thing. A replica seeded from the
    // wrong owner does not error — it silently misses every share lookup,
    // because the store keys on `secret_id`.

    const ALICE_SECRET: u64 = 0x1111_1111_1111_1111;
    const BOB_SECRET: u64 = 0x2222_2222_2222_2222;

    #[test]
    fn a_replica_inherits_the_named_owners_secret_id_when_two_owners_exist() {
        let alice = owner_with_secret(ALICE_SECRET);
        let bob = owner_with_secret(BOB_SECRET);
        // Bob is *second* in the roster, so a "first owner wins" implementation
        // would resolve Alice and this would fail.
        let actors = registry_with(vec![alice.clone(), bob.clone(), actor(Role::Participant)]);

        assert_eq!(resolve_owner_secret_id(&actors, &bob.id), Ok(BOB_SECRET));

        // And the replica actually built from it carries that same secret — the
        // property the share store depends on.
        let replica = provisioned_actor(
            Role::Replica,
            "Bob's laptop",
            "http://localhost",
            Some(BOB_SECRET),
        );
        assert_eq!(replica.secret_id, bob.secret_id);
        assert_ne!(replica.secret_id, alice.secret_id);
    }

    #[test]
    fn naming_the_other_owner_resolves_the_other_secret_id() {
        // The mirror of the test above: a "last owner wins" implementation
        // would pass that one and fail this.
        let alice = owner_with_secret(ALICE_SECRET);
        let actors = registry_with(vec![
            alice.clone(),
            owner_with_secret(BOB_SECRET),
            actor(Role::Participant),
        ]);

        assert_eq!(resolve_owner_secret_id(&actors, &alice.id), Ok(ALICE_SECRET));
    }

    #[test]
    fn an_unregistered_owner_cannot_be_named() {
        let stranger = owner_with_secret(ALICE_SECRET);
        let actors = registry_with(vec![owner_with_secret(BOB_SECRET)]);

        assert_eq!(
            resolve_owner_secret_id(&actors, &stranger.id),
            Err(OwnerTargetError::NotFound)
        );
    }

    #[test]
    fn a_non_owner_actor_cannot_be_named() {
        let participant = actor(Role::Participant);
        let actors = registry_with(vec![owner_with_secret(ALICE_SECRET), participant.clone()]);

        assert_eq!(
            resolve_owner_secret_id(&actors, &participant.id),
            Err(OwnerTargetError::NotAnOwner)
        );
    }

    #[test]
    fn a_malformed_owner_secret_id_is_reported_rather_than_panicking() {
        let mut owner = actor(Role::Owner);
        owner.secret_id = "not-a-u64".to_owned();
        let actors = registry_with(vec![owner.clone()]);

        assert_eq!(
            resolve_owner_secret_id(&actors, &owner.id),
            Err(OwnerTargetError::UnparseableSecretId)
        );
    }
}
