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

import { ContactMode, type ContactMessage } from '@derec-alliance/web'
import type { ContactMessageDto } from './api'
import { fromBase64Url, toBase64Url } from './derecApi'

/** Numeric TransportProtocol discriminant for HTTPS. */
export const TRANSPORT_PROTOCOL_HTTPS = 0

function transportToWire(t: ContactMessage['transport_protocol']): { uri: string; protocol: string } {
  return { uri: t?.uri ?? '', protocol: 'https' }
}

function transportFromWire(t: { uri: string; protocol: string }): { uri: string; protocol: number } {
  return { uri: t.uri, protocol: TRANSPORT_PROTOCOL_HTTPS }
}

export function contactMessageToDto(c: ContactMessage): ContactMessageDto {
  return {
    channel_id: c.channel_id.toString(),
    nonce: c.nonce.toString(),
    transport_protocol: transportToWire(c.transport_protocol),
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
  return {
    channel_id: BigInt(dto.channel_id),
    nonce: BigInt(dto.nonce),
    transport_protocol: transportFromWire(dto.transport_protocol),
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
