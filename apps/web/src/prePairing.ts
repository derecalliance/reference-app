// TESTING CONVENIENCE ONLY
//
// Simulates both sides of the DeRec pairing handshake locally using primitives,
// bypassing the protocol message exchange. The resulting shared keys and contact
// messages are written directly into localStorage under the same namespaces that
// DeRecProtocol uses, so the protocol instances created later in OwnerSessionPage
// treat the channel as already paired.
//
// Real pairing requires the full handshake over the transport.

import { primitives, SenderKind } from '@derec-alliance/web'
import { toBase64Url } from './derecApi'

// ── Storage key helpers (must match stores.ts) ────────────────────────────────

function contactKey(ns: string, channelId: string): string {
  return `derec:${ns}:contact:${channelId}`
}

function secretKey(ns: string, channelId: string, kind: 0 | 1): string {
  return `derec:${ns}:secret:${channelId}:${kind}`
}

// ── Internal result types (primitives are typed as `any` in the public API) ──

interface CreateContactResult {
  contact_message: unknown
  secret_key_material: Uint8Array
}

interface ProduceRequestResult {
  envelope: unknown
  initiator_contact_message: unknown
  secret_key_material: Uint8Array
}

interface ProduceResponseResult {
  envelope: unknown
  pairing_shared_key: Uint8Array
}

interface ProcessResponseResult {
  pairing_shared_key: Uint8Array
}

// ── Channel ID generation ─────────────────────────────────────────────────────

function randomChannelId(): bigint {
  const buf = crypto.getRandomValues(new Uint8Array(8))
  // Build a u64 from 8 random bytes. Shift by 7 bytes max to stay in u64 range.
  let result = 0n
  for (const byte of buf) result = (result << 8n) | BigInt(byte)
  // Clamp to u64 max (2^64 - 1)
  return result & 0xFFFFFFFFFFFFFFFFn
}

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Runs both sides of the pairing handshake locally and stores the resulting
 * shared keys in localStorage so that the protocol instances for this session
 * treat the channel as already established.
 *
 * @param ownerNamespace  e.g. `"owner:{ownerId}"`
 * @param helperNamespace e.g. `"helper:{helperId}"`
 * @param ownerTransport  Owner's transport advertised to the helper
 * @param helperTransport Helper's transport advertised to the owner
 * @returns The channel ID used for this pairing
 */
export function prePairLocally(
  ownerNamespace: string,
  helperNamespace: string,
  ownerTransport: { protocol: string; uri: string },
  helperTransport: { protocol: string; uri: string },
): bigint {
  const channelId = randomChannelId()
  const channelStr = channelId.toString()

  // Step 1 — helper creates contact (generates its KEM/ECIES key pair)
  const helperCreateResult = primitives.pairing.request.create_contact(
    channelId,
    helperTransport,
  ) as CreateContactResult

  // Step 2 — owner produces pairing request, embedding its own contact
  const ownerRequestResult = primitives.pairing.request.produce(
    SenderKind.OwnerNonRecovery,
    ownerTransport,
    helperCreateResult.contact_message,
  ) as ProduceRequestResult

  // Step 3 — helper processes the request, produces a response, derives its shared key
  const helperResponseResult = primitives.pairing.response.produce(
    SenderKind.Helper,
    ownerRequestResult.envelope,
    helperCreateResult.secret_key_material,
  ) as ProduceResponseResult

  // Step 4 — owner processes the response, derives its shared key
  const ownerResponseResult = primitives.pairing.response.process(
    ownerRequestResult.initiator_contact_message,
    helperResponseResult.envelope,
    ownerRequestResult.secret_key_material,
  ) as ProcessResponseResult

  // Encode contacts to protobuf bytes (what ContactStore expects).
  //
  // Owner-side contact store: the helper's contact (so the owner can route to the helper).
  const helperContactBytes: Uint8Array = primitives.pairing.request.encode_contact(
    helperCreateResult.contact_message,
  )

  // Helper-side contact store: a ContactMessage carrying the owner's transport.
  // The protocol's peer_endpoint() only reads transport_protocol, so we create a contact
  // with the owner's transport URI. (create_contact generates fresh crypto keys; they are
  // harmless because they are never used — only transport_protocol is read at runtime.)
  const ownerContactForHelper = primitives.pairing.request.create_contact(
    channelId,
    ownerTransport,
  ) as CreateContactResult
  const ownerContactBytes: Uint8Array = primitives.pairing.request.encode_contact(
    ownerContactForHelper.contact_message,
  )

  // Write owner-side state: helper's contact + owner's shared key
  localStorage.setItem(contactKey(ownerNamespace, channelStr), toBase64Url(helperContactBytes))
  localStorage.setItem(secretKey(ownerNamespace, channelStr, 0), toBase64Url(ownerResponseResult.pairing_shared_key))

  // Write helper-side state: owner's contact + helper's shared key
  localStorage.setItem(contactKey(helperNamespace, channelStr), toBase64Url(ownerContactBytes))
  localStorage.setItem(secretKey(helperNamespace, channelStr, 0), toBase64Url(helperResponseResult.pairing_shared_key))

  return channelId
}
