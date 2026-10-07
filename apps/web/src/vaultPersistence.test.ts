// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteVault, listVaultIds, loadVaultById, persistVault } from './vaultPersistence'
import type { RecoveredSecretTransport, Vault } from './types'

function vault(id: string, name: string): Vault {
  return {
    id,
    name,
    secretId: '42',
    transport: { protocol: 'https', uri: `https://example.test/${id}` },
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
    configOverrides: {},
  }
}

describe('vaultPersistence', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('round-trips a vault by id', () => {
    persistVault(vault('o1', 'Alice'))

    expect(loadVaultById('o1')?.name).toBe('Alice')
  })

  it('lifts the single pending protect round of an older record into the list', () => {
    const round = {
      version: 3,
      protocolSecretId: '42',
      bag: {
        secretId: '42',
        threshold: 2,
        previousVersions: [],
        currentVersion: {
          version: 3,
          participantIds: [],
          verifiedParticipantIds: [],
          failedParticipantIds: [],
          secrets: [],
          rawBytes: '',
          helpers: [],
        },
      },
      channelIds: ['900'],
    }
    localStorage.setItem(
      'derec:vault:o1',
      JSON.stringify({ type: 'vault', vault: { ...vault('o1', 'Alice'), pendingProtectRound: round } }),
    )

    const loaded = loadVaultById('o1')

    expect(loaded?.pendingProtectRounds).toEqual([round])
    expect(loaded).not.toHaveProperty('pendingProtectRound')
  })

  // ── Listing ────────────────────────────────────────────────────────────────

  it('lists every saved vault id', () => {
    persistVault(vault('o1', 'Alice'))
    persistVault(vault('o2', 'Bob'))

    expect(listVaultIds().sort()).toEqual(['o1', 'o2'])
  })

  it('does not mistake protocol-store rows for vaults', () => {
    // `stores.ts` partitions under `derec:vault:{id}:{secretId}:…`, so a naive
    // prefix match would list hundreds of channel and share rows as vaults.
    persistVault(vault('o1', 'Alice'))
    localStorage.setItem('derec:vault:o1:42:contact-index', '[]')
    localStorage.setItem('derec:vault:o1:42:share:900:1', 'AAAA')
    localStorage.setItem('derec:vault:o1:42:state-idx:0', '[]')

    expect(listVaultIds()).toEqual(['o1'])
  })

  it('ignores keys belonging to anything else on the origin', () => {
    persistVault(vault('o1', 'Alice'))
    localStorage.setItem('unrelated', 'x')
    localStorage.setItem('derec:replica-id:o1', '7')

    expect(listVaultIds()).toEqual(['o1'])
  })

  it('treats a record too stale to load as missing', () => {
    // Records with no `secretId` predate secret-partitioned stores; their
    // protocol keys can never be found, so they must not be offered.
    localStorage.setItem(
      'derec:vault:o2',
      JSON.stringify({ type: 'vault', vault: { id: 'o2', name: 'Stale' } }),
    )

    expect(loadVaultById('o2')).toBeNull()
  })

  it.each([
    ['no name', { name: undefined }],
    ['no transport', { transport: undefined }],
    ['a secret bag with no current version', { secretBag: {} }],
  ])('treats a partial record (%s) as unreadable rather than half-loading it', (_, patch) => {
    // One such record used to throw while the list sorted and rendered,
    // blanking every other vault with it.
    localStorage.setItem(
      'derec:vault:o3',
      JSON.stringify({ type: 'vault', vault: { ...vault('o3', 'Partial'), ...patch } }),
    )

    expect(loadVaultById('o3')).toBeNull()
  })

  // ── Deletion ───────────────────────────────────────────────────────────────

  it('deleting a vault removes its record and leaves the others', () => {
    persistVault(vault('o1', 'Alice'))
    persistVault(vault('o2', 'Bob'))

    deleteVault('o1')

    expect(listVaultIds()).toEqual(['o2'])
    expect(loadVaultById('o1')).toBeNull()
  })

  // ── Roster snapshots written before SDK 0.0.3 ──────────────────────────────
  //
  // A roster entry carried one bare `transportUri` under recoverable-payload
  // v2 and carries `transports` under v3. `protocol.restore` reads the list, so
  // a snapshot left in this shape would restore helpers with no endpoint.

  describe('legacy recovered-secret snapshots', () => {
    /** Writes the pre-0.0.3 shape directly — the current types cannot express it. */
    function persistLegacySnapshot(): void {
      const stored = {
        type: 'vault',
        vault: {
          ...vault('o1', 'Alice'),
          recoveredSecrets: [
            {
              secretId: '42',
              version: 3,
              label: 'v3',
              snapshot: {
                helpers: [
                  {
                    channelId: '901',
                    transportUri: 'https://example.test/helper-1',
                    communicationInfo: { name: 'Richard' },
                    sharedKey: 'a2V5',
                  },
                ],
                secrets: [],
                replicas: {
                  channelId: '900',
                  members: [
                    {
                      replicaId: 'ff01',
                      transportUri: 'grpcs://example.test:443',
                      role: 'Destination',
                      communicationInfo: {},
                    },
                  ],
                  sharedKey: 'a2V5',
                },
              },
            },
          ],
        },
      }
      localStorage.setItem('derec:vault:o1', JSON.stringify(stored))
    }

    it('lifts a helper’s single uri into the endpoint list', () => {
      persistLegacySnapshot()

      const helper = loadVaultById('o1')!.recoveredSecrets[0].snapshot.helpers[0]
      expect(helper.transports).toEqual([
        { uri: 'https://example.test/helper-1', protocol: 'https' },
      ])
      // The stale key is dropped rather than carried alongside the list.
      expect('transportUri' in helper).toBe(false)
    })

    it('derives the protocol from the scheme, as v2 payloads force', () => {
      persistLegacySnapshot()

      const member = loadVaultById('o1')!.recoveredSecrets[0].snapshot.replicas!.members[0]
      expect(member.transports).toEqual([{ uri: 'grpcs://example.test:443', protocol: 'grpc' }])
    })

    it('names the numeric protocols a snapshot saved before SDK 0.0.6 holds', () => {
      const current = vault('o1', 'Alice')
      current.recoveredSecrets = [
        {
          secretId: '42',
          version: 3,
          label: 'v3',
          snapshot: {
            helpers: [
              {
                channelId: '901',
                // As an older build wrote it, before protocols were named.
                transports: [
                  { uri: 'https://a.example/derec', protocol: 0 },
                  { uri: 'grpcs://a.example:443', protocol: 1 },
                ] as unknown as RecoveredSecretTransport[],
                communicationInfo: {},
                sharedKey: 'a2V5',
              },
            ],
            secrets: [],
          },
        },
      ]
      persistVault(current)

      expect(loadVaultById('o1')!.recoveredSecrets[0].snapshot.helpers[0].transports).toEqual([
        { uri: 'https://a.example/derec', protocol: 'https' },
        { uri: 'grpcs://a.example:443', protocol: 'grpc' },
      ])
    })
  })
})

describe('persistVault reports failure', () => {
  it('returns false when storage refuses the write', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    try {
      expect(persistVault(vault('q1', 'Q'))).toBe(false)
    } finally {
      setItem.mockRestore()
    }
  })

  it('lists stored vault ids but not the store rows sharing the prefix', () => {
    persistVault(vault('v-list-1', 'L'))
    localStorage.setItem('derec:vault:v-list-1:42:channel:7', 'x')

    expect(listVaultIds()).toContain('v-list-1')
    expect(listVaultIds().some(id => id.includes(':'))).toBe(false)
  })
})
