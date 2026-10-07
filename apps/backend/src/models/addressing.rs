// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Which endpoints name this node, and the listeners they belong to.

use uuid::Uuid;

/// What an endpoint naming this node resolves to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnTarget {
    /// This node's HTTP transport route for `actor_id`.
    Actor(Uuid),
    /// This node's gRPC listener. `served` is false when gRPC is disabled
    /// here, so the address names this node but nothing answers on it.
    GrpcListener { served: bool },
}

/// Which listener an address belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Listener {
    Http,
    Grpc,
}

impl Listener {
    /// The name this listener's addresses are recorded under.
    pub fn kind(self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Grpc => "grpc",
        }
    }

    /// The listener recorded under `kind`, if any.
    pub fn from_kind(kind: &str) -> Option<Self> {
        match kind {
            "http" => Some(Self::Http),
            "grpc" => Some(Self::Grpc),
            _ => None,
        }
    }
}
