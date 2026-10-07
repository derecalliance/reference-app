// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import { FALLBACK_SERVER_DEFAULTS, type ServerDefaults } from '../config'
import {
  hasErrors,
  parseWholeNumber,
  thresholdError,
  validateDefaults,
} from './defaultsValidation'

function draft(overrides: Partial<ServerDefaults>): ServerDefaults {
  return { ...FALLBACK_SERVER_DEFAULTS, ...overrides }
}

describe('validateDefaults', () => {
  it('accepts the shipped defaults', () => {
    expect(hasErrors(validateDefaults(FALLBACK_SERVER_DEFAULTS))).toBe(false)
  })

  it('refuses a pool too small to hold a threshold of two', () => {
    expect(validateDefaults(draft({ participantCount: -3 })).participantCount).toBe('Must be at least 2')
    expect(validateDefaults(draft({ participantCount: 1 })).participantCount).toBe('Must be at least 2')
  })

  it('refuses a minimum of one: the library cannot split a secret with threshold 1', () => {
    expect(validateDefaults(draft({ minParticipants: 1 })).minParticipants).toBe('Must be at least 2')
  })

  it('refuses counts the node cannot hold (it stores them as u8)', () => {
    const errors = validateDefaults(
      draft({ participantCount: 256, recommendedParticipants: 300, prePairedCount: 999 }),
    )
    expect(errors.participantCount).toBe('Must be at most 255')
    expect(errors.recommendedParticipants).toBe('Must be at most 255')
    expect(errors.prePairedCount).toBe('Must be at most 255')
  })

  it('refuses a minimum larger than the pool', () => {
    expect(validateDefaults(draft({ minParticipants: 9 })).minParticipants).toBe(
      'Cannot exceed the pool of 7',
    )
  })

  it('refuses a recommendation below the minimum or above the pool', () => {
    expect(validateDefaults(draft({ recommendedParticipants: 1 })).recommendedParticipants).toBe(
      'Cannot be below the minimum of 3',
    )
    expect(validateDefaults(draft({ recommendedParticipants: 8 })).recommendedParticipants).toBe(
      'Cannot exceed the pool of 7',
    )
  })

  it('refuses a timeout too short for any flow to finish', () => {
    expect(validateDefaults(draft({ protocolTimeoutSecs: 0 })).protocolTimeoutSecs).toBe(
      'Must be at least 10',
    )
  })

  it('allows pre-pairing none, but not a negative count or more than the pool', () => {
    expect(validateDefaults(draft({ prePairedCount: 0 })).prePairedCount).toBeUndefined()
    expect(validateDefaults(draft({ prePairedCount: -1 })).prePairedCount).toBe('Must be at least 0')
    expect(validateDefaults(draft({ prePairedCount: 8 })).prePairedCount).toBe(
      'Cannot exceed the pool of 7',
    )
  })

  it('treats an emptied field as missing rather than as zero', () => {
    expect(validateDefaults(draft({ participantCount: Number.NaN })).participantCount).toBe(
      'Enter a whole number',
    )
  })

  it('requires the transport mix to add up to the pool', () => {
    expect(
      validateDefaults(draft({ helperTransports: { http: 3, grpc: 1, both: 1 } })).helperTransports,
    ).toBe('The three must add up to the pool of 7')
  })
})

describe('parseWholeNumber', () => {
  it('reads plain digits', () => {
    expect(parseWholeNumber(' 12 ')).toBe(12)
  })

  it.each(['1e3', '0x10', '1.5', '-2', '', '+3'])('refuses %j', text => {
    expect(parseWholeNumber(text)).toBeNaN()
  })
})

describe('thresholdError', () => {
  it('accepts 2 up to the pool', () => {
    expect(thresholdError(2, 3)).toBeNull()
    expect(thresholdError(3, 3)).toBeNull()
  })

  it('refuses 1, a fraction, and more than the pool', () => {
    expect(thresholdError(1)).toBe('Must be at least 2')
    expect(thresholdError(2.5)).toBe('Must be a whole number')
    expect(thresholdError(4, 3)).toBe('Cannot exceed the pool of 3')
  })
})
