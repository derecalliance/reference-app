use std::sync::Arc;

use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use tracing::info;

use crate::{
    models::{RegisterOwnerRequest, RegisterOwnerResponse, Role, TransportMode},
    provisioning::{provisioned_actor, register_browser_actor},
    routes::actor_guard::not_found,
    state::AppState,
};

/// POST /owners
///
/// Registers the browser context calling it as an owner actor and hands back a
/// mailbox it can poll. Every browser context that wants to take part does this
/// once — there is no wider container to join, so a second tab is simply a
/// second owner on the same server.
///
/// Two modes:
///   - **Normal**: mints a new owner actor.
///   - **Claim** (when `claim_actor_id` is set): adopts an existing owner
///     actor's identity. Used by the recovery flow so the recovering user can
///     poll the mailbox tied to an old transport URI that the network still
///     recognizes (helpers' channel stores still point at it). The mailbox is
///     rebound to a fresh receiver so the new tab starts receiving; any
///     previous tab silently stops.
pub async fn register(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegisterOwnerRequest>,
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
            let actor = provisioned_actor(
                Role::Owner,
                &req.name,
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

    register_browser_actor(&state, actor.id);

    (StatusCode::CREATED, Json(RegisterOwnerResponse { actor })).into_response()
}
