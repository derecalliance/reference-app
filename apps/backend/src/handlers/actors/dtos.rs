// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};

use crate::models::{Actor, ActorListing, ContactOptions, PeerContact};

/// Actor enriched with live pairing state — used in `GET /api/v1/actors`.
#[derive(Debug, Clone, Serialize)]
pub struct ActorWithStatus {
    #[serde(flatten)]
    pub actor: Actor,
    /// Protocol channel ID, present only if pairing has completed for this actor.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// Shared symmetric key for the helper channel (base64url-encoded), present only for helpers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shared_key: Option<String>,
    /// Whether this actor is currently simulating offline status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
    /// True when this actor's protocol instance runs in a browser rather than
    /// on the backend, so it has no backend instance to drive. Peers must fetch
    /// its contact from the signaling endpoint instead of `/api/v1/actors/{id}/contact`.
    ///
    /// Set for every browser actor regardless of role — including one acting as
    /// another device's replica, which registers as an ordinary owner.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_managed: Option<bool>,
    /// When a browser-managed actor last drained its mailbox, as an RFC 3339
    /// UTC timestamp — or `null` if it has not since this node started.
    ///
    /// The outer `Option` decides presence: only browser-managed actors carry
    /// the field at all, because nothing polls on a provisioned actor's
    /// behalf. Held in memory, so every value resets to `null` on restart.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_polled_at: Option<Option<String>>,
}

impl From<ActorListing> for ActorWithStatus {
    fn from(listing: ActorListing) -> Self {
        Self {
            actor: listing.actor,
            channel_id: listing.channel_id,
            shared_key: listing
                .shared_key
                .map(|key| URL_SAFE_NO_PAD.encode(&key[..])),
            disabled: listing.disabled.then_some(true),
            browser_managed: listing.browser_managed.then_some(true),
            last_polled_at: listing.browser_managed.then_some(listing.last_polled_at),
        }
    }
}

/// `GET /api/v1/actors`: every actor, in registration order.
#[derive(Debug, Serialize)]
pub struct ListActorsResponse {
    pub actors: Vec<ActorWithStatus>,
}

impl From<Vec<ActorListing>> for ListActorsResponse {
    fn from(listings: Vec<ActorListing>) -> Self {
        Self {
            actors: listings.into_iter().map(Into::into).collect(),
        }
    }
}

/// How a provisioned actor should mint a contact; see [`ContactOptions`].
#[derive(Debug, Deserialize, Default)]
pub struct ContactModeQuery {
    #[serde(default)]
    pub contact_mode: Option<String>,
    /// `NoKeys` contacts are typically hand-typed, so callers pick a small
    /// human-readable nonce rather than letting the library mint a random u64.
    #[serde(default)]
    pub nonce: Option<u64>,
    /// When set, mint the contact from the instance bound to this owner's
    /// secret rather than from the helper's own instance — a replica-mode
    /// pairing. Decimal string: a `u64` exceeds JavaScript's exact integer
    /// range, so it never travels as a JSON number.
    #[serde(default)]
    pub replica_for_owner_secret: Option<String>,
}

impl From<ContactModeQuery> for ContactOptions {
    fn from(query: ContactModeQuery) -> Self {
        Self {
            contact_mode: query.contact_mode,
            nonce: query.nonce,
            replica_for_owner_secret: query.replica_for_owner_secret,
        }
    }
}

/// Role the caller wants a backend-managed actor to take when it initiates
/// pairing: `helper` (the default) or `owner`.
#[derive(Debug, Deserialize, Default)]
pub struct PairRoleQuery {
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ChannelQueryParam {
    pub channel_id: String,
}

#[derive(Debug, Deserialize)]
pub struct ConfirmFingerprintBody {
    pub channel_id: String,
    pub fingerprint: String,
}

/// `POST /api/v1/actors/{actor_id}/start-pairing`: the transient pairing id,
/// which the handshake rotates to a long-term one when it completes. A decimal
/// string: a `u64` exceeds JavaScript's exact integer range.
#[derive(Debug, Serialize)]
pub struct StartPairingResponse {
    pub channel_id: String,
}

impl From<u64> for StartPairingResponse {
    fn from(channel_id: u64) -> Self {
        Self {
            channel_id: channel_id.to_string(),
        }
    }
}

/// `GET /api/v1/actors/{actor_id}/fingerprint`: the actor's own fingerprint.
#[derive(Debug, Serialize)]
pub struct FingerprintResponse {
    pub fingerprint: String,
}

impl From<String> for FingerprintResponse {
    fn from(fingerprint: String) -> Self {
        Self { fingerprint }
    }
}

/// `POST /api/v1/actors/{actor_id}/confirm-fingerprint`: always `true` on
/// success — a mismatch is the `FINGERPRINT_MISMATCH` error instead.
#[derive(Debug, Serialize)]
pub struct ConfirmFingerprintResponse {
    pub confirmed: bool,
}

impl ConfirmFingerprintResponse {
    pub const CONFIRMED: Self = Self { confirmed: true };
}

// ── Contacts on the wire ────────────────────────────────────────────────────

/// Mirrors the FE's ContactMessage serialization: `u64` fields travel as
/// decimal strings (they exceed the exact range of a JavaScript number) and
/// binary fields are base64url-encoded.
///
/// Key material is optional because it is only inlined under
/// [`derec_proto::ContactMode::InlineKeys`]; `HashedKeys` carries a binding
/// hash instead, and `NoKeys` carries neither.
#[derive(Debug, Serialize, Deserialize)]
pub struct ContactMessageDto {
    pub channel_id: String,
    pub nonce: String,
    /// The singular endpoint the SDK removed at 0.0.6. Never written any more;
    /// read only as a fallback, so a contact pasted from an older build of this
    /// app still pairs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport_protocol: Option<TransportProtocolDto>,
    /// Every endpoint the sender serves, in the sender's own preference order.
    /// Defaulted so a contact produced by an older peer still deserializes;
    /// [`ContactMessageDto::endpoints`] falls back to the singular field.
    #[serde(default)]
    pub supported_transports: Vec<TransportProtocolDto>,
    /// `ContactMode` numeric value: 0 = INLINE_KEYS, 1 = HASHED_KEYS, 2 = NO_KEYS.
    #[serde(default)]
    pub contact_mode: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mlkem_encapsulation_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ecies_public_key: Option<String>,
    /// SHA-384 commitment over the key material; present only under `HashedKeys`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contact_binding_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransportProtocolDto {
    pub uri: String,
    /// Lowercase name of the `Protocol` discriminant: `"https"` or `"grpc"`.
    /// An unrecognised value is read as HTTPS, matching protobuf's treatment
    /// of an unknown enum value on the wire.
    pub protocol: String,
}

impl From<&derec_proto::TransportProtocol> for TransportProtocolDto {
    fn from(t: &derec_proto::TransportProtocol) -> Self {
        let protocol = match derec_proto::Protocol::try_from(t.protocol) {
            Ok(derec_proto::Protocol::Grpc) => "grpc",
            _ => "https",
        };
        Self {
            uri: t.uri.clone(),
            protocol: protocol.to_owned(),
        }
    }
}

impl From<&TransportProtocolDto> for derec_proto::TransportProtocol {
    fn from(dto: &TransportProtocolDto) -> Self {
        let protocol = match dto.protocol.as_str() {
            "grpc" => derec_proto::Protocol::Grpc,
            _ => derec_proto::Protocol::Https,
        };
        Self {
            uri: dto.uri.clone(),
            protocol: protocol as i32,
        }
    }
}

impl ContactMessageDto {
    /// The endpoints this contact advertises, preferring the list and falling
    /// back to the deprecated singular field for a peer that predates it.
    ///
    /// Empty when the contact names no endpoint at all, which the service
    /// refuses: there is nowhere to send the pairing request.
    pub fn endpoints(&self) -> Vec<derec_proto::TransportProtocol> {
        if self.supported_transports.is_empty() {
            self.transport_protocol.iter().map(Into::into).collect()
        } else {
            self.supported_transports.iter().map(Into::into).collect()
        }
    }
}

impl From<&derec_proto::ContactMessage> for ContactMessageDto {
    fn from(c: &derec_proto::ContactMessage) -> Self {
        Self {
            channel_id: c.channel_id.to_string(),
            nonce: c.nonce.to_string(),
            transport_protocol: None,
            supported_transports: c.supported_transports.iter().map(Into::into).collect(),
            contact_mode: c.contact_mode,
            mlkem_encapsulation_key: c
                .mlkem_encapsulation_key
                .as_ref()
                .map(|k| URL_SAFE_NO_PAD.encode(k)),
            ecies_public_key: c
                .ecies_public_key
                .as_ref()
                .map(|k| URL_SAFE_NO_PAD.encode(k)),
            contact_binding_hash: c
                .contact_binding_hash
                .as_ref()
                .map(|h| URL_SAFE_NO_PAD.encode(h)),
        }
    }
}

impl From<ContactMessageDto> for PeerContact {
    fn from(dto: ContactMessageDto) -> Self {
        Self {
            endpoints: dto.endpoints(),
            channel_id: dto.channel_id,
            nonce: dto.nonce,
            contact_mode: dto.contact_mode,
            mlkem_encapsulation_key: dto.mlkem_encapsulation_key,
            ecies_public_key: dto.ecies_public_key,
            contact_binding_hash: dto.contact_binding_hash,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Role, TransportMode};

    fn listing(
        browser_managed: bool,
        disabled: bool,
        last_polled_at: Option<&str>,
    ) -> ActorListing {
        ActorListing {
            actor: Actor::mint(Role::Owner, "Alice", "http://h", "h:1", TransportMode::Http),
            channel_id: None,
            shared_key: Some([0u8; 32]),
            disabled,
            browser_managed,
            last_polled_at: last_polled_at.map(str::to_owned),
        }
    }

    #[test]
    fn a_provisioned_row_omits_the_browser_only_fields() {
        let json = serde_json::to_value(ActorWithStatus::from(listing(false, false, None)))
            .expect("serializes");

        assert!(json.get("browser_managed").is_none());
        assert!(json.get("last_polled_at").is_none());
        assert!(json.get("disabled").is_none());
    }

    #[test]
    fn a_browser_row_that_never_polled_carries_an_explicit_null() {
        let json = serde_json::to_value(ActorWithStatus::from(listing(true, true, None)))
            .expect("serializes");

        assert_eq!(json["browser_managed"], serde_json::json!(true));
        assert_eq!(json["disabled"], serde_json::json!(true));
        assert_eq!(json["last_polled_at"], serde_json::Value::Null);
        assert!(json
            .as_object()
            .is_some_and(|o| o.contains_key("last_polled_at")));
    }

    #[test]
    fn the_shared_key_travels_base64url_without_padding() {
        let json = serde_json::to_value(ActorWithStatus::from(listing(false, false, None)))
            .expect("serializes");

        assert_eq!(json["shared_key"], serde_json::json!("A".repeat(43)));
    }

    // `transportProtocol` is deprecated in favour of `supportedTransports`, so
    // the contact seam has to read both.

    // `transportProtocol` is deprecated in favour of `supportedTransports`, so
    // this seam has to read both: the list from a current peer, the singular
    // field from one that predates it.

    fn dto(singular: TransportProtocolDto, list: Vec<TransportProtocolDto>) -> ContactMessageDto {
        ContactMessageDto {
            channel_id: "18446744073709551615".to_owned(),
            nonce: "7".to_owned(),
            transport_protocol: Some(singular),
            supported_transports: list,
            contact_mode: 0,
            mlkem_encapsulation_key: None,
            ecies_public_key: None,
            contact_binding_hash: None,
        }
    }

    fn tp(uri: &str, protocol: &str) -> TransportProtocolDto {
        TransportProtocolDto {
            uri: uri.to_owned(),
            protocol: protocol.to_owned(),
        }
    }

    #[test]
    fn the_list_wins_when_present() {
        let endpoints = dto(
            tp("https://a.example", "https"),
            vec![
                tp("https://a.example", "https"),
                tp("grpcs://a.example:443", "grpc"),
            ],
        )
        .endpoints();

        assert_eq!(endpoints.len(), 2);
        assert_eq!(endpoints[0].uri, "https://a.example");
        assert_eq!(endpoints[1].protocol, derec_proto::Protocol::Grpc as i32);
    }

    #[test]
    fn an_empty_list_falls_back_to_the_deprecated_singular_field() {
        let endpoints = dto(tp("https://a.example", "https"), Vec::new()).endpoints();

        assert_eq!(endpoints.len(), 1);
        assert_eq!(endpoints[0].uri, "https://a.example");
        assert_eq!(endpoints[0].protocol, derec_proto::Protocol::Https as i32);
    }

    #[test]
    fn an_unknown_protocol_name_reads_as_https_like_an_unknown_enum_on_the_wire() {
        let endpoints = dto(tp("ws://a.example", "websocket"), Vec::new()).endpoints();

        assert_eq!(endpoints[0].protocol, derec_proto::Protocol::Https as i32);
    }

    #[test]
    fn the_dto_carries_the_endpoint_list_and_no_singular_field() {
        // SDK 0.0.6 removed the singular endpoint from the protocol; the DTO
        // stops writing it too, and every endpoint travels in the list.
        let contact = derec_proto::ContactMessage {
            channel_id: 1,
            nonce: 7,
            supported_transports: vec![
                derec_proto::TransportProtocol {
                    uri: "grpcs://a.example:443".to_owned(),
                    protocol: derec_proto::Protocol::Grpc as i32,
                },
                derec_proto::TransportProtocol {
                    uri: "https://a.example".to_owned(),
                    protocol: derec_proto::Protocol::Https as i32,
                },
            ],
            contact_mode: 0,
            mlkem_encapsulation_key: None,
            ecies_public_key: None,
            contact_binding_hash: None,
            timestamp: None,
        };

        let dto = ContactMessageDto::from(&contact);

        assert_eq!(dto.supported_transports.len(), 2);
        assert_eq!(dto.supported_transports[0].uri, "grpcs://a.example:443");
        assert_eq!(dto.supported_transports[0].protocol, "grpc");
        assert!(dto.transport_protocol.is_none());
    }

    #[test]
    fn a_contact_with_only_the_list_deserializes() {
        // What a creator past the deprecation sends: a contact without the
        // singular field must still be accepted.
        let json = r#"{
            "channel_id": "1",
            "nonce": "7",
            "supported_transports": [{ "uri": "grpc://a:1", "protocol": "grpc" }]
        }"#;

        let dto: ContactMessageDto = serde_json::from_str(json).expect("deserializes");

        assert!(dto.transport_protocol.is_none());
        assert_eq!(dto.endpoints().len(), 1);
        assert_eq!(dto.endpoints()[0].uri, "grpc://a:1");
    }

    #[test]
    fn a_contact_naming_no_endpoint_has_none_to_offer() {
        let json = r#"{ "channel_id": "1", "nonce": "7" }"#;

        let dto: ContactMessageDto = serde_json::from_str(json).expect("deserializes");

        assert!(
            dto.endpoints().is_empty(),
            "the service must refuse this contact"
        );
    }
}
