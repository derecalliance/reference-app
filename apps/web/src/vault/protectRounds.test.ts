// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { DeRecEvent } from '@derec-alliance/web'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { toBase64Url } from '../derecApi'
import { PROTECT_ROUND_BACKSTOP_MS } from '../owner/protocol'
import type { PairedParticipant, SecretBag, UserSecret, Vault } from '../types'
import { VaultRuntime } from './runtime'
import { deps, stubInstance, vault } from './testVault'

/**
 * Protect rounds that overlap, finish out of order, outlive the app's
 * watchdog, or end below threshold — driven through one runtime and its fold,
 * with a fake protocol standing in for WASM.
 */

const s1: UserSecret = { id: 'a1', name: 'S1', data: 'one' }

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

function bagAt(version: number, secrets: UserSecret[]): SecretBag {
  return {
    secretId: '42',
    threshold: 2,
    previousVersions: [],
    currentVersion: {
      version,
      participantIds: [],
      verifiedParticipantIds: [],
      failedParticipantIds: [],
      secrets,
      rawBytes: '',
      helpers: [],
    },
  }
}

function event(e: Record<string, unknown>): DeRecEvent {
  return e as unknown as DeRecEvent
}

/** A runtime over four helpers, threshold 2, with v1 = [S1] committed. */
function runtime(overrides: Partial<Vault> = {}) {
  // Reachable by fiat: the default probe would call a real node on port 5000,
  // which made these specs depend on whether one happened to be running.
  const d = deps({ io: { serverReachable: async () => true } })
  const r = new VaultRuntime(
    vault({
      minParticipants: 2,
      participants: [helper(1), helper(2), helper(3), helper(4)],
      secretBag: bagAt(1, [s1]),
      ...overrides,
    }),
    d,
  )
  // The library targets every paired helper channel, and says so per channel.
  let nextVersion = 2
  const start = vi.fn(async () => {
    const version = nextVersion++
    return r.state().vault.participants.map(p =>
      event({ type: 'ProtectSecretStarted', channel_id: p.channelId, version, trace_id: 't' }),
    )
  })
  stubInstance(r, { start })
  return { r, d, start }
}

/** Fold `events` in order and commit, as the drain does. */
function deliver(r: VaultRuntime, ...events: Record<string, unknown>[]): void {
  let next = r.state().vault
  for (const e of events) next = r.applyEvent(next, event(e))
  r.commit(next)
}

const confirmed = (version: number, channel: string) => ({ type: 'ShareConfirmed', channel_id: channel, version })
const complete = (version: number, thresholdMet: boolean) => ({
  type: 'SharingComplete',
  version,
  confirmed_count: thresholdMet ? 2 : 1,
  failed_count: thresholdMet ? 2 : 3,
  threshold_met: thresholdMet,
})

function secretNames(r: VaultRuntime): string[] {
  return r.state().vault.secretBag?.currentVersion.secrets.map(s => s.name) ?? []
}

function shareStatus(r: VaultRuntime, participantId: string, version: number): string | undefined {
  return r.state().vault.participants
    .find(p => p.id === participantId)
    ?.secretShares.find(s => s.version === version)?.status
}

afterEach(() => {
  vi.useRealTimers()
})

describe('a secret added while an earlier round is still open', () => {
  it('publishes the pending secret along with the new one', async () => {
    const { r, start } = runtime()

    await r.addSecret('S2', 'two')
    await r.addSecret('S3', 'three')

    const published = start.mock.calls.map(call => {
      const params = (call as unknown[])[1] as { secrets: { name: string }[] }
      return params.secrets.map(s => s.name)
    })
    expect(published).toEqual([
      ['S1', 'S2'],
      ['S1', 'S2', 'S3'],
    ])
  })

  it('commits both rounds whatever order they complete in', async () => {
    const { r } = runtime()
    await r.addSecret('S2', 'two')
    await r.addSecret('S3', 'three')

    deliver(r, confirmed(3, '901'), confirmed(3, '902'), complete(3, true))
    expect(secretNames(r)).toEqual(['S1', 'S2', 'S3'])

    // v2 finishing last is history; it must not roll the bag back to itself.
    deliver(r, confirmed(2, '901'), confirmed(2, '902'), complete(2, true))
    const bag = r.state().vault.secretBag
    expect(bag?.currentVersion.version).toBe(3)
    expect(secretNames(r)).toEqual(['S1', 'S2', 'S3'])
    expect(bag?.previousVersions.map(v => v.version)).toEqual([2, 1])
    expect(r.state().vault.pendingProtectRounds).toBeUndefined()
  })

  it('rolls back only the round that failed', async () => {
    const { r } = runtime()
    await r.addSecret('S2', 'two')
    await r.addSecret('S3', 'three')

    deliver(r, confirmed(2, '901'), complete(2, false))
    expect(r.state().vault.secretBag?.currentVersion.version).toBe(1)
    expect(r.state().vault.pendingProtectRounds?.map(round => round.version)).toEqual([3])

    deliver(r, confirmed(3, '901'), confirmed(3, '902'), complete(3, true))
    expect(r.state().vault.secretBag?.currentVersion.version).toBe(3)
    // S2 rode along in v3, so its own round failing did not lose it.
    expect(secretNames(r)).toEqual(['S1', 'S2', 'S3'])
    expect(r.state().vault.secretBag?.previousVersions.map(v => v.version)).toEqual([1])
  })

  it('persists every open round and resumes them all after a reload', async () => {
    const first = runtime()
    await first.r.addSecret('S2', 'two')
    await first.r.addSecret('S3', 'three')
    const saved = first.r.state().vault
    expect(saved.pendingProtectRounds?.map(round => round.version)).toEqual([2, 3])

    const { r } = runtime(saved)
    r.resumeProtectRound()
    expect(r.hasPendingRound(2)).toBe(true)
    expect(r.hasPendingRound(3)).toBe(true)
  })
})

describe('a round that outlives the app watchdog', () => {
  it('waits for the library rather than giving up first', async () => {
    vi.useFakeTimers()
    const { r } = runtime({ configOverrides: { protocolTimeoutSecs: 30 } })
    await r.addSecret('S2', 'two')

    vi.advanceTimersByTime(30_000)

    expect(r.hasPendingRound(2)).toBe(true)
    expect(PROTECT_ROUND_BACKSTOP_MS).toBeGreaterThan(60_000)
  })

  it('keeps a round that met its threshold, with its confirmations, and commits it when the library does', async () => {
    vi.useFakeTimers()
    const { r, d } = runtime()
    await r.addSecret('S2', 'two')
    deliver(r, confirmed(2, '901'), confirmed(2, '902'), confirmed(2, '903'))

    vi.advanceTimersByTime(PROTECT_ROUND_BACKSTOP_MS * 3)

    expect(d.notify.error).not.toHaveBeenCalled()
    expect(r.hasPendingRound(2)).toBe(true)
    expect(shareStatus(r, 'h3', 2)).toBe('confirmed')

    deliver(r, complete(2, true))
    expect(secretNames(r)).toEqual(['S1', 'S2'])
    // The helper that never answered is settled, and recorded on the version.
    expect(shareStatus(r, 'h4', 2)).toBe('rejected')
    expect(r.state().vault.secretBag?.currentVersion.failedParticipantIds.map(f => f.id)).toEqual(['h4'])
  })

  it('rolls a round below threshold back, settling the unanswered rows instead of erasing the answered ones', async () => {
    vi.useFakeTimers()
    const { r, d } = runtime({ configOverrides: { protocolTimeoutSecs: 30 } })
    await r.addSecret('S2', 'two')
    deliver(r, confirmed(2, '901'))

    vi.advanceTimersByTime(PROTECT_ROUND_BACKSTOP_MS)

    expect(r.hasPendingRound(2)).toBe(false)
    expect(d.notify.error).toHaveBeenCalledWith(expect.stringContaining('rolled back'), undefined, expect.anything())
    expect(shareStatus(r, 'h1', 2)).toBe('confirmed')
    expect(shareStatus(r, 'h2', 2)).toBe('rejected')
    expect(r.state().vault.secretBag?.currentVersion.version).toBe(1)
  })
})

describe('a round the library closes below threshold', () => {
  it('ends with every row resolved, so the progress view reaches its rollback banner', async () => {
    const { r } = runtime()
    await r.addSecret('S2', 'two')
    deliver(r, confirmed(2, '901'))

    deliver(r, complete(2, false))

    expect(['h1', 'h2', 'h3', 'h4'].map(id => shareStatus(r, id, 2))).toEqual([
      'confirmed',
      'rejected',
      'rejected',
      'rejected',
    ])
    expect(r.state().vault.secretBag?.currentVersion.version).toBe(1)
    expect(r.state().vault.pendingProtectRounds).toBeUndefined()
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

    const round = await r.addSecret('S2', 'two')

    expect(round).toEqual({ version: 2, recipientIds: ['h1', 'h2', 'h3'], threshold: 2 })
    expect(shareStatus(r, 'h4', 2)).toBeUndefined()

    deliver(r, confirmed(2, '901'), confirmed(2, '902'), confirmed(2, '903'), complete(2, true))

    const committed = r.state().vault.secretBag?.currentVersion
    expect(committed?.version).toBe(2)
    expect(committed?.failedParticipantIds).toEqual([])
    expect(committed?.helpers.map(h => h.id)).toEqual(['h1', 'h2', 'h3'])
    expect(shareStatus(r, 'h4', 2)).toBeUndefined()
  })
})

describe('a vault whose replica group does not list this device', () => {
  afterEach(() => localStorage.clear())

  it('refuses to publish, saying why and what to do, before the library is asked', async () => {
    // The group as the library stores it for vault v1 / secret 42: one member,
    // and not this device (whose id is pinned to 5555).
    localStorage.setItem('derec:replica-id:v1', '5555')
    localStorage.setItem('derec:vault:v1:42:channel-idx:replica', JSON.stringify(['1001']))
    localStorage.setItem(
      'derec:vault:v1:42:channel:replica:1001',
      toBase64Url(new TextEncoder().encode(JSON.stringify({ Replica: { channel_id: 700, role: 'Source', status: 'Paired' } }))),
    )
    const { r, start } = runtime()

    await expect(r.addSecret('S2', 'two')).rejects.toThrow(/does not list this device.*Recover from bag/s)
    expect(start).not.toHaveBeenCalled()
  })
})

describe('publishing a restored bag', () => {
  it('sends the snapshot’s base64url ids as the bytes they encode, not as garbled hex', async () => {
    // `AQID` is base64url for [1, 2, 3].
    const { r, start } = runtime({ secretBag: bagAt(1, [{ id: 'AQID', name: 'Restored', data: 'x' }]) })

    await r.addSecret('S2', 'two')

    const params = (start.mock.calls[0] as unknown[])[1] as { secrets: { id: Uint8Array }[] }
    expect(Array.from(params.secrets[0].id)).toEqual([1, 2, 3])
  })
})

describe('verifying shares', () => {
  const withConfirmed = (overrides: Partial<SecretBag['currentVersion']> = {}): SecretBag => {
    const bag = bagAt(1, [s1])
    return { ...bag, currentVersion: { ...bag.currentVersion, participantIds: ['h1', 'h2'], ...overrides } }
  }

  it('explains, without dispatching, that a version restored from recovery cannot be verified', async () => {
    const { r, start } = runtime({ secretBag: withConfirmed({ restoredFromRecovery: true }) })

    await expect(r.verifyShares(1)).rejects.toThrow('restored from a recovered bag')
    expect(start).not.toHaveBeenCalled()
    expect(r.state().busy).toBe(false)
  })

  it('turns the library’s NoProof report on a version it no longer holds copies of into words (SDK 0.0.9)', async () => {
    const { r } = runtime({ secretBag: withConfirmed() })
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
    const { r } = runtime({ secretBag: withConfirmed() })
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
    expect(r.state().vault.pendingProtectRounds?.[0]).toMatchObject({ threshold: 3 })
    expect(r.state().vault.pendingProtectRounds?.[0].bag.currentVersion.threshold).toBe(3)
  })

  it('always names a threshold, so the app and the library agree on it', async () => {
    const { r, start } = runtime()

    await r.protect([s1])

    expect(start).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ threshold: 2 }))
  })

  it('keeps a round open that met the vault setting but not its own threshold', async () => {
    const { r } = runtime()
    const round = await r.protect([s1], { threshold: 3 })
    const version = round!.version

    // Every helper answers: 2 confirmations meet the vault's 2, not the round's 3.
    const rejected = (channel: string) => ({ type: 'ShareRejected', channel_id: channel, version, status: 10, memo: 'no' })
    deliver(r, confirmed(version, '901'), confirmed(version, '902'), rejected('903'), rejected('904'))

    expect(r.state().vault.secretBag?.currentVersion.version).toBe(1)
  })
})

describe('the publish policy (owner settings)', () => {
  it('splits at the policy\'s default threshold when the publish names none', async () => {
    const { r, start } = runtime()
    r.updatePublishPolicy({
      defaultThreshold: 3,
      defaultWeights: {},
      helperRetention: { mode: 'lastN', n: 3 },
      proofCleanup: { mode: 'manual' },
    })

    await r.protect([s1])

    expect(start).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ threshold: 3 }))
    expect(r.state().vault.publishPolicy?.defaultThreshold).toBe(3)
  })
})

describe('default helper weights', () => {
  it('records a helper\'s default weight, 1 included — it overrides the last published weight', () => {
    const { r } = runtime()

    r.setDefaultWeight('901', 2)
    expect(r.state().vault.publishPolicy?.defaultWeights).toEqual({ '901': 2 })

    r.setDefaultWeight('901', 1)
    expect(r.state().vault.publishPolicy?.defaultWeights).toEqual({ '901': 1 })
  })
})

describe('the versions helpers keep, chosen at publish', () => {
  /** A runtime whose fake `start` asks for the keep-list as the library does, mid-call. */
  function asking(overrides: Partial<Vault> = {}) {
    const harness = runtime(overrides)
    const asked: Array<number[] | null> = []
    const keepList = (harness.r as unknown as { keepList: (s: string, v: number) => number[] | null }).keepList
    const inner = harness.start.getMockImplementation()
    harness.start.mockImplementation(async () => {
      const events = await inner!()
      const version = (events[0] as { version: number }).version
      asked.push(keepList('42', version))
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

  it('sends exactly the versions the owner selected for that publish', async () => {
    const { r, asked } = asking({ publishPolicy: selectPolicy })

    await r.addSecret('S2', 'two', { weights: new Map(), threshold: 2, keep: [1], rememberThreshold: false })

    expect(asked).toEqual([[1]])
  })

  it('sends no list for a round with no selection, in select mode', async () => {
    const { r, asked } = asking({ publishPolicy: selectPolicy })

    await r.protect([s1])

    expect(asked).toEqual([null])
  })

  it('remembers a changed threshold only when the owner says so', async () => {
    const { r } = runtime()

    await r.addSecret('S2', 'two', { weights: new Map(), threshold: 3, keep: null, rememberThreshold: false })
    expect(r.state().vault.publishPolicy?.defaultThreshold ?? 2).toBe(2)

    await r.addSecret('S3', 'three', { weights: new Map(), threshold: 3, keep: null, rememberThreshold: true })
    expect(r.state().vault.publishPolicy?.defaultThreshold).toBe(3)
  })

  it('does not remember the threshold when the publish never went out (review M1)', async () => {
    const { r, start } = runtime()
    start.mockRejectedValueOnce(new Error('refused'))

    await r.addSecret('S2', 'two', { weights: new Map(), threshold: 3, keep: null, rememberThreshold: true }).catch(() => null)

    expect(r.state().vault.publishPolicy?.defaultThreshold ?? 2).toBe(2)
  })

  it('passes the dialog\'s weights as the full assignment', async () => {
    const { r, start } = runtime()

    await r.addSecret('S2', 'two', { weights: new Map([['901', 2]]), threshold: 3, keep: null, rememberThreshold: false })

    const params = (start.mock.calls[0] as unknown[])[1] as { weights: Map<string, number>; threshold: number }
    expect([...params.weights]).toEqual([['901', 2]])
    expect(params.threshold).toBe(3)
  })
})

describe('republish', () => {
  it('publishes the current secrets again with the dialog\'s choice', async () => {
    const { r, start } = runtime()

    const round = await r.republish({ weights: new Map([['902', 2]]), threshold: 3, keep: null, rememberThreshold: false })

    expect(round?.threshold).toBe(3)
    const params = (start.mock.calls[0] as unknown[])[1] as { secrets: unknown[]; weights: Map<string, number> }
    expect(params.secrets).toHaveLength(1)
    expect([...params.weights]).toEqual([['902', 2]])
  })
})

describe('publishContext', () => {
  it('gives the dialogs the policy, the committed versions newest first, and what "keep the last N" keeps', async () => {
    const { r } = runtime({
      secretBag: { ...bagAt(3, [s1]), previousVersions: [bagAt(2, [s1]).currentVersion, bagAt(1, [s1]).currentVersion] },
      publishPolicy: { defaultThreshold: 2, defaultWeights: {}, helperRetention: { mode: 'lastN', n: 2 }, proofCleanup: { mode: 'manual' } },
    })

    const context = r.publishContext()

    expect(context.committedVersions).toEqual([3, 2, 1])
    expect(context.preview).toEqual({ kept: [3, 2], dropped: [1] })
    expect(context.policy.helperRetention).toEqual({ mode: 'lastN', n: 2 })
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

  it('does not leave the vault busy after a scheduled run (review I1)', async () => {
    const { r } = runtime()
    // The real verifyShares marks the vault busy; a person closing the dialog
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
    const { r, d } = runtime({ secretBag: held })
    vi.spyOn(r, 'verifyShares').mockResolvedValue({ failedChannelIds: [] })
    r.setVerificationSchedule({ every: 1, unit: 'minutes' }, 0)

    await r.runScheduledVerification(60_000)

    expect(d.notify.info).toHaveBeenCalledWith('Automatic verification of v1 started: 2 helpers challenged')
    expect(r.state().vault.pendingAutoVerification).toMatchObject({ version: 1, channelIds: ['901', '902'] })

    // Both proofs land; the stubbed run opened no challenges, so it is settled.
    const bag = r.state().vault.secretBag!
    r.commit({
      ...r.state().vault,
      secretBag: { ...bag, currentVersion: { ...bag.currentVersion, verifiedParticipantIds: ['h1', 'h2'] } },
    })
    const result = r.finishAutoVerification(70_000)

    expect(result?.passed).toBe(true)
    expect(r.state().vault.pendingAutoVerification).toBeUndefined()
    expect(r.state().vault.lastAutoVerification).toMatchObject({ version: 1, passed: true, at: 70_000 })
    expect(r.state().vault.notifications?.map(n => [n.severity, n.title])).toEqual([
      ['info', 'Automatic verification of v1 passed'],
      ['info', 'Automatic verification of v1 started'],
    ])
  })

  it('raises a critical notification and an alert when a helper does not prove its share', async () => {
    const held = { ...bagAt(1, [s1]), currentVersion: { ...bagAt(1, [s1]).currentVersion, participantIds: ['h1', 'h2'] } }
    const { r, d } = runtime({ secretBag: held })
    d.notify.alert = vi.fn()
    vi.spyOn(r, 'verifyShares').mockResolvedValue({ failedChannelIds: ['902'] })
    r.setVerificationSchedule({ every: 1, unit: 'minutes' }, 0)

    await r.runScheduledVerification(60_000)
    const result = r.finishAutoVerification(70_000)

    expect(result?.passed).toBe(false)
    expect(result?.summary).toContain('Helper 1 did not answer')
    expect(result?.summary).toContain('Helper 2 could not be reached')
    expect(d.notify.alert).toHaveBeenCalledWith(expect.stringContaining('Automatic verification of v1 failed'))
    const [latest] = r.state().vault.notifications ?? []
    expect(latest).toMatchObject({ severity: 'critical', read: false, title: 'Automatic verification of v1 failed' })
  })

  it('reports a silent helper at the report deadline, while its challenge stays open', async () => {
    const held = { ...bagAt(1, [s1]), currentVersion: { ...bagAt(1, [s1]).currentVersion, participantIds: ['h1', 'h2'] } }
    const { r } = runtime({
      secretBag: { ...held, currentVersion: { ...held.currentVersion, verifiedParticipantIds: ['h1'] } },
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
    expect(r.state().vault.pendingVerifications?.map(v => v.channelId)).toContain('902')
  })

  it('reports a run that could not start as a failure', async () => {
    const { r, d } = runtime()
    d.notify.alert = vi.fn()
    vi.spyOn(r, 'verifyShares').mockRejectedValue(new Error('No participant confirmed v1'))
    r.setVerificationSchedule({ every: 1, unit: 'minutes' }, 0)

    await r.runScheduledVerification(60_000)

    expect(r.state().vault.lastAutoVerification).toMatchObject({ passed: false, summary: 'It could not start: No participant confirmed v1' })
    expect(d.notify.alert).toHaveBeenCalled()
    expect(r.state().vault.notifications?.[0].severity).toBe('critical')
  })

  it('skips a version restored from recovery, which cannot be verified', async () => {
    const restored = { ...bagAt(1, [s1]), currentVersion: { ...bagAt(1, [s1]).currentVersion, restoredFromRecovery: true } }
    const { r } = runtime({ secretBag: restored })
    const verify = vi.spyOn(r, 'verifyShares').mockResolvedValue({ failedChannelIds: [] })
    r.setVerificationSchedule({ every: 1, unit: 'minutes' }, 0)

    expect(await r.runScheduledVerification(60_000)).toBeNull()
    expect(verify).not.toHaveBeenCalled()
  })
})
