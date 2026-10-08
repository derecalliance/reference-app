// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Outbound `DeRecTransport` implementations.
//!
//! The library filters a peer's advertised endpoints and hands the survivors
//! to [`DeRecTransport::send`] in the peer's own order, taking no view on
//! which to dial — choosing, and failing over when one is unreachable, is
//! this module's job. [`CompositeTransport`] is the actor's transport: it
//! dispatches each endpoint to whichever client ([`HttpTransport`] or
//! [`GrpcTransport`]) can dial its advertised protocol, walking the list in
//! the peer's order and stopping at the first delivery that succeeds.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use derec_library::protocol::{DeRecTransport, TransportFuture};
use derec_proto::TransportProtocol;
use prost::Message as _;
use uuid::Uuid;

use crate::models::{LocalAttempt, SENDER_METADATA};
use crate::services::delivery::{DialError, LocalDelivery, PeerDialer};

/// How [`CompositeTransport`] reports that the peer advertised nothing it can
/// dial. The SDK's transport trait returns its own error type and has no
/// richer variant for this, so it travels as an invariant with this reason —
/// see [`is_unreachable`].
pub const NO_DIALABLE_ENDPOINT: &str = "transport: peer advertised no dialable endpoint";

/// How [`CompositeTransport`] reports that every endpoint it tried failed.
pub const NO_ENDPOINT_ACCEPTED: &str = "transport: no endpoint accepted the message";

/// Whether `e` is one of this node's own transport failures surfacing through
/// a protocol call: the peer could not be reached.
pub fn is_unreachable(e: &derec_library::Error) -> bool {
    matches!(
        e,
        derec_library::Error::Invariant(reason)
            if *reason == NO_DIALABLE_ENDPOINT || *reason == NO_ENDPOINT_ACCEPTED
    )
}

// ── HTTP transport ───────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct HttpTransport {
    client: reqwest::Client,
}

impl HttpTransport {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }

    fn client(&self) -> reqwest::Client {
        self.client.clone()
    }

    /// One delivery attempt. The failure reason is a `String` rather than a
    /// protocol error because it is only ever logged: what reaches the caller
    /// is whether *any* endpoint accepted.
    async fn post(client: &reqwest::Client, uri: &str, message: Vec<u8>) -> Result<(), String> {
        let resp = client
            .post(uri)
            .header("Content-Type", "application/octet-stream")
            .body(message)
            .send()
            .await;

        match resp {
            Ok(r) if r.status().is_success() => Ok(()),
            Ok(r) => Err(format!("non-success HTTP status {}", r.status())),
            Err(e) => Err(e.to_string()),
        }
    }
}

// ── gRPC transport ───────────────────────────────────────────────────────────

/// Rewrite a DeRec endpoint URI into the http-family URL a gRPC client dials.
///
/// `grpc://` and `grpcs://` are the spellings the protocol validates and
/// advertises; the wire underneath is ordinary HTTP/2.
///
/// `grpcs://` yields an `https://` URL that a default-features `tonic` cannot
/// dial — it is built with no TLS backend. This app is plaintext loopback and
/// does not enable one; see the spec's non-goals.
pub fn dial_uri(uri: &str) -> String {
    uri.replacen("grpcs://", "https://", 1)
        .replacen("grpc://", "http://", 1)
}

/// How long a gRPC dial may take to establish a connection.
///
/// An actor's protocol instance is borrowed for the whole of a `send`, and
/// every other message for that instance is dropped as "instance busy" while
/// it is out. A black-holed peer — a firewalled port, a host that went away —
/// would otherwise hold it for the OS's TCP connect timeout, which is minutes.
pub const GRPC_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// How long one gRPC `Send` may take end to end, connection included.
///
/// A peer that accepts the connection and never answers is the same hazard as
/// one that never accepts it, so the call itself is bounded too.
pub const GRPC_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Delivers each envelope as one unary `DeRecTransport.Send` call.
///
/// Both timeouts are always applied — see [`GRPC_CONNECT_TIMEOUT`] and
/// [`GRPC_REQUEST_TIMEOUT`] — whether the call is an actor's own or one the
/// relay makes on a browser's behalf.
#[derive(Clone, Default)]
pub struct GrpcTransport {
    /// The actor this transport sends for, stamped on every call as
    /// [`SENDER_METADATA`]. `None` for the relay, which sends
    /// for a browser this node does not route gRPC to anyway.
    sender: Option<Uuid>,
}

impl GrpcTransport {
    /// A transport that does not identify its sender.
    pub fn new() -> Self {
        Self { sender: None }
    }

    /// A transport that stamps each call with `actor_id`, so this node's own
    /// ingress can tell the two ends of a same-node pairing apart.
    pub fn for_actor(actor_id: Uuid) -> Self {
        Self {
            sender: Some(actor_id),
        }
    }

    async fn call(&self, uri: &str, message: &[u8]) -> Result<(), String> {
        let envelope = derec_proto::DeRecMessage::decode(message)
            .map_err(|e| format!("undecodable envelope: {e}"))?;
        let dial = dial_uri(uri);

        let endpoint = tonic::transport::Endpoint::from_shared(dial.clone())
            .map_err(|e| format!("invalid endpoint {dial}: {e}"))?
            .connect_timeout(GRPC_CONNECT_TIMEOUT)
            .timeout(GRPC_REQUEST_TIMEOUT);

        // The connect is bounded by `connect_timeout`; this outer bound also
        // covers name resolution, which that setting does not.
        let channel = tokio::time::timeout(GRPC_REQUEST_TIMEOUT, endpoint.connect())
            .await
            .map_err(|_| format!("connect {dial}: timed out"))?
            .map_err(|e| format!("connect {dial}: {e}"))?;

        let mut client =
            super::grpc::pb::de_rec_transport_client::DeRecTransportClient::new(channel);

        let mut request = tonic::Request::new(envelope);
        if let Some(sender) = self.sender {
            // A UUID's text form is plain ASCII, so this cannot fail; if it
            // ever did, the call goes out without the hint rather than not at
            // all — the hint only matters when both ends are on this node.
            if let Ok(value) = sender
                .to_string()
                .parse::<tonic::metadata::MetadataValue<tonic::metadata::Ascii>>()
            {
                request.metadata_mut().insert(SENDER_METADATA, value);
            }
        }

        client
            .send(request)
            .await
            .map(|_| ())
            .map_err(|e| format!("send {dial}: {e}"))
    }
}

/// Which client dials a given endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Leg {
    Http,
    Grpc,
}

/// Dials whichever transports a peer advertised.
///
/// The library filters a peer's endpoints and hands over the survivors in the
/// peer's own order, taking no view on which to use — choosing, and failing
/// over, is this transport's job. Walking the list in order is the simplest
/// useful policy and the one this reference app documents.
#[derive(Clone)]
pub struct CompositeTransport {
    http: HttpTransport,
    grpc: GrpcTransport,
    /// This node, when the transport belongs to one of its actors. An
    /// endpoint naming this node is then delivered in-process rather than
    /// dialled — see [`super::addresses`] for why that matters once an
    /// address it advertised has gone away.
    local: Option<Arc<dyn LocalDelivery>>,
}

impl CompositeTransport {
    pub fn new(http: HttpTransport, grpc: GrpcTransport) -> Self {
        Self {
            http,
            grpc,
            local: None,
        }
    }

    /// Deliver to endpoints that name this node in-process, without a dial.
    pub fn delivering_locally_on(mut self, local: Arc<dyn LocalDelivery>) -> Self {
        self.local = Some(local);
        self
    }

    /// Pair each endpoint with the client that can dial it, dropping any whose
    /// discriminant this app does not serve. Order is the peer's, preserved.
    pub fn plan(endpoints: &[TransportProtocol]) -> Vec<(Leg, &TransportProtocol)> {
        endpoints
            .iter()
            .filter_map(|e| match derec_proto::Protocol::try_from(e.protocol) {
                Ok(derec_proto::Protocol::Https) => Some((Leg::Http, e)),
                Ok(derec_proto::Protocol::Grpc) => Some((Leg::Grpc, e)),
                Err(_) => None,
            })
            .collect()
    }
}

impl DeRecTransport for CompositeTransport {
    fn send(&self, endpoints: &[TransportProtocol], message: Vec<u8>) -> TransportFuture<'_> {
        let plan: Vec<(Leg, String)> = Self::plan(endpoints)
            .into_iter()
            .map(|(leg, e)| (leg, e.uri.clone()))
            .collect();
        let offered = endpoints.len();
        let client = self.http.client();
        let grpc = self.grpc.clone();
        let local = self.local.clone();

        Box::pin(async move {
            if plan.is_empty() {
                tracing::error!(
                    offered,
                    "transport: no endpoint on a protocol this node dials"
                );
                return Err(derec_library::Error::Invariant(NO_DIALABLE_ENDPOINT));
            }

            for (leg, uri) in &plan {
                if let Some(local) = &local {
                    match local.deliver_local(uri, &message, grpc.sender).await {
                        LocalAttempt::Delivered => return Ok(()),
                        LocalAttempt::Refused(reason) => {
                            // The recipient is here and refused it — a full
                            // mailbox, a database failure. Dialling the same
                            // node would only be refused again.
                            tracing::warn!(uri = %uri, reason = %reason, "transport: local delivery refused");
                            continue;
                        }
                        LocalAttempt::NotLocal => {}
                    }
                }
                let attempt = match leg {
                    Leg::Http => HttpTransport::post(&client, uri, message.clone()).await,
                    Leg::Grpc => grpc.call(uri, &message).await,
                };
                match attempt {
                    Ok(()) => return Ok(()),
                    Err(reason) => {
                        tracing::warn!(uri = %uri, leg = ?leg, reason = %reason, "transport: endpoint failed");
                    }
                }
            }

            tracing::error!(attempted = plan.len(), "transport: every endpoint failed");
            Err(derec_library::Error::Invariant(NO_ENDPOINT_ACCEPTED))
        })
    }
}

/// Dials another node on a browser owner's behalf, for the relay.
///
/// A [`CompositeTransport`] with no local delivery and an anonymous gRPC
/// client: the relay decides itself whether a target is this node, and sends
/// for a browser this node does not route gRPC to anyway.
pub struct RelayDialer {
    http_client: reqwest::Client,
}

impl RelayDialer {
    pub fn new(http_client: reqwest::Client) -> Self {
        Self { http_client }
    }
}

#[async_trait]
impl PeerDialer for RelayDialer {
    async fn dial(&self, uri: &str, bytes: Vec<u8>) -> Result<(), DialError> {
        let transport = CompositeTransport::new(
            HttpTransport::new(self.http_client.clone()),
            GrpcTransport::new(),
        );
        let endpoint = TransportProtocol {
            protocol: if uri.starts_with("grpc") {
                derec_proto::Protocol::Grpc as i32
            } else {
                derec_proto::Protocol::Https as i32
            },
            uri: uri.to_owned(),
        };
        transport
            .send(std::slice::from_ref(&endpoint), bytes)
            .await
            .map_err(|e| DialError(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn http(uri: &str) -> TransportProtocol {
        TransportProtocol {
            uri: uri.to_owned(),
            protocol: derec_proto::Protocol::Https as i32,
        }
    }

    fn grpc(uri: &str) -> TransportProtocol {
        TransportProtocol {
            uri: uri.to_owned(),
            protocol: derec_proto::Protocol::Grpc as i32,
        }
    }

    #[test]
    fn a_grpc_uri_dials_over_plain_http2() {
        // `grpc://` is the spelling the protocol validates and advertises; the
        // wire underneath is ordinary HTTP/2, so the client needs `http://`.
        assert_eq!(dial_uri("grpc://localhost:50051"), "http://localhost:50051");
        assert_eq!(dial_uri("grpcs://a.example:443"), "https://a.example:443");
    }

    #[test]
    fn dialing_rewrites_only_the_scheme() {
        assert_eq!(
            dial_uri("grpc://localhost:50051/ignored"),
            "http://localhost:50051/ignored"
        );
    }

    #[test]
    fn endpoints_are_partitioned_by_discriminant_preserving_order() {
        // The peer's order is its preference and must survive partitioning:
        // the composite walks the list as given.
        let offered = vec![grpc("grpc://a:1"), http("http://b:2"), grpc("grpc://c:3")];

        let plan = CompositeTransport::plan(&offered);

        assert_eq!(
            plan.iter().map(|(_, e)| e.uri.as_str()).collect::<Vec<_>>(),
            vec!["grpc://a:1", "http://b:2", "grpc://c:3"]
        );
        assert_eq!(plan[0].0, Leg::Grpc);
        assert_eq!(plan[1].0, Leg::Http);
    }

    #[test]
    fn an_unknown_discriminant_is_skipped_rather_than_dialed() {
        let offered = vec![
            TransportProtocol {
                uri: "??://x".to_owned(),
                protocol: 99,
            },
            http("http://b:2"),
        ];

        let plan = CompositeTransport::plan(&offered);

        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].1.uri, "http://b:2");
    }

    #[test]
    fn this_nodes_transport_failures_read_as_an_unreachable_peer_and_nothing_else_does() {
        assert!(is_unreachable(&derec_library::Error::Invariant(
            NO_DIALABLE_ENDPOINT
        )));
        assert!(is_unreachable(&derec_library::Error::Invariant(
            NO_ENDPOINT_ACCEPTED
        )));
        assert!(!is_unreachable(&derec_library::Error::Invariant(
            "transport: something else"
        )));
        assert!(!is_unreachable(&derec_library::Error::InvalidInput(
            "transport: nope"
        )));
    }

    #[test]
    fn an_empty_plan_means_nothing_was_dialable() {
        let offered = vec![TransportProtocol {
            uri: "??://x".to_owned(),
            protocol: 99,
        }];

        assert!(CompositeTransport::plan(&offered).is_empty());
    }
}
