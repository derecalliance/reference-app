// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@derec-alliance/web', () => ({
  envelope: {
    // The fake envelope is `[id, timestamp]`; anything else is not one.
    message_id: (bytes: Uint8Array) => {
      if (bytes.length !== 2) throw new Error('not an envelope')
      return { id: new Uint8Array([bytes[0]]), timestamp: BigInt(bytes[1]) }
    },
  },
}))

import { ReplayGuard } from './replayGuard'

describe('ReplayGuard', () => {
  let now = 100
  const guard = () => new ReplayGuard('ns', 30, () => now)

  beforeEach(() => {
    localStorage.clear()
    now = 100
  })

  it('recognises a copy of a message it remembered, across instances of the page', () => {
    guard().remember(new Uint8Array([7, 100]))
    expect(guard().isCopy(new Uint8Array([7, 100]))).toBe(true)
    expect(guard().isCopy(new Uint8Array([8, 100]))).toBe(false)
  })

  it('forgets an id once its window has passed, counted from the later of now and its timestamp', () => {
    guard().remember(new Uint8Array([7, 120]))
    now = 150
    expect(guard().isCopy(new Uint8Array([7, 120]))).toBe(true)
    now = 151
    expect(guard().isCopy(new Uint8Array([7, 120]))).toBe(false)
  })

  it('never takes bytes that are not an envelope for a copy', () => {
    guard().remember(new Uint8Array([1, 2, 3]))
    expect(guard().isCopy(new Uint8Array([1, 2, 3]))).toBe(false)
  })

  it('drops expired ids when it writes', () => {
    guard().remember(new Uint8Array([1, 100]))
    now = 200
    guard().remember(new Uint8Array([2, 200]))
    expect(Object.keys(JSON.parse(localStorage.getItem('ns:seen-message-ids') ?? '{}'))).toEqual(['02'])
  })
})
