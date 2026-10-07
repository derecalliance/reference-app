// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Out-of-band contacts: how a caller asks for one to be minted, a peer's as
//! supplied, and the ones minted and not yet paired against.

/// How a backend-run actor should mint a contact, as the caller spelled it.
///
/// Kept as given and parsed by the service, so a malformed value is refused at
/// the same point, relative to the other checks, whatever the transport.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ContactOptions {
    /// `inline_keys` (the default), `hashed_keys` or `no_keys`.
    pub contact_mode: Option<String>,
    /// A small human-readable nonce, for hand-typed `no_keys` contacts.
    pub nonce: Option<u64>,
    /// Mint from the instance bound to this owner's secret — a replica-mode
    /// pairing. A non-zero `u64` as a decimal string.
    pub replica_for_owner_secret: Option<String>,
}

/// How a provisioned actor should mint a contact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContactRequest {
    pub contact_mode: derec_proto::ContactMode,
    /// A caller-chosen nonce; the library mints one when absent.
    pub nonce: Option<u64>,
    /// Mint from the instance bound to this owner's secret rather than from
    /// the actor's own — a replica-mode pairing.
    pub replica_for_owner_secret: Option<u64>,
}

/// A peer's contact, as a caller supplied it: `u64`s as decimal strings, keys
/// base64url-encoded.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PeerContact {
    pub channel_id: String,
    pub nonce: String,
    /// Every endpoint the peer advertises, in its own preference order.
    pub endpoints: Vec<derec_proto::TransportProtocol>,
    /// `ContactMode` numeric value.
    pub contact_mode: i32,
    pub mlkem_encapsulation_key: Option<String>,
    pub ecies_public_key: Option<String>,
    pub contact_binding_hash: Option<String>,
}

/// A contact minted and not yet paired against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnpairedContact {
    /// The instance that minted it.
    pub secret_id: u64,
    /// The channel its peer's first message will arrive on.
    pub channel_id: u64,
    /// Unix seconds.
    pub minted_at: i64,
}
