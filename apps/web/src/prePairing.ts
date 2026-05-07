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

function channelKey(ns: string, channelId: string): string {
  return `derec:${ns}:contact:${channelId}`
}

function secretKey(ns: string, channelId: string, kind: 0 | 1 | 2): string {
  return `derec:${ns}:secret:${channelId}:${kind}`
}

function addToChannelIndex(ns: string, channelId: string): void {
  const indexKey = `derec:${ns}:contact-index`
  const raw = localStorage.getItem(indexKey)
  const ids: string[] = raw ? (JSON.parse(raw) as string[]) : []
  if (!ids.includes(channelId)) {
    ids.push(channelId)
    localStorage.setItem(indexKey, JSON.stringify(ids))
  }
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
 * @param participantNamespace e.g. `"participant:{participantId}"`
 * @param ownerTransport  Owner's transport advertised to the participant
 * @param participantTransport Participant's transport advertised to the owner
 * @returns The channel ID used for this pairing
 */
export function prePairLocally(
  ownerNamespace: string,
  participantNamespace: string,
  ownerTransport: { protocol: string; uri: string },
  participantTransport: { protocol: string; uri: string },
): bigint {
  const channelId = randomChannelId()
  const channelStr = channelId.toString()

  // Step 1 — participant creates contact (generates its KEM/ECIES key pair)
  const participantCreateResult = primitives.pairing.request.create_contact(
    channelId,
    participantTransport,
  ) as CreateContactResult

  // Step 2 — owner produces pairing request, embedding its own contact
  const ownerRequestResult = primitives.pairing.request.produce(
    SenderKind.OwnerNonRecovery,
    ownerTransport,
    participantCreateResult.contact_message,
  ) as ProduceRequestResult

  // Step 3 — participant processes the request, produces a response, derives its shared key
  const participantResponseResult = primitives.pairing.response.accept(
    SenderKind.Helper,
    ownerRequestResult.envelope,
    participantCreateResult.secret_key_material,
  ) as ProduceResponseResult

  // Step 4 — owner processes the response, derives its shared key
  const ownerResponseResult = primitives.pairing.response.process(
    ownerRequestResult.initiator_contact_message,
    participantResponseResult.envelope,
    ownerRequestResult.secret_key_material,
  ) as ProcessResponseResult

  // Build Channel records (JSON-encoded, what ChannelStore expects).
  // The channel store only needs channel_id, transport, and name — no crypto keys.
  const channelIdNum = Number(channelId)
  const participantChannel = new TextEncoder().encode(JSON.stringify({
    channel_id: channelIdNum,
    transport_uri: participantTransport.uri,
    transport_protocol: 0,
    name: '',
  }))

  const ownerChannel = new TextEncoder().encode(JSON.stringify({
    channel_id: channelIdNum,
    transport_uri: ownerTransport.uri,
    transport_protocol: 0,
    name: '',
  }))

  // Write owner-side state: participant's channel + owner's shared key
  localStorage.setItem(channelKey(ownerNamespace, channelStr), toBase64Url(participantChannel))
  addToChannelIndex(ownerNamespace, channelStr)
  localStorage.setItem(secretKey(ownerNamespace, channelStr, 0), toBase64Url(ownerResponseResult.pairing_shared_key))

  // Write participant-side state: owner's channel + participant's shared key
  localStorage.setItem(channelKey(participantNamespace, channelStr), toBase64Url(ownerChannel))
  addToChannelIndex(participantNamespace, channelStr)
  localStorage.setItem(secretKey(participantNamespace, channelStr, 0), toBase64Url(participantResponseResult.pairing_shared_key))

  return channelId
}
