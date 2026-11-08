// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import { secret } from '../secret/testSecret'
import {
  defaultWeightFor,
  publishPolicyProblems,
  resolvePublishPolicy,
  withGroupThreshold,
  type PublishPolicy,
} from './publishPolicy'

describe('resolvePublishPolicy', () => {
  it('reads a secret saved before the policy existed as today\'s behaviour', () => {
    const policy = resolvePublishPolicy(secret({ minParticipants: 3 }))

    expect(policy).toEqual({
      defaultThreshold: 3,
      defaultWeights: {},
      helperRetention: { mode: 'latestCommitted' },
      proofCleanup: { mode: 'manual' },
    })
  })

  it('reads "keep the last N", saved before SDK 0.0.10, as "keep the newest committed version"', () => {
    const saved = {
      defaultThreshold: 4,
      defaultWeights: {},
      helperRetention: { mode: 'lastN', n: 3 },
      proofCleanup: { mode: 'manual' },
    }

    // A record written by an earlier build: its shape is no longer a valid type.
    const policy = resolvePublishPolicy(secret({ publishPolicy: saved as unknown as PublishPolicy }))

    expect(policy.helperRetention).toEqual({ mode: 'latestCommitted' })
    expect(policy.defaultThreshold).toBe(4)
  })

  it('keeps what the secret saved', () => {
    const saved: PublishPolicy = {
      defaultThreshold: 4,
      defaultWeights: { '901': 2 },
      helperRetention: { mode: 'select' },
      proofCleanup: { mode: 'auto', criterion: 'lastN', n: 2 },
    }

    expect(resolvePublishPolicy(secret({ publishPolicy: saved }))).toEqual(saved)
  })
})

describe('defaultWeightFor', () => {
  it('is 1 for a helper nobody weighted', () => {
    expect(defaultWeightFor(resolvePublishPolicy(secret()), '901')).toBe(1)
  })
})

describe('publishPolicyProblems', () => {
  const ok: PublishPolicy = {
    defaultThreshold: 2,
    defaultWeights: {},
    helperRetention: { mode: 'latestCommitted' },
    proofCleanup: { mode: 'manual' },
  }

  it('accepts a valid policy', () => {
    expect(publishPolicyProblems(ok)).toEqual({})
  })

  it('refuses keeping fewer than one verification copy', () => {
    expect(
      publishPolicyProblems({ ...ok, proofCleanup: { mode: 'auto', criterion: 'lastN', n: 0 } }).cleanupN,
    ).toMatch(/at least 1/)
  })
})

describe('withGroupThreshold (review I3)', () => {
  const legacy = { minParticipants: 2, publishPolicy: undefined }

  it('makes the group\'s threshold the one publish dialogs start from', () => {
    expect(withGroupThreshold(legacy, 3)?.defaultThreshold).toBe(3)
  })

  it('keeps the secret\'s own policy when the roster carries no threshold', () => {
    expect(withGroupThreshold(legacy, undefined)).toBeUndefined()
  })
})
