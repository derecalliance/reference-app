// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import { cleanupCandidates } from './proofCleanup'

const usage = [4, 3, 2, 1].map(version => ({ version, copies: 2, bytes: 100 }))

describe('cleanupCandidates', () => {
  it('following what helpers keep, drops the versions outside the latest keep-list', () => {
    expect(cleanupCandidates(usage, { latest: 4, open: [] }, { kind: 'retention', keep: [3] })).toEqual([2, 1])
  })

  it('following what helpers keep with no list, keeps everything', () => {
    expect(cleanupCandidates(usage, { latest: 4, open: [] }, { kind: 'retention', keep: null })).toEqual([])
  })

  it('keeping the last N, keeps the N newest', () => {
    expect(cleanupCandidates(usage, { latest: 4, open: [] }, { kind: 'lastN', n: 2 })).toEqual([2, 1])
  })

  it('never offers the latest version or a round still open', () => {
    expect(cleanupCandidates(usage, { latest: 3, open: [4] }, { kind: 'lastN', n: 1 })).toEqual([2, 1])
    expect(cleanupCandidates(usage, { latest: 4, open: [] }, { kind: 'retention', keep: [] })).toEqual([3, 2, 1])
  })
})
