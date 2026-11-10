// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import type { PairedParticipant } from '../types'
import { initialPublishOptions, toPublishChoice } from './publishOptions'
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
  helperRetention: { mode: 'latestCommitted' },
  proofCleanup: { mode: 'manual' },
}
const select: PublishPolicy = { ...policy, helperRetention: { mode: 'select' } }

describe('initialPublishOptions', () => {
  it('starts with the newest committed version kept', () => {
    expect(initialPublishOptions()).toEqual({ keep: null })
  })
})

describe('toPublishChoice', () => {
  it('sends no pick under "keep the newest committed version"', () => {
    expect(toPublishChoice({ keep: 3 }, helpers, policy)).toEqual({ keep: null })
  })

  it('sends the pick in "choose at each publish" mode', () => {
    expect(toPublishChoice({ keep: 3 }, helpers, select)?.keep).toBe(3)
    expect(toPublishChoice({ keep: 0 }, helpers, select)?.keep).toBe(0)
  })

  it('leaves an untouched pick to the newest committed version at publish time (review M2)', () => {
    expect(toPublishChoice(initialPublishOptions(), helpers, select)?.keep).toBeNull()
  })

  it('is null while the secret\'s threshold and weights would make the SDK refuse the round', () => {
    expect(toPublishChoice(initialPublishOptions(), helpers, { ...policy, defaultThreshold: 5 })).toBeNull()
    expect(toPublishChoice(initialPublishOptions(), helpers, { ...policy, defaultWeights: { '901': 3 } })).toBeNull()
  })
})
