// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiConfirmActorFingerprint, apiGetActors, apiGetServerDefaults, apiRegisterOwner } from './api'
import { FALLBACK_SERVER_DEFAULTS } from './config'

/** What `fetch` throws when it cannot open a connection at all. */
function connectionRefused() {
  return Promise.reject(new TypeError('Failed to fetch'))
}

/** A success in the node's envelope. */
function ok(result: unknown, status = 200) {
  return jsonResponse({ result, timestamp: '2026-10-07T12:00:00.000Z', request_id: 'req-1' }, status)
}

/** A failure in the node's error envelope. */
function failure(status: number, code: string, message: string) {
  return jsonResponse(
    { error: { code, message }, timestamp: '2026-10-07T12:00:00.000Z', request_id: 'req-1' },
    status,
  )
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

describe('api — unreachable backend', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(connectionRefused))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // "Failed to fetch" is the browser's words and names nothing the reader can
  // act on. The one thing they need is which address is unreachable.
  it('names the unreachable server instead of surfacing "Failed to fetch"', async () => {
    await expect(apiRegisterOwner('Alice')).rejects.toThrow(/localhost:5000/)
    await expect(apiRegisterOwner('Alice')).rejects.not.toThrow(/^Failed to fetch$/)
  })

  it('keeps the original failure as the cause', async () => {
    // The friendly message replaces the browser's, so the original has to stay
    // reachable or the actual network error is lost.
    const err = await apiRegisterOwner('Alice').catch((e: unknown) => e)

    expect((err as Error).cause).toBeInstanceOf(TypeError)
  })

  it('reports the server as unreachable when defaults cannot be fetched', async () => {
    // The wizard needs this to warn *before* the user fills in three steps.
    const result = await apiGetServerDefaults()

    expect(result.reachable).toBe(false)
    expect(result.fromServer).toBe(false)
    expect(result.defaults).toEqual(FALLBACK_SERVER_DEFAULTS)
  })
})

describe('api — reachable backend', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports the server as reachable and uses its defaults', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => ok({ participant_count: 4, protocol_timeout_secs: 99 })),
    )

    const result = await apiGetServerDefaults()

    expect(result.reachable).toBe(true)
    expect(result.fromServer).toBe(true)
    expect(result.defaults.participantCount).toBe(4)
    expect(result.defaults.protocolTimeoutSecs).toBe(99)
  })

  it('treats a served error status as reachable, falling back on the values', async () => {
    // A 500 from /config means the server is up but could not answer. The
    // wizard should not claim it is unreachable — that would send the user
    // hunting for a process that is running fine.
    vi.stubGlobal('fetch', vi.fn(() => failure(500, 'INTERNAL_ERROR', 'boom')))

    const result = await apiGetServerDefaults()

    expect(result.reachable).toBe(true)
    expect(result.fromServer).toBe(false)
    expect(result.defaults).toEqual(FALLBACK_SERVER_DEFAULTS)
  })

  it('surfaces the server’s own error message and code for a failed request', async () => {
    vi.stubGlobal('fetch', vi.fn(() => failure(404, 'NOT_FOUND', 'claim_actor_id not found')))

    const err = await apiRegisterOwner('Alice', 'nope').catch((e: unknown) => e)

    expect((err as Error).message).toBe('Could not register the owner: claim_actor_id not found')
    expect(err).toMatchObject({ status: 404, code: 'NOT_FOUND', requestId: 'req-1' })
  })

  it('calls the versioned API and hands back the result alone', async () => {
    const fetchMock = vi.fn(() => ok({ actors: [{ id: 'a1' }] }))
    vi.stubGlobal('fetch', fetchMock)

    const actors = await apiGetActors()

    expect(actors).toEqual([{ id: 'a1' }])
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('http://localhost:5000/api/v1/actors')
  })

  it('reads a mismatched fingerprint as an answer, by its code', async () => {
    vi.stubGlobal('fetch', vi.fn(() => failure(400, 'FINGERPRINT_MISMATCH', 'fingerprint mismatch')))

    await expect(apiConfirmActorFingerprint('a1', '7', '1234')).resolves.toBe(false)
  })

  it('still throws any other refusal of a fingerprint', async () => {
    vi.stubGlobal('fetch', vi.fn(() => failure(400, 'BAD_REQUEST', 'channel_id is not a number')))

    await expect(apiConfirmActorFingerprint('a1', 'x', '1234')).rejects.toThrow('channel_id is not a number')
  })

  it('confirms a matching fingerprint from the result', async () => {
    vi.stubGlobal('fetch', vi.fn(() => ok({ confirmed: true })))

    await expect(apiConfirmActorFingerprint('a1', '7', '1234')).resolves.toBe(true)
  })
})

describe('api — rejected requests', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('never surfaces a bare status code for a malformed claim', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('', { status: 422, statusText: 'Unprocessable Entity' }))),
    )

    const err = (await apiRegisterOwner('Alice', 'nope').catch((e: unknown) => e)) as Error

    expect(err.message).not.toMatch(/failed: 422$/)
    expect(err.message).toMatch(/^Could not register the owner: the server could not understand/)
  })
})
