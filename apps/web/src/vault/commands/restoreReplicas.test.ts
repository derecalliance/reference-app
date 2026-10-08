// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import type { RecoveredSecretReplica } from '../../types'
import {
  restoredGroupPeer,
  restoredReplicaIdentity,
  type RecoveredReplicaGroup,
} from './restoreReplicas'

function member(replicaId: string, role: RecoveredSecretReplica['role'], name = replicaId): RecoveredSecretReplica {
  return {
    replicaId,
    role,
    transports: [{ uri: `http://localhost:5000/derec/${name}`, protocol: 'https' }],
    communicationInfo: { name },
  }
}

const group: RecoveredReplicaGroup = {
  channelId: '700',
  sharedKey: '',
  members: [member('1001', 'Source', 'Lost laptop'), member('2002', 'Destination', 'Phone')],
}

describe('restoredReplicaIdentity', () => {
  it('keeps this device’s id when the group already names it', () => {
    expect(restoredReplicaIdentity(group, 2002n)).toEqual({ replicaId: 2002n, takesOverSource: false })
    expect(restoredReplicaIdentity(group, 1001n)).toEqual({ replicaId: 1001n, takesOverSource: false })
  })

  it('takes over the source’s id on a device the group does not name', () => {
    expect(restoredReplicaIdentity(group, 5555n)).toEqual({ replicaId: 1001n, takesOverSource: true })
    expect(restoredReplicaIdentity(group, null)).toEqual({ replicaId: 1001n, takesOverSource: true })
  })

  it('never takes a destination’s id — that member is another live device', () => {
    const noSource = { ...group, members: [member('2002', 'Destination')] }
    expect(restoredReplicaIdentity(noSource, 5555n)).toBeNull()
  })

  it('has nothing to choose without a group', () => {
    expect(restoredReplicaIdentity(undefined, 5555n)).toBeNull()
    expect(restoredReplicaIdentity({ ...group, members: [] }, 5555n)).toBeNull()
  })
})

describe('restoredGroupPeer', () => {
  it('names a destination on the source, as a destination row', () => {
    const peer = restoredGroupPeer(group, '1001', new Set(), null)
    expect(peer?.peer.replicaId).toBe('2002')
    expect(peer?.ownRole).toBe('replica_source')
    expect(peer?.peerRole).toBe('replica_destination')
  })

  it('keeps the member this device already recorded against the channel', () => {
    const three = { ...group, members: [...group.members, member('3003', 'Destination')] }
    expect(restoredGroupPeer(three, '1001', new Set(), '3003')?.peer.replicaId).toBe('3003')
  })

  it('names the source on a destination', () => {
    const peer = restoredGroupPeer(group, '2002', new Set(), null)
    expect(peer?.peer.replicaId).toBe('1001')
    expect(peer?.ownRole).toBe('replica_destination')
    expect(peer?.peerRole).toBe('replica_source')
  })

  it('names nobody the restore wrote no channel for, nor a group without this device', () => {
    expect(restoredGroupPeer(group, '1001', new Set(['2002']), null)).toBeNull()
    expect(restoredGroupPeer(group, '9999', new Set(), null)).toBeNull()
  })
})
