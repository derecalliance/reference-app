// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Plumbing: configuration and the database, the actor runtime and the
//! transports it sends over, the gRPC listener, the in-memory indexes behind
//! the services' ports, and the process around them — boot, recovery, the
//! state handed to handlers, and the server.

pub mod actors;
pub mod addresses;
pub mod bootstrap;
pub mod config;
pub mod db;
pub mod event_log;
pub mod grpc;
pub mod recovery;
pub mod routing;
pub mod server;
pub mod state;
pub mod test_support;
pub mod transport;
