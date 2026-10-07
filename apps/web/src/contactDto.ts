// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

// ── ContactMessage transport form ────────────────────────────────────────────
//
// The protocol type uses `bigint` for `channel_id`/`nonce` and a numeric
// `protocol` discriminant, none of which survive JSON. The app's wire form
// (QR payload and the backend signaling DTO) therefore carries `u64`s as
// decimal strings, the transport protocol as a label, and binary fields
// base64url-encoded.
//
// Key material is optional: it is inlined only under ContactMode.InlineKeys.
// HashedKeys carries a SHA-384 binding hash instead and NoKeys carries
// neither, with the real keys fetched later over the PrePair round-trip.
//
// Lives in its own module (rather than beside its first caller) because both
// the participant flows in `OwnerPage` and the replica flows in
// `replicaFlows` need it; importing it from the page module would make the
// dependency cyclic.

import { ContactMode, type ContactMessage, type TransportProtocol } from '@derec-alliance/web'
import type { ContactMessageDto, TransportProtocolDto } from './api'
import { fromBase64Url, toBase64Url } from './derecApi'

/** Numeric TransportProtocol discriminant for HTTPS. */
export const TRANSPORT_PROTOCOL_HTTPS = 0
/** Numeric TransportProtocol discriminant for gRPC. */
export const TRANSPORT_PROTOCOL_GRPC = 1

/**
 * A transport protocol as its name, from either spelling the SDK has used.
 *
 * SDK 0.0.6 names the protocol (`"https"` / `"grpc"`) everywhere an app sees an
 * endpoint; contacts, stored channel records and anything this app persisted
 * before that still carry the numeric discriminant. Anything unrecognised reads
 * as HTTPS, as protobuf treats an unknown enum.
 */
export function protocolName(value: number | string | undefined): 'https' | 'grpc' {
  if (value === TRANSPORT_PROTOCOL_GRPC) return 'grpc'
  return typeof value === 'string' && value.toLowerCase() === 'grpc' ? 'grpc' : 'https'
}

/** An unrecognised name reads as HTTPS, as protobuf treats an unknown enum. */
function protocolDiscriminant(name: string): number {
  return name.toLowerCase() === 'grpc' ? TRANSPORT_PROTOCOL_GRPC : TRANSPORT_PROTOCOL_HTTPS
}

function transportToWire(t: TransportProtocol): TransportProtocolDto {
  return { uri: t.uri, protocol: protocolName(t.protocol) }
}

function transportFromWire(t: TransportProtocolDto): TransportProtocol {
  return { uri: t.uri, protocol: protocolDiscriminant(t.protocol) }
}

/**
 * The endpoints a DTO advertises: the list when present, and otherwise the
 * removed singular field, which is all a payload from an older build carries.
 */
function endpointsFromDto(dto: ContactMessageDto): TransportProtocol[] {
  const list = dto.supported_transports ?? []
  if (list.length > 0) return list.map(transportFromWire)
  return dto.transport_protocol ? [transportFromWire(dto.transport_protocol)] : []
}

export function contactMessageToDto(c: ContactMessage): ContactMessageDto {
  const supported = c.supported_transports.map(transportToWire)
  return {
    channel_id: c.channel_id.toString(),
    nonce: c.nonce.toString(),
    supported_transports: supported,
    contact_mode: c.contact_mode,
    mlkem_encapsulation_key: c.mlkem_encapsulation_key
      ? toBase64Url(c.mlkem_encapsulation_key)
      : undefined,
    ecies_public_key: c.ecies_public_key ? toBase64Url(c.ecies_public_key) : undefined,
    contact_binding_hash: c.contact_binding_hash
      ? toBase64Url(c.contact_binding_hash)
      : undefined,
  }
}

export function dtoToContactMessage(dto: ContactMessageDto): ContactMessage {
  const supported = endpointsFromDto(dto)
  return {
    channel_id: BigInt(dto.channel_id),
    nonce: BigInt(dto.nonce),
    supported_transports: supported,
    contact_mode: dto.contact_mode ?? ContactMode.InlineKeys,
    mlkem_encapsulation_key: dto.mlkem_encapsulation_key
      ? fromBase64Url(dto.mlkem_encapsulation_key)
      : undefined,
    ecies_public_key: dto.ecies_public_key ? fromBase64Url(dto.ecies_public_key) : undefined,
    contact_binding_hash: dto.contact_binding_hash
      ? fromBase64Url(dto.contact_binding_hash)
      : undefined,
  }
}
