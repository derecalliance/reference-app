// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { DeRecEvent } from '@derec-alliance/web'
import { describe, expect, it, vi } from 'vitest'

import type { PairedParticipant, RecoveryProgress, ItemBag, Secret } from '../../types'
import { RoundTracker } from '../rounds'
import { secret } from '../testSecret'
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
    getSecret: () => secret(),
    commit: vi.fn(),
    offerReplicaAdoption: vi.fn(),
    readChannelInfo: vi.fn(() => null),
    channelInfoOutcome: vi.fn(),
    awaitingIdentityAnswer: vi.fn(() => false),
    isShareHeld: vi.fn(() => true),
    respondToFailure: vi.fn(),
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

function bagAt(version: number): ItemBag {
  return {
    secretId: '42',
    threshold: 2,
    previousVersions: [],
    currentVersion: {
      version,
      participantIds: ['h1', 'h2'],
      verifiedParticipantIds: [],
      failedParticipantIds: [],
      items: [],
      rawBytes: '',
      helpers: [],
    },
  }
}

describe('ShareVerifyRejected', () => {
  function challenged(): { current: Secret; ctx: FoldContext } {
    const ctx = context()
    const deadline = Date.now() + 60_000
    ctx.rounds.beginVerification('1', { protocolSecretId: '42', version: 3, deadline })
    ctx.rounds.beginVerification('2', { protocolSecretId: '42', version: 3, deadline })
    return { current: secret({ participants: [helper(1), helper(2)], itemBag: bagAt(3) }), ctx }
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

    expect(next.itemBag?.currentVersion.verifyRejections).toEqual([
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

describe('ShareVerifyInvalid (SDK 0.0.9)', () => {
  function challenged(): { current: Secret; ctx: FoldContext } {
    const ctx = context()
    const deadline = Date.now() + 60_000
    ctx.rounds.beginVerification('1', { protocolSecretId: '42', version: 3, deadline })
    ctx.rounds.beginVerification('2', { protocolSecretId: '42', version: 3, deadline })
    return { current: secret({ participants: [helper(1), helper(2)], itemBag: bagAt(3) }), ctx }
  }

  const invalid = (channel: string): DeRecEvent => ({ type: 'ShareVerifyInvalid', channel_id: channel, version: 3 })

  it('records the helper apart from refusals and warns about it', () => {
    const { current, ctx } = challenged()

    const next = foldEvent(current, invalid('2'), ctx)

    expect(next.itemBag?.currentVersion.invalidProofParticipantIds).toEqual(['h2'])
    expect(next.itemBag?.currentVersion.verifyRejections).toBeUndefined()
    expect(ctx.rounds.isAwaitingVerification('2', 3)).toBe(false)
    expect(ctx.notify.error).toHaveBeenCalledWith(
      "Helper 2's share of v3 failed verification",
      expect.stringContaining('damaged or dishonest'),
      { channelId: '2' },
    )
    expect(ctx.notify.outcome).not.toHaveBeenCalled()
  })

  it('closes the round on its last answer, naming the invalid proof', () => {
    const { current, ctx } = challenged()

    const verified = foldEvent(current, { type: 'ShareVerified', channel_id: '1', version: 3 }, ctx)
    foldEvent(verified, invalid('2'), ctx)

    expect(ctx.notify.outcome).toHaveBeenCalledWith(
      'Verification of v3 complete: 1 share verified, 1 with an invalid proof',
    )
  })

  it('ignores a verdict nobody is waiting for', () => {
    const { current, ctx } = challenged()
    const next = foldEvent(current, { ...invalid('2'), version: 2 } as DeRecEvent, ctx)
    expect(next).toBe(current)
    expect(ctx.notify.error).not.toHaveBeenCalled()
  })
})

describe('recovery answers without a share', () => {
  function recovering(progress: Partial<RecoveryProgress> = {}): Secret {
    return secret({
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

  it('leaves the decision to the library once the last helper asked refuses', () => {
    const answered = foldEvent(recovering({ sharesReceived: 1, refusals: [{ channelId: '1', status: 6, memo: '' }] }), refused('3'), context())
    expect(answered.recoveryProgress?.error).toBeNull()

    const next = foldEvent(answered, { type: 'RecoveryIncomplete', version: 3, shares_received: 1 }, context())

    expect(next.recoveryProgress?.error).toMatch(/Not enough shares.*1 share collected, 2 helpers answered without a usable share/)
    expect(next.recoveryFailures).toHaveLength(1)
  })

  it('notes a helper that timed out instead of reporting a dispatch failure', () => {
    const ctx = context()
    const next = foldEvent(
      recovering({ sharesReceived: 2 }),
      { type: 'RecoverSecretFailed', channel_id: '3', version: 3, error: 'timeout' },
      ctx,
    )

    expect(next.recoveryProgress?.timedOut).toEqual(['3'])
    expect(ctx.notify.error).not.toHaveBeenCalled()
    const closed = foldEvent(next, { type: 'RecoveryIncomplete', version: 3, shares_received: 2 }, ctx)
    expect(closed.recoveryProgress?.error).toMatch(/1 did not answer in time/)
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

  it('points an unreadable share at the SDK-upgrade cause rather than only at the helper', () => {
    const ctx = context()
    const malformed = (channel: string): DeRecEvent => ({
      type: 'RecoveryShareCorrupted',
      channel_id: channel,
      version: 3,
      reason: 'Malformed',
    })
    const progress = { totalRequested: 2, requestedChannelIds: ['1', '2'] }
    const once = foldEvent(recovering(progress), malformed('1'), ctx)
    const twice = foldEvent(once, malformed('2'), ctx)
    const next = foldEvent(twice, { type: 'RecoveryIncomplete', version: 3, shares_received: 0 }, ctx)

    expect(ctx.notify.error).toHaveBeenCalledWith(expect.stringContaining('before an SDK upgrade'), undefined, expect.anything())
    expect(ctx.notify.error).not.toHaveBeenCalledWith(expect.stringContaining('An honest helper never'), undefined, expect.anything())
    expect(next.recoveryProgress?.error).toMatch(/2 helpers answered without a usable share.*protect a new version/)
  })

  it('reports a forged share without touching a recovery the library already decided', () => {
    const current = secret({ participants: [helper(1)], recoveryProgress: null })
    const next = foldEvent(
      current,
      { type: 'RecoveryShareCorrupted', channel_id: '1', version: 3, reason: 'Forged' },
      context(),
    )

    expect(next.recoveryProgress).toBeNull()
    expect(next.corruptShareReports?.map(r => r.reason)).toEqual(['Forged'])
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
    const current = secret({
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

describe('a recovery the helpers disagree on (SDK 0.0.11)', () => {
  type Recovered = Extract<DeRecEvent, { type: 'SecretRecovered' }>['secret']
  const payload = (value: string) =>
    ({
      helpers: [],
      secrets: [{ id: new Uint8Array([1]), name: 'seed', data: new TextEncoder().encode(value) }],
    }) as unknown as Recovered
  const by = (...channels: string[]) => channels.map(channel_id => ({ channel_id }))

  function recovering(): { current: Secret; ctx: FoldContext } {
    const ctx = context()
    ctx.rounds.beginRecovery({ secretId: '42', version: 3, label: 'Seeds' })
    const current = secret({
      participants: [helper(1), helper(2), helper(3)],
      recoveryProgress: { secretId: '42', version: 3, sharesReceived: 3, totalRequested: 3, error: null },
    })
    return { current, ctx }
  }

  it('keeps a disputed secret for the owner to judge, naming both sides', () => {
    const { current, ctx } = recovering()
    const next = foldEvent(
      current,
      { type: 'RecoveryDisputed', version: 3, secret: payload('real'), supported_by: by('1', '2'), disputed_by: by('3') },
      ctx,
    )

    expect(next.recoveryProgress).toBeNull()
    expect(next.recoveredSecrets).toHaveLength(1)
    expect(next.recoveredSecrets[0]).toMatchObject({
      secretId: '42',
      version: 3,
      dispute: {
        kind: 'disputed',
        supportedBy: [{ channelId: '1', name: 'Helper 1' }, { channelId: '2', name: 'Helper 2' }],
        disputedBy: [{ channelId: '3', name: 'Helper 3' }],
      },
    })
    expect(ctx.notify.error).toHaveBeenCalledWith(expect.stringContaining('Helper 3 hold shares of a different secret'))
    expect(ctx.notify.outcome).not.toHaveBeenCalled()
  })

  it('offers every candidate of a conflict, each disputed by the helpers behind the others', () => {
    const { current, ctx } = recovering()
    const next = foldEvent(
      current,
      {
        type: 'RecoveryConflict',
        version: 3,
        candidates: [
          { secret: payload('real'), supported_by: by('1', '2') },
          { secret: payload('forged'), supported_by: by('3') },
        ],
        disputed_by: [],
      },
      ctx,
    )

    expect(next.recoveredSecrets.map(r => r.dispute)).toEqual([
      expect.objectContaining({ kind: 'conflict', candidate: 1, candidates: 2, disputedBy: [{ channelId: '3', name: 'Helper 3' }] }),
      expect.objectContaining({ kind: 'conflict', candidate: 2, candidates: 2, disputedBy: [
        { channelId: '1', name: 'Helper 1' },
        { channelId: '2', name: 'Helper 2' },
      ] }),
    ])
  })

  it('names a helper this device has no row for by what it advertised', () => {
    const { current, ctx } = recovering()
    const next = foldEvent(
      current,
      {
        type: 'RecoveryDisputed',
        version: 3,
        secret: payload('real'),
        supported_by: by('1'),
        disputed_by: [{ channel_id: '99', communication_info: { name: 'Mallory' } }],
      },
      ctx,
    )

    expect(next.recoveredSecrets[0].dispute?.disputedBy).toEqual([{ channelId: '99', name: 'Mallory' }])
  })
})
