// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * Shared fixtures for the secret-engine specs.
 *
 * One place so every spec agrees on what a secret looks like, and so a new field
 * on `Secret` is added once rather than in each file.
 */

import { vi } from 'vitest'

import { toBase64Url } from '../derecApi'
import type { ProtocolInstance } from '../owner/protocol'
import type { Secret } from '../types'
import type { SecretRuntime } from './runtime'
import type { SecretRuntimeDeps } from './types'
import { ChannelUpdateClock } from './channelUpdates'
import { ReplayGuard } from './replayGuard'

export function secret(overrides: Partial<Secret> = {}): Secret {
  return {
    id: 'v1',
    name: 'Crypto Seeds',
    secretId: '42',
    transport: { protocol: 'https', uri: 'http://localhost:5000/derec/v1' },
    participants: [],
    itemBag: null,
    pendingPairings: [],
    minParticipants: 3,
    recommendedParticipants: 5,
    recoveredSecrets: [],
    recoveryProgress: null,
    recoveryFailures: [],
    heldShares: [],
    mainChannels: [],
    configOverrides: {},
    ...overrides,
  }
}

export function deps(overrides: Partial<SecretRuntimeDeps> = {}): SecretRuntimeDeps {
  return {
    log: vi.fn(),
    notify: { error: vi.fn(), info: vi.fn(), outcome: vi.fn() },
    onSecretChange: vi.fn(),
    ...overrides,
  }
}

/**
 * Give a runtime a fake protocol so specs can drive it with no WASM.
 *
 * Goes through the documented `__setInstanceForTest` seam rather than casting
 * the runtime at each call site.
 */
export function stubInstance(
  runtime: SecretRuntime,
  protocol: Record<string, unknown>,
): void {
  // The engine reads which channels are paired from the library's own store,
  // as the real one does; a fake protocol writes none, so the secret's paired
  // rows are seeded there.
  const { secret: record } = runtime.state()
  for (const p of record.participants) {
    if (p.connectionStatus === 'paired' && p.channelId) {
      seedHelperChannel(record.id, '42', p.channelId, 'Paired', p.peerRole === 'owner' ? 'Owner' : 'Helper')
    }
  }
  runtime.__setInstanceForTest({
    secretId: '42',
    protocol,
    channelStore: {},
    shareStore: {},
    replayGuard: new ReplayGuard('test', 30),
    channelUpdates: new ChannelUpdateClock('test', '42'),
  } as unknown as ProtocolInstance)
}

/**
 * Write a helper-type channel record into the library's store layout, as the
 * library would — for specs whose fake protocol writes nothing.
 */
export function seedHelperChannel(
  localSecretId: string,
  secretId: string,
  channelId: string,
  status: 'Pending' | 'Paired' | 'Unpairing' = 'Paired',
  peerRole: 'Helper' | 'Owner' = 'Helper',
  createdAtSecs = Math.floor(Date.now() / 1000),
): void {
  const partition = `derec:secret:${localSecretId}:${secretId}`
  const record = `{"Helper":{"schema_version":3,"channel_id":${channelId},"transports":[{"uri":"http://localhost:5000/derec/x","protocol":0}],"communication_info":{},"peer_role":"${peerRole}","status":"${status}","created_at":${createdAtSecs}}}`
  localStorage.setItem(`${partition}:channel:helper:${channelId}`, toBase64Url(new TextEncoder().encode(record)))
  const indexKey = `${partition}:channel-idx:helper`
  const index = JSON.parse(localStorage.getItem(indexKey) ?? '[]') as string[]
  if (!index.includes(channelId)) localStorage.setItem(indexKey, JSON.stringify([...index, channelId]))
}
