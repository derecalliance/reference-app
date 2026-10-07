// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { DeRecEvent } from '@derec-alliance/web'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BagVersion, SecretBag, Vault } from '../types'
import { foldEvent, type FoldContext } from './fold'
import { KEPT_COMMITTED_VERSIONS, keepListFor } from './keepList'
import { RoundTracker } from './rounds'
import { vault } from './testVault'

function version(n: number, overrides: Partial<BagVersion> = {}): BagVersion {
  return {
    version: n,
    participantIds: [],
    verifiedParticipantIds: [],
    failedParticipantIds: [],
    secrets: [{ id: 'aa', name: 'Seed', data: `v${n}` }],
    rawBytes: '',
    helpers: [],
    ...overrides,
  }
}

/** A bag whose current version is the first of `versions`, the rest history. */
function bag(...versions: number[]): SecretBag {
  const [current, ...previous] = versions
  return {
    secretId: '42',
    threshold: 2,
    currentVersion: version(current),
    previousVersions: previous.map(n => version(n)),
  }
}

function context(rounds = new RoundTracker(), getVault: () => Vault = () => vault()): FoldContext {
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
    getVault,
    commit: vi.fn(),
    offerReplicaAdoption: vi.fn(),
    readChannelInfo: vi.fn(() => null),
    channelInfoOutcome: vi.fn(),
    awaitingIdentityAnswer: vi.fn(() => false),
    isShareHeld: vi.fn(() => true),
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

describe('keepListFor', () => {
  it('keeps the latest three committed versions — the cap SDK 0.0.6 applied itself', () => {
    expect(KEPT_COMMITTED_VERSIONS).toBe(3)
    expect(keepListFor(vault({ secretBag: bag(5, 4, 3, 2, 1) }), '42', 6)).toEqual([5, 4, 3])
  })

  it('always lists the latest committed version, however few there are', () => {
    expect(keepListFor(vault({ secretBag: bag(1) }), '42', 2)).toEqual([1])
  })

  it('sends no list when the record cannot vouch for anything', () => {
    // Nothing committed on this device: helpers keep everything rather than
    // lose a version this record merely does not know about.
    expect(keepListFor(vault({ secretBag: null }), '42', 1)).toBeNull()
    // A round for another secret — the moment a restore or adoption has
    // rebuilt the instance and the record has not caught up yet.
    expect(keepListFor(vault({ secretBag: bag(3, 2) }), '77', 4)).toBeNull()
  })

  it('lists the version a restored vault was rebuilt at, which helpers served', () => {
    const restored = bag(7)
    restored.currentVersion.restoredFromRecovery = true
    expect(keepListFor(vault({ secretBag: restored }), '42', 8)).toEqual([7])
  })
})

describe('the keep list follows what the vault committed', () => {
  it('never lists a rolled-back version', () => {
    const rounds = new RoundTracker()
    let current = vault({ secretBag: bag(1) })
    const ctx = context(rounds, () => current)

    // v2 is staged, then closes below threshold: rolled back.
    rounds.beginProtectRound({ bag: bag(2, 1), version: 2, protocolSecretId: '42', channelIds: ['7', '8'] })
    current = foldEvent(current, sharingComplete(2, false), ctx)
    // v3 commits.
    rounds.beginProtectRound({ bag: bag(3, 1), version: 3, protocolSecretId: '42', channelIds: ['7', '8'] })
    current = foldEvent(current, sharingComplete(3, true), ctx)

    expect(keepListFor(current, '42', 4)).toEqual([3, 1])
  })

  it('lists a round still in flight, so helpers keep it while it can still commit', () => {
    // SDK 0.0.7: if v3 then fails and v2 commits, v2 is the latest version —
    // helpers that had dropped it would leave the vault short of shares.
    const rounds = new RoundTracker()
    rounds.beginProtectRound({ bag: bag(2, 1), version: 2, protocolSecretId: '42', channelIds: ['7'] })
    const open = rounds.snapshotProtectRounds().map(round => round.version)

    expect(keepListFor(vault({ secretBag: bag(1) }), '42', 3, open)).toEqual([2, 1])
  })

  it('lists open rounds beyond the committed cap', () => {
    const open = [6, 7]
    const kept = keepListFor(vault({ secretBag: bag(5, 4, 3, 2, 1) }), '42', 8, open)

    expect(kept).toEqual([7, 6, 5, 4, 3])
    expect(kept?.filter(v => v <= 5)).toHaveLength(KEPT_COMMITTED_VERSIONS)
  })

  it('lists the open rounds the record persisted, for instances a command builds', () => {
    const persisted = vault({
      secretBag: bag(1),
      pendingProtectRounds: [{ version: 2, protocolSecretId: '42', bag: bag(2, 1), channelIds: ['7'] }],
    })

    expect(keepListFor(persisted, '42', 3)).toEqual([2, 1])
  })

  it('does not list an open round at or above the version being sent', () => {
    expect(keepListFor(vault({ secretBag: bag(1) }), '42', 3, [3, 4])).toEqual([1])
  })

  it('lists a version the library published on its own once it commits', () => {
    // Pair-completion and fingerprint-confirmation publishes are not staged by
    // the app; `SharingComplete` is what brings them into the bag.
    const current = foldEvent(vault({ secretBag: bag(1) }), sharingComplete(2, true), context())

    expect(current.secretBag?.currentVersion.version).toBe(2)
    expect(keepListFor(current, '42', 3)).toEqual([2, 1])
  })

  it('keeps a member’s history across a mirrored update, so its next publish keeps more than one', async () => {
    const before = vault({ secretBag: bag(4, 3) })
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
    expect(committed.secretBag?.previousVersions.map(v => v.version)).toEqual([4, 3])
    expect(keepListFor(committed, '42', 6)).toEqual([5, 4, 3])
  })
})
