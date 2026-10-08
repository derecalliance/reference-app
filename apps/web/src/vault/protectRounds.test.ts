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

    expect(round).toEqual({ version: 2, recipientIds: ['h1', 'h2', 'h3'] })
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

  it('turns the library’s missing-tracking-share refusal into the same explanation', async () => {
    const { r } = runtime({ secretBag: withConfirmed() })
    stubInstance(r, {
      start: async () => {
        throw new Error('invalid input: no committed share stored for this channel/version — cannot verify proof')
      },
    })

    await expect(r.verifyShares(1)).rejects.toThrow('Publish a new version')
    expect(r.state().busy).toBe(false)
  })

  it('reports the channels a challenge could not be sent on', async () => {
    const { r } = runtime({ secretBag: withConfirmed() })
    stubInstance(r, {
      start: async () => [
        event({ type: 'VerifySharesStarted', channel_id: '901', version: 1, trace_id: 't' }),
        event({ type: 'VerifySharesFailed', channel_id: '902', version: 1, error: 'unreachable' }),
      ],
    })

    await expect(r.verifyShares(1)).resolves.toEqual({ failedChannelIds: ['902'] })
  })
})
