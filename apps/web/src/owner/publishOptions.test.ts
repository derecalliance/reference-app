// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import type { PairedParticipant } from '../types'
import { initialPublishOptions, publishOptionsProblems, toPublishChoice } from './publishOptions'
import type { PublishPolicy } from './publishPolicy'

function helper(n: number): PairedParticipant {
  return {
    id: `h${n}`,
    name: `Helper ${n}`,
    channelId: `90${n}`,
    transport: { protocol: 'https', uri: '' },
    secretShares: [],
    connectionStatus: 'paired',
    peerRole: 'helper',
  }
}

const helpers = [helper(1), helper(2), helper(3)]

const policy: PublishPolicy = {
  defaultThreshold: 3,
  defaultWeights: { '901': 2 },
  helperRetention: { mode: 'lastN', n: 3 },
  proofCleanup: { mode: 'manual' },
}

describe('initialPublishOptions', () => {
  it('starts from the vault defaults: weights, threshold, and no version dropped', () => {
    expect(initialPublishOptions(helpers, policy)).toEqual({
      weights: { '901': '2', '902': '1', '903': '1' },
      threshold: '3',
      dropped: [],
      rememberThreshold: false,
    })
  })
})

describe('a helper with no default of its own (review I2)', () => {
  it('starts from the weight the library last published for it, so a publish never resets it', () => {
    // After a restore or a join, the library stores the roster's weights and
    // the participant row carries them; the vault has set no defaults yet.
    const restored = { ...helper(2), weight: 2 }
    const draft = initialPublishOptions([helper(1), restored], { ...policy, defaultWeights: {} })

    expect(draft.weights).toEqual({ '901': '1', '902': '2' })
  })
})

describe('publishOptionsProblems', () => {
  it('accepts the defaults', () => {
    expect(publishOptionsProblems(initialPublishOptions(helpers, policy), helpers)).toEqual({ weights: {} })
  })

  it('refuses a weight that reaches the threshold', () => {
    const draft = { ...initialPublishOptions(helpers, policy), weights: { '901': '3', '902': '1', '903': '1' } }

    expect(publishOptionsProblems(draft, helpers).weights['901']).toMatch(/below the threshold/)
  })

  it('refuses weights that together fall short of the threshold', () => {
    const draft = { ...initialPublishOptions(helpers, policy), threshold: '5' }

    expect(publishOptionsProblems(draft, helpers).total).toMatch(/4 subshares.*below the threshold of 5/)
  })

  it('refuses a threshold below 2', () => {
    const draft = { ...initialPublishOptions(helpers, policy), threshold: '1' }

    expect(publishOptionsProblems(draft, helpers).threshold).toMatch(/at least 2/)
  })
})

describe('toPublishChoice', () => {
  it('sends every helper\'s weight as the full assignment, and no selection under "keep the last N"', () => {
    const choice = toPublishChoice(initialPublishOptions(helpers, policy), helpers, policy, [4])

    expect(choice).toEqual({
      weights: new Map([
        ['901', 2],
        ['902', 1],
        ['903', 1],
      ]),
      threshold: 3,
      keep: null,
      rememberThreshold: false,
    })
  })

  it('sends the selection in "choose at each publish" mode', () => {
    const select: PublishPolicy = { ...policy, helperRetention: { mode: 'select' } }
    const draft = { ...initialPublishOptions(helpers, select), dropped: [3] }

    expect(toPublishChoice(draft, helpers, select, [4, 3])?.keep).toEqual([4])
  })

  it('keeps a version that committed while the dialog was open (review M2)', () => {
    const select: PublishPolicy = { ...policy, helperRetention: { mode: 'select' } }
    const draft = { ...initialPublishOptions(helpers, select), dropped: [3] }

    // v5 committed after the dialog opened: nobody unchecked it.
    expect(toPublishChoice(draft, helpers, select, [5, 4, 3])?.keep).toEqual([5, 4])
  })

  it('remembers the threshold only when it changed', () => {
    const draft = { ...initialPublishOptions(helpers, policy), rememberThreshold: true }

    expect(toPublishChoice(draft, helpers, policy, [])?.rememberThreshold).toBe(false)
    expect(toPublishChoice({ ...draft, threshold: '2', weights: { '901': '1', '902': '1', '903': '1' } }, helpers, policy, [])?.rememberThreshold).toBe(true)
  })

  it('is null while anything is invalid', () => {
    expect(toPublishChoice({ ...initialPublishOptions(helpers, policy), threshold: '1' }, helpers, policy, [])).toBeNull()
  })
})
