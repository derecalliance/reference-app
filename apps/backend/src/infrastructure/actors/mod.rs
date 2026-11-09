// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The actix actor runtime: one [`provisioned::ProvisionedActor`] per
//! backend-run helper, the inbox table every delivery goes through, and the
//! [`runtime::ActorRuntime`] adapter the services drive them with.
//!
//! Actix actors are `!Send`, so they run on their own single-threaded runtime
//! on a dedicated OS thread ([`runtime::ActorThread`]); everything else reaches
//! them through an arbiter handle and their `Addr`s, which never leave this
//! module.

pub mod inboxes;
pub mod instances;
pub mod protocol;
pub mod provisioned;
pub mod runtime;

/// How long a `Pending` channel may wait for out-of-band confirmation.
///
/// The library's automatic sweep is disabled in favour of this, because its
/// default (5 minutes) is also the budget a *human* gets to compare a
/// fingerprint out of band — every `NoKeys` pairing and every replica pairing
/// waits in `Pending` for exactly that. Five minutes is far too short for an
/// interop session where the operator is reading codes between two browsers.
///
/// Also how long a contact's gRPC route is kept waiting for its first message;
/// see [`super::routing::PIN_TTL`].
pub const PENDING_CHANNEL_TTL_SECS: u64 = 3600;

/// How long a pairing stays possible (SDK 0.0.11): how old a contact may be
/// when it is scanned or answered, and how old a pairing request may be when
/// it is accepted.
///
/// The library's default is 30 seconds. These actors mint contacts an
/// operator carries to another node by hand, and answer requests from pages
/// whose owner may be reading a fingerprint first, so the front end's half
/// hour applies here too. It stays well inside [`PENDING_CHANNEL_TTL_SECS`],
/// as the library requires of a scanner's sweep.
pub const PAIRING_LIFETIME_SECS: u64 = 1800;

/// The most replica instances one actor may hold, on top of its own.
///
/// Each is created on demand by `POST /api/v1/actors/{id}/contact
/// ?replica_for_owner_secret=…`, an unauthenticated call naming an arbitrary
/// secret — so without a bound, a loop over secret ids grows an actor's
/// instance map, and every tick's work, without limit. An interop session
/// mirrors a handful of owners at most.
pub const MAX_REPLICA_INSTANCES: usize = 16;
