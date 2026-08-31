//! Minting actors and wiring up their inboxes.
//!
//! Kept out of the route modules so the HTTP layer stays thin: handlers decide
//! *whether* to provision and with what, this decides *how*.

use std::sync::Arc;

use actix::Actor as _;
use tokio::sync::{Mutex, mpsc};
use uuid::Uuid;

use crate::{
    actor::{ProtocolConfig, ProvisionedActor},
    models::{Actor, Role, Transport, TransportProtocol, UnpairAck},
    state::{ActorInbox, AppState},
};

/// Point an actor's inbox at a fresh mpsc channel drained by HTTP polling.
///
/// Also the rebind used by the claim flow: `insert` replaces any prior entry,
/// so the previous tab's sender is dropped and its `pollMailbox` returns empty
/// from here on — the new tab now owns the receiver.
pub fn register_browser_actor(state: &AppState, actor_id: Uuid) {
    let (tx, rx) = mpsc::unbounded_channel();
    state.actor_inboxes.insert(actor_id, ActorInbox::Browser(tx));
    state.browser_receivers.insert(actor_id, Arc::new(Mutex::new(rx)));
}

/// Spawn a backend-managed actor.
///
/// No protocol instance is created here: an instance is bound to one
/// `secret_id`, and which secret this actor will serve is only known once a
/// pairing is driven against it. The actor builds instances on demand from
/// this config — see [`ProvisionedActor`].
pub fn spawn_provisioned(state: &AppState, actor: &Actor, timeout_secs: u32, unpair_ack: UnpairAck) {
    let actor_id = actor.id;
    let role = actor.role;
    let secret_id: u64 = match actor.secret_id.parse() {
        Ok(v) => v,
        Err(_) => {
            tracing::error!(actor_id = %actor_id, "actor has an unparseable secret_id; not spawning");
            return;
        }
    };

    let communication_info =
        std::collections::HashMap::from([("name".to_owned(), actor.name.clone())]);

    let config = ProtocolConfig {
        secret_id,
        transport_uri: actor.transport.uri.clone(),
        communication_info,
        timeout_secs,
        unpair_ack,
        threshold: 2,
        keep_versions_count: 3,
        // Every actor may take part in replica-mode pairing: the source is an
        // Owner, the destination a Replica. Both sides need a stable id, so it
        // is assigned unconditionally rather than by role.
        replica_id: Some(rand::random::<u64>()),
        http_client: state.http_client.clone(),
    };

    let protocol = match crate::actor::build_protocol(&config) {
        Ok(p) => p,
        Err(e) => {
            tracing::error!(actor_id = %actor_id, error = %e, "failed to build protocol; not spawning");
            return;
        }
    };

    let app_state = Arc::new(state.clone());

    let addr = ProvisionedActor::start_in_arbiter(&state.arbiter, move |_ctx| {
        ProvisionedActor::new(protocol, actor_id, role, app_state)
    });

    state.actor_inboxes.insert(actor_id, ActorInbox::Provisioned(addr));
}

/// Decides the `secret_id` a newly minted actor binds its protocol to.
///
/// A replica destination mirrors one named owner's vault, and the share store
/// keys on `(secret_id, channel_id, version, replica_id)` — a destination under
/// a different `secret_id` would miss every lookup. It therefore inherits the
/// owner's, resolved by the caller from the explicit `owner_actor_id` on the
/// request (see `replicas::resolve_owner_secret_id`). Every other role protects
/// its own secret, and the argument is ignored for them.
///
/// There is deliberately no "find the owner" fallback: several `Role::Owner`
/// actors are routinely registered at once — one per browser context — so a
/// guess would not error, it would silently bind the replica to the wrong vault.
fn actor_secret_id(role: Role, owner_secret_id: Option<u64>) -> u64 {
    match (role, owner_secret_id) {
        (Role::Replica, Some(owner)) => owner,
        _ => rand::random::<u64>(),
    }
}

/// Mint a new actor.
///
/// `owner_secret_id` is only read for `Role::Replica` — see [`actor_secret_id`].
pub fn provisioned_actor(
    role: Role,
    name: &str,
    base_url: &str,
    owner_secret_id: Option<u64>,
) -> Actor {
    let actor_id = Uuid::new_v4();
    Actor {
        id: actor_id,
        role,
        name: name.to_owned(),
        transport: Transport {
            protocol: TransportProtocol::Https,
            uri: format!("{base_url}/derec/{}/{actor_id}", role.path_segment()),
        },
        secret_id: actor_secret_id(role, owner_secret_id).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replica_inherits_the_owner_secret_id() {
        let owner = 0xDEAD_BEEF_u64;
        assert_eq!(actor_secret_id(Role::Replica, Some(owner)), owner);
    }

    #[test]
    fn non_replicas_get_their_own_secret_id() {
        // Two assertions rather than one `assert_ne!` against a constant: an
        // implementation that returned `owner` for every role would make the
        // two calls *equal to each other* as well as equal to `owner`, so the
        // second assertion catches it without relying on a random draw missing
        // a fixed value.
        let owner = 0xDEAD_BEEF_u64;

        for role in [Role::Participant, Role::Owner] {
            let first = actor_secret_id(role, Some(owner));
            let second = actor_secret_id(role, Some(owner));
            assert_ne!(first, owner, "{role:?} must not inherit the owner's secret id");
            assert_ne!(first, second, "{role:?} must get a fresh id each time");
        }
    }

    #[test]
    fn replica_without_a_known_owner_falls_back_to_a_fresh_id() {
        // A replica added with no resolvable owner must still get a usable,
        // freshly drawn id rather than panicking or reusing a constant;
        // adoption will reseat it later.
        let first = actor_secret_id(Role::Replica, None);
        let second = actor_secret_id(Role::Replica, None);
        assert_ne!(first, 0);
        assert_ne!(first, second);
    }

    #[test]
    fn a_transport_uri_carries_the_role_segment_and_actor_id() {
        // The URI is what peers post to, and `deliver_message` parses the role
        // back out of it, so the two must agree on the segment vocabulary.
        for (role, segment) in [
            (Role::Owner, "owners"),
            (Role::Participant, "participants"),
            (Role::Replica, "replicas"),
        ] {
            let actor = provisioned_actor(role, "test", "http://localhost:5000", Some(42));

            assert_eq!(
                actor.transport.uri,
                format!("http://localhost:5000/derec/{segment}/{}", actor.id)
            );
            assert_eq!(Role::from_path_segment(segment), Some(role));
        }
    }
}
