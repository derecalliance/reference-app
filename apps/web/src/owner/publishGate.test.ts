// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import type { PairedParticipant } from '../types'
import { publishReadiness } from './publishGate'
import type { PublishPolicy } from './publishPolicy'

function helper(n: number, weight?: number): PairedParticipant {
  return {
    id: `h${n}`,
    name: `Helper ${n}`,
    channelId: `90${n}`,
    transport: { protocol: 'https', uri: '' },
    secretShares: [],
    connectionStatus: 'paired',
    peerRole: 'helper',
    ...(weight !== undefined ? { weight } : {}),
  }
}

function policy(defaultThreshold: number, defaultWeights: Record<string, number> = {}): PublishPolicy {
  return { defaultThreshold, defaultWeights, helperRetention: { mode: 'latestCommitted' }, proofCleanup: { mode: 'manual' } }
}

describe('publishReadiness', () => {
  it('blocks with fewer than two helpers', () => {
    expect(publishReadiness([helper(1)], policy(2)).blocked).toMatch(/at least 2 paired participants \(currently 1\)/)
    expect(publishReadiness([], policy(3)).blocked).toMatch(/currently 0/)
  })

  it('blocks when the helpers fall short of the threshold — the dialogs can no longer lower it', () => {
    expect(publishReadiness([helper(1), helper(2)], policy(3)).blocked).toMatch(/2 subshares.*below the threshold of 3.*Channels tab/)
  })

  it('blocks when a weight reaches the threshold', () => {
    expect(publishReadiness([helper(1), helper(2)], policy(2, { '901': 2 })).blocked).toMatch(/1 helper weight is not valid.*Channels tab/)
  })

  it('reads a helper with no weight set from what the library last published', () => {
    expect(publishReadiness([helper(1, 2), helper(2)], policy(3)).blocked).toBeNull()
  })

  it('says nothing when the threshold and weights work', () => {
    expect(publishReadiness([helper(1), helper(2)], policy(3, { '901': 2 }))).toEqual({ blocked: null })
  })
})
