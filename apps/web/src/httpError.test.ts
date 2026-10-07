// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'
import { ApiRequestError, readResponseDetail, responseDetail, responseError } from './httpError'

function response(body: string, status: number, contentType = 'text/plain', statusText = '') {
  return new Response(body, { status, statusText, headers: { 'Content-Type': contentType } })
}

describe('responseDetail', () => {
  it('prefers the message in the backend’s error envelope', async () => {
    const body = { error: { code: 'NOT_FOUND', message: 'claim_actor_id not found' }, timestamp: 't', request_id: 'r' }
    const res = response(JSON.stringify(body), 404, 'application/json')
    expect(await responseDetail(res)).toBe('claim_actor_id not found')
  })

  it('still reads the plain `{"error": "..."}` an older node answers with', async () => {
    const res = response(JSON.stringify({ error: 'claim_actor_id not found' }), 404, 'application/json')
    expect(await responseDetail(res)).toBe('claim_actor_id not found')
  })

  it('quotes a short plain-text rejection, as Axum extractors send', async () => {
    const res = response('Invalid URL: UUID parsing failed', 422)
    expect(await responseDetail(res)).toBe('Invalid URL: UUID parsing failed')
  })

  it('explains the status when the body is empty', async () => {
    expect(await responseDetail(response('', 422, 'text/plain', 'Unprocessable Entity'))).toBe(
      'the server could not understand the request (HTTP 422 Unprocessable Entity)',
    )
  })

  it('ignores an HTML page and JSON without an `error`', async () => {
    expect(await responseDetail(response('<html>Bad gateway</html>', 502))).toMatch(/proxy/)
    expect(await responseDetail(response('{"detail":"x"}', 500))).toMatch(/internal error/)
  })

  it('falls back to the bare status for one it has no words for', async () => {
    expect(await responseDetail(response('', 418))).toBe('the server answered HTTP 418')
  })
})

describe('responseError', () => {
  it('leads with what was being attempted', async () => {
    const err = await responseError(response('{"error":"name is empty"}', 400), 'Could not register the owner')
    expect(err.message).toBe('Could not register the owner: name is empty')
  })
})

describe('readResponseDetail', () => {
  it('carries the envelope’s code and request id for callers to branch on and quote', async () => {
    const body = { error: { code: 'RELAY_DISABLED', message: 'relay disabled on this node' }, request_id: 'req-9' }
    const detail = await readResponseDetail(response(JSON.stringify(body), 503, 'application/json'))
    expect(detail).toEqual({ message: 'relay disabled on this node', code: 'RELAY_DISABLED', requestId: 'req-9' })
  })

  it('falls back to the response header for the request id', async () => {
    const res = new Response('', { status: 500, headers: { 'x-request-id': 'req-7' } })
    expect((await readResponseDetail(res)).requestId).toBe('req-7')
  })

  it('has no code for a body that is not the envelope', async () => {
    const detail = await readResponseDetail(response(JSON.stringify({ error: 'old' }), 400, 'application/json'))
    expect(detail.code).toBeUndefined()
  })
})

describe('ApiRequestError', () => {
  it('keeps the status and code beside the message', async () => {
    const body = { error: { code: 'NAME_TAKEN', message: 'a helper named "Alex" already exists' } }
    const err = await responseError(response(JSON.stringify(body), 409, 'application/json'), 'Could not add')
    expect(err).toBeInstanceOf(ApiRequestError)
    expect(err).toMatchObject({ status: 409, code: 'NAME_TAKEN' })
  })
})
