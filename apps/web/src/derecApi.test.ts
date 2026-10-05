// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DeliveryError, relayMessage, sendMessage } from './derecApi'

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}

afterEach(() => vi.unstubAllGlobals())

describe('relayMessage', () => {
  it('names the vault it relays for, so the node can attribute the request', async () => {
    const fetchMock = respond(202, {})
    vi.stubGlobal('fetch', fetchMock)

    await relayMessage('grpc://helper:50051', new Uint8Array([1, 2]), 'owner-uuid')

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(init.body as string)).toMatchObject({ uri: 'grpc://helper:50051', actor_id: 'owner-uuid' })
  })

  it('passes the node’s refusal on in its own words, and only a delivery failure as worth resending', async () => {
    vi.stubGlobal('fetch', respond(409, { error: 'gRPC is disabled on this node' }))
    const refused = await relayMessage('grpc://h:1', new Uint8Array([1])).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(DeliveryError)
    expect((refused as DeliveryError).message).toMatch(/gRPC is disabled on this node/)
    expect((refused as DeliveryError).transient).toBe(false)

    vi.stubGlobal('fetch', respond(502, { error: 'relay delivery failed: connection refused' }))
    const failed = (await relayMessage('grpc://h:1', new Uint8Array([1])).catch((err: unknown) => err)) as DeliveryError
    expect(failed.transient).toBe(true)

    vi.stubGlobal('fetch', respond(503, { error: 'the relay is disabled (server.grpc_relay)' }))
    const disabled = (await relayMessage('grpc://h:1', new Uint8Array([1])).catch((err: unknown) => err)) as DeliveryError
    expect(disabled.transient).toBe(false)
  })
})

describe('sendMessage', () => {
  it('marks an endpoint that could not be reached at all as worth resending', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))

    const err = (await sendMessage('http://down:5000/derec/x', new Uint8Array([1])).catch((e: unknown) => e)) as DeliveryError

    expect(err.transient).toBe(true)
    expect(err.message).toMatch(/could not be reached/)
  })
})
