// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The gRPC ingress listener.
//!
//! One listener serves the whole process. gRPC has no path segment to carry an
//! actor id — tonic builds the request URI from the endpoint authority plus the
//! fixed method path — so the target actor is resolved from the cleartext
//! `channel_id` on the envelope. See [`super::routing`].

use std::sync::Arc;

use tonic::{Request, Response, Status};
use tracing::{error, info};
use uuid::Uuid;

use crate::models::SENDER_METADATA;
use crate::services::delivery::{DeliveryService, GrpcRefusal, MAX_MESSAGE_BYTES};

pub mod pb {
    tonic::include_proto!("org.derecalliance.derec.protobuf");
}

use pb::de_rec_transport_server::{DeRecTransport, DeRecTransportServer};

/// The `DeRecTransport` service: unwraps each call, hands it to the delivery
/// service, and answers with the gRPC status its outcome maps to.
pub struct GrpcIngress {
    delivery: Arc<dyn DeliveryService>,
}

impl GrpcIngress {
    /// Serve `DeRecTransport` over `delivery`.
    ///
    /// A real constructor (not `pub(crate)`) so integration tests under
    /// `tests/` — a separate crate — can drive `send` directly against a
    /// `GrpcIngress` without binding a socket.
    pub fn new(delivery: Arc<dyn DeliveryService>) -> Self {
        Self { delivery }
    }
}

#[tonic::async_trait]
impl DeRecTransport for GrpcIngress {
    async fn send(
        &self,
        request: Request<derec_proto::DeRecMessage>,
    ) -> Result<Response<()>, Status> {
        // Read before `into_inner` consumes the request. Absent from any peer
        // but this node's own actors — see `SENDER_METADATA`.
        let sender = sender_hint(&request);
        let envelope = request.into_inner();

        self.delivery
            .receive_grpc(envelope, sender)
            .await
            .map(Response::new)
            .map_err(Status::from)
    }
}

impl From<GrpcRefusal> for Status {
    fn from(refusal: GrpcRefusal) -> Self {
        match refusal {
            GrpcRefusal::NotFound(message) => Status::not_found(message),
            GrpcRefusal::FailedPrecondition(message) => Status::failed_precondition(message),
            GrpcRefusal::ResourceExhausted(message) => Status::resource_exhausted(message),
            GrpcRefusal::Unavailable(message) => Status::unavailable(message),
        }
    }
}

/// The sending actor this node's own gRPC client stamped on the call, if any.
///
/// A malformed value is treated as absent rather than refused: the hint only
/// narrows a choice between local claimants, and a call without it is still
/// routable whenever the channel has a single one.
fn sender_hint<T>(request: &Request<T>) -> Option<Uuid> {
    request
        .metadata()
        .get(SENDER_METADATA)
        .and_then(|value| value.to_str().ok())
        .and_then(|text| text.parse().ok())
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
pub async fn serve(
    delivery: Arc<dyn DeliveryService>,
    incoming: tonic::transport::server::TcpIncoming,
) {
    info!("gRPC transport listening");

    if let Err(e) = tonic::transport::Server::builder()
        .add_service(
            DeRecTransportServer::new(GrpcIngress::new(delivery))
                .max_decoding_message_size(MAX_MESSAGE_BYTES),
        )
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
        let port = first
            .local_addr()
            .expect("bound socket has a local address")
            .port();

        assert!(
            bind(port).is_err(),
            "a second bind to the same port must fail, not silently succeed"
        );
    }
}
