// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Actors: the owners and helpers this node knows about, the settings each
//! runs with, where its protocol runs, and how the roster reports them.

use serde::Serialize;
use uuid::Uuid;

use super::{Transport, TransportMode, TransportProtocol, UnpairAck};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Owner,
    Helper,
}

impl Role {
    /// The role as a noun: `owner` or `helper`.
    pub fn noun(self) -> &'static str {
        match self {
            Role::Owner => "owner",
            Role::Helper => "helper",
        }
    }

    /// The noun with its article. `owner` is the one role noun starting with a
    /// vowel, so the article is picked per role rather than hardcoded to "a".
    pub fn with_article(self) -> String {
        let article = match self {
            Role::Owner => "an",
            Role::Helper => "a",
        };
        format!("{article} {}", self.noun())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Actor {
    pub id: Uuid,
    pub role: Role,
    pub name: String,
    /// The first of [`Self::transports`]. Kept because several front-end call
    /// sites want "an address for this actor" and gain nothing from the list.
    pub transport: Transport,
    /// Every endpoint this actor advertises, in preference order.
    ///
    /// The relay's allowlist trusts these by exact string match, on the
    /// strength of two facts that hold together: `Actor` derives `Serialize`
    /// but not `Deserialize`, so a value here can never be supplied by a
    /// request body, and every non-test constructor ([`Actor::mint`]) builds
    /// these URIs from server config. If a client could ever populate this
    /// field, the relay would dial whatever URI it was handed — an open proxy.
    pub transports: Vec<Transport>,
    /// This actor's own `secret_id` — the secret it protects when acting as
    /// Owner — as a decimal string (a `u64` exceeds JavaScript's exact
    /// integer range).
    ///
    /// Each actor runs one protocol instance bound to this value. Helper-role
    /// channels live in that same instance; the shares they hold carry their
    /// own Owner's `secret_id` on the record.
    pub secret_id: String,
}

impl Actor {
    /// Mint a new actor advertising `mode`'s endpoints at this node's address.
    ///
    /// Every actor protects its own, freshly drawn secret. A replica
    /// relationship does not change this: it is an extra protocol *instance*
    /// bound to the mirrored owner's secret, added on demand, not a different
    /// actor with a different identity.
    pub fn mint(
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
            secret_id: fresh_secret_id().to_string(),
        }
    }

    /// Which mode this actor's advertised endpoints correspond to.
    pub fn transport_mode(&self) -> TransportMode {
        TransportMode::of(&self.transports)
    }

    /// Whether this actor can receive over gRPC — the only transport whose
    /// ingress routes by channel id, and so the only one a router pin is any
    /// use to.
    pub fn advertises_grpc(&self) -> bool {
        self.transports
            .iter()
            .any(|t| t.protocol == TransportProtocol::Grpc)
    }

    /// Whether this actor advertises `uri`, by exact match.
    pub fn advertises(&self, uri: &str) -> bool {
        self.transports.iter().any(|t| t.uri == uri)
    }

    /// Whether this actor's name would read as `name` in a roster.
    ///
    /// Trimmed and case-insensitive: `Alex` and ` alex ` side by side are no
    /// easier to tell apart than two `Alex` rows.
    pub fn is_named(&self, name: &str) -> bool {
        self.name.trim().to_lowercase() == name.trim().to_lowercase()
    }
}

/// A fresh, random `secret_id` for a new actor.
fn fresh_secret_id() -> u64 {
    rand::random::<u64>()
}

/// An actor to register together with the settings it runs with.
pub type NewActor = (Actor, ActorSettings);

/// The protocol settings an actor runs with, kept so a restart rebuilds the
/// same actor rather than a new one wearing its name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActorSettings {
    /// Stable per-device replica id.
    ///
    /// Every stored `ReplicaMember` row references it, so an actor rebuilt with
    /// a fresh one is a stranger to every replica group holding its old id.
    /// This is why the settings are persisted at all.
    pub replica_id: u64,
    pub timeout_secs: u32,
    pub unpair_ack: UnpairAck,
}

impl ActorSettings {
    /// Settings for a new actor, with a freshly drawn `replica_id`.
    pub fn fresh(timeout_secs: u32, unpair_ack: UnpairAck) -> Self {
        Self {
            replica_id: rand::random::<u64>(),
            timeout_secs,
            unpair_ack,
        }
    }
}

/// Where an actor's protocol runs, which decides where its traffic goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InboxKind {
    /// In a browser tab: messages queue in its mailbox until the tab polls.
    Browser,
    /// On this backend: messages go straight to its running protocol instance.
    Provisioned,
}

/// One roster row: the actor, and the live pairing state held outside the
/// registry.
#[derive(Debug, Clone)]
pub struct ActorListing {
    pub actor: Actor,
    /// The one channel the roster reports, once a pairing has completed.
    pub channel_id: Option<String>,
    /// That channel's shared key; helpers only, and only once the instance
    /// holding the channel has it.
    pub shared_key: Option<[u8; 32]>,
    /// Simulating offline.
    pub disabled: bool,
    /// The actor's protocol runs in a browser rather than on this backend.
    pub browser_managed: bool,
    /// When a browser-managed actor last drained its mailbox, as RFC 3339 UTC.
    /// `None` until it does after this node started.
    pub last_polled_at: Option<String>,
}

/// What registering a plan of new actors did, all under one lock.
#[derive(Debug, Clone, Default)]
pub struct PlannedRegistration {
    /// Only the actors the plan asked for, in the order they were registered.
    pub registered: Vec<Actor>,
    /// The whole roster afterwards, in registration order.
    pub roster: Vec<Actor>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_article_matches_the_role_noun() {
        assert_eq!(Role::Owner.with_article(), "an owner");
        assert_eq!(Role::Helper.with_article(), "a helper");
    }

    fn minted(mode: TransportMode) -> Actor {
        Actor::mint(
            Role::Helper,
            "test",
            "http://localhost:5000",
            "localhost:50051",
            mode,
        )
    }

    #[test]
    fn every_actor_gets_its_own_freshly_drawn_secret_id() {
        let first = fresh_secret_id();
        let second = fresh_secret_id();

        assert_ne!(first, 0);
        assert_ne!(first, second, "each actor must get a fresh id");
    }

    #[test]
    fn an_http_helper_advertises_only_its_http_endpoint() {
        // The URI is what peers post to, and the transport route parses the id
        // back out of it, so the two must agree on the shape.
        let actor = minted(TransportMode::Http);

        assert_eq!(actor.transports.len(), 1);
        assert_eq!(
            actor.transports[0].uri,
            format!("http://localhost:5000/derec/{}", actor.id)
        );
        assert_eq!(actor.transports[0].protocol, TransportProtocol::Https);
        assert!(!actor.advertises_grpc());
    }

    #[test]
    fn a_grpc_helper_advertises_an_authority_with_no_actor_path() {
        // gRPC has no path to carry an actor id — the id is recovered from the
        // envelope's channel id instead.
        let actor = minted(TransportMode::Grpc);

        assert_eq!(actor.transports.len(), 1);
        assert_eq!(actor.transports[0].uri, "grpc://localhost:50051");
        assert_eq!(actor.transports[0].protocol, TransportProtocol::Grpc);
        assert!(actor.advertises_grpc());
    }

    #[test]
    fn a_both_helper_advertises_grpc_first() {
        // An arbitrary but fixed app preference: the order carries no protocol
        // meaning, and the library takes no view on which a dialer picks.
        let actor = minted(TransportMode::Both);

        assert_eq!(actor.transports.len(), 2);
        assert_eq!(actor.transports[0].protocol, TransportProtocol::Grpc);
        assert_eq!(actor.transports[1].protocol, TransportProtocol::Https);
        assert_eq!(actor.transport_mode(), TransportMode::Both);
    }

    #[test]
    fn the_singular_transport_mirrors_the_first_entry() {
        // Four front-end call sites read `transport.uri` as "an address for
        // this actor"; it must never disagree with the head of the list.
        let actor = minted(TransportMode::Both);

        assert_eq!(actor.transport, actor.transports[0]);
    }

    #[test]
    fn a_name_matches_ignoring_case_and_surrounding_space() {
        let mut actor = minted(TransportMode::Http);
        actor.name = "Alex".to_owned();

        assert!(actor.is_named(" alex "));
        assert!(!actor.is_named("Alexa"));
    }
}
