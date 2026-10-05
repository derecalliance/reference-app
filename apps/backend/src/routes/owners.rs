// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use tracing::info;
use uuid::Uuid;

use crate::{
    models::{
        RegisterOwnerRequest, RegisterOwnerResponse, RenameOwnerRequest, RenameOwnerResponse,
        Role, TransportMode, validate_display_name,
    },
    provisioning::{provisioned_actor, register_browser_actor},
    routes::actor_guard::not_found,
    routes::api_error::{ApiError, ApiJson, ApiPath},
    state::AppState,
};

/// POST /owners
///
/// Registers the browser context calling it as an owner actor and hands back a
/// mailbox it can poll. Every browser context that wants to take part does this
/// once — there is no wider container to join, so a second tab is simply a
/// second owner on the same server.
///
/// Two modes, both answering `201`:
///   - **Normal**: mints a new owner actor. `name` is trimmed and must be
///     1–64 characters.
///   - **Claim** (when `claim_actor_id` is set): adopts an existing owner
///     actor's identity. Used by the recovery flow so the recovering user can
///     poll the mailbox tied to an old transport URI that the network still
///     recognizes (helpers' channel stores still point at it). `name` is not
///     used — the actor keeps the one it has. The mailbox is kept, not
///     replaced: anything that queued for this actor while no tab was polling
///     is delivered on the claiming tab's first poll.
pub async fn register(
    State(state): State<Arc<AppState>>,
    ApiJson(req): ApiJson<RegisterOwnerRequest>,
) -> Response {
    let actor = match req.claim_actor_id {
        Some(claim_actor_id) => {
            let found = match state
                .actors
                .get_with_role(&claim_actor_id, Role::Owner)
                .await
            {
                Ok(found) => found,
                Err(e) => return crate::routes::actor_guard::registry_unavailable(e),
            };

            match found {
                Ok(actor) => {
                    info!(
                        actor_id = %actor.id,
                        name = %actor.name,
                        "owner actor reclaimed in recovery mode"
                    );
                    actor
                }
                Err(_) => {
                    return not_found("claim_actor_id is not a registered owner actor");
                }
            }
        }
        None => {
            let name = match validate_display_name(&req.name, "name") {
                Ok(name) => name,
                Err(message) => return ApiError::bad_request(message).into_response(),
            };
            let actor = provisioned_actor(
                Role::Owner,
                &name,
                &state.base_url,
                &state.grpc_authority(),
                TransportMode::Http,
            );
            // A browser-run actor's protocol settings live in the page; these
            // are stored so the row is well-formed and are never read back.
            let settings = crate::registry::actors::ActorSettings {
                replica_id: rand::random::<u64>(),
                timeout_secs: state.defaults.protocol_timeout_secs,
                unpair_ack: state.defaults.unpair_ack,
            };
            if let Err(e) = state.actors.register(actor.clone(), settings).await {
                return crate::routes::actor_guard::registry_unavailable(e);
            }
            info!(actor_id = %actor.id, name = %actor.name, "owner registered");
            actor
        }
    };

    // Idempotent: a claimed actor keeps the mailbox it already has.
    register_browser_actor(&state, actor.id);

    (StatusCode::CREATED, Json(RegisterOwnerResponse { actor })).into_response()
}

/// PATCH /owners/:owner_id
///
/// Renames a browser-managed owner. The new name is what `GET /actors` lists
/// and what a later claim of this actor hands back; the page's own protocol
/// instance decides separately what it tells its peers.
///
/// `name` is held to the registration rules (trimmed, 1–64 characters, no
/// control characters) — `400` otherwise. An id naming no actor, or a helper,
/// is `404`: there is no owner by that id to rename.
pub async fn rename(
    State(state): State<Arc<AppState>>,
    ApiPath(owner_id): ApiPath<Uuid>,
    ApiJson(req): ApiJson<RenameOwnerRequest>,
) -> Response {
    let name = match validate_display_name(&req.name, "name") {
        Ok(name) => name,
        Err(message) => return ApiError::bad_request(message).into_response(),
    };

    match state.actors.rename_owner(&owner_id, &name).await {
        Ok(true) => {}
        Ok(false) => return not_found("no owner actor with this id"),
        Err(e) => return crate::routes::actor_guard::registry_unavailable(e),
    }

    info!(actor_id = %owner_id, name = %name, "owner renamed");

    (
        StatusCode::OK,
        Json(RenameOwnerResponse { id: owner_id, name }),
    )
        .into_response()
}
