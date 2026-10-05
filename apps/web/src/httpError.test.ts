// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'
import { responseDetail, responseError } from './httpError'

function response(body: string, status: number, contentType = 'text/plain', statusText = '') {
  return new Response(body, { status, statusText, headers: { 'Content-Type': contentType } })
}

describe('responseDetail', () => {
  it('prefers the JSON `error` the backend answers with', async () => {
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
