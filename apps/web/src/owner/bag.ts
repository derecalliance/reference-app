// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { fromBase64Url } from '../derecApi'
import type { StoredReplicaMember } from '../stores'
import type { BagReplicaGroup, BagVersion, SecretBag } from '../types'

export function updateBagVersion(
  bag: SecretBag,
  version: number,
  updater: (v: BagVersion) => BagVersion,
): SecretBag {
  if (bag.currentVersion.version === version) {
    return { ...bag, currentVersion: updater(bag.currentVersion) }
  }
  return {
    ...bag,
    previousVersions: bag.previousVersions.map(v => (v.version === version ? updater(v) : v)),
  }
}

export function updateBagParticipant(
  bag: SecretBag,
  version: number,
  participantId: string,
): SecretBag {
  return updateBagVersion(bag, version, v =>
    v.participantIds.includes(participantId)
      ? v
      : { ...v, participantIds: [...v.participantIds, participantId] },
  )
}

export function updateBagVerified(
  bag: SecretBag,
  version: number,
  participantId: string,
): SecretBag {
  return updateBagVersion(bag, version, v =>
    v.verifiedParticipantIds.includes(participantId)
      ? v
      : { ...v, verifiedParticipantIds: [...v.verifiedParticipantIds, participantId] },
  )
}

/**
 * The replica group a protect round puts in the secret, read from the same
 * store the library reads.
 *
 * Mirrors the library's own rule (`build_replicas` in `handlers/sharing.rs`):
 * every stored member, this device included, except one that is leaving
 * (`Unpairing`) — its absence is what completes its removal. The group's
 * channel is the one on this device's own row; a member admitted since the
 * last round may still sit on its pairing channel. `null` when there is no
 * group, or no row of our own to name it by.
 */
export function replicaGroupFromStore(
  members: readonly StoredReplicaMember[],
  ownReplicaId: string,
): BagReplicaGroup | null {
  const channelId = members.find(m => m.replicaId === ownReplicaId)?.channelId
  if (!channelId) return null
  return {
    channelId,
    members: members
      .filter(m => m.status !== 'Unpairing')
      .map(m => ({ replicaId: m.replicaId, role: m.role, name: m.name })),
  }
}

/** Builds a structured representation of the SecretContainer that gets protobuf-encoded and distributed. */
/**
 * A user-secret id as hex, whichever form it is stored in.
 *
 * Ids this app mints are hex; ids that came out of an adopted or recovered
 * snapshot are the library's base64url rendering of the same bytes. Shown
 * as stored, the source and its destination displayed one secret under two
 * different-looking ids. The same test as the protect path's
 * `userSecretIdBytes`, so what is shown is what would be sent.
 */
export function userSecretIdHex(id: string): string {
  if (/^(?:[0-9a-f]{2})+$/i.test(id)) return id.toLowerCase()
  try {
    return Array.from(fromBase64Url(id), b => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return id
  }
}

/** Placeholder for a secret value the payload view has not been asked to reveal. */
export const MASKED_SECRET_VALUE = '••••••••'

export function buildSecretContainerPayload(
  version: BagVersion,
  { maskSecrets = false }: { maskSecrets?: boolean } = {},
) {
  return {
    helpers: version.helpers.map(h => ({
      channel_id: h.channelId,
      transport_uri: `(paired endpoint)`,
      name: h.name,
      shared_key: '(32-byte symmetric key)',
    })),
    secrets: version.secrets.map(s => ({
      id: userSecretIdHex(s.id),
      name: s.name,
      // Masked the same way the Secrets table masks them: a payload view is
      // not a reason to put every value on screen at once.
      data: maskSecrets ? MASKED_SECRET_VALUE : s.data,
    })),
    replicas: replicasPayload(version.replicas),
  }
}

/** The `replicas` field: the group, `null` for none, or a note when this version predates tracking it. */
function replicasPayload(group: BagReplicaGroup | null | undefined) {
  if (group === undefined) return '(not recorded for this version)'
  if (group === null) return null
  return {
    channel_id: group.channelId,
    members: group.members.map(m => ({
      replica_id: m.replicaId,
      role: m.role,
      name: m.name,
      transports: '(advertised endpoints)',
    })),
    shared_key: '(32-byte group key)',
  }
}

/** Returns a hex dump of the UTF-8 JSON payload, 32 bytes per line. */
export function hexDump(data: Uint8Array): string[] {
  const lines: string[] = []
  const bytesPerLine = 16
  for (let offset = 0; offset < data.length; offset += bytesPerLine) {
    const slice = data.slice(offset, offset + bytesPerLine)
    const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = Array.from(slice).map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('')
    const addr = offset.toString(16).padStart(8, '0')
    lines.push(`${addr}  ${hex.padEnd(bytesPerLine * 3 - 1)}  ${ascii}`)
  }
  return lines
}
