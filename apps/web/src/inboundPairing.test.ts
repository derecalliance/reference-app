import { describe, expect, it } from 'vitest'
import { SenderKind } from '@derec-alliance/web'
import { classifyInboundPairing } from './inboundPairing'
import { complementRole, replicaRoleForSenderKind } from './pairingRoles'

/**
 * Which confirmation an inbound pairing raises.
 *
 * The bug this covers: the handler ignored `sender_kind` entirely, so a replica
 * pairing arrived behind the participant modal — which offers linking (a replica
 * channel cannot be linked) and says nothing about the responder's own vault
 * being replaced. `replica === null` is what routes to the participant modal, so
 * these assertions are the branch.
 */

const REQUEST = {
  peerName: 'Alice',
  channelId: 'chan-1',
  action: new Uint8Array([1, 2, 3]),
}

describe('classifyInboundPairing — replica kinds', () => {
  it('raises the replica confirmation for a ReplicaSource initiator, not the participant one', () => {
    const confirmation = classifyInboundPairing(REQUEST, SenderKind.ReplicaSource)
    expect(confirmation.replica).not.toBeNull()
    expect(confirmation.replica).toEqual({
      peerRole: 'replica_source',
      // Alice sources, so this device is the side that gets replaced.
      localRole: 'replica_destination',
    })
  })

  it('raises the replica confirmation for a ReplicaDestination initiator, with this device sourcing', () => {
    const confirmation = classifyInboundPairing(REQUEST, SenderKind.ReplicaDestination)
    expect(confirmation.replica).toEqual({
      peerRole: 'replica_destination',
      localRole: 'replica_source',
    })
  })

  it('never reports this device as the same side the peer declared', () => {
    for (const kind of [SenderKind.ReplicaSource, SenderKind.ReplicaDestination]) {
      const replica = classifyInboundPairing(REQUEST, kind)!.replica
      expect(replica).not.toBeNull()
      expect(replica!.localRole).not.toBe(replica!.peerRole)
    }
  })

  it('derives this device as the counterparty the library resolves, for every kind', () => {
    // The library takes `peer_kind.counterparty()`; anything else and the two
    // sides disagree about who gets erased.
    const kinds = [
      SenderKind.Owner,
      SenderKind.Helper,
      SenderKind.ReplicaSource,
      SenderKind.ReplicaDestination,
      undefined,
    ]
    for (const kind of kinds) {
      const peerRole = replicaRoleForSenderKind(kind)
      const replica = classifyInboundPairing(REQUEST, kind).replica
      if (peerRole === null) {
        expect(replica).toBeNull()
      } else {
        expect(replica).toEqual({ peerRole, localRole: complementRole(peerRole) })
      }
    }
  })
})

describe('classifyInboundPairing — participant kinds', () => {
  it('keeps a Helper initiator on the participant modal', () => {
    expect(classifyInboundPairing(REQUEST, SenderKind.Helper).replica).toBeNull()
  })

  it('keeps an Owner initiator on the participant modal', () => {
    expect(classifyInboundPairing(REQUEST, SenderKind.Owner).replica).toBeNull()
  })

  it('keeps an event that reported no kind on the participant modal', () => {
    // `sender_kind` is optional on the wire; an absent one is an ordinary
    // pairing, never a replica.
    expect(classifyInboundPairing(REQUEST, undefined).replica).toBeNull()
  })
})

describe('classifyInboundPairing — the request itself', () => {
  it('carries the accept token and identity through untouched, for both verdicts', () => {
    for (const kind of [SenderKind.Helper, SenderKind.ReplicaSource]) {
      const confirmation = classifyInboundPairing(REQUEST, kind)
      expect(confirmation.peerName).toBe('Alice')
      expect(confirmation.channelId).toBe('chan-1')
      // The same opaque token either way — there is one accept path.
      expect(confirmation.action).toBe(REQUEST.action)
    }
  })
})
