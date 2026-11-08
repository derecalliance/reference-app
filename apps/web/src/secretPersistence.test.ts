// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteSecret, listLocalSecretIds, loadSecretById, persistSecret } from './secretPersistence'
import type { RecoveredSecretTransport, Secret } from './types'

function secret(id: string, name: string): Secret {
  return {
    id,
    name,
    secretId: '42',
    transport: { protocol: 'https', uri: `https://example.test/${id}` },
    participants: [],
    itemBag: null,
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

describe('secretPersistence', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('round-trips a secret by id', () => {
    persistSecret(secret('o1', 'Alice'))

    expect(loadSecretById('o1')?.name).toBe('Alice')
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
          items: [],
          rawBytes: '',
          helpers: [],
        },
      },
      channelIds: ['900'],
    }
    localStorage.setItem(
      'derec:secret:o1',
      JSON.stringify({ type: 'vault', vault: { ...secret('o1', 'Alice'), pendingProtectRound: round } }),
    )

    const loaded = loadSecretById('o1')

    expect(loaded?.pendingProtectRounds).toEqual([round])
    expect(loaded).not.toHaveProperty('pendingProtectRound')
  })

  // ── Listing ────────────────────────────────────────────────────────────────

  it('lists every saved local secret id', () => {
    persistSecret(secret('o1', 'Alice'))
    persistSecret(secret('o2', 'Bob'))

    expect(listLocalSecretIds().sort()).toEqual(['o1', 'o2'])
  })

  it('does not mistake protocol-store rows for secrets', () => {
    // `stores.ts` partitions under `derec:secret:{id}:{secretId}:…`, so a naive
    // prefix match would list hundreds of channel and share rows as secrets.
    persistSecret(secret('o1', 'Alice'))
    localStorage.setItem('derec:secret:o1:42:contact-index', '[]')
    localStorage.setItem('derec:secret:o1:42:share:900:1', 'AAAA')
    localStorage.setItem('derec:secret:o1:42:state-idx:0', '[]')

    expect(listLocalSecretIds()).toEqual(['o1'])
  })

  it('ignores keys belonging to anything else on the origin', () => {
    persistSecret(secret('o1', 'Alice'))
    localStorage.setItem('unrelated', 'x')
    localStorage.setItem('derec:replica-id:o1', '7')

    expect(listLocalSecretIds()).toEqual(['o1'])
  })

  it('treats a record too stale to load as missing', () => {
    // Records with no `secretId` predate secret-partitioned stores; their
    // protocol keys can never be found, so they must not be offered.
    localStorage.setItem(
      'derec:secret:o2',
      JSON.stringify({ type: 'vault', vault: { id: 'o2', name: 'Stale' } }),
    )

    expect(loadSecretById('o2')).toBeNull()
  })

  it.each([
    ['no name', { name: undefined }],
    ['no transport', { transport: undefined }],
    ['an item bag with no current version', { itemBag: {} }],
  ])('treats a partial record (%s) as unreadable rather than half-loading it', (_, patch) => {
    // One such record used to throw while the list sorted and rendered,
    // blanking every other secret with it.
    localStorage.setItem(
      'derec:secret:o3',
      JSON.stringify({ type: 'vault', vault: { ...secret('o3', 'Partial'), ...patch } }),
    )

    expect(loadSecretById('o3')).toBeNull()
  })

  // ── Deletion ───────────────────────────────────────────────────────────────

  it('deleting a secret removes its record and leaves the others', () => {
    persistSecret(secret('o1', 'Alice'))
    persistSecret(secret('o2', 'Bob'))

    deleteSecret('o1')

    expect(listLocalSecretIds()).toEqual(['o2'])
    expect(loadSecretById('o1')).toBeNull()
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
          ...secret('o1', 'Alice'),
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
      localStorage.setItem('derec:secret:o1', JSON.stringify(stored))
    }

    it('lifts a helper’s single uri into the endpoint list', () => {
      persistLegacySnapshot()

      const helper = loadSecretById('o1')!.recoveredSecrets[0].snapshot.helpers[0]
      expect(helper.transports).toEqual([
        { uri: 'https://example.test/helper-1', protocol: 'https' },
      ])
      // The stale key is dropped rather than carried alongside the list.
      expect('transportUri' in helper).toBe(false)
    })

    it('derives the protocol from the scheme, as v2 payloads force', () => {
      persistLegacySnapshot()

      const member = loadSecretById('o1')!.recoveredSecrets[0].snapshot.replicas!.members[0]
      expect(member.transports).toEqual([{ uri: 'grpcs://example.test:443', protocol: 'grpc' }])
    })

    it('names the numeric protocols a snapshot saved before SDK 0.0.6 holds', () => {
      const current = secret('o1', 'Alice')
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
            items: [],
          },
        },
      ]
      persistSecret(current)

      expect(loadSecretById('o1')!.recoveredSecrets[0].snapshot.helpers[0].transports).toEqual([
        { uri: 'https://a.example/derec', protocol: 'https' },
        { uri: 'grpcs://a.example:443', protocol: 'grpc' },
      ])
    })
  })
})

describe('persistSecret reports failure', () => {
  it('returns false when storage refuses the write', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    try {
      expect(persistSecret(secret('q1', 'Q'))).toBe(false)
    } finally {
      setItem.mockRestore()
    }
  })

  it('lists stored local secret ids but not the store rows sharing the prefix', () => {
    persistSecret(secret('v-list-1', 'L'))
    localStorage.setItem('derec:secret:v-list-1:42:channel:7', 'x')

    expect(listLocalSecretIds()).toContain('v-list-1')
    expect(listLocalSecretIds().some(id => id.includes(':'))).toBe(false)
  })
})
