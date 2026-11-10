// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { DeRecEvent } from '@derec-alliance/web'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BagVersion, ItemBag, Secret } from '../types'
import { foldEvent, type FoldContext } from './fold'
import { keepVersionFor, retentionPreview } from './keepVersion'
import { RoundTracker } from './rounds'
import { secret } from './testSecret'

function version(n: number, overrides: Partial<BagVersion> = {}): BagVersion {
  return {
    version: n,
    participantIds: [],
    verifiedParticipantIds: [],
    failedParticipantIds: [],
    items: [{ id: 'aa', name: 'Seed', data: `v${n}` }],
    rawBytes: '',
    helpers: [],
    ...overrides,
  }
}

/** A bag whose current version is the first of `versions`, the rest history. */
function bag(...versions: number[]): ItemBag {
  const [current, ...previous] = versions
  return {
    secretId: '42',
    threshold: 2,
    currentVersion: version(current),
    previousVersions: previous.map(n => version(n)),
  }
}

function context(rounds = new RoundTracker(), getSecret: () => Secret = () => secret()): FoldContext {
  return {
    log: vi.fn(),
    notify: { error: vi.fn(), info: vi.fn(), outcome: vi.fn() },
    effects: {
      refreshReplicas: vi.fn(),
      openFingerprint: vi.fn(),
      openAdoption: vi.fn(),
      pairingRejected: vi.fn(),
      pairingCompleted: vi.fn(),
      unpairSettled: vi.fn(),
      channelsLinked: vi.fn(),
    },
    rounds,
    flowProgressed: vi.fn(),
    roundResolved: vi.fn(),
    getSecret,
    commit: vi.fn(),
    offerReplicaAdoption: vi.fn(),
    readChannelInfo: vi.fn(() => null),
    channelInfoOutcome: vi.fn(),
    awaitingIdentityAnswer: vi.fn(() => false),
    isShareHeld: vi.fn(() => true),
    respondToFailure: vi.fn(),
  }
}

function sharingComplete(n: number, thresholdMet: boolean): DeRecEvent {
  return {
    type: 'SharingComplete',
    version: n,
    confirmed_count: thresholdMet ? 2 : 0,
    failed_count: thresholdMet ? 0 : 2,
    threshold_met: thresholdMet,
  }
}

afterEach(() => localStorage.clear())

describe('keepVersionFor', () => {
  it('keeps the newest committed version — the library’s own advice', () => {
    expect(keepVersionFor(secret({ itemBag: bag(5, 4, 3, 2, 1) }), '42', 6)).toBe(5)
  })

  it('keeps the newest committed version below the one being sent', () => {
    expect(keepVersionFor(secret({ itemBag: bag(5, 4, 3) }), '42', 5)).toBe(4)
  })

  it('keeps the newest version that may have committed when the record cannot vouch for anything', () => {
    // Nothing committed on this device: the version just below may be one
    // this record merely does not know about. The first version has none.
    expect(keepVersionFor(secret({ itemBag: null }), '42', 1)).toBe(0)
    expect(keepVersionFor(secret({ itemBag: null }), '42', 3)).toBe(2)
    // A round for another secret — the moment a restore or adoption has
    // rebuilt the instance and the record has not caught up yet.
    expect(keepVersionFor(secret({ itemBag: bag(3, 2) }), '77', 6)).toBe(5)
  })

  it('keeps the version a restored secret was rebuilt at, which helpers served', () => {
    const restored = bag(7)
    restored.currentVersion.restoredFromRecovery = true
    expect(keepVersionFor(secret({ itemBag: restored }), '42', 8)).toBe(7)
  })
})

describe('the kept version follows what the secret committed', () => {
  it('never keeps a rolled-back version', () => {
    const rounds = new RoundTracker()
    let current = secret({ itemBag: bag(1) })
    const ctx = context(rounds, () => current)

    // v2 is staged, then v3 commits, then v4 closes below threshold.
    rounds.beginProtectRound({ bag: bag(2, 1), version: 2, protocolSecretId: '42', channelIds: ['7', '8'] })
    current = foldEvent(current, sharingComplete(2, true), ctx)
    rounds.beginProtectRound({ bag: bag(3, 2, 1), version: 3, protocolSecretId: '42', channelIds: ['7', '8'] })
    current = foldEvent(current, sharingComplete(3, false), ctx)

    expect(keepVersionFor(current, '42', 4)).toBe(2)
  })

  it('keeps a version the library published on its own once it commits', () => {
    // Pair-completion and fingerprint-confirmation publishes are not staged by
    // the app; `SharingComplete` is what brings them into the bag.
    const current = foldEvent(secret({ itemBag: bag(1) }), sharingComplete(2, true), context())

    expect(current.itemBag?.currentVersion.version).toBe(2)
    expect(keepVersionFor(current, '42', 3)).toBe(2)
  })

  it('keeps a member’s history across a mirrored update', async () => {
    const before = secret({ itemBag: bag(4, 3) })
    const ctx = context(new RoundTracker(), () => before)

    foldEvent(
      before,
      {
        type: 'ReplicaSecretReceived',
        channel_id: '100',
        from_replica_id: '22',
        author_replica_id: '22',
        secret_id: '42',
        version: 5,
        secret: { helpers: [], secrets: [] },
        shares: [],
      } as unknown as DeRecEvent,
      ctx,
    )

    await vi.waitFor(() => expect(ctx.commit).toHaveBeenCalled())
    const committed = vi.mocked(ctx.commit).mock.calls[0][0]
    expect(committed.itemBag?.previousVersions.map(v => v.version)).toEqual([4, 3])
    expect(keepVersionFor(committed, '42', 6)).toBe(5)
  })
})

describe('keepVersionFor follows the owner\'s retention setting', () => {
  const policy = (helperRetention: { mode: 'latestCommitted' } | { mode: 'select' }) => ({
    defaultThreshold: 2,
    defaultWeights: {},
    helperRetention,
    proofCleanup: { mode: 'manual' as const },
  })

  it('in select mode, keeps what the owner picked for this round', () => {
    const v = secret({ itemBag: bag(4, 3, 2, 1), publishPolicy: policy({ mode: 'select' }) })

    expect(keepVersionFor(v, v.secretId, 5, 2)).toBe(2)
  })

  it('in select mode, a pick of 0 keeps nothing but the new version', () => {
    const v = secret({ itemBag: bag(4, 3), publishPolicy: policy({ mode: 'select' }) })

    expect(keepVersionFor(v, v.secretId, 5, 0)).toBe(0)
  })

  it('in select mode with no pick — a round the library started — keeps the newest committed', () => {
    const v = secret({ itemBag: bag(4, 3), publishPolicy: policy({ mode: 'select' }) })

    expect(keepVersionFor(v, v.secretId, 5)).toBe(4)
    expect(keepVersionFor(v, v.secretId, 5, null)).toBe(4)
  })

  it('ignores a pick that is not below the version sent, which the library would refuse', () => {
    const v = secret({ itemBag: bag(4, 3), publishPolicy: policy({ mode: 'select' }) })

    expect(keepVersionFor(v, v.secretId, 5, 5)).toBe(4)
  })

  it('ignores a pick outside select mode', () => {
    const v = secret({ itemBag: bag(4, 3), publishPolicy: policy({ mode: 'latestCommitted' }) })

    expect(keepVersionFor(v, v.secretId, 5, 3)).toBe(4)
  })

  it('reads a policy saved before SDK 0.0.10 as "keep the newest committed version"', () => {
    const legacy = { ...policy({ mode: 'select' }), helperRetention: { mode: 'lastN', n: 3 } }
    // A record written by an earlier build: its shape is no longer a valid type.
    const v = secret({ itemBag: bag(4, 3), publishPolicy: legacy as unknown as ReturnType<typeof policy> })

    expect(keepVersionFor(v, v.secretId, 5, 3)).toBe(4)
    expect(retentionPreview(v)).toEqual({ kept: 4, dropped: [3] })
  })
})

describe('retentionPreview', () => {
  it('names the version helpers keep and the ones they drop, newest first', () => {
    expect(retentionPreview(secret({ itemBag: bag(4, 3, 2, 1) }))).toEqual({ kept: 4, dropped: [3, 2, 1] })
  })

  it('keeps nothing before any version committed', () => {
    expect(retentionPreview(secret({ itemBag: null }))).toEqual({ kept: null, dropped: [] })
  })

  it('is null in select mode, where the owner picks', () => {
    const v = secret({
      itemBag: bag(4, 3),
      publishPolicy: {
        defaultThreshold: 2,
        defaultWeights: {},
        helperRetention: { mode: 'select' },
        proofCleanup: { mode: 'manual' },
      },
    })

    expect(retentionPreview(v)).toBeNull()
  })
})
