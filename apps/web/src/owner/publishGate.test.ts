// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import { publishReadiness } from './publishGate'

const one = { weight: 1 }

describe('publishReadiness (review I4)', () => {
  it('blocks only what no publish could satisfy: fewer than two helpers', () => {
    expect(publishReadiness([one], 2).blocked).toMatch(/at least 2 paired participants \(currently 1\)/)
    expect(publishReadiness([], 3).blocked).toMatch(/currently 0/)
  })

  it('lets two helpers publish under a default threshold they fall short of — the dialog can lower it', () => {
    const readiness = publishReadiness([one, one], 3)

    expect(readiness.blocked).toBeNull()
    expect(readiness.shortOfDefault).toMatch(/2 of the 3 subshares/)
  })

  it('says nothing when the defaults already work', () => {
    expect(publishReadiness([{ weight: 2 }, one], 3)).toEqual({ blocked: null, shortOfDefault: null })
  })
})
