// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it, vi } from 'vitest'

import { SecretRuntime } from './runtime'
import { deps, stubInstance, secret } from './testSecret'

/** A paired helper, so the flows that ask paired helpers have one to ask. */
const alex = {
  id: 'h1',
  name: 'Alex',
  channelId: '7',
  transport: { protocol: 'https' as const, uri: 'http://localhost:5000/derec/h1' },
  secretShares: [],
  connectionStatus: 'paired' as const,
}

/** Deps whose server answers, so a failure is reported as the flow's own. */
function reachableDeps() {
  return deps({ io: { serverReachable: async () => true } })
}

describe('secret commands', () => {
  it('clears busy after a command fails to start', async () => {
    // A command that leaves busy set wedges every control on the page until the
    // watchdog fires.
    const r = new SecretRuntime(secret({ participants: [alex] }), reachableDeps())
    stubInstance(r, { start: async () => { throw new Error('nope') } })

    await expect(r.requestDiscovery()).rejects.toThrow('nope')

    expect(r.state().busy).toBe(false)
  })

  it('clears busy when a command fails before reaching the protocol', async () => {
    const r = new SecretRuntime(secret({ itemBag: null }), deps())
    stubInstance(r, { start: async () => [] })

    await expect(r.verifyShares(1)).rejects.toThrow('No item bag')

    expect(r.state().busy).toBe(false)
  })

  it('stays busy once a flow is dispatched, until its responses arrive', async () => {
    // Busy means "a flow is in flight", which is what keeps the fast poll
    // cadence and the watchdog running while helpers answer.
    const r = new SecretRuntime(secret({ participants: [alex] }), reachableDeps())
    stubInstance(r, { start: async () => [] })

    await r.requestDiscovery()

    expect(r.state().busy).toBe(true)
  })

  it('serialises two overlapping commands', async () => {
    const order: string[] = []
    const r = new SecretRuntime(secret({ participants: [alex] }), reachableDeps())
    stubInstance(r, {
      start: async () => {
        order.push('in')
        await new Promise(resolve => setTimeout(resolve, 5))
        order.push('out')
        return []
      },
    })

    await Promise.all([r.requestDiscovery(), r.requestDiscovery()])

    expect(order).toEqual(['in', 'out', 'in', 'out'])
  })

  it('refuses to protect a blocked secret', async () => {
    const r = new SecretRuntime(secret({ id: 'blocked' }), deps())
    stubInstance(r, { start: vi.fn() })
    r.block({ code: 'STORAGE', message: '', channelIds: [], wipeDidNotTake: false, text: 'x' })

    await expect(r.protect([])).rejects.toThrow('blocked')
    localStorage.clear()
  })

  it('records a pending pairing on the secret', () => {
    const d = deps()
    const r = new SecretRuntime(secret(), d)

    r.addPendingPairing(7n, 'h1')

    expect(r.state().secret.pendingPairings).toEqual([
      { channelId: 7n, participantId: 'h1', peerTransportUri: undefined },
    ])
    expect(d.onSecretChange).toHaveBeenCalledTimes(1)
  })
})

describe('deciding attention items', () => {
  const action = new Uint8Array([1])

  it('accepts a request, then clears it', async () => {
    const accept = vi.fn(async () => [])
    const r = new SecretRuntime(secret(), deps())
    stubInstance(r, { accept })
    const id = r.raiseAttention({
      kind: 'verify-share',
      blocksDrain: true,
      payload: { peerName: 'Alex', channelId: '9', version: 2, secretId: '42', action },
    })

    await r.acceptAttention(id)

    expect(accept).toHaveBeenCalledWith(action)
    expect(r.attention()).toEqual([])
  })

  it('records a held share with its metadata when storage is accepted', async () => {
    const r = new SecretRuntime(secret(), deps())
    stubInstance(r, { accept: async () => [] })
    const id = r.raiseAttention({
      kind: 'store-share',
      blocksDrain: true,
      payload: { peerName: 'Alex', channelId: '9', secretId: '5', version: 3, description: 'seed', action },
    })

    await r.acceptAttention(id)

    expect(r.state().secret.heldShares).toEqual([
      { channelId: '9', secretId: '5', version: 3, description: 'seed' },
    ])
  })

  it('rejects with the REJECTED status, then clears the item', async () => {
    const reject = vi.fn(async () => [])
    const r = new SecretRuntime(secret(), deps())
    stubInstance(r, { reject })
    const id = r.raiseAttention({
      kind: 'unpair',
      blocksDrain: true,
      payload: { peerName: 'Alex', channelId: '9', action },
    })

    await r.rejectAttention(id)

    expect(reject).toHaveBeenCalledWith(action, 10, 'Secret rejected the unpair request')
    expect(r.attention()).toEqual([])
  })

  it('leaves the item open when the secret has not started', async () => {
    // There is nothing to answer it with yet; clearing it would lose the request.
    const r = new SecretRuntime(secret(), deps())
    const id = r.raiseAttention({
      kind: 'unpair',
      blocksDrain: true,
      payload: { peerName: 'Alex', channelId: '9', action },
    })

    await r.acceptAttention(id)

    expect(r.attention()).toHaveLength(1)
  })

  it('dismisses an adoption offer without touching the protocol', async () => {
    const r = new SecretRuntime(secret(), deps())
    r.stageReplicaAdoption({
      channelId: '900',
      fromReplicaId: 'ff01',
      secretId: '99',
      version: 1,
      payload: { helpers: [], secrets: [] },
      shares: [],
    })

    await r.rejectAttention(r.attention()[0].id)

    expect(r.attention()).toEqual([])
  })
})
