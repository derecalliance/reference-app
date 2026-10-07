// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The signaling endpoint for browser-run actors, which have no backend
//! instance to mint a contact from: the page publishes its own, scoped to a
//! secret, and peers fetch it here.

pub mod get;
pub mod publish;
