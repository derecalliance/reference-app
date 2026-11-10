// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { ContactMessage, DeRecEvent } from '@derec-alliance/web'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { toBase64Url } from '../derecApi'
import { PROTECT_ROUND_BACKSTOP_MS } from '../owner/protocol'
import { makeStateStore } from '../stores'
import type { PairedParticipant, ItemBag, Item, Secret } from '../types'
import { SecretRuntime } from './runtime'
import { deps, stubInstance, secret } from './testSecret'

/**
 * Protect rounds that overlap, finish out of order, outlive the app's
 * watchdog, or end below threshold — driven through one runtime and its fold,
 * with a fake protocol standing in for WASM.
 */

const s1: Item = { id: 'a1', name: 'S1', data: 'one' }

function helper(n: number): PairedParticipant {
  return {
    id: `h${n}`,
    name: `Helper ${n}`,
    channelId: `90${n}`,
    transport: { protocol: 'https', uri: `http://localhost:5000/derec/h${n}` },
    secretShares: [],
    connectionStatus: 'paired',
    peerRole: 'helper',
  }
}

function bagAt(version: number, items: Item[]): ItemBag {
  return {
    secretId: '42',
    threshold: 2,
    previousVersions: [],
    currentVersion: {
      version,
      participantIds: [],
      verifiedParticipantIds: [],
      failedParticipantIds: [],
      items,
      rawBytes: '',
      helpers: [],
    },
  }
}

function event(e: Record<string, unknown>): DeRecEvent {
  return e as unknown as DeRecEvent
}

/** A runtime over four helpers, threshold 2, with v1 = [S1] committed. */
function runtime(overrides: Partial<Secret> = {}) {
  // Reachable by fiat: the default probe would call a real node on port 5000,
  // which made these specs depend on whether one happened to be running.
  const d = deps({ io: { serverReachable: async () => true } })
  const r = new SecretRuntime(
    secret({
      minParticipants: 2,
      participants: [helper(1), helper(2), helper(3), helper(4)],
      itemBag: bagAt(1, [s1]),
      ...overrides,
    }),
    d,
  )
  // The library targets every paired helper channel, and says so per channel.
  let nextVersion = 2
  const start = vi.fn(async () => {
    const version = nextVersion++
    return r.state().secret.participants.map(p =>
      event({ type: 'ProtectSecretStarted', channel_id: p.channelId, version, trace_id: 't' }),
    )
  })
  stubInstance(r, { start })
  return { r, d, start }
}

/** Fold `events` in order and commit, as the drain does. */
function deliver(r: SecretRuntime, ...events: Record<string, unknown>[]): void {
  let next = r.state().secret
  for (const e of events) next = r.applyEvent(next, event(e))
  r.commit(next)
}

const confirmed = (version: number, channel: string) => ({ type: 'ShareConfirmed', channel_id: channel, version })
/** Every one of the four helpers stored its share. */
const settled = (version: number) => ({
  type: 'SharingComplete',
  version,
  confirmed_count: 4,
  failed_count: 0,
  threshold_met: true,
})
const complete = (version: number, thresholdMet: boolean) => ({
  type: 'SharingComplete',
  version,
  confirmed_count: thresholdMet ? 2 : 1,
  failed_count: thresholdMet ? 2 : 3,
  threshold_met: thresholdMet,
})

function itemNames(r: SecretRuntime): string[] {
  return r.state().secret.itemBag?.currentVersion.items.map(s => s.name) ?? []
}

function shareStatus(r: SecretRuntime, participantId: string, version: number): string | undefined {
  return r.state().secret.participants
    .find(p => p.id === participantId)
    ?.secretShares.find(s => s.version === version)?.status
}

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

describe('one round at a time', () => {
  it('refuses a second publish while the first is open, and sends nothing', async () => {
    const { r, start } = runtime()

    await r.addItem('S2', 'two')
    await expect(r.addItem('S3', 'three')).rejects.toThrow(/v2 is still being published/)

    expect(start).toHaveBeenCalledTimes(1)
    expect(r.roundInProgressReason()).toMatch(/v2 is still being published/)
  })

  it('publishes again once the open round settles', async () => {
    const { r, start } = runtime()
    await r.addItem('S2', 'two')
    deliver(r, confirmed(2, '901'), confirmed(2, '902'), confirmed(2, '903'), confirmed(2, '904'), settled(2))

    await r.addItem('S3', 'three')

    expect(r.roundInProgressReason()).toMatch(/v3/)
    const published = start.mock.calls.map(call => ((call as unknown[])[1] as { secrets: { name: string }[] }).secrets.map(x => x.name))
    expect(published).toEqual([
      ['S1', 'S2'],
      ['S1', 'S2', 'S3'],
    ])
  })

  it('keeps refusing after a reload while the persisted round is still open', async () => {
    const first = runtime()
    await first.r.addItem('S2', 'two')
    const saved = first.r.state().secret

    const { r, start } = runtime(saved)
    r.resumeProtectRound()

    await expect(r.addItem('S3', 'three')).rejects.toThrow(/v2 is still being published/)
    expect(start).not.toHaveBeenCalled()
  })

  it('refuses pairing and fingerprint confirmation while a round is open: both publish', async () => {
    const { r } = runtime()
    await r.addItem('S2', 'two')

    await expect(r.createContact()).rejects.toThrow(/Pairing would publish this secret/)
    await expect(r.startPairing({} as ContactMessage, 'owner')).rejects.toThrow(/Pairing would publish this secret/)
    await expect(r.replicaProtocol.verifyFingerprint(1n, '1234')).rejects.toThrow(/Confirming would publish this secret/)
  })

  it('counts the rounds the library started on its own, which only its state rows record', async () => {
    const { r } = runtime()
    await makeStateStore('secret:v1').save('42', new TextEncoder().encode(JSON.stringify({ kind: 3, version: 2, pending: [] })))

    expect(r.openRoundVersions()).toEqual([2])
    await expect(r.addItem('S2', 'two')).rejects.toThrow(/v2 is still being published/)
  })

  it('holds publishes back while an unpair awaits its answer, since completing it publishes', async () => {
    const { r, start } = runtime()
    await makeStateStore('secret:v1').save('42', new TextEncoder().encode(JSON.stringify({ kind: 2, channel_id: '903' })))

    expect(r.roundInProgressReason()).toMatch(/An unpair is waiting for the helper's answer/)
    await expect(r.addItem('S2', 'two')).rejects.toThrow(/unpair/)
    expect(start).not.toHaveBeenCalled()
  })

  it('does not send an unpair while a round is open', async () => {
    const { r, start } = runtime()
    await r.addItem('S2', 'two')

    const result = await r.unpair('903', 'Helper 3', 'h3')

    expect(result).toEqual({ dispatched: false, reason: expect.stringMatching(/v2 is still being published/) })
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('folds what an unacknowledged unpair returns, so the channel goes at once', async () => {
    const { r } = runtime()
    const start = vi.fn(async () => [event({ type: 'Unpaired', channel_id: '904' })])
    stubInstance(r, { start })

    await expect(r.unpair('904', 'Helper 4', 'h4')).resolves.toEqual({ dispatched: true })

    expect(r.state().secret.participants.map(p => p.id)).toEqual(['h1', 'h2', 'h3'])
  })
})

describe('the version an unpair or a replica removal publishes', () => {
  /** Helper 4, holding its confirmed share of v1. */
  const shareHolder: PairedParticipant = {
    ...helper(4),
    secretShares: [{ version: 1, status: 'confirmed', verified: false }],
  }

  /** Drop a helper channel from the library's store, as a completed unpair does. */
  function dropHelperChannel(channelId: string) {
    localStorage.removeItem(`derec:secret:v1:42:channel:helper:${channelId}`)
    const idx = 'derec:secret:v1:42:channel-idx:helper'
    const remaining = (JSON.parse(localStorage.getItem(idx) ?? '[]') as string[]).filter(id => id !== channelId)
    localStorage.setItem(idx, JSON.stringify(remaining))
  }

  /**
   * A runtime whose fake library answers each flow as SDK 0.0.10 does: an
   * unpair with `onUnpair`, a replica removal with nothing, and a publish with
   * v2 sent to the three helpers that remain.
   */
  function libraryRuntime(onUnpair: () => DeRecEvent[], overrides: Partial<Secret> = {}) {
    const { r, d } = runtime({ participants: [helper(1), helper(2), helper(3), shareHolder], ...overrides })
    const start = vi.fn(async (_flow: unknown, params: Record<string, unknown>) => {
      if ('secrets' in params) {
        return ['901', '902', '903'].map(channel_id =>
          event({ type: 'ProtectSecretStarted', channel_id, version: 2, trace_id: 't' }),
        )
      }
      if ('replica_id' in params) return []
      dropHelperChannel('904')
      return onUnpair()
    })
    stubInstance(r, { start })
    return { r, d, start }
  }

  const published = (start: ReturnType<typeof vi.fn>) =>
    start.mock.calls.flatMap(call => {
      const params = (call as unknown[])[1] as { secrets?: { name: string }[] }
      return params.secrets ? [params.secrets.map(s => s.name)] : []
    })

  it('publishes the current items to the helpers that remain once an unacknowledged unpair completes', async () => {
    const { r, start } = libraryRuntime(() => [event({ type: 'Unpaired', channel_id: '904' })])

    await expect(r.unpair('904', 'Helper 4', 'h4')).resolves.toEqual({ dispatched: true })

    expect(published(start)).toEqual([['S1']])
    expect(r.roundInProgressReason()).toMatch(/v2 is still being published/)
  })

  it('publishes when an acknowledged unpair completes later, on a tick', async () => {
    const { r, start } = libraryRuntime(() => [])
    stubInstance(r, {
      start,
      tick: async () => [event({ type: 'Unpaired', channel_id: '904' })],
      removeExpiredChannels: async () => [],
    })

    await r.unpair('904', 'Helper 4', 'h4')
    expect(published(start)).toEqual([])

    dropHelperChannel('904')
    await r.tickOnce()

    expect(published(start)).toEqual([['S1']])
  })

  it('publishes nothing for a helper that held no share', async () => {
    const { r, start } = libraryRuntime(() => [event({ type: 'Unpaired', channel_id: '904' })], {
      participants: [helper(1), helper(2), helper(3), helper(4)],
    })

    await r.unpair('904', 'Helper 4', 'h4')

    expect(published(start)).toEqual([])
  })

  it('publishes nothing, and says so, when the helpers that remain fall below the threshold', async () => {
    const { r, d, start } = libraryRuntime(() => [event({ type: 'Unpaired', channel_id: '904' })])
    r.setThreshold({ mode: 'fixed', value: 4 })

    await r.unpair('904', 'Helper 4', 'h4')

    expect(published(start)).toEqual([])
    expect(d.notify.info).toHaveBeenCalledWith(expect.stringMatching(/3 subshare\(s\), below the threshold of 4/))
  })

  it('publishes the roster without the removed replica member as the next version', async () => {
    const { r, start } = libraryRuntime(() => [])

    await expect(r.evictReplica('7')).resolves.toBe('published')

    expect(published(start)).toEqual([['S1']])
  })

  it('only announces a replica removal when the secret holds no items to carry the roster', async () => {
    const { r, start } = libraryRuntime(() => [], { itemBag: undefined })

    await expect(r.evictReplica('7')).resolves.toBe('announced')

    expect(published(start)).toEqual([])
  })
})

describe('a round that closed without every helper storing its share', () => {
  it('records a rolled-back round as not recoverable, with the items it carried', async () => {
    const { r } = runtime()
    await r.addItem('S2', 'two')

    deliver(r, confirmed(2, '901'), complete(2, false))

    expect(r.state().secret.itemBag?.currentVersion.version).toBe(1)
    expect(r.state().secret.unsettledRound).toMatchObject({
      version: 2,
      recoverable: false,
      confirmedCount: 1,
      failedCount: 3,
    })
    expect(r.state().secret.unsettledRound?.items.map(x => x.name)).toEqual(['S1', 'S2'])
  })

  it('records a committed round with failures as recoverable', async () => {
    const { r } = runtime()
    await r.addItem('S2', 'two')

    deliver(r, confirmed(2, '901'), confirmed(2, '902'), complete(2, true))

    expect(r.state().secret.itemBag?.currentVersion.version).toBe(2)
    expect(r.state().secret.unsettledRound).toMatchObject({ version: 2, recoverable: true, failedCount: 2 })
  })

  it('retries by publishing the same items as a new round, and clears once that one settles fully', async () => {
    const { r, start } = runtime()
    await r.addItem('S2', 'two')
    deliver(r, confirmed(2, '901'), complete(2, false))

    const retried = await r.retryUnsettledRound()

    expect(retried?.version).toBe(3)
    expect(((start.mock.calls[1] as unknown[])[1] as { secrets: { name: string }[] }).secrets.map(x => x.name)).toEqual(['S1', 'S2'])
    // Still on record while the retry is open.
    expect(r.state().secret.unsettledRound?.version).toBe(2)

    deliver(r, confirmed(3, '901'), confirmed(3, '902'), confirmed(3, '903'), confirmed(3, '904'), settled(3))

    expect(r.state().secret.unsettledRound).toBeUndefined()
    expect(itemNames(r)).toEqual(['S1', 'S2'])
  })

  it('refuses a retry while a round is open', async () => {
    const { r } = runtime()
    await r.addItem('S2', 'two')
    deliver(r, confirmed(2, '901'), complete(2, false))
    await r.retryUnsettledRound()

    await expect(r.retryUnsettledRound()).rejects.toThrow(/v3 is still being published/)
  })

  it('forgets it when the owner dismisses it', async () => {
    const { r } = runtime()
    await r.addItem('S2', 'two')
    deliver(r, confirmed(2, '901'), complete(2, false))

    r.dismissUnsettledRound()

    expect(r.state().secret.unsettledRound).toBeUndefined()
  })
})

describe('a round that outlives the app watchdog', () => {
  it('waits for the library rather than giving up first', async () => {
    vi.useFakeTimers()
    const { r } = runtime({ configOverrides: { protocolTimeoutSecs: 30 } })
    await r.addItem('S2', 'two')

    vi.advanceTimersByTime(30_000)

    expect(r.hasPendingRound(2)).toBe(true)
    expect(PROTECT_ROUND_BACKSTOP_MS).toBeGreaterThan(60_000)
  })

  it('keeps a round that met its threshold, with its confirmations, and commits it when the library does', async () => {
    vi.useFakeTimers()
    const { r, d } = runtime()
    await r.addItem('S2', 'two')
    deliver(r, confirmed(2, '901'), confirmed(2, '902'), confirmed(2, '903'))

    vi.advanceTimersByTime(PROTECT_ROUND_BACKSTOP_MS * 3)

    expect(d.notify.error).not.toHaveBeenCalled()
    expect(r.hasPendingRound(2)).toBe(true)
    expect(shareStatus(r, 'h3', 2)).toBe('confirmed')

    deliver(r, complete(2, true))
    expect(itemNames(r)).toEqual(['S1', 'S2'])
    // The helper that never answered is settled, and recorded on the version.
    expect(shareStatus(r, 'h4', 2)).toBe('rejected')
    expect(r.state().secret.itemBag?.currentVersion.failedParticipantIds.map(f => f.id)).toEqual(['h4'])
  })

  it('rolls a round below threshold back, settling the unanswered rows instead of erasing the answered ones', async () => {
    vi.useFakeTimers()
    const { r, d } = runtime({ configOverrides: { protocolTimeoutSecs: 30 } })
    await r.addItem('S2', 'two')
    deliver(r, confirmed(2, '901'))

    vi.advanceTimersByTime(PROTECT_ROUND_BACKSTOP_MS)

    expect(r.hasPendingRound(2)).toBe(false)
    expect(d.notify.error).toHaveBeenCalledWith(expect.stringContaining('rolled back'), undefined, expect.anything())
    expect(shareStatus(r, 'h1', 2)).toBe('confirmed')
    expect(shareStatus(r, 'h2', 2)).toBe('rejected')
    expect(r.state().secret.itemBag?.currentVersion.version).toBe(1)
  })
})

describe('a round the library closes below threshold', () => {
  it('ends with every row resolved, so the progress view reaches its rollback banner', async () => {
    const { r } = runtime()
    await r.addItem('S2', 'two')
    deliver(r, confirmed(2, '901'))

    deliver(r, complete(2, false))

    expect(['h1', 'h2', 'h3', 'h4'].map(id => shareStatus(r, id, 2))).toEqual([
      'confirmed',
      'rejected',
      'rejected',
      'rejected',
    ])
    expect(r.state().secret.itemBag?.currentVersion.version).toBe(1)
    expect(r.state().secret.pendingProtectRounds).toBeUndefined()
  })
})

describe('a helper the library does not send the round to', () => {
  it('is neither waited on nor reported as having failed to store it', async () => {
    const { r, start } = runtime()
    // h4's fingerprint was refused, so its channel is still `Pending` and the
    // library sends the round to the other three only.
    start.mockImplementationOnce(async () =>
      ['901', '902', '903'].map(channel_id =>
        event({ type: 'ProtectSecretStarted', channel_id, version: 2, trace_id: 't' }),
      ),
    )

    const round = await r.addItem('S2', 'two')

    expect(round).toEqual({ version: 2, recipientIds: ['h1', 'h2', 'h3'], threshold: 2 })
    expect(shareStatus(r, 'h4', 2)).toBeUndefined()

    deliver(r, confirmed(2, '901'), confirmed(2, '902'), confirmed(2, '903'), complete(2, true))

    const committed = r.state().secret.itemBag?.currentVersion
    expect(committed?.version).toBe(2)
    expect(committed?.failedParticipantIds).toEqual([])
    expect(committed?.helpers.map(h => h.id)).toEqual(['h1', 'h2', 'h3'])
    expect(shareStatus(r, 'h4', 2)).toBeUndefined()
  })
})

describe('a secret whose replica group does not list this device', () => {
  afterEach(() => localStorage.clear())

  it('refuses to publish, saying why and what to do, before the library is asked', async () => {
    // The group as the library stores it for local secret v1 / secret id 42: one member,
    // and not this device (whose id is pinned to 5555).
    localStorage.setItem('derec:replica-id:v1', '5555')
    localStorage.setItem('derec:secret:v1:42:channel-idx:replica', JSON.stringify(['1001']))
    localStorage.setItem(
      'derec:secret:v1:42:channel:replica:1001',
      toBase64Url(new TextEncoder().encode(JSON.stringify({ Replica: { channel_id: 700, role: 'Source', status: 'Paired' } }))),
    )
    const { r, start } = runtime()

    await expect(r.addItem('S2', 'two')).rejects.toThrow(/does not list this device.*Recover from bag/s)
    expect(start).not.toHaveBeenCalled()
  })
})

describe('publishing a restored bag', () => {
  it('sends the snapshot’s base64url ids as the bytes they encode, not as garbled hex', async () => {
    // `AQID` is base64url for [1, 2, 3].
    const { r, start } = runtime({ itemBag: bagAt(1, [{ id: 'AQID', name: 'Restored', data: 'x' }]) })

    await r.addItem('S2', 'two')

    const params = (start.mock.calls[0] as unknown[])[1] as { secrets: { id: Uint8Array }[] }
    expect(Array.from(params.secrets[0].id)).toEqual([1, 2, 3])
  })
})

describe('verifying shares', () => {
  const withConfirmed = (overrides: Partial<ItemBag['currentVersion']> = {}): ItemBag => {
    const bag = bagAt(1, [s1])
    return { ...bag, currentVersion: { ...bag.currentVersion, participantIds: ['h1', 'h2'], ...overrides } }
  }

  it('explains, without dispatching, that a version restored from recovery cannot be verified', async () => {
    const { r, start } = runtime({ itemBag: withConfirmed({ restoredFromRecovery: true }) })

    await expect(r.verifyShares(1)).rejects.toThrow('restored from a recovered bag')
    expect(start).not.toHaveBeenCalled()
    expect(r.state().busy).toBe(false)
  })

  it('turns the library’s NoProof report on a version it no longer holds copies of into words (SDK 0.0.9)', async () => {
    const { r } = runtime({ itemBag: withConfirmed() })
    stubInstance(r, {
      // Nothing to check a proof against: nothing is sent, and every channel
      // reports why.
      start: async () => [
        event({ type: 'VerifySharesFailed', channel_id: '901', version: 1, reason: 'NoProof', error: 'no proof' }),
      ],
    })

    await expect(r.verifyShares(1)).rejects.toThrow('no verification copies')
    expect(r.state().busy).toBe(false)
  })

  it('reports the channels a challenge could not be sent on', async () => {
    const { r } = runtime({ itemBag: withConfirmed() })
    stubInstance(r, {
      start: async () => [
        event({ type: 'VerifySharesStarted', channel_id: '901', version: 1, trace_id: 't' }),
        event({ type: 'VerifySharesFailed', channel_id: '902', version: 1, reason: 'DispatchFailed', error: 'unreachable' }),
      ],
    })

    await expect(r.verifyShares(1)).resolves.toEqual({ failedChannelIds: ['902'] })
  })
})

describe('the threshold is per round (SDK 0.0.9)', () => {
  afterEach(() => vi.useRealTimers())

  it('splits at the threshold the publish asks for, and records it on the version', async () => {
    const { r, start } = runtime()

    const round = await r.protect([s1], { threshold: 3 })

    expect(start).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ threshold: 3 }))
    expect(round?.threshold).toBe(3)
    expect(r.state().secret.pendingProtectRounds?.[0]).toMatchObject({ threshold: 3 })
    expect(r.state().secret.pendingProtectRounds?.[0].bag.currentVersion.threshold).toBe(3)
  })

  it('always names a threshold, so the app and the library agree on it', async () => {
    const { r, start } = runtime()

    await r.protect([s1])

    expect(start).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ threshold: 2 }))
  })

  it('keeps a round open that met the secret setting but not its own threshold', async () => {
    const { r } = runtime()
    const round = await r.protect([s1], { threshold: 3 })
    const version = round!.version

    // Every helper answers: 2 confirmations meet the secret's 2, not the round's 3.
    const rejected = (channel: string) => ({ type: 'ShareRejected', channel_id: channel, version, status: 10, memo: 'no' })
    deliver(r, confirmed(version, '901'), confirmed(version, '902'), rejected('903'), rejected('904'))

    expect(r.state().secret.itemBag?.currentVersion.version).toBe(1)
  })
})

describe('the publish policy (owner settings)', () => {
  it('splits at the policy\'s default threshold when the publish names none', async () => {
    const { r, start } = runtime()
    r.updatePublishPolicy({
      defaultThreshold: 3,
      defaultWeights: {},
      helperRetention: { mode: 'latestCommitted' },
      proofCleanup: { mode: 'manual' },
    })

    await r.protect([s1])

    expect(start).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ threshold: 3 }))
    expect(r.state().secret.publishPolicy?.defaultThreshold).toBe(3)
  })
})

describe('default helper weights', () => {
  it('records a helper\'s default weight, 1 included — it overrides the last published weight', () => {
    const { r } = runtime()

    r.setDefaultWeight('901', 2)
    expect(r.state().secret.publishPolicy?.defaultWeights).toEqual({ '901': 2 })

    r.setDefaultWeight('901', 1)
    expect(r.state().secret.publishPolicy?.defaultWeights).toEqual({ '901': 1 })
  })
})

describe('the earlier version helpers keep, chosen at publish', () => {
  /** A runtime whose fake `start` asks for the `keepVersion` as the library does, mid-call. */
  function asking(overrides: Partial<Secret> = {}) {
    const harness = runtime(overrides)
    const asked: number[] = []
    const keepVersion = (harness.r as unknown as { keepVersion: (s: string, v: number) => number }).keepVersion
    const inner = harness.start.getMockImplementation()
    harness.start.mockImplementation(async () => {
      const events = await inner!()
      const version = (events[0] as { version: number }).version
      asked.push(keepVersion('42', version))
      return events
    })
    return { ...harness, asked }
  }

  const selectPolicy = {
    defaultThreshold: 2,
    defaultWeights: {},
    helperRetention: { mode: 'select' as const },
    proofCleanup: { mode: 'manual' as const },
  }

  it('sends exactly the version the owner picked for that publish', async () => {
    const { r, asked } = asking({ publishPolicy: selectPolicy })

    await r.addItem('S2', 'two', { keep: 0 })

    expect(asked).toEqual([0])
  })

  it('keeps the newest committed version for a round with no pick, in select mode', async () => {
    const { r, asked } = asking({ publishPolicy: selectPolicy })

    await r.protect([s1])

    expect(asked).toEqual([1])
  })

})

describe('the threshold and weights set on the Channels tab', () => {
  /** A paired helper channel in the library's own store, as it records one. */
  function seedHelperChannel(channelId: string) {
    const record = `{"Helper":{"channel_id":${channelId},"transports":[],"peer_role":"Helper","status":"Paired","created_at":1}}`
    localStorage.setItem(`derec:secret:v1:42:channel:helper:${channelId}`, toBase64Url(new TextEncoder().encode(record)))
    const idx = 'derec:secret:v1:42:channel-idx:helper'
    localStorage.setItem(idx, JSON.stringify([...JSON.parse(localStorage.getItem(idx) ?? '[]'), channelId]))
  }

  it('are what every publish uses', async () => {
    const { r, start } = runtime()
    seedHelperChannel('901')
    seedHelperChannel('902')
    r.setThreshold({ mode: 'fixed', value: 3 })
    r.setDefaultWeight('901', 2)

    await r.addItem('S2', 'two', { keep: null })

    const params = (start.mock.calls[0] as unknown[])[1] as { weights: Map<string, number>; threshold: number }
    expect([...params.weights]).toEqual([['901', 2]])
    expect(params.threshold).toBe(3)
  })

  it('work a percentage out from the helpers\' subshares at publish time', async () => {
    const { r, start } = runtime()
    for (const channelId of ['901', '902', '903', '904']) seedHelperChannel(channelId)
    r.setThreshold({ mode: 'percent', percent: 60 })
    r.setDefaultWeight('901', 2)

    await r.addItem('S2', 'two', { keep: null })

    // 2 + 1 + 1 + 1 = 5 subshares; 60% of 5 is 3.
    const params = (start.mock.calls[0] as unknown[])[1] as { threshold: number }
    expect(params.threshold).toBe(3)
  })

  it('setting the threshold sends nothing', () => {
    const { r, start } = runtime()

    r.setThreshold({ mode: 'fixed', value: 3 })

    expect(r.state().secret.publishPolicy?.defaultThreshold).toBe(3)
    expect(start).not.toHaveBeenCalled()
  })
})

describe('republish', () => {
  it('publishes the current items again with the secret\'s threshold and weights', async () => {
    const { r, start } = runtime()
    r.setThreshold({ mode: 'fixed', value: 3 })

    const round = await r.republish({ keep: null })

    expect(round?.threshold).toBe(3)
    const params = (start.mock.calls[0] as unknown[])[1] as { secrets: unknown[] }
    expect(params.secrets).toHaveLength(1)
  })
})

describe('publishContext', () => {
  it('gives the dialogs the policy, the committed versions newest first, and what the default rule keeps', async () => {
    const { r } = runtime({
      itemBag: { ...bagAt(3, [s1]), previousVersions: [bagAt(2, [s1]).currentVersion, bagAt(1, [s1]).currentVersion] },
      publishPolicy: { defaultThreshold: 2, defaultWeights: {}, helperRetention: { mode: 'latestCommitted' }, proofCleanup: { mode: 'manual' } },
    })

    const context = r.publishContext()

    expect(context.committedVersions).toEqual([3, 2, 1])
    expect(context.preview).toEqual({ kept: 3, dropped: [2, 1] })
    expect(context.policy.helperRetention).toEqual({ mode: 'latestCommitted' })
  })
})

describe('periodic verification', () => {
  it('verifies the current version once the schedule is due, and not before', async () => {
    const { r } = runtime()
    const verify = vi.spyOn(r, 'verifyShares').mockResolvedValue({ failedChannelIds: [] })
    r.setVerificationSchedule({ every: 30, unit: 'minutes' }, 0)

    expect(await r.runScheduledVerification(29 * 60_000)).toBeNull()
    expect(verify).not.toHaveBeenCalled()

    expect(await r.runScheduledVerification(30 * 60_000)).toBe(1)
    expect(verify).toHaveBeenCalledWith(1)
    // The next one counts from this run.
    expect(await r.runScheduledVerification(31 * 60_000)).toBeNull()
  })

  it('does not leave the secret busy after a scheduled run (review I1)', async () => {
    const { r } = runtime()
    // The real verifyShares marks the secret busy; a person closing the dialog
    // clears it, and a scheduled run has no dialog.
    vi.spyOn(r, 'verifyShares').mockImplementation(async () => {
      r.setBusy(true)
      return { failedChannelIds: [] }
    })
    r.setVerificationSchedule({ every: 1, unit: 'minutes' }, 0)

    await r.runScheduledVerification(60_000)

    expect(r.state().busy).toBe(false)
  })

  it('does nothing without a schedule', async () => {
    const { r } = runtime()
    const verify = vi.spyOn(r, 'verifyShares').mockResolvedValue({ failedChannelIds: [] })

    expect(await r.runScheduledVerification(10 ** 12)).toBeNull()
    expect(verify).not.toHaveBeenCalled()
  })

  it('announces the start, then a pass once every challenged helper proved its share', async () => {
    const held = { ...bagAt(1, [s1]), currentVersion: { ...bagAt(1, [s1]).currentVersion, participantIds: ['h1', 'h2'] } }
    const { r, d } = runtime({ itemBag: held })
    vi.spyOn(r, 'verifyShares').mockResolvedValue({ failedChannelIds: [] })
    r.setVerificationSchedule({ every: 1, unit: 'minutes' }, 0)

    await r.runScheduledVerification(60_000)

    expect(d.notify.info).toHaveBeenCalledWith('Automatic verification of v1 started: 2 helpers challenged')
    expect(r.state().secret.pendingAutoVerification).toMatchObject({ version: 1, channelIds: ['901', '902'] })

    // Both proofs land; the stubbed run opened no challenges, so it is settled.
    const bag = r.state().secret.itemBag!
    r.commit({
      ...r.state().secret,
      itemBag: { ...bag, currentVersion: { ...bag.currentVersion, verifiedParticipantIds: ['h1', 'h2'] } },
    })
    const result = r.finishAutoVerification(70_000)

    expect(result?.passed).toBe(true)
    expect(r.state().secret.pendingAutoVerification).toBeUndefined()
    expect(r.state().secret.lastAutoVerification).toMatchObject({ version: 1, passed: true, at: 70_000 })
    expect(r.state().secret.notifications?.map(n => [n.severity, n.title])).toEqual([
      ['info', 'Automatic verification of v1 passed'],
      ['info', 'Automatic verification of v1 started'],
    ])
  })

  it('raises a critical notification and an alert when a helper does not prove its share', async () => {
    const held = { ...bagAt(1, [s1]), currentVersion: { ...bagAt(1, [s1]).currentVersion, participantIds: ['h1', 'h2'] } }
    const { r, d } = runtime({ itemBag: held })
    d.notify.alert = vi.fn()
    vi.spyOn(r, 'verifyShares').mockResolvedValue({ failedChannelIds: ['902'] })
    r.setVerificationSchedule({ every: 1, unit: 'minutes' }, 0)

    await r.runScheduledVerification(60_000)
    const result = r.finishAutoVerification(70_000)

    expect(result?.passed).toBe(false)
    expect(result?.summary).toContain('Helper 1 did not answer')
    expect(result?.summary).toContain('Helper 2 could not be reached')
    expect(d.notify.alert).toHaveBeenCalledWith(expect.stringContaining('Automatic verification of v1 failed'))
    const [latest] = r.state().secret.notifications ?? []
    expect(latest).toMatchObject({ severity: 'critical', read: false, title: 'Automatic verification of v1 failed' })
  })

  it('reports a silent helper at the report deadline, while its challenge stays open', async () => {
    const held = { ...bagAt(1, [s1]), currentVersion: { ...bagAt(1, [s1]).currentVersion, participantIds: ['h1', 'h2'] } }
    const { r } = runtime({
      itemBag: { ...held, currentVersion: { ...held.currentVersion, verifiedParticipantIds: ['h1'] } },
      verificationSchedule: { every: 5, unit: 'minutes', since: 0 },
      // h2 was challenged and has not answered; its 24-hour window is open.
      pendingVerifications: [{ channelId: '902', protocolSecretId: '42', version: 1, deadline: Date.now() + 86_400_000 }],
      pendingAutoVerification: { version: 1, startedAt: 0, reportBy: 60_000, channelIds: ['901', '902'], notReachedChannelIds: [] },
    })
    r.resumeVerifications()

    expect(r.finishAutoVerification(59_000)).toBeNull()
    // The run still in its window holds the next one back.
    expect(await r.runScheduledVerification(5 * 60_000)).toBeNull()

    const result = r.finishAutoVerification(60_000)
    expect(result?.passed).toBe(false)
    expect(result?.summary).toContain('Helper 2 did not answer within 60 s')
    expect(r.state().secret.pendingVerifications?.map(v => v.channelId)).toContain('902')
  })

  it('reports a run that could not start as a failure', async () => {
    const { r, d } = runtime()
    d.notify.alert = vi.fn()
    vi.spyOn(r, 'verifyShares').mockRejectedValue(new Error('No participant confirmed v1'))
    r.setVerificationSchedule({ every: 1, unit: 'minutes' }, 0)

    await r.runScheduledVerification(60_000)

    expect(r.state().secret.lastAutoVerification).toMatchObject({ passed: false, summary: 'It could not start: No participant confirmed v1' })
    expect(d.notify.alert).toHaveBeenCalled()
    expect(r.state().secret.notifications?.[0].severity).toBe('critical')
  })

  it('skips a version restored from recovery, which cannot be verified', async () => {
    const restored = { ...bagAt(1, [s1]), currentVersion: { ...bagAt(1, [s1]).currentVersion, restoredFromRecovery: true } }
    const { r } = runtime({ itemBag: restored })
    const verify = vi.spyOn(r, 'verifyShares').mockResolvedValue({ failedChannelIds: [] })
    r.setVerificationSchedule({ every: 1, unit: 'minutes' }, 0)

    expect(await r.runScheduledVerification(60_000)).toBeNull()
    expect(verify).not.toHaveBeenCalled()
  })
})
