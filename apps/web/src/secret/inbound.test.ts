// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { DeRecEvent } from '@derec-alliance/web'
import { describe, expect, it, vi } from 'vitest'

import { resolveSecretConfig } from '../protocolDefaults'
import type { SecretConfig } from '../types'
import { routeActionRequired, type InboundContext } from './inbound'
import { secret } from './testSecret'

type ActionRequired = Extract<DeRecEvent, { type: 'ActionRequired' }>

function request(kind: string, extra: Partial<ActionRequired> = {}): ActionRequired {
  return {
    type: 'ActionRequired',
    channel_id: '9',
    action: new Uint8Array([1]),
    action_kind: kind,
    ...extra,
  } as ActionRequired
}

/** The stock config with every auto-accept off, so each test opts in to what it checks. */
function config(overrides: Partial<SecretConfig> = {}): () => SecretConfig {
  const base = resolveSecretConfig({})
  return () => ({
    ...base,
    autoAcceptUnpairRequests: false,
    autoAcceptStoreShareRequests: false,
    autoAcceptVerifyShareRequests: false,
    ...overrides,
  })
}

function context(overrides: Partial<InboundContext> = {}): InboundContext {
  return {
    log: vi.fn(),
    raiseAttention: vi.fn(() => 'id'),
    config: config(),
    acceptAndFold: vi.fn(async (_action, current) => current),
    acceptStoreShare: vi.fn(async (_request, current) => current),
    ...overrides,
  }
}

describe('routeActionRequired', () => {
  it.each(['Pairing', 'StoreShare', 'VerifyShare', 'Unpair'])(
    'raises %s for the owner and holds back the rest of the batch',
    async kind => {
      const ctx = context()

      const outcome = await routeActionRequired(request(kind), secret(), ctx)

      expect(outcome.holdBack).toBe(true)
      expect(ctx.raiseAttention).toHaveBeenCalledTimes(1)
      expect(ctx.acceptAndFold).not.toHaveBeenCalled()
      expect(ctx.acceptStoreShare).not.toHaveBeenCalled()
    },
  )

  it.each(['PrePair', 'Discovery', 'GetShare', 'UpdateChannelInfo'])(
    'accepts %s without asking',
    async kind => {
      const ctx = context()

      const outcome = await routeActionRequired(request(kind), secret(), ctx)

      expect(outcome.holdBack).toBe(false)
      expect(ctx.acceptAndFold).toHaveBeenCalledTimes(1)
      expect(ctx.raiseAttention).not.toHaveBeenCalled()
    },
  )

  it('accepts a peer unpair outright when configured to', async () => {
    const ctx = context({ config: config({ autoAcceptUnpairRequests: true }) })

    const outcome = await routeActionRequired(request('Unpair'), secret(), ctx)

    expect(outcome.holdBack).toBe(false)
    expect(ctx.raiseAttention).not.toHaveBeenCalled()
  })

  it('stores a share outright when configured to, keeping its metadata', async () => {
    const ctx = context({ config: config({ autoAcceptStoreShareRequests: true }) })
    const event = request('StoreShare', {
      share_secret_id: '7',
      version: 3,
      share_description: 'Crypto Seeds',
    } as Partial<ActionRequired>)

    const outcome = await routeActionRequired(event, secret(), ctx)

    expect(outcome.holdBack).toBe(false)
    expect(ctx.raiseAttention).not.toHaveBeenCalled()
    expect(ctx.acceptStoreShare).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: '9', secretId: '7', version: 3, description: 'Crypto Seeds' }),
      expect.anything(),
    )
  })

  it('answers a verification outright when configured to', async () => {
    const ctx = context({ config: config({ autoAcceptVerifyShareRequests: true }) })

    const outcome = await routeActionRequired(request('VerifyShare'), secret(), ctx)

    expect(outcome.holdBack).toBe(false)
    expect(ctx.raiseAttention).not.toHaveBeenCalled()
    expect(ctx.acceptAndFold).toHaveBeenCalledTimes(1)
  })

  it('keeps each auto-accept to its own kind', async () => {
    // Auto-storing shares must not quietly answer verifications, or the reverse.
    const storeOnly = context({ config: config({ autoAcceptStoreShareRequests: true }) })
    const verifyOnly = context({ config: config({ autoAcceptVerifyShareRequests: true }) })

    expect((await routeActionRequired(request('VerifyShare'), secret(), storeOnly)).holdBack).toBe(true)
    expect((await routeActionRequired(request('StoreShare'), secret(), verifyOnly)).holdBack).toBe(true)
  })

  it('accepts a kind this build does not know, as before', async () => {
    const ctx = context()

    const outcome = await routeActionRequired(request('SomethingNew'), secret(), ctx)

    expect(outcome.holdBack).toBe(false)
    expect(ctx.acceptAndFold).toHaveBeenCalledTimes(1)
  })
})
