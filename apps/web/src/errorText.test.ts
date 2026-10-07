// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'
import { errorText } from './errorText'

describe('errorText', () => {
  it('reads an Error message', () => {
    expect(errorText(new Error('pairing timed out'))).toBe('pairing timed out')
  })

  it('passes a thrown string straight through', () => {
    expect(errorText('no usable endpoint')).toBe('no usable endpoint')
  })

  it('unwraps the plain objects the WASM bindings throw', () => {
    // The whole reason this exists: `String({...})` yields "[object Object]",
    // which is what every protocol failure used to show the user.
    expect(errorText({ code: 'NO_USABLE_ENDPOINT', message: 'peer offered nothing dialable' }))
      .toBe('peer offered nothing dialable (NO_USABLE_ENDPOINT)')
  })

  it('uses whichever of the message-ish keys is present', () => {
    expect(errorText({ error: 'relay disabled' })).toBe('relay disabled')
    expect(errorText({ detail: 'channel not found' })).toBe('channel not found')
  })

  it('falls back to the code when there is no prose', () => {
    expect(errorText({ code: 'INVALID_OWN_TRANSPORT' })).toBe('INVALID_OWN_TRANSPORT')
  })

  it('serialises an unrecognised object rather than hiding it', () => {
    // Still not pretty, but the answer is in there — which "[object Object]"
    // never was.
    expect(errorText({ status: 502, retries: 3 })).toBe('{"status":502,"retries":3}')
  })

  it('survives a circular object', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(() => errorText(circular)).not.toThrow()
    expect(errorText(circular)).toBe('[object Object]')
  })

  it('handles null and undefined without claiming an error message', () => {
    expect(errorText(null)).toBe('unknown error')
    expect(errorText(undefined)).toBe('unknown error')
  })

  it('ignores blank strings in message-ish keys', () => {
    // An empty `message` is worse than useless — it renders as nothing at all.
    expect(errorText({ message: '   ', code: 'TIMEOUT' })).toBe('TIMEOUT')
  })
})
