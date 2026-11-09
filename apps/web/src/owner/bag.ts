// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { fromBase64Url } from '../derecApi'
import type { StoredReplicaMember } from '../stores'
import type { BagReplicaGroup, BagVersion, ItemBag } from '../types'

/** Version `version` of `bag`, current or previous; `undefined` when it holds no such version. */
export function bagVersionOf(bag: ItemBag | null, version: number): BagVersion | undefined {
  if (!bag) return undefined
  return bag.currentVersion.version === version
    ? bag.currentVersion
    : bag.previousVersions.find(v => v.version === version)
}

export function updateBagVersion(
  bag: ItemBag,
  version: number,
  updater: (v: BagVersion) => BagVersion,
): ItemBag {
  if (bag.currentVersion.version === version) {
    return { ...bag, currentVersion: updater(bag.currentVersion) }
  }
  return {
    ...bag,
    previousVersions: bag.previousVersions.map(v => (v.version === version ? updater(v) : v)),
  }
}

export function updateBagParticipant(
  bag: ItemBag,
  version: number,
  participantId: string,
): ItemBag {
  return updateBagVersion(bag, version, v =>
    v.participantIds.includes(participantId)
      ? v
      : { ...v, participantIds: [...v.participantIds, participantId] },
  )
}

export function updateBagVerified(
  bag: ItemBag,
  version: number,
  participantId: string,
): ItemBag {
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
 * every confirmed (`Paired`) member, this device included. One that is
 * leaving (`Unpairing`) is left out — its absence is what completes its
 * removal — and from SDK 0.0.11 so is one whose pairing is not yet confirmed
 * (`Pending`), which every recipient would otherwise install as a member. The
 * group's channel is the one on this device's own row; a member admitted
 * since the last round may still sit on its pairing channel. `null` when
 * there is no group, or no row of our own to name it by.
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
      .filter(m => m.status === 'Paired')
      .map(m => ({ replicaId: m.replicaId, role: m.role, name: m.name })),
  }
}

/** Builds a structured representation of the SecretContainer that gets protobuf-encoded and distributed. */
/**
 * An item id as hex, whichever form it is stored in.
 *
 * Ids this app mints are hex; ids that came out of an adopted or recovered
 * snapshot are the library's base64url rendering of the same bytes. Shown
 * as stored, the source and its destination displayed one item under two
 * different-looking ids. The same test as the protect path's
 * `itemIdBytes`, so what is shown is what would be sent.
 */
export function itemIdHex(id: string): string {
  if (/^(?:[0-9a-f]{2})+$/i.test(id)) return id.toLowerCase()
  try {
    return Array.from(fromBase64Url(id), b => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return id
  }
}

/** Placeholder for an item value the payload view has not been asked to reveal. */
export const MASKED_SECRET_VALUE = '••••••••'

export function buildSecretContainerPayload(
  version: BagVersion,
  { maskItems: maskItems = false }: { maskItems?: boolean } = {},
) {
  return {
    helpers: version.helpers.map(h => ({
      channel_id: h.channelId,
      transport_uri: `(paired endpoint)`,
      name: h.name,
      shared_key: '(32-byte symmetric key)',
    })),
    secrets: version.items.map(s => ({
      id: itemIdHex(s.id),
      name: s.name,
      // Masked the same way the Items table masks them: a payload view is
      // not a reason to put every value on screen at once.
      data: maskItems ? MASKED_SECRET_VALUE : s.data,
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
