// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { StoredReplicaMember } from '../stores'

/**
 * Why this vault cannot publish as a member of its replica group, or `null`.
 *
 * The library publishes on the group's channel as one of its members, so a
 * group that does not list this device's replica id stops every round before
 * a share is sent — reported only as "internal invariant violated: replica
 * group has members but this device holds no row of its own". The same test
 * the library applies, made here first so the person is told what happened
 * and what to do about it.
 *
 * The one way into this state was a restore that kept this device's own id for
 * a group recovered from another device. Restore now takes the identity the
 * group names, so restoring again is the way out.
 */
export function replicaMembershipProblem(
  members: readonly StoredReplicaMember[],
  ownReplicaId: string,
): string | null {
  if (members.length === 0) return null
  if (members.some(member => member.replicaId === ownReplicaId)) return null
  return (
    'Nothing was sent: this vault belongs to a replica group that does not list this device, ' +
    'so no new version can be published from it. This happens when a vault with replicas was ' +
    'restored on a new device by an earlier version of this app. Recover it again — Discover, ' +
    'Recover, then Recover from bag — and the restore gives this device the identity its group knows.'
  )
}
