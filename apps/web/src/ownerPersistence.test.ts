import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearActiveOwner,
  deleteOwner,
  listOwners,
  loadActiveOwner,
  loadOwnerById,
  persistOwner,
} from './ownerPersistence'
import type { Owner } from './types'

function owner(ownerId: string, ownerName: string): Owner {
  return {
    ownerId,
    ownerName,
    ownSecretId: '42',
    transport: { protocol: 'https', uri: `https://example.test/${ownerId}` },
    participants: [],
    secretBag: null,
    pendingPairings: [],
    minParticipants: 2,
    recommendedParticipants: 3,
    recoveredSecrets: [],
    recoveryProgress: null,
    recoveryFailures: [],
    heldShares: [],
    mainChannels: [],
    config: {
      protocolTimeoutSecs: 300,
      authenticationMethod: 'user',
      unpairAck: 'required',
      autoAcceptUnpairRequests: true,
    },
  }
}

describe('ownerPersistence', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('round-trips an owner by id', () => {
    persistOwner(owner('o1', 'Alice'))

    expect(loadOwnerById('o1')?.ownerName).toBe('Alice')
  })

  // ── Per-tab active pointer ─────────────────────────────────────────────────
  //
  // The pointer lives in sessionStorage so each tab tracks its own owner. Held
  // in localStorage it was a single global cursor: a second tab setting up an
  // owner silently moved the first tab's idea of "current".

  it('keeps the active pointer out of localStorage', () => {
    persistOwner(owner('o1', 'Alice'))

    expect(sessionStorage.getItem('derec:active-owner')).toBe('o1')
    expect(localStorage.getItem('derec:active-owner')).toBeNull()
  })

  it('reports no active owner for a tab that has not picked one', () => {
    // A fresh tab shares localStorage with every other tab, so the owner data
    // is right there — but it must still land on the picker rather than
    // adopting whatever another tab happens to be driving.
    persistOwner(owner('o1', 'Alice'))
    sessionStorage.clear()

    expect(loadActiveOwner()).toBeNull()
    expect(loadOwnerById('o1')).not.toBeNull()
  })

  it('resumes the active owner while the pointer survives', () => {
    persistOwner(owner('o1', 'Alice'))

    expect(loadActiveOwner()?.ownerName).toBe('Alice')
  })

  it('clearing the active owner leaves the stored owner intact', () => {
    persistOwner(owner('o1', 'Alice'))

    clearActiveOwner()

    expect(loadActiveOwner()).toBeNull()
    expect(loadOwnerById('o1')?.ownerName).toBe('Alice')
  })

  // ── Picker listing ─────────────────────────────────────────────────────────

  it('lists every saved owner', () => {
    persistOwner(owner('o1', 'Alice'))
    persistOwner(owner('o2', 'Bob'))

    expect(listOwners().map(o => o.ownerName)).toEqual(['Alice', 'Bob'])
  })

  it('does not mistake protocol-store rows for owners', () => {
    // `stores.ts` partitions under `derec:owner:{id}:{secretId}:…`, so a naive
    // prefix match would list hundreds of channel and share rows as owners.
    persistOwner(owner('o1', 'Alice'))
    localStorage.setItem('derec:owner:o1:42:contact-index', '[]')
    localStorage.setItem('derec:owner:o1:42:share:900:1', 'AAAA')
    localStorage.setItem('derec:owner:o1:42:state-idx:0', '[]')

    expect(listOwners()).toHaveLength(1)
    expect(listOwners()[0].ownerId).toBe('o1')
  })

  it('skips owners too stale to load', () => {
    // `loadOwnerById` rejects records with no `ownSecretId`; the picker must
    // not offer a row that would fail to open.
    persistOwner(owner('o1', 'Alice'))
    localStorage.setItem(
      'derec:owner:o2',
      JSON.stringify({ type: 'owner', owner: { ownerId: 'o2', ownerName: 'Stale' } }),
    )

    expect(listOwners().map(o => o.ownerId)).toEqual(['o1'])
  })

  it('reports how many participants each owner has paired', () => {
    const alice = owner('o1', 'Alice')
    alice.participants = [
      {
        id: 'p1',
        name: 'Bob',
        channelId: '900',
        transport: { protocol: 'https', uri: 'https://example.test/p1' },
        secretShares: [],
        connectionStatus: 'paired',
      },
      {
        id: 'p2',
        name: 'Carol',
        channelId: '',
        transport: { protocol: 'https', uri: 'https://example.test/p2' },
        secretShares: [],
        connectionStatus: 'available',
      },
    ]
    persistOwner(alice)

    expect(listOwners()[0].pairedCount).toBe(1)
  })

  it('ignores keys belonging to anything else on the origin', () => {
    persistOwner(owner('o1', 'Alice'))
    localStorage.setItem('unrelated', 'x')
    localStorage.setItem('derec:replica-id:o1', '7')

    expect(listOwners()).toHaveLength(1)
  })

  // ── Deletion ───────────────────────────────────────────────────────────────

  it('deleting the active owner clears this tab’s pointer', () => {
    persistOwner(owner('o1', 'Alice'))

    deleteOwner('o1')

    expect(loadActiveOwner()).toBeNull()
    expect(listOwners()).toEqual([])
  })

  it('deleting another owner leaves this tab’s pointer alone', () => {
    persistOwner(owner('o2', 'Bob'))
    persistOwner(owner('o1', 'Alice')) // active

    deleteOwner('o2')

    expect(loadActiveOwner()?.ownerId).toBe('o1')
  })
})
