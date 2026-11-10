// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import type { PairedParticipant } from '../types'
import type { PublishPolicy } from './publishPolicy'
import {
  hasNoSharingProblems,
  maxWeightFor,
  sharingProblems,
  sharingProblemSummary,
  sharingThreshold,
  sharingTotal,
  sharingWeights,
  thresholdFromPercent,
  thresholdOutcome,
  thresholdRaisedText,
  MAX_OFFERED_WEIGHT,
} from './sharingSettings'

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

const helpers = [helper(1), helper(2, 2), helper(3)]

describe('sharingWeights', () => {
  it('takes the weight set on the Channels tab, else the one the library last published', () => {
    expect([...sharingWeights(helpers, policy(3, { '901': 2 }))]).toEqual([
      ['901', 2],
      ['902', 2],
      ['903', 1],
    ])
    expect(sharingTotal(helpers, policy(3, { '901': 2 }))).toBe(5)
  })
})

describe('sharingProblems', () => {
  it('accepts a threshold the helpers can reach, with every weight below it', () => {
    expect(hasNoSharingProblems(sharingProblems(helpers, policy(3)))).toBe(true)
  })

  it('refuses a threshold below 2', () => {
    expect(sharingProblems(helpers, policy(1)).threshold).toMatch(/at least 2/)
  })

  it('refuses a weight that reaches the threshold, by channel', () => {
    expect(sharingProblems(helpers, policy(2)).weights).toEqual({ '902': expect.stringMatching(/below the threshold \(2\)/) })
  })

  it('refuses a threshold the helpers together fall short of', () => {
    expect(sharingProblems(helpers, policy(5)).total).toMatch(/4 subshares.*below the threshold of 5/)
  })

  it('has nothing to say with no helpers yet', () => {
    expect(hasNoSharingProblems(sharingProblems([], policy(3)))).toBe(true)
  })
})

describe('sharingProblemSummary', () => {
  it('points to the Channels tab', () => {
    expect(sharingProblemSummary(sharingProblems(helpers, policy(5)))).toMatch(/Channels tab$/)
    expect(sharingProblemSummary(sharingProblems(helpers, policy(2)))).toMatch(/1 helper weight is not valid.*Channels tab$/)
    expect(sharingProblemSummary(sharingProblems(helpers, policy(3)))).toBeNull()
  })
})

function percentPolicy(percent: number, defaultWeights: Record<string, number> = {}): PublishPolicy {
  return { ...policy(2, defaultWeights), thresholdMode: 'percent', thresholdPercent: percent }
}

describe('a percentage threshold', () => {
  it('rounds up, and never goes below 2', () => {
    expect(thresholdFromPercent(50, 4)).toBe(2)
    expect(thresholdFromPercent(50, 5)).toBe(3)
    expect(thresholdFromPercent(60, 5)).toBe(3)
    expect(thresholdFromPercent(67, 3)).toBe(3)
    expect(thresholdFromPercent(100, 6)).toBe(6)
    expect(thresholdFromPercent(10, 3)).toBe(2)
    expect(thresholdFromPercent(50, 0)).toBe(2)
  })

  it('counts subshares, weights included', () => {
    // 1 + 2 + 1 = 4 subshares; 60% of them is 3.
    expect(sharingThreshold(helpers, percentPolicy(60))).toBe(3)
    expect(thresholdOutcome(helpers, percentPolicy(60)).raised).toBeNull()
    expect(hasNoSharingProblems(sharingProblems(helpers, percentPolicy(60)))).toBe(true)
  })

  it('is at least the percentage, raised above the heaviest helper so none recovers alone', () => {
    // 50% of 4 is 2, which Helper 2 (weight 2) would reach alone: raised to 3.
    expect(sharingThreshold(helpers, percentPolicy(50))).toBe(3)
    expect(hasNoSharingProblems(sharingProblems(helpers, percentPolicy(50)))).toBe(true)

    const outcome = thresholdOutcome(helpers, percentPolicy(50))
    expect(outcome.raised).toEqual({ byPercent: 2, helper: 'Helper 2', weight: 2 })
    expect(thresholdRaisedText(outcome, 4)).toBe(
      '50% of 4 subshares would be 2, but Helper 2 holds 2 and could then recover alone. The threshold is ' +
        'raised to 3, one more than the heaviest helper: at least 50%, never letting one helper recover alone.',
    )
  })

  it('cannot be met by a lone helper, which would always recover alone', () => {
    // A lone helper: 50% of 3 is 2, raised to 4 — more than the 3 it holds.
    expect(sharingProblems([helper(1, 3)], percentPolicy(50)).total).toMatch(/below the threshold of 4/)
  })

  it('is fixed for a secret saved before percentages existed', () => {
    expect(sharingThreshold(helpers, policy(3))).toBe(3)
  })

  it('refuses a percentage outside 1 to 100', () => {
    expect(sharingProblems(helpers, percentPolicy(0)).threshold).toMatch(/from 1 to 100/)
    expect(sharingProblems(helpers, percentPolicy(101)).threshold).toMatch(/from 1 to 100/)
  })

  it('leaves weights uncapped while another helper holds a subshare too', () => {
    const four = [helper(1), helper(2), helper(3), helper(4)]
    expect(maxWeightFor(four, percentPolicy(60), '901')).toBe(MAX_OFFERED_WEIGHT)
    // Weight 9 against three at 1: 12 subshares, 60% is 8, raised to 10.
    expect(hasNoSharingProblems(sharingProblems(four, percentPolicy(60, { '901': 9 })))).toBe(true)
    expect(sharingThreshold(four, percentPolicy(60, { '901': 9 }))).toBe(10)
  })

  it('caps a weight just below a fixed threshold', () => {
    expect(maxWeightFor(helpers, policy(4), '901')).toBe(3)
  })
})
