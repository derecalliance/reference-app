// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { DeRecEvent } from '@derec-alliance/web'
import { describe, expect, it, vi } from 'vitest'

import type { PairedParticipant, RecoveryProgress, SecretBag, Vault } from '../../types'
import { RoundTracker } from '../rounds'
import { vault } from '../testVault'
import { foldEvent, type FoldContext } from '.'

/**
 * The answers SDK 0.0.7 started reporting instead of leaving the owner to time
 * out: a helper refusing a verification challenge or a recovery request, and
 * a helper sending a share that cannot be part of the secret.
 */

function context(overrides: Partial<FoldContext> = {}): FoldContext {
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
    rounds: new RoundTracker(),
    flowProgressed: vi.fn(),
    roundResolved: vi.fn(),
    getVault: () => vault(),
    commit: vi.fn(),
    offerReplicaAdoption: vi.fn(),
    readChannelInfo: vi.fn(() => null),
    channelInfoOutcome: vi.fn(),
    awaitingIdentityAnswer: vi.fn(() => false),
    isShareHeld: vi.fn(() => true),
    ...overrides,
  }
}

function helper(n: number): PairedParticipant {
  return {
    id: `h${n}`,
    name: `Helper ${n}`,
    channelId: String(n),
    transport: { protocol: 'https', uri: '' },
    connectionStatus: 'paired',
    peerRole: 'helper',
    secretShares: [{ version: 3, status: 'confirmed', verified: false }],
  }
}

function bagAt(version: number): SecretBag {
  return {
    secretId: '42',
    threshold: 2,
    previousVersions: [],
    currentVersion: {
      version,
      participantIds: ['h1', 'h2'],
      verifiedParticipantIds: [],
      failedParticipantIds: [],
      secrets: [],
      rawBytes: '',
      helpers: [],
    },
  }
}

describe('ShareVerifyRejected', () => {
  function challenged(): { current: Vault; ctx: FoldContext } {
    const ctx = context()
    const deadline = Date.now() + 60_000
    ctx.rounds.beginVerification('1', { protocolSecretId: '42', version: 3, deadline })
    ctx.rounds.beginVerification('2', { protocolSecretId: '42', version: 3, deadline })
    return { current: vault({ participants: [helper(1), helper(2)], secretBag: bagAt(3) }), ctx }
  }

  const rejected = (channel: string): DeRecEvent => ({
    type: 'ShareVerifyRejected',
    channel_id: channel,
    version: 3,
    status: 10,
    memo: 'Helper rejected the verification request',
  })

  it('records the refusal as that helper’s answer, with its memo', () => {
    const { current, ctx } = challenged()

    const next = foldEvent(current, rejected('2'), ctx)

    expect(next.secretBag?.currentVersion.verifyRejections).toEqual([
      { id: 'h2', status: 10, memo: 'Helper rejected the verification request' },
    ])
    expect(ctx.rounds.isAwaitingVerification('2', 3)).toBe(false)
    // Helper 1 is still out, so the round is not over.
    expect(ctx.notify.outcome).not.toHaveBeenCalled()
  })

  it('closes the round on its last answer, naming the rejections', () => {
    const { current, ctx } = challenged()

    const verified = foldEvent(current, { type: 'ShareVerified', channel_id: '1', version: 3 }, ctx)
    foldEvent(verified, rejected('2'), ctx)

    expect(ctx.notify.outcome).toHaveBeenCalledWith('Verification of v3 complete: 1 share verified, 1 rejected')
  })

  it('ignores a refusal nobody is waiting for', () => {
    const { current, ctx } = challenged()
    const next = foldEvent(current, { ...rejected('2'), version: 2 } as DeRecEvent, ctx)
    expect(next).toBe(current)
  })
})

describe('recovery answers without a share', () => {
  function recovering(progress: Partial<RecoveryProgress> = {}): Vault {
    return vault({
      participants: [helper(1), helper(2), helper(3)],
      recoveryProgress: {
        secretId: '42',
        version: 3,
        sharesReceived: 0,
        totalRequested: 3,
        requestedChannelIds: ['1', '2', '3'],
        error: null,
        ...progress,
      },
    })
  }

  const refused = (channel: string): DeRecEvent => ({
    type: 'RecoveryShareRefused',
    channel_id: channel,
    version: 3,
    status: 6,
    memo: 'unknown share version',
  })

  it('shows a refusal on the progress without counting it as a share', () => {
    const next = foldEvent(recovering({ sharesReceived: 1 }), refused('2'), context())

    expect(next.recoveryProgress).toMatchObject({
      sharesReceived: 1,
      refusals: [{ channelId: '2', status: 6, memo: 'unknown share version' }],
      error: null,
    })
  })

  it('ends the recovery as insufficient once the last helper asked refuses', () => {
    const next = foldEvent(recovering({ sharesReceived: 1, refusals: [{ channelId: '1', status: 6, memo: '' }] }), refused('3'), context())

    expect(next.recoveryProgress?.error).toMatch(/Not enough shares.*2 helpers answered without a usable share/)
    expect(next.recoveryFailures).toHaveLength(1)
  })

  it('does not count a refusal from a helper that was not expected to hold the version', () => {
    const progress = { sharesReceived: 1, totalRequested: 2, requestedChannelIds: ['1', '2'] }
    const next = foldEvent(recovering(progress), refused('3'), context())

    expect(next.recoveryProgress?.error).toBeNull()
  })

  it('warns about a corrupted share by helper and reason, and keeps it for the owner to act on', () => {
    const ctx = context()
    const next = foldEvent(
      recovering(),
      { type: 'RecoveryShareCorrupted', channel_id: '2', version: 3, reason: 'InvalidProof' },
      ctx,
    )

    expect(ctx.notify.error).toHaveBeenCalledWith(expect.stringContaining('Helper 2 sent a recovery share that fails its own proof'), undefined, expect.anything())
    expect(next.corruptShareReports).toEqual([
      expect.objectContaining({ channelId: '2', peerName: 'Helper 2', version: 3, reason: 'InvalidProof' }),
    ])
    expect(next.recoveryProgress?.corrupted).toEqual([{ channelId: '2', reason: 'InvalidProof' }])
  })

  it('reports an inconsistent share without touching a recovery that already succeeded', () => {
    const current = vault({ participants: [helper(1)], recoveryProgress: null })
    const next = foldEvent(
      current,
      { type: 'RecoveryShareCorrupted', channel_id: '1', version: 3, reason: 'Inconsistent' },
      context(),
    )

    expect(next.recoveryProgress).toBeNull()
    expect(next.corruptShareReports?.map(r => r.reason)).toEqual(['Inconsistent'])
  })

  it('does not repeat a report already standing', () => {
    const event: DeRecEvent = { type: 'RecoveryShareCorrupted', channel_id: '2', version: 3, reason: 'Malformed' }
    const once = foldEvent(recovering(), event, context())
    const twice = foldEvent(once, event, context())
    expect(twice.corruptShareReports).toHaveLength(1)
  })
})

describe('ShareStored, on a helper', () => {
  it('drops the held shares the owner’s keep list made the store delete', () => {
    const current = vault({
      heldShares: [
        { channelId: '7', secretId: '99', version: 1, description: '' },
        { channelId: '7', secretId: '99', version: 2, description: '' },
        { channelId: '8', secretId: '55', version: 1, description: '' },
      ],
    })
    // The library deleted v1 on channel 7 while storing v3.
    const ctx = context({ isShareHeld: vi.fn((channel: string, v: number) => !(channel === '7' && v === 1)) })

    const next = foldEvent(current, { type: 'ShareStored', channel_id: '7', version: 3 }, ctx)

    expect(next.heldShares.map(s => `${s.channelId}:v${s.version}`)).toEqual(['7:v2', '8:v1', '7:v3'])
  })
})
