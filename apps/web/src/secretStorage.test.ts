// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { afterEach, describe, expect, it } from 'vitest'

import { fromLegacyRecord, migrateLegacyStorageKeys, secretNamespace } from './secretStorage'

afterEach(() => localStorage.clear())

/** The parts of a migrated record these specs read. */
interface Migrated {
  id: string
  secretBag?: unknown
  itemBag: { currentVersion: { items: unknown[] }; previousVersions: { items: unknown[] }[] }
  pendingProtectRounds: { bag: { currentVersion: { items: unknown[] } } }[]
  recoveredSecrets: { snapshot: { items: unknown[] } }[]
  replicaConflict: { rivalItems: unknown[] }
  unsettledRound: { items: unknown[] }
}

describe('keys saved before the rename', () => {
  it('move from derec:vault: to derec:secret:, record and protocol rows alike', () => {
    localStorage.setItem('derec:vault:v1', '{"type":"vault"}')
    localStorage.setItem('derec:vault:v1:42:channel:helper:7', 'row')
    localStorage.setItem('derec:replica-id:v1', '9')

    expect(migrateLegacyStorageKeys()).toBe(2)

    expect(localStorage.getItem('derec:secret:v1')).toBe('{"type":"vault"}')
    expect(localStorage.getItem('derec:secret:v1:42:channel:helper:7')).toBe('row')
    expect(localStorage.getItem('derec:vault:v1')).toBeNull()
    expect(localStorage.getItem('derec:replica-id:v1')).toBe('9')
    expect(secretNamespace('v1')).toBe('secret:v1')
  })

  it('never overwrite a key already under the new name, so a cut-short run can resume', () => {
    localStorage.setItem('derec:secret:v1', 'new')
    localStorage.setItem('derec:vault:v1', 'old')

    migrateLegacyStorageKeys()
    expect(migrateLegacyStorageKeys()).toBe(0)

    expect(localStorage.getItem('derec:secret:v1')).toBe('new')
    expect(localStorage.getItem('derec:vault:v1')).toBeNull()
  })
})

describe('a record saved before the rename', () => {
  it('reads with today\'s names: envelope, bag, items and every nested list', () => {
    const version = (n: number) => ({ version: n, secrets: [{ id: 'a', name: 'S', data: 'd' }] })
    const legacy = {
      type: 'vault',
      vault: {
        id: 'v1',
        secretBag: { secretId: '42', currentVersion: version(2), previousVersions: [version(1)] },
        pendingProtectRounds: [{ version: 3, bag: { secretId: '42', currentVersion: version(3), previousVersions: [] } }],
        recoveredSecrets: [{ snapshot: { secrets: [{ id: 'a', name: 'S', data: 'ZA' }] } }],
        replicaConflict: { rivalSecrets: [] },
        unsettledRound: { version: 2, secrets: [] },
      },
    }

    const record = fromLegacyRecord(legacy) as Migrated

    expect(record.id).toBe('v1')
    expect(record.secretBag).toBeUndefined()
    expect(record.itemBag.currentVersion.items).toHaveLength(1)
    expect(record.itemBag.previousVersions[0].items).toHaveLength(1)
    expect(record.pendingProtectRounds[0].bag.currentVersion.items).toHaveLength(1)
    expect(record.recoveredSecrets[0].snapshot.items).toHaveLength(1)
    expect(record.replicaConflict.rivalItems).toEqual([])
    expect(record.unsettledRound.items).toEqual([])
  })

  it('leaves a current record as it is', () => {
    const current = { id: 'v1', itemBag: null }
    expect(fromLegacyRecord({ type: 'secret', secret: current })).toEqual(current)
  })
})
