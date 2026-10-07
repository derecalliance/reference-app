// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import { asNonOkStatus, isUnknownChannelError } from './channelErrors'

describe('channel error classification', () => {
  it('recognises an unknown-channel failure under the SDK 0.0.6 code and the old one', () => {
    const message = 'invalid input: unknown channel_id: no shared key or pairing secret found'
    expect(isUnknownChannelError({ code: 'invalid_input', category: 'input', message })).toBe(true)
    expect(isUnknownChannelError({ code: 'DEREC_ERROR', message })).toBe(true)
    // The code alone is not enough: plenty of input errors are not this one.
    expect(isUnknownChannelError({ code: 'invalid_input', message: 'something else' })).toBe(false)
  })

  it('reads a peer\'s non-OK status under either spelling of the code', () => {
    expect(asNonOkStatus({ code: 'non_ok_status', status: 10, memo: 'no' })).toEqual({
      status: 10,
      memo: 'no',
      channelId: undefined,
    })
    expect(asNonOkStatus({ code: 'NON_OK_STATUS', status: 13 })?.status).toBe(13)
    expect(asNonOkStatus({ code: 'invalid_input' })).toBeNull()
  })
})
