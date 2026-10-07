// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import { classifyShareFailure, lastDeliveryProblem, shareFailureLabel } from './shareFailure'

describe('classifyShareFailure', () => {
  it.each([
    [{ status: 10, memo: 'not today' }, 'rejected'],
    [{ status: 2, memo: 'timeout' }, 'no-answer'],
    [{ status: 0, memo: 'No answer before the round closed' }, 'no-answer'],
    [{ status: 2, memo: 'invalid input: transport.send promise rejected' }, 'unreachable'],
    [{ status: 8, memo: '' }, 'rejected'],
  ] as const)('%j is %s', (detail, kind) => {
    expect(classifyShareFailure(detail)).toBe(kind)
  })

  it('labels the same way everywhere', () => {
    expect(shareFailureLabel({ status: 2, memo: 'timeout' })).toBe('No answer')
    expect(shareFailureLabel({ status: 2, memo: 'transport.send failed' })).toBe('Not reachable')
    expect(shareFailureLabel({ status: 10, memo: '' })).toBe('Rejected')
  })
})

describe('lastDeliveryProblem', () => {
  it('flags only the newest share, and only a silence or failed send', () => {
    const timedOut = { version: 1, status: 'rejected' as const, verified: false, failure: { status: 2, memo: 'timeout' } }
    const confirmed = { version: 2, status: 'confirmed' as const, verified: false }
    const refused = { version: 3, status: 'rejected' as const, verified: false, failure: { status: 10, memo: '' } }

    expect(lastDeliveryProblem([timedOut])).toBe('no-answer')
    expect(lastDeliveryProblem([timedOut, confirmed])).toBeNull()
    expect(lastDeliveryProblem([timedOut, refused])).toBeNull()
    expect(lastDeliveryProblem([])).toBeNull()
  })
})
