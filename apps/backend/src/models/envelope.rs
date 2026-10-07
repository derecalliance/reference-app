// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Cleartext metadata from a `DeRecMessage` envelope.
//!
//! The envelope is not encrypted; only its `message` payload is. That makes
//! `channel_id` readable without any key material, which is what lets an actor
//! route an inbound message to the protocol instance that owns the channel.
//!
//! Message *type* is inside the encrypted payload and is deliberately not
//! available here.

use prost::Message as _;

/// Cleartext fields of a `DeRecMessage` envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvelopeMeta {
    pub channel_id: u64,
    pub sequence: u32,
    pub trace_id: u64,
    pub protocol_version_major: u32,
    pub protocol_version_minor: u32,
    /// Length of the encrypted payload, for observability. The payload itself
    /// is never retained.
    pub payload_len: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum EnvelopeError {
    #[error("malformed DeRec envelope: {0}")]
    Malformed(#[from] prost::DecodeError),
}

/// Read the cleartext metadata from an inbound envelope.
impl TryFrom<&[u8]> for EnvelopeMeta {
    type Error = EnvelopeError;

    fn try_from(bytes: &[u8]) -> Result<Self, Self::Error> {
        let msg = derec_proto::DeRecMessage::decode(bytes)?;

        Ok(Self {
            channel_id: msg.channel_id,
            sequence: msg.sequence,
            trace_id: msg.trace_id,
            protocol_version_major: msg.protocol_version_major,
            protocol_version_minor: msg.protocol_version_minor,
            payload_len: msg.message.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(channel_id: u64, sequence: u32, trace_id: u64, payload: &[u8]) -> Vec<u8> {
        let msg = derec_proto::DeRecMessage {
            protocol_version_major: 1,
            protocol_version_minor: 2,
            sequence,
            channel_id,
            timestamp: None,
            message: payload.to_vec(),
            trace_id,
        };
        let mut buf = Vec::new();
        msg.encode(&mut buf)
            .expect("encoding a constructed message cannot fail");
        buf
    }

    #[test]
    fn reads_the_cleartext_fields() {
        let bytes = envelope(0xDEAD_BEEF, 7, 0xC0FFEE, &[1, 2, 3, 4]);

        let meta =
            EnvelopeMeta::try_from(bytes.as_slice()).expect("a well-formed envelope decodes");

        assert_eq!(meta.channel_id, 0xDEAD_BEEF);
        assert_eq!(meta.sequence, 7);
        assert_eq!(meta.trace_id, 0xC0FFEE);
        assert_eq!(meta.protocol_version_major, 1);
        assert_eq!(meta.protocol_version_minor, 2);
        assert_eq!(meta.payload_len, 4);
    }

    #[test]
    fn an_encrypted_payload_is_not_required_to_be_readable() {
        // The payload is ciphertext. Decoding must not care what is in it —
        // routing happens on the envelope alone.
        let bytes = envelope(42, 1, 0, &[0xFF; 64]);

        let meta =
            EnvelopeMeta::try_from(bytes.as_slice()).expect("ciphertext payloads decode fine");

        assert_eq!(meta.channel_id, 42);
        assert_eq!(meta.payload_len, 64);
    }

    #[test]
    fn garbage_is_rejected_rather_than_guessed_at() {
        // A byte string that is not a valid protobuf must not silently produce
        // channel 0, which would route it to whichever instance owns channel 0.
        let bytes = vec![0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF];

        assert!(EnvelopeMeta::try_from(bytes.as_slice()).is_err());
    }

    #[test]
    fn an_empty_body_is_not_a_valid_envelope_to_route() {
        // Empty input decodes to an all-default message under proto3. Routing on
        // channel 0 would be wrong, so callers must treat channel 0 as unroutable
        // rather than relying on a decode error here.
        let meta = EnvelopeMeta::try_from(&[][..]).expect("proto3 decodes empty input to defaults");
        assert_eq!(meta.channel_id, 0);
    }
}
