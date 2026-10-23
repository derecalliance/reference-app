// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import type { BagVersion } from '../types'
import { recoverability } from './recoverability'

function version(overrides: Partial<BagVersion>): BagVersion {
  return {
    version: 5,
    participantIds: ['h1', 'h2', 'h3'],
    verifiedParticipantIds: [],
    failedParticipantIds: [],
    secrets: [],
    rawBytes: '',
    helpers: [],
    ...overrides,
  }
}

describe('recoverability', () => {
  it('is recoverable when the verified helpers hold the threshold between them', () => {
    expect(
      recoverability(version({ verifiedParticipantIds: ['h1', 'h2'], verifiedSubshares: { h1: 2, h2: 2 }, verifiedThreshold: 3 })),
    ).toEqual({ kind: 'recoverable', verified: 4, threshold: 3 })
  })

  it('is short when they do not', () => {
    expect(
      recoverability(version({ verifiedParticipantIds: ['h1'], verifiedSubshares: { h1: 2 }, verifiedThreshold: 3 })),
    ).toEqual({ kind: 'short', verified: 2, threshold: 3 })
  })

  it('is unknown when any count or the threshold was not recorded — never guessed as 1', () => {
    expect(
      recoverability(version({ verifiedParticipantIds: ['h1', 'h2'], verifiedSubshares: { h1: 2, h2: null }, verifiedThreshold: 3 }))?.kind,
    ).toBe('unknown')
    expect(
      recoverability(version({ verifiedParticipantIds: ['h1'], verifiedSubshares: { h1: 2 }, verifiedThreshold: null }))?.kind,
    ).toBe('unknown')
  })

  it('says nothing before any helper verified', () => {
    expect(recoverability(version({}))).toBeNull()
  })
})
