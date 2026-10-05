// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { FlowKind, type DeRecEvent } from '@derec-alliance/web'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MAX_BAG_BYTES } from '../owner/secretLimits'
import type { BEActorWithStatus } from '../api'
import { listHelperChannels } from '../stores'
import type { PairedParticipant, SecretBag, Vault } from '../types'
import { VaultRuntime } from './runtime'
import { deps, seedHelperChannel, stubInstance, vault } from './testVault'

const { apiGetActors } = vi.hoisted(() => ({ apiGetActors: vi.fn(async (): Promise<BEActorWithStatus[]> => []) }))

vi.mock('../api', async importOriginal => ({
  ...(await importOriginal<typeof import('../api')>()),
  apiGetActors,
}))

/**
 * Engine behaviour around peers that are slow, gone or half-paired, and around
 * a browser that runs out of room — each driven through one runtime with a
 * fake protocol standing in for WASM.
 */

const NS_PREFIX = 'derec:vault:v1:42'

function helper(n: number, overrides: Partial<PairedParticipant> = {}): PairedParticipant {
  return {
    id: `h${n}`,
    name: `Helper ${n}`,
    channelId: `90${n}`,
    transport: { protocol: 'https', uri: `http://localhost:5000/derec/h${n}` },
    secretShares: [],
    connectionStatus: 'paired',
    peerRole: 'helper',
    ...overrides,
  }
}

function event(e: Record<string, unknown>): DeRecEvent {
  return e as unknown as DeRecEvent
}

function bagAt(version: number, participantIds: string[]): SecretBag {
  return {
    secretId: '42',
    threshold: 2,
    previousVersions: [],
    currentVersion: {
      version,
      participantIds,
      verifiedParticipantIds: [],
      failedParticipantIds: [],
      secrets: [{ id: 'a1', name: 'S1', data: 'one' }],
      rawBytes: '',
      helpers: [],
    },
  }
}

function running(record: Partial<Vault>, protocol: Record<string, unknown>, serverReachable = true) {
  const d = deps({ io: { serverReachable: async () => serverReachable, postBrowserContact: async () => {} } })
  const r = new VaultRuntime(vault(record), d)
  stubInstance(r, protocol)
  return { r, d }
}

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

describe('a pairing that cannot complete', () => {
  it('forgets the Pending channel a failed send left behind', async () => {
    const { r } = running({}, {
      start: async () => {
        // The library writes the channel, then the send fails.
        seedHelperChannel('v1', '42', '555', 'Pending')
        throw new Error('transport: no endpoint accepted the message')
      },
    })

    await expect(r.startPairing({} as never, 'owner', 'Alex')).rejects.toThrow('no endpoint accepted')

    expect(listHelperChannels('vault:v1', '42')).toEqual([])
  })

  it('sweeps a pairing this vault started once the peer can no longer answer', async () => {
    const longAgo = Math.floor(Date.now() / 1000) - 3600
    seedHelperChannel('v1', '42', '555', 'Pending', 'Helper', longAgo)
    // A completed NoKeys handshake also waits in Pending — but this vault did
    // not start it as a pairing still in flight, so it is not touched.
    seedHelperChannel('v1', '42', '777', 'Pending', 'Helper', longAgo)
    const { r } = running(
      { pendingPairings: [{ channelId: 555n, participantId: 'h1' }] },
      { tick: async () => [], removeExpiredChannels: async () => [] },
    )

    await r.tickOnce()

    expect(listHelperChannels('vault:v1', '42').map(c => c.channelId)).toEqual(['777'])
    expect(r.state().vault.pendingPairings).toEqual([])
  })

  it('leaves a pairing alone while its peer may still answer', async () => {
    seedHelperChannel('v1', '42', '555', 'Pending')
    const { r } = running(
      { pendingPairings: [{ channelId: 555n }] },
      { tick: async () => [], removeExpiredChannels: async () => [] },
    )

    await r.tickOnce()

    expect(listHelperChannels('vault:v1', '42').map(c => c.channelId)).toEqual(['555'])
  })
})

describe('broadcasts while a pairing is in progress', () => {
  it('announces an identity change to paired channels only', async () => {
    const start = vi.fn(async () => [event({ type: 'UpdateChannelInfoStarted', channel_id: '901', trace_id: 't' })])
    const { r } = running(
      { participants: [helper(1)] },
      { setCommunicationInfo: async () => {}, setOwnTransports: async () => {}, start, createContact: async () => ({}) },
    )
    seedHelperChannel('v1', '42', '555', 'Pending')

    await r.updateIdentity({ name: 'Family Vault', endpoint: 'https://relay.example/derec/v1' })

    expect(start).toHaveBeenCalledWith(FlowKind.UpdateChannelInfo, expect.objectContaining({ target: [901n] }))
  })

  it('asks paired helpers only, and marks one that could not be reached', async () => {
    const start = vi.fn(async () => [
      event({ type: 'DiscoveryStarted', channel_id: '901', trace_id: 't' }),
      event({ type: 'DiscoveryFailed', channel_id: '902', error: 'HTTP 404' }),
    ])
    const { r } = running({ participants: [helper(1), helper(2)] }, { start })
    seedHelperChannel('v1', '42', '555', 'Pending')

    await r.requestDiscovery()

    expect(start).toHaveBeenCalledWith(FlowKind.Discovery, { target: [901n, 902n] })
    const rows = r.state().vault.participants
    expect(rows.find(p => p.id === 'h2')?.discoveryError).toMatch(/HTTP 404/)
    expect(r.state().busy).toBe(true)
  })

  it('says the server is down rather than leaving every helper pending', async () => {
    const start = vi.fn(async () => [
      event({ type: 'DiscoveryFailed', channel_id: '901', error: 'fetch failed' }),
    ])
    const { r } = running({ participants: [helper(1)] }, { start }, false)

    await expect(r.requestDiscovery()).rejects.toThrow(/DeRec server cannot be reached/)
    expect(r.state().busy).toBe(false)
  })

  it('marks helpers that never answer once the flow times out', async () => {
    vi.useFakeTimers()
    const start = vi.fn(async () => [
      event({ type: 'DiscoveryStarted', channel_id: '901', trace_id: 't' }),
      event({ type: 'DiscoveryStarted', channel_id: '902', trace_id: 't' }),
    ])
    const answers = [[{ bytes: new Uint8Array([1]) }]]
    const d = deps({
      io: { serverReachable: async () => true, pollMailbox: async () => answers.shift() ?? [] },
    })
    const r = new VaultRuntime(
      vault({ participants: [helper(1), helper(2)], configOverrides: { protocolTimeoutSecs: 30 } }),
      d,
    )
    stubInstance(r, {
      start,
      process: async () => [event({ type: 'SecretsDiscovered', channel_id: '901', secrets: [] })],
    })
    await r.requestDiscovery()
    await r.drainOnce()
    // One answer is not the end of a discovery that asked two.
    expect(r.state().busy).toBe(true)

    vi.advanceTimersByTime(31_000)

    const rows = r.state().vault.participants
    expect(rows.find(p => p.id === 'h1')?.discoveryError).toBeUndefined()
    expect(rows.find(p => p.id === 'h2')?.discoveryError).toMatch(/No answer/)
  })
})

describe('verification answers that land after a reload', () => {
  it('still applies them', async () => {
    const participants = [helper(1, { secretShares: [{ version: 1, status: 'confirmed', verified: false }] })]
    const first = running(
      { participants, minParticipants: 1, secretBag: bagAt(1, ['h1']) },
      { start: async () => [event({ type: 'VerifySharesStarted', channel_id: '901', version: 1, trace_id: 't' })] },
    )
    await first.r.verifyShares(1)
    const saved = first.r.state().vault
    expect(saved.pendingVerifications?.map(v => v.channelId)).toEqual(['901'])

    // A fresh runtime over the saved record, as after a reload.
    const { r } = running(saved, {})
    r.resumeVerifications()
    r.commit(r.applyEvent(r.state().vault, event({ type: 'ShareVerified', channel_id: '901', version: 1 })))

    expect(r.state().vault.secretBag?.currentVersion.verifiedParticipantIds).toEqual(['h1'])
    expect(r.state().vault.pendingVerifications).toBeUndefined()
  })

  it('reports a holder no longer paired as not reached, without handing it to the library', async () => {
    const participants = [
      helper(1, { secretShares: [{ version: 1, status: 'confirmed', verified: false }] }),
      helper(2, { secretShares: [{ version: 1, status: 'confirmed', verified: false }] }),
    ]
    const start = vi.fn(async () => [event({ type: 'VerifySharesStarted', channel_id: '901', version: 1, trace_id: 't' })])
    const { r } = running({ participants, minParticipants: 1, secretBag: bagAt(1, ['h1', 'h2']) }, { start })
    // Helper 2's channel is gone from the library's store.
    localStorage.removeItem(`${NS_PREFIX}:channel:helper:902`)

    const dispatch = await r.verifyShares(1)

    expect(start).toHaveBeenCalledWith(FlowKind.VerifyShares, expect.objectContaining({ target: [901n] }))
    expect(dispatch.failedChannelIds).toEqual(['902'])
  })
})

describe('a request nobody answers', () => {
  it('is refused on the engine’s deadline, with no page attached', async () => {
    vi.useFakeTimers()
    const reject = vi.fn(async () => {})
    const { r } = running({ configOverrides: { protocolTimeoutSecs: 30 } }, { reject })
    r.raiseAttention({
      kind: 'store-share',
      blocksDrain: true,
      payload: { peerName: 'Bob', channelId: '901', secretId: '7', version: 2, description: '', action: new Uint8Array([1]) },
    })
    expect(r.drainPaused()).toBe(true)

    await vi.advanceTimersByTimeAsync(30_000)

    expect(reject).toHaveBeenCalledTimes(1)
    expect(r.attention()).toEqual([])
    expect(r.drainPaused()).toBe(false)
  })

  it('is not refused once answered', async () => {
    vi.useFakeTimers()
    const reject = vi.fn(async () => {})
    const { r } = running({ configOverrides: { protocolTimeoutSecs: 30 } }, { reject })
    const id = r.raiseAttention({
      kind: 'unpair',
      blocksDrain: true,
      payload: { peerName: 'Bob', channelId: '901', action: new Uint8Array([1]) },
    })
    r.resolveAttention(id)

    await vi.advanceTimersByTimeAsync(60_000)

    expect(reject).not.toHaveBeenCalled()
  })
})

describe('protecting', () => {
  it('refuses an oversized bag before anything is sent', async () => {
    const start = vi.fn()
    const { r } = running({ participants: [helper(1), helper(2)], minParticipants: 2 }, { start })

    await expect(r.addSecret('Big', 'x'.repeat(MAX_BAG_BYTES))).rejects.toThrow(/over the 32 KB/)

    expect(start).not.toHaveBeenCalled()
    expect(r.state().busy).toBe(false)
  })

  it('settles a share request that could not be delivered at once, and fails a round that cannot reach its threshold', async () => {
    const start = vi.fn(async () => [
      event({ type: 'ProtectSecretStarted', channel_id: '901', version: 2, trace_id: 't' }),
      event({ type: 'ProtectSecretFailed', channel_id: '902', version: 2, error: 'HTTP 404' }),
    ])
    const { r, d } = running({ participants: [helper(1), helper(2)], minParticipants: 2, secretBag: bagAt(1, []) }, { start })

    await r.addSecret('S2', 'two')

    const share = r.state().vault.participants.find(p => p.id === 'h2')?.secretShares.find(s => s.version === 2)
    expect(share).toMatchObject({ status: 'rejected', failure: { memo: expect.stringMatching(/transport\.send/) } })
    expect(r.hasPendingRound(2)).toBe(false)
    expect(d.notify.error).toHaveBeenCalledWith(expect.stringMatching(/did not reach its threshold/), undefined, expect.anything())
  })

  it('says why when no share request could be delivered', async () => {
    const start = vi.fn(async () => [
      event({ type: 'ProtectSecretFailed', channel_id: '901', version: 2, error: 'HTTP 502 relay off' }),
    ])
    const { r } = running({ participants: [helper(1)], minParticipants: 1 }, { start })

    await expect(r.addSecret('S1', 'one')).rejects.toThrow(/could be delivered.*HTTP 502 relay off/)
    expect(r.state().busy).toBe(false)
  })

  it('commits a round as soon as every helper answered, without waiting on a replica', async () => {
    const start = vi.fn(async () => [
      event({ type: 'ProtectSecretStarted', channel_id: '901', version: 2, trace_id: 't' }),
      event({ type: 'ProtectSecretStarted', channel_id: '902', version: 2, trace_id: 't' }),
    ])
    const { r } = running({ participants: [helper(1), helper(2)], minParticipants: 2, secretBag: bagAt(1, []) }, { start })
    await r.addSecret('S2', 'two')

    let next = r.state().vault
    next = r.applyEvent(next, event({ type: 'ShareConfirmed', channel_id: '901', version: 2 }))
    next = r.applyEvent(next, event({ type: 'ShareConfirmed', channel_id: '902', version: 2 }))
    r.commit(next)

    // No SharingComplete yet — the library still waits on its replica leg.
    expect(r.state().vault.secretBag?.currentVersion.version).toBe(2)
    expect(r.state().vault.pendingProtectRounds).toBeUndefined()

    // And the late SharingComplete commits nothing twice.
    r.commit(
      r.applyEvent(r.state().vault, event({ type: 'SharingComplete', version: 2, confirmed_count: 2, failed_count: 0, threshold_met: true })),
    )
    expect(r.state().vault.secretBag?.previousVersions.map(v => v.version)).toEqual([1])
  })
})

describe('a channel whose peer is gone', () => {
  it('can be forgotten on this device alone', async () => {
    const { r } = running(
      { participants: [helper(1), helper(2)], secretBag: bagAt(1, ['h1', 'h2']) },
      {},
    )
    localStorage.setItem(`${NS_PREFIX}:secret:902:0`, 'key')

    await r.forgetChannel('902')

    expect(r.state().vault.participants.map(p => p.id)).toEqual(['h1'])
    expect(r.state().vault.secretBag?.currentVersion.participantIds).toEqual(['h1'])
    expect(listHelperChannels('vault:v1', '42').map(c => c.channelId)).toEqual(['901'])
    expect(localStorage.getItem(`${NS_PREFIX}:secret:902:0`)).toBeNull()
  })

  it('returns why an unpair could not be sent', async () => {
    const { r } = running(
      { participants: [helper(1)] },
      { start: async () => { throw new Error('transport: no endpoint accepted the message (HTTP 404)') } },
    )

    const result = await r.unpair('901', 'Helper 1', 'h1')

    expect(result).toEqual({ dispatched: false, reason: expect.stringMatching(/HTTP 404/) })
  })
})

describe('recovering', () => {
  it('counts only the holders it asked, so the last answer can end the round', async () => {
    const start = vi.fn(async () => [
      event({ type: 'RecoverSecretStarted', channel_id: '901', version: 1, trace_id: 't' }),
      event({ type: 'RecoverSecretStarted', channel_id: '902', version: 1, trace_id: 't' }),
      event({ type: 'RecoverSecretStarted', channel_id: '903', version: 1, trace_id: 't' }),
    ])
    const { r } = running({ participants: [helper(1), helper(2), helper(3)] }, { start })

    await r.recover('42', 1, 'S', [901n, 902n])

    expect(r.state().vault.recoveryProgress?.totalRequested).toBe(2)
  })

  it('says the server is down rather than "insufficient shares"', async () => {
    const start = vi.fn(async () => [
      event({ type: 'RecoverSecretFailed', channel_id: '901', version: 1, error: 'fetch failed' }),
    ])
    const { r } = running({ participants: [helper(1)] }, { start }, false)

    await r.recover('42', 1, 'S', [901n])

    expect(r.state().vault.recoveryProgress?.error).toMatch(/DeRec server cannot be reached/)
    expect(r.state().busy).toBe(false)
  })
})

describe('Edit Identity on a vault that has not read the roster yet', () => {
  it('reads where the node lists this vault before deciding whether anything changed', async () => {
    const uri = 'http://192.168.0.28:8080/derec/v1'
    apiGetActors.mockResolvedValueOnce([
      {
        id: 'v1',
        role: 'owner',
        name: 'Crypto Seeds',
        transport: { protocol: 'https', uri },
        transports: [{ protocol: 'https', uri }],
        secret_id: '42',
        browser_managed: true,
      },
    ])
    const start = vi.fn(async () => [event({ type: 'UpdateChannelInfoStarted', channel_id: '901', trace_id: 't' })])
    const { r } = running(
      { participants: [helper(1)], ownTransportPinned: true },
      { setCommunicationInfo: async () => {}, setOwnTransports: async () => {}, start, createContact: async () => ({}) },
    )
    expect(r.nodeListingRead()).toBe(false)

    // Back to following the node, with no roster tick yet: not "nothing changed".
    const update = await r.updateIdentity({ name: 'Crypto Seeds', endpoint: null })

    expect(update).not.toBeNull()
    expect(r.state().vault.transport.uri).toBe(uri)
    expect(r.nodeListingRead()).toBe(true)
  })
})
