//! Outbound `DeRecTransport` implementations.
//!
//! The library filters a peer's advertised endpoints and hands the survivors
//! to [`DeRecTransport::send`] in the peer's own order, taking no view on
//! which to dial — choosing, and failing over when one is unreachable, is
//! this module's job. [`CompositeTransport`] is the actor's transport: it
//! dispatches each endpoint to whichever client ([`HttpTransport`] or
//! [`GrpcTransport`]) can dial its advertised protocol, walking the list in
//! the peer's order and stopping at the first delivery that succeeds.

use derec_library::protocol::{DeRecTransport, TransportFuture};
use derec_proto::TransportProtocol;
use prost::Message as _;

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
    async fn post(
        client: &reqwest::Client,
        uri: &str,
        message: Vec<u8>,
    ) -> Result<(), String> {
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

/// Delivers each envelope as one unary `DeRecTransport.Send` call.
#[derive(Clone, Default)]
pub struct GrpcTransport;

impl GrpcTransport {
    pub fn new() -> Self {
        Self
    }

    async fn call(&self, uri: &str, message: &[u8]) -> Result<(), String> {
        let envelope = derec_proto::DeRecMessage::decode(message)
            .map_err(|e| format!("undecodable envelope: {e}"))?;
        let dial = dial_uri(uri);

        let mut client = crate::grpc::pb::de_rec_transport_client::DeRecTransportClient::connect(
            dial.clone(),
        )
        .await
        .map_err(|e| format!("connect {dial}: {e}"))?;

        client
            .send(envelope)
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
}

impl CompositeTransport {
    pub fn new(http: HttpTransport, grpc: GrpcTransport) -> Self {
        Self { http, grpc }
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

        Box::pin(async move {
            if plan.is_empty() {
                tracing::error!(offered, "transport: no endpoint on a protocol this node dials");
                return Err(derec_library::Error::Invariant(
                    "transport: peer advertised no dialable endpoint",
                ));
            }

            for (leg, uri) in &plan {
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
            Err(derec_library::Error::Invariant(
                "transport: no endpoint accepted the message",
            ))
        })
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
            TransportProtocol { uri: "??://x".to_owned(), protocol: 99 },
            http("http://b:2"),
        ];

        let plan = CompositeTransport::plan(&offered);

        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].1.uri, "http://b:2");
    }

    #[test]
    fn an_empty_plan_means_nothing_was_dialable() {
        let offered = vec![TransportProtocol { uri: "??://x".to_owned(), protocol: 99 }];

        assert!(CompositeTransport::plan(&offered).is_empty());
    }
}
