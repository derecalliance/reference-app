//! Resolving the `{actor_id}` path segment shared by most routes.
//!
//! `AppState::actor_inboxes`, `disabled_participants`, `participant_channels`
//! and friends are all keyed by actor UUID, and several of them are written by
//! routes that mean something quite specific by the entry: `disabled_replicas`
//! is consulted by `deliver_message` for *every* actor, so writing an owner's id
//! into it silently drops that owner's mail. Resolving a target from one of
//! those maps therefore says nothing about whether the actor is the right kind
//! of thing for the route acting on it.
//!
//! `AppState::actors` is the registry of what exists and what role it holds, so
//! it is what these routes resolve through.

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use uuid::Uuid;

use crate::{
    models::{Actor, Role},
    state::{AppState, RoleMismatch},
};

/// Reject unless an actor with this id is registered.
///
/// Used by routes that work on any provisioned actor whatever its role — the
/// contact and pairing endpoints, which narrow instead on whether the actor has
/// a backend protocol instance.
pub fn ensure_actor_exists(state: &AppState, actor_id: &Uuid) -> Result<Actor, Response> {
    state
        .actors
        .get(actor_id)
        .ok_or_else(|| not_found("actor not found"))
}

/// Reject unless an actor with this id is registered **and** holds `role`.
///
/// The two rejections differ deliberately. An unknown id is `404`: there is
/// nothing there. A known id of the wrong kind is `400`: the caller named a
/// real actor on a route that cannot act on it, and saying so plainly is more
/// useful than pretending it does not exist — there is no cross-tenant boundary
/// left to protect, so nothing is leaked by admitting it.
pub fn ensure_actor_role(state: &AppState, actor_id: &Uuid, role: Role) -> Result<Actor, Response> {
    state.actors.get_with_role(actor_id, role).map_err(|e| match e {
        RoleMismatch::NotFound => not_found(&format!("{} not found", noun(role))),
        RoleMismatch::WrongRole { actual } => bad_request(&format!(
            "actor is {}, not {}",
            with_article(actual),
            with_article(role)
        )),
    })
}

fn noun(role: Role) -> &'static str {
    match role {
        Role::Owner => "owner",
        Role::Participant => "participant",
        Role::Replica => "replica",
    }
}

/// `owner` is the one role noun starting with a vowel, so the article is picked
/// per role rather than hardcoded to "a".
fn with_article(role: Role) -> String {
    let article = match role {
        Role::Owner => "an",
        Role::Participant | Role::Replica => "a",
    };
    format!("{article} {}", noun(role))
}

pub fn not_found(message: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "error": message })),
    )
        .into_response()
}

pub fn bad_request(message: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({ "error": message })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provisioning::provisioned_actor;
    use crate::state::ActorRegistry;

    fn actor(role: Role) -> Actor {
        provisioned_actor(role, "test", "http://localhost", Some(42))
    }

    /// The registry alone, without an `AppState` (which needs a live Actix
    /// arbiter). `ensure_*` are thin HTTP wrappers over these lookups.
    fn registry_with(actors: Vec<Actor>) -> ActorRegistry {
        let registry = ActorRegistry::default();
        for a in actors {
            registry.register(a);
        }
        registry
    }

    #[test]
    fn a_registered_actor_resolves_whatever_its_role() {
        let owner = actor(Role::Owner);
        let participant = actor(Role::Participant);
        let registry = registry_with(vec![owner.clone(), participant.clone()]);

        assert!(registry.get(&owner.id).is_some());
        assert!(registry.get(&participant.id).is_some());
    }

    #[test]
    fn an_unregistered_actor_is_rejected() {
        let registry = registry_with(vec![actor(Role::Owner)]);

        assert!(registry.get(&actor(Role::Participant).id).is_none());
    }

    #[test]
    fn a_role_route_rejects_an_actor_of_another_role() {
        // Regression: `replicas/{id}/toggle-status` on an owner's id wrote that
        // id into `disabled_replicas`, and `deliver_message` consults it for
        // every actor — silently dropping the owner's entire mailbox.
        let owner = actor(Role::Owner);
        let participant = actor(Role::Participant);
        let registry = registry_with(vec![owner.clone(), participant.clone(), actor(Role::Replica)]);

        assert_eq!(
            registry.get_with_role(&owner.id, Role::Replica).err(),
            Some(RoleMismatch::WrongRole { actual: Role::Owner })
        );
        assert_eq!(
            registry.get_with_role(&participant.id, Role::Replica).err(),
            Some(RoleMismatch::WrongRole {
                actual: Role::Participant
            })
        );
    }

    #[test]
    fn a_role_route_accepts_the_matching_role() {
        let replica = actor(Role::Replica);
        let registry = registry_with(vec![actor(Role::Owner), replica.clone()]);

        assert_eq!(
            registry.get_with_role(&replica.id, Role::Replica).map(|a| a.id),
            Ok(replica.id)
        );
    }
}
