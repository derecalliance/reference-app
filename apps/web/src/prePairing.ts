// TESTING CONVENIENCE ONLY
//
// Simulates both sides of the DeRec pairing handshake locally using primitives,
// bypassing the protocol message exchange. The resulting shared keys and channel
// records are written directly into localStorage under the same namespaces that
// DeRecProtocol uses, so the protocol instances created later in OwnerSessionPage
// treat the channel as already paired.
//
// Real pairing requires the full handshake over the transport.
//
// NOTE: this module hand-writes the library's persisted `Channel` record, so it
// is coupled to that struct's serde shape. If a pairing simulation ever starts
// failing with a channel-store decode error, check this file against
// `derec_library::protocol::types::Channel` first.

import { primitives, SenderKind, ContactMode } from '@derec-alliance/web'
import { toBase64Url } from './derecApi'

/** Numeric TransportProtocol discriminant for HTTPS. */
const TRANSPORT_PROTOCOL_HTTPS = 0

/** Transport endpoint in the shape the primitives expect. */
interface WireTransport {
  uri: string
  protocol: number
}

// ── Storage key helpers (must match stores.ts) ────────────────────────────────
//
// Every store is partitioned by secret id: a protocol instance binds to one
// secret, and both ends of a relationship bind to the same one — so the helper
// side writes under the *owner's* secret, not one of its own.

function partition(ns: string, secretId: string): string {
  return `derec:${ns}:${secretId}`
}

function channelKey(ns: string, secretId: string, channelId: string): string {
  return `${partition(ns, secretId)}:contact:${channelId}`
}

function secretKey(ns: string, secretId: string, channelId: string, kind: 0 | 1 | 2): string {
  return `${partition(ns, secretId)}:secret:${channelId}:${kind}`
}

function addToChannelIndex(ns: string, secretId: string, channelId: string): void {
  const indexKey = `${partition(ns, secretId)}:contact-index`
  const raw = localStorage.getItem(indexKey)
  const ids: string[] = raw ? (JSON.parse(raw) as string[]) : []
  if (!ids.includes(channelId)) {
    ids.push(channelId)
    localStorage.setItem(indexKey, JSON.stringify(ids))
  }
}

/**
 * Serialize a `Channel` the way the library's channel store expects.
 *
 * `status`, `created_at`, `communication_info` and `replica_id` all carry serde
 * defaults; `id`, `transport` and `peer_role` do not. A channel row describes
 * the party on the other end: `peer_role` is the *peer's* role (this node's is
 * always its inverse) and `transport` is the peer's endpoint.
 */
function encodeChannel(
  channelId: bigint,
  peerTransport: WireTransport,
  peerRole: 'Owner' | 'Helper',
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      id: Number(channelId),
      transport: { uri: peerTransport.uri, protocol: peerTransport.protocol },
      peer_role: peerRole,
      communication_info: {},
    }),
  )
}

// ── Channel ID generation ─────────────────────────────────────────────────────

function randomChannelId(): bigint {
  const buf = crypto.getRandomValues(new Uint8Array(8))
  // Build a u64 from 8 random bytes.
  let result = 0n
  for (const byte of buf) result = (result << 8n) | BigInt(byte)
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
 * @param secretId  The owner's secret (u64 decimal string). Both sides store
 *                  under it — a helper binds to the secret it is helping
 *                  protect, not to one of its own.
 * @param ownerTransport  Owner's transport advertised to the participant
 * @param participantTransport Participant's transport advertised to the owner
 * @returns The post-rekey channel ID both sides settled on
 */
export function prePairLocally(
  ownerNamespace: string,
  participantNamespace: string,
  secretId: string,
  ownerTransport: WireTransport,
  participantTransport: WireTransport,
): bigint {
  const pairingChannelId = randomChannelId()

  // Step 1 — participant creates a contact (generates its KEM/ECIES key pair).
  // Inline keys: there is no PrePair round-trip to run in a local simulation.
  const participantContact = primitives.pairing.request.create_contact(
    pairingChannelId,
    ContactMode.InlineKeys,
    participantTransport,
  )

  // Step 2 — owner produces the pairing request against that contact.
  const ownerRequest = primitives.pairing.request.produce(
    SenderKind.Owner,
    ownerTransport,
    participantContact.contact_message,
    null,
    null,
  )

  // Step 3 — participant extracts the request and answers it, deriving its
  // shared key. `produce` also returns the post-handshake rekey channel id.
  const extractedRequest = primitives.pairing.request.extract(
    ownerRequest.envelope,
    participantContact.secret_key,
  )
  const participantResponse = primitives.pairing.response.produce(
    pairingChannelId,
    extractedRequest.request,
    participantContact.secret_key,
    null,
    null,
  )

  // Step 4 — owner extracts the response and derives the same shared key. Its
  // rekey id is validated against its own derivation, so both sides agree.
  const extractedResponse = primitives.pairing.response.extract(
    participantResponse.envelope,
    ownerRequest.secret_key,
  )
  const ownerResult = primitives.pairing.response.process(
    ownerRequest.initiator_contact_message,
    extractedResponse.response,
    ownerRequest.secret_key,
  )

  // The handshake atomically rotates off the transient pairing id. All
  // persisted state keys on the long-term id — storing under the pairing id
  // would leave records the library never looks up.
  const channelId = ownerResult.channel_id
  const channelStr = channelId.toString()

  // Owner side: the participant is the peer, and its role is Helper.
  localStorage.setItem(
    channelKey(ownerNamespace, secretId, channelStr),
    toBase64Url(encodeChannel(channelId, participantTransport, 'Helper')),
  )
  addToChannelIndex(ownerNamespace, secretId, channelStr)
  localStorage.setItem(
    secretKey(ownerNamespace, secretId, channelStr, 0),
    toBase64Url(ownerResult.shared_key),
  )

  // Participant side: the owner is the peer, and its role is Owner.
  localStorage.setItem(
    channelKey(participantNamespace, secretId, channelStr),
    toBase64Url(encodeChannel(channelId, ownerTransport, 'Owner')),
  )
  addToChannelIndex(participantNamespace, secretId, channelStr)
  localStorage.setItem(
    secretKey(participantNamespace, secretId, channelStr, 0),
    toBase64Url(participantResponse.shared_key),
  )

  return channelId
}

// Retained for symmetry with the transport shape used elsewhere in the app.
export const PRE_PAIR_TRANSPORT_PROTOCOL = TRANSPORT_PROTOCOL_HTTPS
