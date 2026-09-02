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
    models::{Actor, Role, TransportMode, UnpairAck},
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
/// The own instance, bound to `secret_id`, is built eagerly here. Any further
/// instance — a replica bound to a different owner's secret — is added later,
/// on demand, via `EnsureReplicaInstanceMsg`; see [`ProvisionedActor`].
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
        own_transports: actor.transports.clone(),
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

    // The actor keeps the config so it can rebuild an instance in place when
    // settings change — see `ReconfigureMsg`.
    let addr = ProvisionedActor::start_in_arbiter(&state.arbiter, move |_ctx| {
        ProvisionedActor::new(protocol, config, actor_id, role, app_state)
    });

    state.actor_inboxes.insert(actor_id, ActorInbox::Provisioned(addr));
}

/// Every actor protects its own secret. A replica relationship no longer
/// changes this: it is an extra protocol *instance* bound to the mirrored
/// owner's secret, added on demand by `EnsureReplicaInstanceMsg`, not a
/// different actor with a different identity.
fn actor_secret_id() -> u64 {
    rand::random::<u64>()
}

/// Mint a new actor.
pub fn provisioned_actor(
    role: Role,
    name: &str,
    base_url: &str,
    grpc_authority: &str,
    mode: TransportMode,
) -> Actor {
    let actor_id = Uuid::new_v4();
    let transports = mode.endpoints(base_url, grpc_authority, actor_id);
    Actor {
        id: actor_id,
        role,
        name: name.to_owned(),
        transport: transports[0].clone(),
        transports,
        secret_id: actor_secret_id().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::TransportProtocol;

    #[test]
    fn every_actor_gets_its_own_freshly_drawn_secret_id() {
        let first = actor_secret_id();
        let second = actor_secret_id();

        assert_ne!(first, 0);
        assert_ne!(first, second, "each actor must get a fresh id");
    }

    #[test]
    fn an_http_helper_advertises_only_its_http_endpoint() {
        // The URI is what peers post to, and `deliver_message` parses the id
        // back out of it, so the two must agree on the shape.
        let actor = provisioned_actor(
            Role::Helper,
            "test",
            "http://localhost:5000",
            "localhost:50051",
            TransportMode::Http,
        );

        assert_eq!(actor.transports.len(), 1);
        assert_eq!(
            actor.transports[0].uri,
            format!("http://localhost:5000/derec/{}", actor.id)
        );
        assert_eq!(actor.transports[0].protocol, TransportProtocol::Https);
    }

    #[test]
    fn a_grpc_helper_advertises_an_authority_with_no_actor_path() {
        // gRPC has no path to carry an actor id — the id is recovered from the
        // envelope's channel id instead.
        let actor = provisioned_actor(
            Role::Helper,
            "test",
            "http://localhost:5000",
            "localhost:50051",
            TransportMode::Grpc,
        );

        assert_eq!(actor.transports.len(), 1);
        assert_eq!(actor.transports[0].uri, "grpc://localhost:50051");
        assert_eq!(actor.transports[0].protocol, TransportProtocol::Grpc);
    }

    #[test]
    fn a_both_helper_advertises_grpc_first() {
        // An arbitrary but fixed app preference: the order carries no protocol
        // meaning, and the library takes no view on which a dialer picks.
        let actor = provisioned_actor(
            Role::Helper,
            "test",
            "http://localhost:5000",
            "localhost:50051",
            TransportMode::Both,
        );

        assert_eq!(actor.transports.len(), 2);
        assert_eq!(actor.transports[0].protocol, TransportProtocol::Grpc);
        assert_eq!(actor.transports[1].protocol, TransportProtocol::Https);
    }

    #[test]
    fn the_singular_transport_mirrors_the_first_entry() {
        // Four front-end call sites read `transport.uri` as "an address for
        // this actor"; it must never disagree with the head of the list.
        let actor = provisioned_actor(
            Role::Helper,
            "test",
            "http://localhost:5000",
            "localhost:50051",
            TransportMode::Both,
        );

        assert_eq!(actor.transport, actor.transports[0]);
    }
}
