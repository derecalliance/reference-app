//! The gRPC ingress listener.
//!
//! One listener serves the whole process. gRPC has no path segment to carry an
//! actor id — tonic builds the request URI from the endpoint authority plus the
//! fixed method path — so the target actor is resolved from the cleartext
//! `channel_id` on the envelope. See [`crate::routing`].

use std::sync::Arc;

use tonic::{Request, Response, Status};
use tracing::{error, info};

use crate::routes::derec::{DispatchOutcome, dispatch_to_inbox};
use crate::state::AppState;

pub mod pb {
    tonic::include_proto!("org.derecalliance.derec.protobuf");
}

use pb::de_rec_transport_server::{DeRecTransport, DeRecTransportServer};

pub struct GrpcIngress {
    state: Arc<AppState>,
}

impl GrpcIngress {
    /// Wrap `state` for serving `DeRecTransport`.
    ///
    /// Exposed as a real constructor (not `pub(crate)`) so integration tests
    /// under `tests/` — a separate crate — can drive `send` directly against
    /// a `GrpcIngress` without binding a socket.
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }
}

#[tonic::async_trait]
impl DeRecTransport for GrpcIngress {
    async fn send(
        &self,
        request: Request<derec_proto::DeRecMessage>,
    ) -> Result<Response<()>, Status> {
        let envelope = request.into_inner();
        let channel_id = envelope.channel_id;

        let Some(actor_id) = self.state.channel_router.resolve(channel_id) else {
            // Refused rather than guessed. A wrong guess delivers a peer's
            // message to an actor that does not own the channel.
            return Err(Status::not_found(format!(
                "no actor holds channel {channel_id}"
            )));
        };

        // Re-encode rather than pass the decoded message on: every inbox in
        // this app takes wire bytes, because that is what
        // `DeRecProtocol::process` takes.
        let bytes = prost::Message::encode_to_vec(&envelope);

        match dispatch_to_inbox(&self.state, actor_id, crate::debug::Carrier::Grpc, bytes).await {
            // A dropped message is still an accepted call: "offline" is a
            // simulation of an unreachable peer, and the peer's transport
            // should see the same success it sees over HTTP.
            DispatchOutcome::Delivered | DispatchOutcome::Dropped => Ok(Response::new(())),
            DispatchOutcome::NoInbox => Err(Status::not_found("actor inbox not found")),
        }
    }
}

/// Bind the gRPC listen socket.
///
/// Split out of [`serve`] so the caller can observe a bind failure at
/// startup, synchronously, rather than inside a detached task: a helper
/// advertising an endpoint nothing is listening on pairs successfully and
/// then black-holes every reply, which is exactly what an unobserved bind
/// failure would produce.
pub fn bind(port: u16) -> std::io::Result<tonic::transport::server::TcpIncoming> {
    let addr = format!("0.0.0.0:{port}")
        .parse()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
    tonic::transport::server::TcpIncoming::bind(addr)
}

/// Serve gRPC ingress on an already-bound socket, until the process ends.
pub async fn serve(state: Arc<AppState>, incoming: tonic::transport::server::TcpIncoming) {
    info!("gRPC transport listening");

    if let Err(e) = tonic::transport::Server::builder()
        .add_service(DeRecTransportServer::new(GrpcIngress::new(state)))
        .serve_with_incoming(incoming)
        .await
    {
        error!(error = %e, "gRPC server stopped");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // `bind` exists specifically so main can observe a taken port at startup
    // instead of inside a detached task that silently swallows the failure —
    // so its own failure path is what these tests hold onto.

    // `TcpIncoming::bind` registers the socket with the Tokio reactor, so it
    // panics outside a running runtime — `#[tokio::test]` rather than
    // `#[test]`. Production calls it from inside `#[tokio::main]`, which is
    // already such a runtime by the time `main`'s body runs.

    #[tokio::test]
    async fn binding_an_available_port_succeeds() {
        // Port 0 asks the OS for whichever ephemeral port is free, so this
        // does not race other tests or a real gRPC listener on the machine.
        assert!(bind(0).is_ok());
    }

    #[tokio::test]
    async fn binding_an_already_bound_port_fails() {
        let first = bind(0).expect("first bind must succeed");
        let port = first.local_addr().expect("bound socket has a local address").port();

        assert!(
            bind(port).is_err(),
            "a second bind to the same port must fail, not silently succeed"
        );
    }
}
