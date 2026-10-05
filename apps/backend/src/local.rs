// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Delivering to an actor on this node without dialling anything.
//!
//! Used by both senders this node has — an actor's own transport and the relay
//! — whenever [`crate::addresses::own_target`] says an endpoint is this node.
//! The message lands exactly where the listener would have put it, through
//! the same [`dispatch_to_inbox`], so a simulated-offline helper still drops
//! it and a full browser mailbox still refuses it. What is skipped is only the
//! network hop — which, for an address this node no longer listens on, is the
//! hop that would have failed.

use uuid::Uuid;

use crate::addresses::OwnTarget;
use crate::debug::Carrier;
use crate::routes::derec::{DispatchOutcome, dispatch_to_inbox_noting};
use crate::routing::Resolution;
use crate::state::AppState;

/// Why a message addressed to this node has no recipient here.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct NotHere(pub String);

/// Deliver `bytes`, addressed to `target` on this node, straight into the
/// recipient's inbox.
///
/// `sender` is the sending actor, when known: for a gRPC target the recipient
/// is resolved from the envelope's channel id exactly as the listener resolves
/// it, and a message is never for the actor that sent it.
///
/// [`NotHere`] means nothing on this node holds what the message names — an
/// actor id this node does not run, a channel no actor here holds, a channel
/// two actors here hold with no sender to tell them apart, or a gRPC address
/// while gRPC is disabled. The caller decides whether to dial instead.
pub async fn deliver(
    state: &AppState,
    target: OwnTarget,
    uri: &str,
    bytes: Vec<u8>,
    sender: Option<Uuid>,
) -> Result<DispatchOutcome, NotHere> {
    let note = format!("delivered to the actor's inbox without a dial ({uri} is this node)");
    match target {
        OwnTarget::Actor(actor_id) => {
            if !state.actor_inboxes.contains_key(&actor_id) {
                return Err(NotHere(format!("no actor {actor_id} runs on this node")));
            }
            Ok(dispatch_to_inbox_noting(state, actor_id, Carrier::Http, bytes, &note).await)
        }
        OwnTarget::GrpcListener { served: false } => Err(NotHere(
            "gRPC is disabled on this node (defaults.grpc_enabled / DEREC_GRPC_ENABLED), so \
             nothing here answers on a gRPC address"
                .to_owned(),
        )),
        OwnTarget::GrpcListener { served: true } => {
            let channel_id = crate::envelope::decode(&bytes)
                .ok()
                .map(|meta| meta.channel_id)
                .filter(|&channel_id| channel_id != 0)
                .ok_or_else(|| NotHere("the message names no channel".to_owned()))?;
            match state.channel_router.resolve_from(channel_id, sender) {
                Resolution::Actor(actor_id) => {
                    Ok(dispatch_to_inbox_noting(state, actor_id, Carrier::Grpc, bytes, &note).await)
                }
                Resolution::Unknown => Err(NotHere(format!(
                    "no actor on this node holds channel {channel_id}"
                ))),
                Resolution::Ambiguous(_) => Err(NotHere(format!(
                    "channel {channel_id} is held by more than one actor on this node and the \
                     sender is not known"
                ))),
            }
        }
    }
}
