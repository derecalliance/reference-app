// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import { readResult } from './apiEnvelope'

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}

describe('readResult', () => {
  it('unwraps the envelope’s result', async () => {
    const body = { result: { channel_id: '7' }, timestamp: '2026-10-07T12:00:00.000Z', request_id: 'r' }
    expect(await readResult(json(body))).toEqual({ channel_id: '7' })
  })

  it('keeps a null result as null', async () => {
    expect(await readResult(json({ result: null, timestamp: 't' }))).toBeNull()
  })

  it('returns a body without a result whole, as a node from before the envelope answered', async () => {
    expect(await readResult(json({ messages: [] }))).toEqual({ messages: [] })
  })
})
