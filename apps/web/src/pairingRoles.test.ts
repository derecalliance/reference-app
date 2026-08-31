import { describe, expect, it } from 'vitest'
import { SenderKind } from '@derec-alliance/web'
import {
  complementRole,
  isReplicaRole,
  isReplicaSenderKind,
  localReplicaRoleForPeerSenderKind,
  replicaRoleForSenderKind,
  senderKindFor,
  type PairingRole,
} from './pairingRoles'

describe('senderKindFor', () => {
  it('maps each role to its distinct SenderKind', () => {
    expect(senderKindFor('owner')).toBe(SenderKind.Owner)
    expect(senderKindFor('helper')).toBe(SenderKind.Helper)
    expect(senderKindFor('replica_source')).toBe(SenderKind.ReplicaSource)
    expect(senderKindFor('replica_destination')).toBe(SenderKind.ReplicaDestination)
  })

  it('never collapses a replica role to Helper', () => {
    // The exact defect in the previous implementation.
    expect(senderKindFor('replica_source')).not.toBe(SenderKind.Helper)
    expect(senderKindFor('replica_destination')).not.toBe(SenderKind.Helper)
  })
})

describe('complementRole', () => {
  it('pairs roles with their opposite', () => {
    expect(complementRole('owner')).toBe('helper')
    expect(complementRole('helper')).toBe('owner')
    expect(complementRole('replica_source')).toBe('replica_destination')
    expect(complementRole('replica_destination')).toBe('replica_source')
  })

  it('is an involution for every role', () => {
    const roles: PairingRole[] = ['owner', 'helper', 'replica_source', 'replica_destination']
    for (const role of roles) {
      expect(complementRole(complementRole(role))).toBe(role)
    }
  })
})

describe('isReplicaRole', () => {
  it('identifies only the replica roles', () => {
    expect(isReplicaRole('replica_source')).toBe(true)
    expect(isReplicaRole('replica_destination')).toBe(true)
    expect(isReplicaRole('owner')).toBe(false)
    expect(isReplicaRole('helper')).toBe(false)
  })
})

describe('replicaRoleForSenderKind', () => {
  it('inverts senderKindFor for each replica role', () => {
    expect(replicaRoleForSenderKind(SenderKind.ReplicaSource)).toBe('replica_source')
    expect(replicaRoleForSenderKind(SenderKind.ReplicaDestination)).toBe('replica_destination')
  })

  it('reports no replica role for a participant kind or a missing one', () => {
    expect(replicaRoleForSenderKind(SenderKind.Owner)).toBeNull()
    expect(replicaRoleForSenderKind(SenderKind.Helper)).toBeNull()
    expect(replicaRoleForSenderKind(undefined)).toBeNull()
  })

  it('agrees with isReplicaSenderKind on every kind', () => {
    // The roster guard and the direction lookup must classify identically: a
    // kind the guard let through but this could not name would leave a replica
    // channel with no row, and one it named but the guard rejected would put a
    // replica in the participant roster.
    const kinds = [
      SenderKind.Owner,
      SenderKind.Helper,
      SenderKind.ReplicaSource,
      SenderKind.ReplicaDestination,
      undefined,
    ]
    for (const kind of kinds) {
      expect(replicaRoleForSenderKind(kind) !== null).toBe(isReplicaSenderKind(kind))
    }
  })
})

describe('localReplicaRoleForPeerSenderKind', () => {
  it('reports the counterparty of what the peer declared', () => {
    // Alice declares ReplicaSource; Bob, receiving it, is the destination — the
    // side whose vault is replaced. Getting this backwards would warn the wrong
    // device and leave the one being erased unwarned.
    expect(localReplicaRoleForPeerSenderKind(SenderKind.ReplicaSource)).toBe(
      'replica_destination',
    )
    expect(localReplicaRoleForPeerSenderKind(SenderKind.ReplicaDestination)).toBe(
      'replica_source',
    )
  })

  it('never reports the same side the peer declared', () => {
    for (const kind of [SenderKind.ReplicaSource, SenderKind.ReplicaDestination]) {
      expect(localReplicaRoleForPeerSenderKind(kind)).not.toBe(
        replicaRoleForSenderKind(kind),
      )
    }
  })

  it('reports no replica role for a participant kind or a missing one', () => {
    expect(localReplicaRoleForPeerSenderKind(SenderKind.Owner)).toBeNull()
    expect(localReplicaRoleForPeerSenderKind(SenderKind.Helper)).toBeNull()
    expect(localReplicaRoleForPeerSenderKind(undefined)).toBeNull()
  })

  it('agrees with complementRole on every kind it names', () => {
    // Stated against the shared helper rather than a literal, so a hand-rolled
    // mapping cannot be reintroduced here without this failing.
    const kinds = [
      SenderKind.Owner,
      SenderKind.Helper,
      SenderKind.ReplicaSource,
      SenderKind.ReplicaDestination,
      undefined,
    ]
    for (const kind of kinds) {
      const peerRole = replicaRoleForSenderKind(kind)
      expect(localReplicaRoleForPeerSenderKind(kind)).toBe(
        peerRole === null ? null : complementRole(peerRole),
      )
    }
  })
})
