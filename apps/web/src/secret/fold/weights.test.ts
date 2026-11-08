// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it, vi } from 'vitest'

import type { PairedParticipant, ItemBag } from '../../types'
import { RoundTracker } from '../rounds'
import { secret } from '../testSecret'
import { foldEvent, type FoldContext } from '.'

/** Weighted helpers (SDK 0.0.9): what the fold keeps of each helper's weight. */

function context(rounds = new RoundTracker()): FoldContext {
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
    getSecret: () => secret(),
    commit: vi.fn(),
    offerReplicaAdoption: vi.fn(),
    readChannelInfo: vi.fn(() => null),
    channelInfoOutcome: vi.fn(),
    awaitingIdentityAnswer: vi.fn(() => false),
    isShareHeld: vi.fn(() => true),
    respondToFailure: vi.fn(),
  }
}

function helper(n: number, weight?: number): PairedParticipant {
  return {
    id: `h${n}`,
    name: `Helper ${n}`,
    channelId: String(n),
    transport: { protocol: 'https', uri: '' },
    connectionStatus: 'paired',
    peerRole: 'helper',
    secretShares: [{ version: 4, status: 'pending', verified: false, ...(weight ? { weight } : {}) }],
    ...(weight ? { weight } : {}),
  }
}

const bag: ItemBag = {
  secretId: '42',
  threshold: 3,
  previousVersions: [],
  currentVersion: {
    version: 4,
    participantIds: [],
    verifiedParticipantIds: [],
    failedParticipantIds: [],
    items: [],
    rawBytes: '',
    helpers: [],
  },
}

describe('helper weights in the fold', () => {
  it('keeps the weight a share went out with when the helper confirms it', () => {
    const rounds = new RoundTracker()
    rounds.beginProtectRound({ bag, version: 4, protocolSecretId: '42', channelIds: ['1', '2'], weights: { h1: 2 } })
    const ctx = context(rounds)

    const next = foldEvent(
      secret({ participants: [helper(1, 2), helper(2)], minParticipants: 3 }),
      { type: 'ShareConfirmed', channel_id: '1', version: 4 },
      ctx,
    )

    expect(next.participants[0].secretShares).toEqual([{ version: 4, status: 'confirmed', verified: false, weight: 2 }])
  })

  it('does not commit early on a round below its own threshold, whatever the secret setting', () => {
    const rounds = new RoundTracker()
    // Split at 4 although the secret's setting says 2: weights 2 + 1 = 3 < 4.
    rounds.beginProtectRound({
      bag,
      version: 4,
      protocolSecretId: '42',
      channelIds: ['1', '2'],
      weights: { h1: 2 },
      threshold: 4,
    })
    const ctx = context(rounds)
    const start = secret({ participants: [helper(1, 2), helper(2)], minParticipants: 2, itemBag: null })

    const once = foldEvent(start, { type: 'ShareConfirmed', channel_id: '1', version: 4 }, ctx)
    const next = foldEvent(once, { type: 'ShareConfirmed', channel_id: '2', version: 4 }, ctx)

    expect(next.itemBag).toBeNull()
    expect(rounds.hasPendingRound(4)).toBe(true)
  })

  it('records the weight a library-started publish reports for a helper', () => {
    const next = foldEvent(
      secret({ participants: [helper(1), helper(2)] }),
      { type: 'ProtectSecretStarted', channel_id: '1', version: 5, trace_id: '0', weight: 2 },
      context(),
    )

    expect(next.participants.map(p => p.weight)).toEqual([2, undefined])
  })
})

describe('verification records what recovery needs (SDK 0.0.9)', () => {
  function verifying(rounds: RoundTracker) {
    rounds.beginVerification('1', { protocolSecretId: '42', version: 4, deadline: Date.now() + 60_000 })
    rounds.beginVerification('2', { protocolSecretId: '42', version: 4, deadline: Date.now() + 60_000 })
    return secret({ participants: [helper(1, 2), helper(2)], itemBag: bag })
  }

  it('keeps each verified helper\'s subshares and the version\'s threshold', () => {
    const rounds = new RoundTracker()
    const next = foldEvent(
      verifying(rounds),
      { type: 'ShareVerified', channel_id: '1', version: 4, subshares: 2, threshold: 3 },
      context(rounds),
    )

    expect(next.itemBag?.currentVersion.verifiedSubshares).toEqual({ h1: 2 })
    expect(next.itemBag?.currentVersion.verifiedThreshold).toBe(3)
  })

  it('records an unreported count as unknown, not 1', () => {
    const rounds = new RoundTracker()
    const next = foldEvent(verifying(rounds), { type: 'ShareVerified', channel_id: '2', version: 4 }, context(rounds))

    expect(next.itemBag?.currentVersion.verifiedSubshares).toEqual({ h2: null })
    expect(next.itemBag?.currentVersion.verifiedThreshold).toBeNull()
  })
})
