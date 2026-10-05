// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'
import { effectiveRecommended } from './recommendedParticipants'

describe('effectiveRecommended', () => {
  it('keeps the configured recommendation when the pool can meet it', () => {
    expect(effectiveRecommended(5, 2, 7)).toBe(5)
  })

  it('caps it at a pool too small to meet it', () => {
    // The QA case: three helpers, five recommended.
    expect(effectiveRecommended(5, 2, 3)).toBe(3)
  })

  it('never drops below the minimum', () => {
    expect(effectiveRecommended(5, 3, 1)).toBe(3)
  })
})
