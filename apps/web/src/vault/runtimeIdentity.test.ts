// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { FlowKind } from '@derec-alliance/web'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BEActorWithStatus } from '../api'
import { VaultRuntime } from './runtime'
import { deps, stubInstance, vault } from './testVault'

const alex = {
  id: 'h1',
  name: 'Alex',
  channelId: '7',
  transport: { protocol: 'https' as const, uri: 'http://localhost:5000/derec/h1' },
  secretShares: [],
  connectionStatus: 'paired' as const,
}

function self(uri: string): BEActorWithStatus {
  return {
    id: 'v1',
    role: 'owner',
    name: 'Crypto Seeds',
    transport: { protocol: 'https', uri },
    transports: [{ protocol: 'https', uri }],
    secret_id: '42',
    browser_managed: true,
  }
}

function running(protocolOverrides: Record<string, unknown> = {}) {
  const renameOwner = vi.fn(async (_id: string, name: string) => ({ kind: 'renamed' as const, name }))
  const d = deps({ io: { postBrowserContact: async () => {}, renameOwner } })
  const r = new VaultRuntime(vault({ participants: [alex] }), d)
  const protocol = {
    setCommunicationInfo: vi.fn(async () => {}),
    setOwnTransports: vi.fn(async () => {}),
    start: vi.fn(async () => [{ type: 'UpdateChannelInfoFailed', channel_id: '7', error: 'unreachable' }]),
    createContact: async () => {
      throw new Error('not modelled')
    },
    ...protocolOverrides,
  }
  stubInstance(r, protocol)
  return { r, d, protocol, renameOwner }
}

afterEach(() => vi.useRealTimers())

describe('re-sending an identity update', () => {
  it('re-announces on Save when the last update did not reach a peer, though nothing changed', async () => {
    const { r, protocol } = running()
    await r.updateIdentity({ name: 'Family Vault', endpoint: null })
    expect(r.state().identityUpdate?.channels['7'].outcome).toBe('failed')

    protocol.start.mockResolvedValueOnce([{ type: 'UpdateChannelInfoStarted', channel_id: '7', trace_id: 't' }] as never)
    const update = await r.updateIdentity({ name: 'Family Vault', endpoint: null })

    // Targeted at the unreached peer, carrying the same name as before.
    expect(protocol.start).toHaveBeenLastCalledWith(FlowKind.UpdateChannelInfo, {
      target: [7n],
      communication_info: { name: 'Family Vault' },
    })
    expect(update?.channels['7'].outcome).toBe('pending')
  })

  it('still says "nothing changed" when every peer got the last update', async () => {
    const { r, protocol } = running({
      start: vi.fn(async () => [{ type: 'UpdateChannelInfoStarted', channel_id: '7', trace_id: 't' }]),
    })
    await r.updateIdentity({ name: 'Family Vault', endpoint: null })
    protocol.start.mockClear()

    await expect(r.updateIdentity({ name: 'Family Vault', endpoint: null })).resolves.toBeNull()
    expect(protocol.start).not.toHaveBeenCalled()
  })

  it('counts dispatched and failed sends separately in the console', async () => {
    const { r, d } = running()
    await r.updateIdentity({ name: 'Family Vault', endpoint: null })

    expect(d.log).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 'identity_updated',
        description: expect.stringContaining('Sent to 0 paired peer(s); 1 could not be reached.'),
      }),
    )
  })

  it('marks a peer silent past the protocol timeout as "no answer"', async () => {
    vi.useFakeTimers()
    const { r } = running({
      start: vi.fn(async () => [{ type: 'UpdateChannelInfoStarted', channel_id: '7', trace_id: 't' }]),
    })
    await r.updateIdentity({ name: 'Family Vault', endpoint: null })
    expect(r.state().identityUpdate?.channels['7'].outcome).toBe('pending')

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)

    expect(r.state().identityUpdate?.channels['7'].outcome).toBe('no-answer')
  })
})

describe('committing an identity update', () => {
  it('merges onto the record as it is after the announcement, not a stale snapshot', async () => {
    let commitDuringAwait: (() => void) | null = null
    const { r } = running({
      start: vi.fn(async () => {
        commitDuringAwait?.()
        return [{ type: 'UpdateChannelInfoStarted', channel_id: '7', trace_id: 't' }]
      }),
    })
    // Something else commits while the announcement is in flight — a roster
    // tick, or the announcement's own fold.
    commitDuringAwait = () => r.commit({ ...r.state().vault, minParticipants: 9 })

    await r.updateIdentity({ name: 'Family Vault', endpoint: null })

    expect(r.state().vault).toMatchObject({ name: 'Family Vault', minParticipants: 9 })
  })

  it('renames the vault on the node after a successful rename, and only then', async () => {
    const { r, renameOwner } = running({
      start: vi.fn(async () => [{ type: 'UpdateChannelInfoStarted', channel_id: '7', trace_id: 't' }]),
    })

    await r.updateIdentity({ name: 'Crypto Seeds', endpoint: 'https://relay.example/derec/v1' })
    expect(renameOwner).not.toHaveBeenCalled()

    await r.updateIdentity({ name: 'Family Vault', endpoint: 'https://relay.example/derec/v1' })
    await vi.waitFor(() => expect(renameOwner).toHaveBeenCalledWith('v1', 'Family Vault'))
  })

  it('keeps the rename when the node cannot be renamed', async () => {
    const renameOwner = vi.fn(async () => {
      throw new Error('boom')
    })
    const d = deps({ io: { postBrowserContact: async () => {}, renameOwner } })
    const r = new VaultRuntime(vault(), d)
    stubInstance(r, {
      setCommunicationInfo: vi.fn(async () => {}),
      start: vi.fn(async () => []),
      createContact: async () => {
        throw new Error('not modelled')
      },
    })

    await r.updateIdentity({ name: 'Family Vault', endpoint: null })

    expect(r.state().vault.name).toBe('Family Vault')
    await vi.waitFor(() =>
      expect(d.log).toHaveBeenCalledWith(expect.objectContaining({ step: 'owner_rename_on_node_failed' })),
    )
  })
})

describe('following the node’s address', () => {
  it('announces a move once, however many roster ticks land while it is in flight', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const start = vi.fn(async () => {
      await gate
      return [{ type: 'UpdateChannelInfoStarted', channel_id: '7', trace_id: 't' }]
    })
    const { r } = running({ start })

    r.applyRoster([self('http://127.0.0.1:5600/derec/v1')])
    r.applyRoster([self('http://127.0.0.1:5600/derec/v1')])
    // Even a *different* address waits for the move in flight.
    r.applyRoster([self('http://127.0.0.1:5700/derec/v1')])
    release()
    await vi.waitFor(() => expect(r.state().vault.transport.uri).toBe('http://127.0.0.1:5600/derec/v1'))

    expect(start).toHaveBeenCalledTimes(1)
  })

  it('retries peers the move did not reach on a later roster tick, a bounded number of times', async () => {
    vi.useFakeTimers()
    const { r, protocol } = running()

    r.applyRoster([self('http://127.0.0.1:5600/derec/v1')])
    await vi.waitFor(() => expect(r.state().vault.transport.uri).toBe('http://127.0.0.1:5600/derec/v1'))
    expect(protocol.start).toHaveBeenCalledTimes(1)

    // Too soon: nothing is resent before a protocol timeout has passed.
    r.applyRoster([self('http://127.0.0.1:5600/derec/v1')])
    expect(protocol.start).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
      r.applyRoster([self('http://127.0.0.1:5600/derec/v1')])
      await vi.advanceTimersByTimeAsync(0)
    }

    // The first send plus at most three retries.
    expect(protocol.start).toHaveBeenCalledTimes(4)
    expect(protocol.start).toHaveBeenLastCalledWith(FlowKind.UpdateChannelInfo, {
      target: [7n],
      own_transports: [{ uri: 'http://127.0.0.1:5600/derec/v1', protocol: 'https' }],
    })
  })
})
