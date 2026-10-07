// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The DeRec transport: where other implementations post protocol messages,
//! where browser actors drain their mailboxes, and the relay that dials on a
//! browser's behalf.
//!
//! Outside `/api/v1`, and with success bodies that never change shape: peers
//! built against other implementations read them. Errors use the error
//! envelope like every other route.

pub mod deliver;
pub mod dtos;
pub mod mailbox;
pub mod relay;

use crate::services::delivery::MAX_MESSAGE_BYTES;

/// The JSON body `POST /derec/relay` accepts: room for a
/// [`MAX_MESSAGE_BYTES`] message once base64url-encoded (four characters per
/// three bytes), plus headroom for the URI and the rest of the envelope.
/// Anything the gRPC listener accepts can therefore be relayed; the decoded
/// message is held to the same limit by the delivery service.
pub const RELAY_BODY_LIMIT: usize = MAX_MESSAGE_BYTES.div_ceil(3) * 4 + 64 * 1024;
