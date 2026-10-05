// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FALLBACK_SERVER_DEFAULTS } from '../../config'
import type { ProtocolInstance } from '../../owner/protocol'
import type { RecoveredSecret, Vault } from '../../types'
import { vault } from '../testVault'
import type { CommandContext } from './context'
import { restoreVault } from './restore'

const { buildProtocolInstance, apiGetActors } = vi.hoisted(() => ({
  buildProtocolInstance: vi.fn(),
  apiGetActors: vi.fn(),
}))

vi.mock('../../owner/protocol', async importOriginal => ({
  ...(await importOriginal<typeof import('../../owner/protocol')>()),
  buildProtocolInstance,
}))

vi.mock('../../api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api')>()),
  apiGetActors,
}))

const GRPC = 'grpc://localhost:50051'

/** A bag recovered from two gRPC-only helpers that share the node's one gRPC endpoint. */
const recovered: RecoveredSecret = {
  secretId: '77',
  version: 6,
  label: 'Crypto Seeds',
  snapshot: {
    helpers: [
      { channelId: '11', transports: [{ uri: GRPC, protocol: 'grpc' }], communicationInfo: { name: 'Alex' }, sharedKey: '' },
      { channelId: '22', transports: [{ uri: GRPC, protocol: 'grpc' }], communicationInfo: { name: 'Richard' }, sharedKey: '' },
    ],
    secrets: [{ id: 'AQID', name: 'Seed', data: 'b25lIHR3bw' }],
  },
}

function grpcHelper(id: string, name: string) {
  return {
    id,
    role: 'helper' as const,
    name,
    transport: { protocol: 'grpc' as const, uri: GRPC },
    transports: [{ protocol: 'grpc' as const, uri: GRPC }],
    secret_id: '1',
  }
}

function fakeInstance(): ProtocolInstance {
  return {
    secretId: '77',
    protocol: {
      restore: vi.fn(async () => []),
      setOwnTransports: vi.fn(async () => {}),
      setCommunicationInfo: vi.fn(async () => {}),
      start: vi.fn(async () => []),
    },
    channelStore: {},
    shareStore: {},
  } as unknown as ProtocolInstance
}

function context(current: Vault) {
  let record = current
  const ctx: CommandContext = {
    log: vi.fn(),
    notify: { error: vi.fn(), info: vi.fn(), outcome: vi.fn() },
    getVault: () => record,
    commit: vi.fn((next: Vault) => {
      record = next
    }),
    getServerDefaults: () => FALLBACK_SERVER_DEFAULTS,
    instance: () => null,
    withLock: fn => fn(),
    fold: c => c,
    adoptInstance: vi.fn(),
  }
  return { ctx, committed: () => record }
}

beforeEach(() => {
  buildProtocolInstance.mockReset()
  apiGetActors.mockReset()
})

describe('restoreVault', () => {
  it('installs the instance it restored into, so protect and verify work without a reload', async () => {
    const instance = fakeInstance()
    buildProtocolInstance.mockReturnValue(instance)
    apiGetActors.mockResolvedValue([])
    const { ctx, committed } = context(vault())

    await expect(restoreVault(recovered, ctx)).resolves.toBe(true)

    expect(ctx.adoptInstance).toHaveBeenCalledWith(instance)
    expect(committed().secretId).toBe('77')
    // The library writes no tracking shares on restore: the version says so.
    expect(committed().secretBag?.currentVersion.restoredFromRecovery).toBe(true)
  })

  it('re-identifies gRPC helpers sharing one endpoint as distinct actors', async () => {
    buildProtocolInstance.mockReturnValue(fakeInstance())
    apiGetActors.mockResolvedValue([grpcHelper('a1', 'Alex'), grpcHelper('r1', 'Richard')])
    const { ctx, committed } = context(vault())

    await restoreVault(recovered, ctx)

    expect(committed().participants.map(p => p.id)).toEqual(['a1', 'r1'])
    expect(committed().participants.map(p => p.transport)).toEqual([
      { protocol: 'grpc', uri: GRPC },
      { protocol: 'grpc', uri: GRPC },
    ])
  })

  it('keeps the channels the snapshot restores, retiring only the ones paired to recover', async () => {
    const instance = fakeInstance()
    buildProtocolInstance.mockReturnValue(instance)
    apiGetActors.mockResolvedValue([])
    // Restoring on the device that protected the bag: channels 11 and 22 are
    // the very ones the snapshot names. 33 was paired only to recover.
    const running = fakeInstance()
    const paired = (channelId: string) => ({
      id: `h${channelId}`,
      name: `Helper ${channelId}`,
      channelId,
      transport: { protocol: 'https' as const, uri: `http://localhost:5000/derec/h${channelId}` },
      secretShares: [],
      connectionStatus: 'paired' as const,
    })
    const { ctx } = context(vault({ participants: [paired('11'), paired('22'), paired('33')] }))
    ctx.instance = () => running

    await expect(restoreVault(recovered, ctx)).resolves.toBe(true)

    const unpaired = vi
      .mocked(running.protocol.start)
      .mock.calls.map(call => (call as unknown[])[1] as { channel_id: string })
      .map(params => params.channel_id)
    expect(unpaired).toEqual(['33'])
  })

  it('does not install anything when the restore itself fails', async () => {
    const instance = fakeInstance()
    vi.mocked(instance.protocol.restore).mockRejectedValue(new Error('ALREADY_RESTORED'))
    buildProtocolInstance.mockReturnValue(instance)
    const { ctx } = context(vault())

    await expect(restoreVault(recovered, ctx)).resolves.toBe(false)

    expect(ctx.adoptInstance).not.toHaveBeenCalled()
    expect(ctx.commit).not.toHaveBeenCalled()
  })
})
