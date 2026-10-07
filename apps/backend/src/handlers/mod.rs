// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The HTTP interface. Each handler parses its input, calls exactly one
//! service, and maps the answer — or the service's refusal — onto the wire.
//! No rule lives here.
//!
//! One file per endpoint, grouped by entity, each entity's wire shapes in its
//! `dtos.rs`. Answers under `/api/v1` travel in the envelope in [`response`];
//! every refusal, everywhere, is an [`errors::ApiError`].

pub mod errors;
pub mod extractors;
pub mod response;

mod actors;
mod config;
mod debug;
mod derec;
mod health;
mod helpers;
mod owners;

use axum::{
    extract::DefaultBodyLimit,
    routing::{delete, get, patch, post},
    Router,
};

use crate::infrastructure::state::AppState;
use crate::services::delivery::MAX_MESSAGE_BYTES;

/// The versioned API, nested under `/api/v1` by the server.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/config", get(config::get::get))
        // The debug surface. Unauthenticated by design: this app ships as a
        // developer's local container and exposing its internals is the point.
        .route("/debug/config", get(debug::config::config))
        .route("/debug/state", get(debug::state::state))
        .route("/debug/events", get(debug::events::events))
        .route("/owners", post(owners::register::register))
        .route("/owners/{owner_id}", patch(owners::rename::rename))
        .route("/actors", get(actors::get_all::get_all))
        .route(
            "/actors/{actor_id}/contact",
            post(actors::create_contact::create_contact),
        )
        .route(
            "/actors/{actor_id}/start-pairing",
            post(actors::start_pairing::start_pairing),
        )
        .route(
            "/actors/{actor_id}/fingerprint",
            get(actors::fingerprint::fingerprint),
        )
        .route(
            "/actors/{actor_id}/confirm-fingerprint",
            post(actors::confirm_fingerprint::confirm_fingerprint),
        )
        .route("/helpers", post(helpers::provision::provision))
        .route("/helpers/ensure", post(helpers::ensure::ensure))
        .route("/helpers/{helper_id}", delete(helpers::delete::delete))
        .route(
            "/helpers/{helper_id}/toggle-status",
            post(helpers::status::toggle_status),
        )
        .route(
            "/helpers/{helper_id}/channels",
            get(helpers::channels::channels),
        )
        .route("/helpers/{helper_id}/link", post(helpers::link::link))
        .route(
            "/helpers/{helper_id}/browser-contact",
            get(helpers::browser_contact::get::get)
                .post(helpers::browser_contact::publish::publish),
        )
}

/// The routes outside the versioned API, at fixed paths other software
/// depends on: the image's healthcheck, and the DeRec transport other
/// implementations post to. Their success bodies never change shape.
pub fn root_routes() -> Router<AppState> {
    Router::new()
        .route("/health", get(health::get::get))
        // Registered ahead of `/derec/{actor_id}` so `relay` is matched
        // literally rather than parsed as that segment's UUID.
        //
        // Both carry a DeRec message, so both take the largest one this node
        // accepts on any transport — the gRPC listener's 4 MiB — rather than
        // Axum's 2 MiB default. The relay's JSON body is larger again by the
        // base64url encoding of that message.
        .route(
            "/derec/relay",
            post(derec::relay::relay).layer(DefaultBodyLimit::max(derec::RELAY_BODY_LIMIT)),
        )
        .route(
            "/derec/{actor_id}",
            post(derec::deliver::deliver).layer(DefaultBodyLimit::max(MAX_MESSAGE_BYTES)),
        )
        .route("/derec/{actor_id}/mailbox", get(derec::mailbox::mailbox))
}
