// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The endpoints an actor advertises, the transport modes they come in, and a
//! pool's target composition by mode.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportProtocol {
    Https,
    Grpc,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Transport {
    pub protocol: TransportProtocol,
    pub uri: String,
}

impl Transport {
    /// This endpoint as the protocol carries it on the wire.
    pub fn to_proto(&self) -> derec_proto::TransportProtocol {
        let protocol = match self.protocol {
            TransportProtocol::Https => derec_proto::Protocol::Https,
            TransportProtocol::Grpc => derec_proto::Protocol::Grpc,
        };
        derec_proto::TransportProtocol {
            uri: self.uri.clone(),
            protocol: protocol as i32,
        }
    }
}

/// Which transports one provisioned helper serves.
///
/// This is about what it *advertises*. Every provisioned actor dials both
/// regardless — a gRPC-only helper still answers a peer over HTTP if that is
/// what the peer advertised.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportMode {
    /// The status quo, and what an omitted mode resolves to.
    #[default]
    Http,
    Grpc,
    Both,
}

impl TransportMode {
    /// The endpoints a helper in this mode advertises, in preference order.
    ///
    /// `Both` leads with gRPC. The order is an arbitrary fixed app preference:
    /// the library hands a peer's whole list to `DeRecTransport::send` and
    /// takes no view on which entry is dialed.
    pub fn endpoints(
        &self,
        base_url: &str,
        grpc_authority: &str,
        actor_id: Uuid,
    ) -> Vec<Transport> {
        let http = Transport {
            protocol: TransportProtocol::Https,
            uri: format!("{base_url}/derec/{actor_id}"),
        };
        // No actor path: tonic builds the request URI from the authority plus
        // the fixed method path, so anything after it is dropped. The actor is
        // recovered from the envelope's channel id instead.
        let grpc = Transport {
            protocol: TransportProtocol::Grpc,
            uri: format!("grpc://{grpc_authority}"),
        };

        match self {
            TransportMode::Http => vec![http],
            TransportMode::Grpc => vec![grpc],
            TransportMode::Both => vec![grpc, http],
        }
    }

    /// The mode a set of advertised endpoints corresponds to.
    ///
    /// Read back off the endpoints rather than stored beside them, so the two
    /// can never disagree. An empty set reads as HTTP.
    pub fn of(transports: &[Transport]) -> Self {
        let has_grpc = transports
            .iter()
            .any(|t| t.protocol == TransportProtocol::Grpc);
        let has_http = transports
            .iter()
            .any(|t| t.protocol == TransportProtocol::Https);
        match (has_grpc, has_http) {
            (true, true) => TransportMode::Both,
            (true, false) => TransportMode::Grpc,
            _ => TransportMode::Http,
        }
    }

    /// The lowercase name this mode is reported under.
    pub fn label(self) -> &'static str {
        match self {
            TransportMode::Http => "http",
            TransportMode::Grpc => "grpc",
            TransportMode::Both => "both",
        }
    }
}

/// A target *composition* for the shared helper pool.
///
/// `POST /api/v1/helpers/ensure` states a target, not a quantity to add, so a
/// transport preference has to be expressed the same way: how many helpers of
/// each mode should exist once the call returns.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransportBreakdown {
    #[serde(default)]
    pub http: u8,
    #[serde(default)]
    pub grpc: u8,
    #[serde(default)]
    pub both: u8,
}

impl TransportBreakdown {
    pub fn total(&self) -> usize {
        self.http as usize + self.grpc as usize + self.both as usize
    }

    /// Every mode paired with its target.
    pub fn modes(&self) -> [(TransportMode, usize); 3] {
        [
            (TransportMode::Http, self.http as usize),
            (TransportMode::Grpc, self.grpc as usize),
            (TransportMode::Both, self.both as usize),
        ]
    }

    /// Whether any helper in this composition advertises gRPC.
    pub fn wants_grpc(&self) -> bool {
        self.grpc > 0 || self.both > 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(protocol: TransportProtocol) -> Transport {
        Transport {
            protocol,
            uri: match protocol {
                TransportProtocol::Grpc => "grpc://localhost:50051".to_owned(),
                TransportProtocol::Https => "http://localhost:5000/derec/x".to_owned(),
            },
        }
    }

    #[test]
    fn the_mode_is_read_back_off_the_advertised_endpoints() {
        // Derived, never stored: a second field could disagree with the
        // endpoints it claims to describe.
        assert_eq!(
            TransportMode::of(&[endpoint(TransportProtocol::Https)]).label(),
            "http"
        );
        assert_eq!(
            TransportMode::of(&[endpoint(TransportProtocol::Grpc)]).label(),
            "grpc"
        );
        assert_eq!(
            TransportMode::of(&[
                endpoint(TransportProtocol::Grpc),
                endpoint(TransportProtocol::Https),
            ])
            .label(),
            "both"
        );
    }

    #[test]
    fn an_actor_advertising_nothing_reads_as_http() {
        assert_eq!(TransportMode::of(&[]), TransportMode::Http);
    }

    #[test]
    fn a_breakdown_reports_its_total() {
        let want = TransportBreakdown {
            http: 1,
            grpc: 2,
            both: 3,
        };

        assert_eq!(want.total(), 6);
    }

    #[test]
    fn a_breakdown_wants_grpc_when_any_helper_advertises_it() {
        assert!(!TransportBreakdown {
            http: 3,
            grpc: 0,
            both: 0
        }
        .wants_grpc());
        assert!(TransportBreakdown {
            http: 0,
            grpc: 1,
            both: 0
        }
        .wants_grpc());
        assert!(TransportBreakdown {
            http: 0,
            grpc: 0,
            both: 1
        }
        .wants_grpc());
    }
}
