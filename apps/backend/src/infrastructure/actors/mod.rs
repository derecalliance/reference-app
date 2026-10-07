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

/// The most replica instances one actor may hold, on top of its own.
///
/// Each is created on demand by `POST /api/v1/actors/{id}/contact
/// ?replica_for_owner_secret=…`, an unauthenticated call naming an arbitrary
/// secret — so without a bound, a loop over secret ids grows an actor's
/// instance map, and every tick's work, without limit. An interop session
/// mirrors a handful of owners at most.
pub const MAX_REPLICA_INSTANCES: usize = 16;
