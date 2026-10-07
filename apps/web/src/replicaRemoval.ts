// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { ReplicaView } from './replicaFlows'

/** What the user asked to do, and to whom. */
export type ReplicaRemovalRequest =
  | {
      kind: 'forget'
      channelId: string
      name: string
    }
  | {
      kind: 'remove'
      /** The member to evict — the id `RemoveReplica` names. */
      replicaId: string
      /** The row's channel, when there is one, so its records go with it. */
      channelId: string | null
      name: string
      /**
       * The member being evicted is the group's source — the device the vault
       * originated on. Evicting it erases the original, and the library then
       * promotes another member (possibly this device) to source.
       */
      targetIsSource: boolean
    }

/**
 * A removal request for evicting the member on `view`'s other end, or `null`
 * when that member is not yet known by replica id.
 *
 * `direction` is *this* device's side, so a row on which this device is the
 * destination names a peer that is the source.
 */
export function removalRequestFor(view: ReplicaView): ReplicaRemovalRequest | null {
  if (view.peerReplicaId === null) return null
  return {
    kind: 'remove',
    replicaId: view.peerReplicaId,
    channelId: view.channelId,
    name: view.name,
    targetIsSource: view.direction === 'replica_destination',
  }
}
