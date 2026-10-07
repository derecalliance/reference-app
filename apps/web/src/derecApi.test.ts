// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DeliveryError, NodeUnreachableError, pollMailbox, relayMessage, sendMessage } from './derecApi'

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}

/** The node's error envelope. */
function failure(code: string, message: string) {
  return { error: { code, message }, timestamp: '2026-10-07T12:00:00.000Z', request_id: 'req-1' }
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
    vi.stubGlobal('fetch', respond(409, failure('CONFLICT', 'gRPC is disabled on this node')))
    const refused = await relayMessage('grpc://h:1', new Uint8Array([1])).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(DeliveryError)
    expect((refused as DeliveryError).message).toMatch(/gRPC is disabled on this node/)
    expect((refused as DeliveryError).transient).toBe(false)

    vi.stubGlobal('fetch', respond(502, failure('BAD_GATEWAY', 'relay delivery failed: connection refused')))
    const failed = (await relayMessage('grpc://h:1', new Uint8Array([1])).catch((err: unknown) => err)) as DeliveryError
    expect(failed.transient).toBe(true)

    vi.stubGlobal('fetch', respond(503, failure('RELAY_DISABLED', 'relay disabled on this node')))
    const disabled = (await relayMessage('grpc://h:1', new Uint8Array([1])).catch((err: unknown) => err)) as DeliveryError
    expect(disabled.transient).toBe(false)
  })

  it('tells a switched-off relay from a full mailbox by code, not by wording', async () => {
    vi.stubGlobal('fetch', respond(503, failure('MAILBOX_FULL', 'the recipient’s mailbox is full; it is not disabled')))
    const full = (await relayMessage('grpc://h:1', new Uint8Array([1])).catch((err: unknown) => err)) as DeliveryError
    expect(full.transient).toBe(true)
  })

  it('still recognises a switched-off relay on a node from before the error codes', async () => {
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

describe('pollMailbox', () => {
  it('reports a node that did not answer at all as unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))

    const err = await pollMailbox('owner-uuid').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(NodeUnreachableError)
    expect((err as Error).message).toMatch(/could not be reached/)
  })

  it('reports a proxy answering for a node that is down as unreachable', async () => {
    vi.stubGlobal('fetch', respond(502, {}))

    expect(await pollMailbox('owner-uuid').catch((e: unknown) => e)).toBeInstanceOf(NodeUnreachableError)
  })

  it('keeps an answer from the node about this one mailbox as an ordinary error', async () => {
    // The node is up; it is this vault's actor it does not know.
    vi.stubGlobal('fetch', respond(404, { error: 'actor not found' }))

    const err = await pollMailbox('owner-uuid').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(NodeUnreachableError)
    expect((err as Error).message).toMatch(/actor not found/)
  })
})
