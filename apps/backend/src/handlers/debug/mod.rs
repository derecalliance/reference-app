// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The debug surface: the resolved configuration, one state snapshot and one
//! event log, over plain HTTP.
//!
//! Nothing here is authenticated. The app ships as a developer's local
//! container and deliberately exposes its internals; that is the product.

pub mod config;
pub mod dtos;
pub mod events;
pub mod state;
