// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Which endpoints are this node, under any name it has been given.
//!
//! A peer holds whatever address this node advertised when they paired. That
//! address can outlive the listener behind it: a container republished on
//! another port (`-p 8080:5000` becoming `-p 9090:5000`) keeps the same
//! database and the same actors, but the old public port is simply gone. A
//! browser tab paired before the move still posts to — or asks the relay to
//! dial — the old one.
//!
//! Dialling such an address is pointless even when it works: the target is an
//! actor in this process. So everything that sends — an actor's own transport
//! and the relay — first asks [`NodeAddresses::own_target`] whether the endpoint names this
//! node, and if so delivers straight into the inbox (see
//! [`crate::services::delivery`]).
//!
//! "This node" is, for each listener:
//!
//! - its current address: the `base_url` host or a loopback name, on the port
//!   peers are told to dial or the one the listener binds (they differ behind
//!   a published port);
//! - every address it advertised before, recorded in `advertised_addresses` so
//!   the record survives the very restart that changes the port.
//!
//! Strict on shape, because what is not matched here may be dialled: an HTTP
//! endpoint must be exactly `http(s)://host:port/derec/<uuid>`, a gRPC one
//! exactly `grpc://host:port`, neither with credentials, query or fragment.

use std::collections::BTreeSet;
use std::sync::{Arc, RwLock};

use uuid::Uuid;

use crate::models::{Listener, NodeConfig, OwnTarget};
use crate::repositories::advertised_addresses::AdvertisedAddressRepository;
use crate::repositories::RepositoryError;
use crate::services::ports::OwnEndpoints;

/// Loopback names every node answers to.
const LOOPBACK: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// One listener's `(host, port)`, host lowercased.
type Authority = (String, u16);

/// This node's addresses: the current ones, from its configuration, and every
/// one it advertised before.
///
/// The history is in memory for lookups and persisted through
/// [`AdvertisedAddressRepository`] so it survives a restart. Only ever added
/// to.
pub struct NodeAddresses {
    config: Arc<NodeConfig>,
    repository: Arc<dyn AdvertisedAddressRepository>,
    http: RwLock<BTreeSet<Authority>>,
    grpc: RwLock<BTreeSet<Authority>>,
}

impl NodeAddresses {
    pub fn new(config: Arc<NodeConfig>, repository: Arc<dyn AdvertisedAddressRepository>) -> Self {
        Self {
            config,
            repository,
            http: RwLock::default(),
            grpc: RwLock::default(),
        }
    }

    /// Load every address recorded by an earlier run.
    pub async fn load(&self) -> Result<usize, RepositoryError> {
        let rows = self.repository.all().await?;
        let mut loaded = 0;
        for (kind, address) in rows {
            let Some(listener) = Listener::from_kind(&kind) else {
                continue;
            };
            if let Some(authority) = parse_address(listener, &address) {
                self.set(listener).insert(authority);
                loaded += 1;
            }
        }
        Ok(loaded)
    }

    /// Remember that this node advertised `address` — a base URL
    /// (`http://host:port`) for HTTP, an authority (`host:port`) for gRPC — or
    /// any endpoint URI built from one. Idempotent. Persisted before it counts,
    /// so a failed write is reported rather than remembered for this run only.
    pub async fn remember(&self, listener: Listener, address: &str) -> Result<(), RepositoryError> {
        let Some(authority) = parse_address(listener, address) else {
            return Ok(());
        };
        if self.get(listener).contains(&authority) {
            return Ok(());
        }
        let text = format_authority(listener, &authority);
        self.repository.insert(listener.kind(), &text).await?;
        self.set(listener).insert(authority);
        Ok(())
    }

    /// Every remembered address, for the debug surface: base URLs for HTTP,
    /// authorities for gRPC, sorted.
    pub fn list(&self, listener: Listener) -> Vec<String> {
        self.get(listener)
            .iter()
            .map(|authority| format_authority(listener, authority))
            .collect()
    }

    /// Whether `uri` names this node, and if so what it reaches.
    ///
    /// `None` for anything else, including a malformed URI and an HTTP URI on
    /// this node whose path names no actor: neither is something to deliver
    /// here.
    pub fn own_target(&self, uri: &str) -> Option<OwnTarget> {
        let url = reqwest::Url::parse(uri).ok()?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return None;
        }

        let config = &self.config;
        match url.scheme() {
            "grpc" => {
                if !matches!(url.path(), "" | "/") {
                    return None;
                }
                // An explicit port is part of the shape every gRPC endpoint
                // this node advertises; `grpc://host` names no listener at all.
                let authority = (url.host_str()?.to_ascii_lowercase(), url.port()?);
                let current = self.is_current(
                    &authority,
                    &[config.defaults.grpc_port, config.public_grpc_port],
                );
                (current || self.contains(Listener::Grpc, &authority)).then_some(
                    OwnTarget::GrpcListener {
                        served: config.defaults.grpc_enabled,
                    },
                )
            }
            "http" | "https" => {
                let authority = (
                    url.host_str()?.to_ascii_lowercase(),
                    url.port_or_known_default()?,
                );
                let current = self.is_current(
                    &authority,
                    &[self.public_http_port()?, config.loaded.settings.server.port],
                );
                if !current && !self.contains(Listener::Http, &authority) {
                    return None;
                }
                let id = url.path().strip_prefix("/derec/")?;
                id.parse::<Uuid>().ok().map(OwnTarget::Actor)
            }
            _ => None,
        }
    }

    /// The host of this node's `base_url`, lowercased.
    fn own_host(&self) -> Option<String> {
        reqwest::Url::parse(&self.config.base_url)
            .ok()?
            .host_str()
            .map(str::to_ascii_lowercase)
    }

    /// Whether `authority` is this node's current address for a listener
    /// served on any of `ports`.
    fn is_current(&self, authority: &Authority, ports: &[u16]) -> bool {
        let (host, port) = authority;
        if !ports.contains(port) {
            return false;
        }
        LOOPBACK.contains(&host.as_str()) || self.own_host().as_deref() == Some(host.as_str())
    }

    /// The HTTP port peers are told to dial: the one `base_url` carries.
    fn public_http_port(&self) -> Option<u16> {
        reqwest::Url::parse(&self.config.base_url)
            .ok()?
            .port_or_known_default()
    }

    fn contains(&self, listener: Listener, authority: &Authority) -> bool {
        self.get(listener).contains(authority)
    }

    // A poisoned lock means a writer panicked mid-insert into a plain set;
    // the data is still coherent, so recover rather than escalate — the same
    // stance `EventLog` takes.
    fn get(&self, listener: Listener) -> std::sync::RwLockReadGuard<'_, BTreeSet<Authority>> {
        match listener {
            Listener::Http => self.http.read(),
            Listener::Grpc => self.grpc.read(),
        }
        .unwrap_or_else(|e| e.into_inner())
    }

    fn set(&self, listener: Listener) -> std::sync::RwLockWriteGuard<'_, BTreeSet<Authority>> {
        match listener {
            Listener::Http => self.http.write(),
            Listener::Grpc => self.grpc.write(),
        }
        .unwrap_or_else(|e| e.into_inner())
    }
}

impl OwnEndpoints for NodeAddresses {
    fn own_target(&self, uri: &str) -> Option<OwnTarget> {
        NodeAddresses::own_target(self, uri)
    }

    fn advertised(&self, listener: Listener) -> Vec<String> {
        self.list(listener)
    }
}

/// `(host, port)` out of a stored or advertised address.
///
/// Accepts the bare authority a gRPC row stores, and any URI — so an actor's
/// stored endpoint can be remembered as-is.
fn parse_address(listener: Listener, address: &str) -> Option<Authority> {
    let text = if address.contains("://") {
        address.to_owned()
    } else {
        match listener {
            Listener::Http => format!("http://{address}"),
            Listener::Grpc => format!("grpc://{address}"),
        }
    };
    let url = reqwest::Url::parse(&text).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let port = match listener {
        Listener::Http => url.port_or_known_default()?,
        Listener::Grpc => url.port()?,
    };
    Some((host, port))
}

/// The stored spelling of an authority.
fn format_authority(listener: Listener, (host, port): &Authority) -> String {
    match listener {
        Listener::Http => format!("http://{host}:{port}"),
        Listener::Grpc => format!("{host}:{port}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_endpoint_uri_and_a_bare_authority_reduce_to_the_same_address() {
        assert_eq!(
            parse_address(Listener::Grpc, "grpc://LOCALHOST:50051"),
            Some(("localhost".to_owned(), 50051))
        );
        assert_eq!(
            parse_address(Listener::Grpc, "localhost:50051"),
            Some(("localhost".to_owned(), 50051))
        );
        assert_eq!(
            parse_address(
                Listener::Http,
                "http://192.168.0.28:8080/derec/00000000-0000-0000-0000-000000000001"
            ),
            Some(("192.168.0.28".to_owned(), 8080))
        );
        assert_eq!(
            parse_address(Listener::Http, "http://[::1]:5000"),
            Some(("[::1]".to_owned(), 5000))
        );
    }

    #[test]
    fn a_grpc_address_without_a_port_is_not_an_address() {
        assert_eq!(parse_address(Listener::Grpc, "grpc://localhost"), None);
    }

    #[test]
    fn stored_spellings_round_trip() {
        for (listener, text) in [
            (Listener::Http, "http://localhost:5000"),
            (Listener::Grpc, "192.168.0.28:8081"),
        ] {
            let authority = parse_address(listener, text).expect("parses");
            assert_eq!(format_authority(listener, &authority), text);
        }
    }
}
