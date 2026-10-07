// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The node's roster, and driving its backend-run actors through pairing:
//! minting contacts, initiating pairing, and confirming fingerprints.
//!
//! A `NoKeys` pairing — and every replica-mode pairing — can land on any
//! provisioned actor and on any of its channels, so the fingerprint routes
//! name the channel explicitly rather than inferring it from the actor. The
//! actor resolves which of its protocol instances holds that channel, so a
//! replica-mode channel (which lives on the mirrored owner's instance, not the
//! actor's own) is served like any other.

pub mod confirm_fingerprint;
pub mod create_contact;
pub mod dtos;
pub mod fingerprint;
pub mod get_all;
pub mod start_pairing;
