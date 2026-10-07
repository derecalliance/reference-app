// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { DeRecEvent } from '@derec-alliance/web'
import { describe, expect, it, vi } from 'vitest'

import type { PairedParticipant } from '../../types'
import { RoundTracker } from '../rounds'
import { vault } from '../testVault'
import { foldEvent, type FoldContext } from '.'

function context(overrides: Partial<FoldContext> = {}): FoldContext {
  const current = vault()
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
    getVault: () => current,
    commit: vi.fn(),
    offerReplicaAdoption: vi.fn(),
    readChannelInfo: vi.fn(() => null),
    channelInfoOutcome: vi.fn(),
    awaitingIdentityAnswer: vi.fn(() => false),
    isShareHeld: vi.fn(() => true),
    ...overrides,
  }
}

describe('foldEvent', () => {
  it('routes an event to the handler for its type', () => {
    const ctx = context()

    foldEvent(vault(), { type: 'DiscoveryStarted', channel_id: '1' } as DeRecEvent, ctx)

    expect(ctx.flowProgressed).toHaveBeenCalledTimes(1)
  })

  it('returns the same record when an event changes nothing', () => {
    // Callers commit only on a changed reference, so an unchanged fold must
    // not look like a change.
    const current = vault()

    expect(foldEvent(current, { type: 'NoOp' } as DeRecEvent, context())).toBe(current)
  })

  it('logs and ignores an event type this build does not know', () => {
    // Exhaustive at compile time, but a newer library can still deliver one.
    const ctx = context()
    const current = vault()

    const next = foldEvent(current, { type: 'SomethingNew' } as unknown as DeRecEvent, ctx)

    expect(next).toBe(current)
    expect(ctx.log).toHaveBeenCalledWith(expect.objectContaining({ step: 'unhandled_event' }))
  })

  it('does not consume another round’s staged bag on completion', () => {
    const ctx = context()
    ctx.rounds.beginProtectRound({
      bag: {
        secretId: '42',
        threshold: 2,
        previousVersions: [],
        currentVersion: {
          version: 5,
          participantIds: [],
          verifiedParticipantIds: [],
          failedParticipantIds: [],
          secrets: [],
          rawBytes: '',
          helpers: [],
        },
      },
      version: 5,
      protocolSecretId: '42',
      channelIds: [],
    })

    foldEvent(vault(), { type: 'SharingComplete', version: 4, threshold_met: true } as DeRecEvent, ctx)

    expect(ctx.rounds.hasPendingRound(5)).toBe(true)
    expect(ctx.roundResolved).toHaveBeenCalled()
  })

  describe('outcomes — a banner when the vault is off screen', () => {
    it('reports a sharing round that reached its threshold', () => {
      const ctx = context()

      foldEvent(vault(), { type: 'SharingComplete', version: 4, threshold_met: true } as DeRecEvent, ctx)

      expect(ctx.notify.outcome).toHaveBeenCalledWith('Sharing round v4 complete')
    })

    it('reports a sharing round that fell short of its threshold', () => {
      const ctx = context()

      foldEvent(vault(), { type: 'SharingComplete', version: 4, threshold_met: false } as DeRecEvent, ctx)

      expect(ctx.notify.outcome).toHaveBeenCalledWith('Sharing round v4 did not reach its threshold')
    })

    it('reports a recovered secret', () => {
      const ctx = context()
      ctx.rounds.beginRecovery({ secretId: '42', version: 2, label: 'Seeds' })

      foldEvent(
        vault(),
        { type: 'SecretRecovered', secret: { helpers: [], secrets: [] } } as unknown as DeRecEvent,
        ctx,
      )

      expect(ctx.notify.outcome).toHaveBeenCalledWith('Secret recovered')
    })

    it('reports a failed recovery', () => {
      const ctx = context()
      const current = vault({
        recoveryProgress: { secretId: '42', version: 2, sharesReceived: 0, totalRequested: 2, error: null },
      })

      foldEvent(current, { type: 'RecoveryShareError', channel_id: '7', error: 'not enough shares' } as DeRecEvent, ctx)

      expect(ctx.notify.outcome).toHaveBeenCalledWith('Recovery failed: not enough shares')
    })

    const richard: PairedParticipant = {
      id: 'richard',
      name: 'Richard',
      channelId: '',
      transport: { protocol: 'https', uri: 'https://richard' },
      secretShares: [],
      connectionStatus: 'available',
    }
    const pairing = { type: 'PairingCompleted', channel_id: '9', pairing_channel_id: '3' } as DeRecEvent

    it('reports a completed pairing by the peer’s name', () => {
      const ctx = context()
      const current = vault({
        participants: [richard],
        pendingPairings: [{ channelId: 3n, participantId: 'richard' }],
      })

      foldEvent(current, pairing, ctx)

      expect(ctx.notify.outcome).toHaveBeenCalledWith('Paired with Richard')
    })

    it('does not report a redelivered pairing again', () => {
      const ctx = context()
      const current = vault({ participants: [{ ...richard, channelId: '9', connectionStatus: 'paired' }] })

      foldEvent(current, pairing, ctx)

      expect(ctx.notify.outcome).not.toHaveBeenCalled()
    })
  })
})

describe('channel info updates', () => {
  const alex: PairedParticipant = {
    id: 'h1',
    name: 'Alex',
    channelId: '7',
    transport: { protocol: 'https', uri: 'http://localhost:5000/derec/h1' },
    secretShares: [],
    connectionStatus: 'paired',
  }

  it('takes a peer\'s new name and endpoints from the store into its row', () => {
    const ctx = context({
      readChannelInfo: vi.fn(() => ({
        name: 'Alex (laptop)',
        transports: [{ protocol: 'https' as const, uri: 'http://192.168.0.28:5300/derec/h1' }],
      })),
    })

    const next = foldEvent(
      vault({ participants: [alex] }),
      { type: 'ChannelInfoUpdated', channel_id: '7' } as DeRecEvent,
      ctx,
    )

    expect(next.participants[0]).toMatchObject({
      name: 'Alex (laptop)',
      transport: { uri: 'http://192.168.0.28:5300/derec/h1' },
    })
    // The same event is also this vault's own update being acknowledged.
    expect(ctx.channelInfoOutcome).toHaveBeenCalledWith('7', 'updated', null)
  })

  it('returns the same record when the stored info already matches', () => {
    const current = vault({ participants: [alex] })
    const ctx = context({
      readChannelInfo: vi.fn(() => ({ name: 'Alex', transports: [alex.transport] })),
    })
    // An echo of this vault's own update changes nothing on its side.
    expect(foldEvent(current, { type: 'ChannelInfoUpdated', channel_id: '7' } as DeRecEvent, ctx)).toBe(
      current,
    )
  })

  it('records a rejection and an undelivered update against the channel', () => {
    const ctx = context()
    foldEvent(
      vault(),
      { type: 'ChannelInfoUpdateRejected', channel_id: '7', status: 10, memo: 'no thanks' } as DeRecEvent,
      ctx,
    )
    foldEvent(vault(), { type: 'UpdateChannelInfoFailed', channel_id: '8', error: 'unreachable' } as DeRecEvent, ctx)

    expect(ctx.channelInfoOutcome).toHaveBeenCalledWith('7', 'rejected', 'no thanks')
    expect(ctx.channelInfoOutcome).toHaveBeenCalledWith('8', 'failed', 'unreachable')
  })
})
