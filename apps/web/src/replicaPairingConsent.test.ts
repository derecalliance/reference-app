import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SenderKind } from '@derec-alliance/web'
import { type PairingRole } from './pairingRoles'
import { BROWSER_PAIRING_ROLE_OPTIONS } from './pairingRoleOptions'
import { requestPairingConsent, requiresEraseConsent } from './replicaPairingConsent'

const ALL_ROLES: readonly PairingRole[] = [
  'owner',
  'helper',
  'replica_source',
  'replica_destination',
]

/** Consent granted without being asked to say why. */
const grant = () => Promise.resolve(true)
/** Consent refused — what Cancel, Escape and a backdrop click all produce. */
const refuse = () => Promise.resolve(false)

describe('requiresEraseConsent', () => {
  it('flags only the role that gives up this device’s vault', () => {
    expect(requiresEraseConsent('replica_destination')).toBe(true)
    expect(requiresEraseConsent('replica_source')).toBe(false)
    expect(requiresEraseConsent('owner')).toBe(false)
    expect(requiresEraseConsent('helper')).toBe(false)
  })
})

describe('requestPairingConsent — the warning gate', () => {
  it('asks before granting a replica_destination pairing', async () => {
    const ask = vi.fn(grant)

    const consent = await requestPairingConsent('replica_destination', ask)

    expect(ask).toHaveBeenCalledTimes(1)
    expect(consent.kind).toBe('granted')
  })

  it('does not let a pairing start until the gate has been passed', async () => {
    // Models the submit handler: the gate resolves first, `startPairing` only
    // after. A gate that ran after dispatch — or not at all — fails here.
    const order: string[] = []
    const startPairing = vi.fn(async () => {
      order.push('start')
      return 1n
    })

    const consent = await requestPairingConsent('replica_destination', async () => {
      order.push('ask')
      return true
    })
    if (consent.kind === 'granted') await startPairing()

    expect(order).toEqual(['ask', 'start'])
    expect(startPairing).toHaveBeenCalledTimes(1)
  })

  it('never asks for a role that destroys nothing', async () => {
    const ask = vi.fn(refuse)

    for (const role of ['owner', 'helper', 'replica_source'] as const) {
      const consent = await requestPairingConsent(role, ask)
      expect(consent.kind).toBe('granted')
    }

    expect(ask).not.toHaveBeenCalled()
  })
})

describe('cancelling the warning', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('starts no pairing', async () => {
    const startPairing = vi.fn(async () => 1n)

    const consent = await requestPairingConsent('replica_destination', refuse)
    if (consent.kind === 'granted') await startPairing()

    expect(consent.kind).toBe('cancelled')
    expect(startPairing).not.toHaveBeenCalled()
  })

  it('erases nothing', async () => {
    // Stand-ins for the vault the destination role would eventually replace,
    // including the replica identity that must survive even a real adoption.
    localStorage.setItem('derec:replica-id', 'this-device')
    localStorage.setItem('derec:owner:o1:secret:42:0', 'shared-key')
    localStorage.setItem('derec:replica-state:s1', '{"replicas":{}}')
    const before = { ...localStorage }
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem')
    const clear = vi.spyOn(Storage.prototype, 'clear')

    const consent = await requestPairingConsent('replica_destination', refuse)

    expect(consent.kind).toBe('cancelled')
    expect({ ...localStorage }).toEqual(before)
    expect(removeItem).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
    removeItem.mockRestore()
    clear.mockRestore()
  })

  it('leaves the choice repeatable — consenting afterwards still works', async () => {
    expect((await requestPairingConsent('replica_destination', refuse)).kind).toBe('cancelled')
    expect((await requestPairingConsent('replica_destination', grant)).kind).toBe('granted')
  })
})

describe('roles resolved through the gate', () => {
  it('maps each role to its own distinct SenderKind', async () => {
    const kinds = new Map<PairingRole, SenderKind>()
    for (const role of ALL_ROLES) {
      const consent = await requestPairingConsent(role, grant)
      if (consent.kind !== 'granted') throw new Error(`gate refused ${role}`)
      kinds.set(role, consent.pairing.senderKind)
    }

    expect(kinds.get('owner')).toBe(SenderKind.Owner)
    expect(kinds.get('helper')).toBe(SenderKind.Helper)
    expect(kinds.get('replica_source')).toBe(SenderKind.ReplicaSource)
    expect(kinds.get('replica_destination')).toBe(SenderKind.ReplicaDestination)
    expect(new Set(kinds.values()).size).toBe(ALL_ROLES.length)
  })

  it('never degrades a replica pairing into a helper one', async () => {
    // The original defect: a replica role collapsing to SenderKind.Helper.
    for (const role of ['replica_source', 'replica_destination'] as const) {
      const consent = await requestPairingConsent(role, grant)
      if (consent.kind !== 'granted') throw new Error(`gate refused ${role}`)
      expect(consent.pairing.senderKind).not.toBe(SenderKind.Helper)
    }
  })

  it('reports the complementary role the responder takes', async () => {
    const consent = await requestPairingConsent('replica_destination', grant)
    if (consent.kind !== 'granted') throw new Error('gate refused')

    expect(consent.pairing.role).toBe('replica_destination')
    expect(consent.pairing.peerRole).toBe('replica_source')
  })
})

describe('BROWSER_PAIRING_ROLE_OPTIONS', () => {
  it('offers every role exactly once', () => {
    expect(BROWSER_PAIRING_ROLE_OPTIONS.map(o => o.role)).toEqual(ALL_ROLES)
  })

  it('warns, in the picker itself, that the destination choice erases', () => {
    const destination = BROWSER_PAIRING_ROLE_OPTIONS.find(
      o => o.role === 'replica_destination',
    )
    expect(destination?.hint).toMatch(/erase/i)
  })
})
