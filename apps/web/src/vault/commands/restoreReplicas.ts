// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { ReplicaPairingRole } from '../../pairingRoles'
import type { RecoveredSecretReplica, RecoveredSecretSnapshot } from '../../types'

/** The replica group a recovered snapshot carries. */
export type RecoveredReplicaGroup = NonNullable<RecoveredSecretSnapshot['replicas']>

/** The replica id a restored vault is built with, and how it was chosen. */
export interface RestoredReplicaIdentity {
  replicaId: bigint
  /**
   * The id is the group's `Source`, not one this device held: restoring took
   * over the identity the group knows the vault by.
   */
  takesOverSource: boolean
}

/**
 * Which replica id a vault restored from `group` must run under.
 *
 * The library publishes as a member of the group, so after `restore` it needs
 * a configured `replica_id` the recovered roster names — and `restore`
 * deliberately does not pick one (lib-derec `handlers/restore.rs`, step 3).
 * Without one every publish fails with "replica group has members but this
 * device holds no row of its own".
 *
 * - **This device is already a member** — restoring on the device that holds
 *   the group: its own id stays.
 * - **It is not** — restoring on a new device after losing the old one: it
 *   takes the `Source`'s id. That is the device the secret was protected from,
 *   which is exactly what this one now replaces, and it keeps the library's
 *   interim rule of one `Source` per group, set at first pairing. A
 *   `Destination`'s id is never taken: that member is another live device, and
 *   claiming its identity would have two devices answer as one replica.
 *
 * `null` when there is nothing to choose from — no group, or a roster with no
 * `Source` — and the caller keeps the vault's own id.
 */
export function restoredReplicaIdentity(
  group: RecoveredReplicaGroup | undefined,
  storedId: bigint | null,
): RestoredReplicaIdentity | null {
  if (!group || group.members.length === 0) return null

  if (storedId !== null && group.members.some(m => m.replicaId === storedId.toString())) {
    return { replicaId: storedId, takesOverSource: false }
  }

  const source = group.members.find(m => m.role === 'Source')
  const sourceId = source ? parseReplicaId(source.replicaId) : null
  return sourceId === null ? null : { replicaId: sourceId, takesOverSource: true }
}

/** The member a restored vault's replica channel row names, and this device's side of it. */
export interface RestoredGroupPeer {
  peer: RecoveredSecretReplica
  /** The role **this** device holds in the group. */
  ownRole: ReplicaPairingRole
  /** The role the named member holds — the row's `peerRole`. */
  peerRole: ReplicaPairingRole
}

/**
 * The member to name on the one channel row a restored group gets.
 *
 * Every member shares the group's channel, so a device holds one channel row
 * for the group and lists any further member through the library's own store
 * (`groupMemberRows`). This picks who that row is about:
 *
 * - on a `Destination`, the `Source` — the side it mirrors from;
 * - on the `Source`, the member this device already recorded against the
 *   channel when it is still in the group, so a row keeps its peer across a
 *   restore on the same device; otherwise the first other member.
 *
 * Members `restore` wrote no channel for (`notRestored`) are skipped: there is
 * nothing to address them on. `null` when this device is not in the group, or
 * no other member was restored.
 */
export function restoredGroupPeer(
  group: RecoveredReplicaGroup,
  ownReplicaId: string,
  notRestored: ReadonlySet<string>,
  recordedPeerId: string | null,
): RestoredGroupPeer | null {
  const own = group.members.find(m => m.replicaId === ownReplicaId)
  if (!own) return null

  const others = group.members.filter(
    m => m.replicaId !== ownReplicaId && !notRestored.has(m.replicaId),
  )
  const ownRole = roleOf(own)
  const peer =
    ownRole === 'replica_destination'
      ? (others.find(m => m.role === 'Source') ?? others[0])
      : (others.find(m => m.replicaId === recordedPeerId) ?? others[0])
  if (!peer) return null

  return { peer, ownRole, peerRole: roleOf(peer) }
}

/** A roster member's role, in this app's vocabulary. */
function roleOf(member: RecoveredSecretReplica): ReplicaPairingRole {
  return member.role === 'Source' ? 'replica_source' : 'replica_destination'
}

/** A decimal replica id, or `null` for one the library would refuse (unparsable, or `0`). */
function parseReplicaId(value: string): bigint | null {
  try {
    const id = BigInt(value)
    return id > 0n ? id : null
  } catch {
    return null
  }
}
