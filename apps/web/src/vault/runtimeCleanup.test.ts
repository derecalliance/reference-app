// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { DeRecEvent } from '@derec-alliance/web'
import { beforeEach, describe, expect, it } from 'vitest'

import type { PublishPolicy } from '../owner/publishPolicy'
import { listOwnerProofVersions, makeShareStore } from '../stores'
import type { BagVersion, SecretBag } from '../types'
import { VaultRuntime } from './runtime'
import { deps, vault } from './testVault'

const NS = 'vault:v1'
const SECRET = '42'

/** A helper-channel record as the library stores it, plus its index entry. */
function seedChannel(channelId: string, peerRole: 'Helper' | 'Owner') {
  const record = `{"Helper":{"channel_id":${channelId},"transports":[],"peer_role":"${peerRole}","status":"Paired","created_at":1}}`
  localStorage.setItem(
    `derec:${NS}:${SECRET}:channel:helper:${channelId}`,
    btoa(record).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  )
  const idx = `derec:${NS}:${SECRET}:channel-idx:helper`
  localStorage.setItem(idx, JSON.stringify([...JSON.parse(localStorage.getItem(idx) ?? '[]'), channelId]))
}

function bagVersion(version: number): BagVersion {
  return { version, participantIds: [], verifiedParticipantIds: [], failedParticipantIds: [], secrets: [], rawBytes: '', helpers: [] }
}

function bagAt(current: number, ...previous: number[]): SecretBag {
  return { secretId: SECRET, threshold: 2, currentVersion: bagVersion(current), previousVersions: previous.map(bagVersion) }
}

const auto: PublishPolicy = {
  defaultThreshold: 2,
  defaultWeights: {},
  helperRetention: { mode: 'lastN', n: 3 },
  proofCleanup: { mode: 'auto', criterion: 'lastN', n: 1 },
}

async function seedProofs(...versions: number[]) {
  seedChannel('7', 'Helper')
  seedChannel('9', 'Owner')
  const shares = makeShareStore(NS)
  for (const v of versions) {
    await shares.save(SECRET, '7', { secretId: SECRET, version: v, bytes: new Uint8Array([v]) })
    // Held *for* another owner: never touched.
    await shares.save(SECRET, '9', { secretId: '77', version: v, bytes: new Uint8Array([v]) })
  }
}

const versionsLeft = () => listOwnerProofVersions(NS, SECRET).map(u => u.version)

describe('cleaning up verification copies', () => {
  beforeEach(() => localStorage.clear())

  it('deletes the chosen versions\' copies, never the latest, never shares held for others', async () => {
    await seedProofs(1, 2, 3)
    const r = new VaultRuntime(vault({ secretBag: bagAt(3, 2, 1) }), deps())

    const removed = await r.cleanupProofs([1, 3])

    expect(removed).toEqual([1])
    expect(versionsLeft()).toEqual([3, 2])
    expect((await makeShareStore(NS).load(SECRET, '9', [])).map(s => s.version)).toEqual([1, 2, 3])
  })

  it('cleans up on its own after a version commits, in automatic mode', async () => {
    await seedProofs(1, 2)
    const r = new VaultRuntime(vault({ secretBag: bagAt(2, 1), publishPolicy: auto }), deps())

    r.commit(r.applyEvent(r.state().vault, { type: 'SharingComplete', version: 2, confirmed_count: 2, failed_count: 0, threshold_met: true } as DeRecEvent))
    await r.withLock(async () => {})

    expect(versionsLeft()).toEqual([2])
  })

  it('cleans up after a mirrored copy is installed on a replica', async () => {
    await seedProofs(1, 2)
    const r = new VaultRuntime(vault({ secretBag: bagAt(2, 1), publishPolicy: auto }), deps())

    const installed: DeRecEvent = {
      type: 'ReplicaSecretInstalled',
      channel_id: '5',
      from_replica_id: '1',
      author_replica_id: null,
      secret_id: SECRET,
      version: 2,
      secret: { helpers: [], secrets: [] },
      shares: [],
    } as unknown as DeRecEvent
    r.applyEvent(r.state().vault, installed)
    await r.withLock(async () => {})

    expect(versionsLeft()).toEqual([2])
  })

  it('leaves everything alone in manual mode', async () => {
    await seedProofs(1, 2)
    const r = new VaultRuntime(vault({ secretBag: bagAt(2, 1) }), deps())

    r.commit(r.applyEvent(r.state().vault, { type: 'SharingComplete', version: 2, confirmed_count: 2, failed_count: 0, threshold_met: true } as DeRecEvent))
    await r.withLock(async () => {})

    expect(versionsLeft()).toEqual([2, 1])
  })
})

describe('automatic cleanup never deletes the version that just landed (review C1)', () => {
  beforeEach(() => localStorage.clear())

  it('keeps a mirrored version the bag has not caught up with yet', async () => {
    await seedProofs(1, 2)
    // The bag still says v1: the mirrored v2 is committed to it later, after a network call.
    const followHelpers: PublishPolicy = {
      ...auto,
      helperRetention: { mode: 'lastN', n: 1 },
      proofCleanup: { mode: 'auto', criterion: 'retention' },
    }
    const r = new VaultRuntime(vault({ secretBag: bagAt(1), publishPolicy: followHelpers }), deps())

    r.applyEvent(r.state().vault, {
      type: 'ReplicaSecretInstalled',
      channel_id: '5',
      from_replica_id: '1',
      author_replica_id: null,
      secret_id: SECRET,
      version: 2,
      secret: { helpers: [], secrets: [] },
      shares: [],
    } as unknown as DeRecEvent)
    await r.withLock(async () => {})

    expect(versionsLeft()).toContain(2)
  })
})

describe('removing an earlier version from this device', () => {
  beforeEach(() => localStorage.clear())

  it('drops it from the history and deletes its copies, never shares held for others', async () => {
    await seedProofs(1, 2, 3)
    const r = new VaultRuntime(vault({ secretBag: bagAt(3, 2, 1) }), deps())

    await r.removeVersion(2)

    expect(r.state().vault.secretBag?.previousVersions.map(v => v.version)).toEqual([1])
    expect(versionsLeft()).toEqual([3, 1])
    expect((await makeShareStore(NS).load(SECRET, '9', [])).map(s => s.version)).toEqual([1, 2, 3])
  })

  it('refuses the current version, and a version not in the history', async () => {
    await seedProofs(1, 2)
    const r = new VaultRuntime(vault({ secretBag: bagAt(2, 1) }), deps())

    await expect(r.removeVersion(2)).rejects.toThrow('current version')
    await expect(r.removeVersion(7)).rejects.toThrow('not in this vault')
    expect(r.state().vault.secretBag?.previousVersions.map(v => v.version)).toEqual([1])
    expect(versionsLeft()).toEqual([2, 1])
  })
})
