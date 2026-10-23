// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import { vault } from '../vault/testVault'
import {
  DEFAULT_RETAINED_VERSIONS,
  defaultWeightFor,
  publishPolicyProblems,
  resolvePublishPolicy,
  withGroupThreshold,
  type PublishPolicy,
} from './publishPolicy'

describe('resolvePublishPolicy', () => {
  it('reads a vault saved before the policy existed as today\'s behaviour', () => {
    const policy = resolvePublishPolicy(vault({ minParticipants: 3 }))

    expect(policy).toEqual({
      defaultThreshold: 3,
      defaultWeights: {},
      helperRetention: { mode: 'lastN', n: DEFAULT_RETAINED_VERSIONS },
      proofCleanup: { mode: 'manual' },
    })
    expect(DEFAULT_RETAINED_VERSIONS).toBe(3)
  })

  it('keeps what the vault saved', () => {
    const saved: PublishPolicy = {
      defaultThreshold: 4,
      defaultWeights: { '901': 2 },
      helperRetention: { mode: 'select' },
      proofCleanup: { mode: 'auto', criterion: 'lastN', n: 2 },
    }

    expect(resolvePublishPolicy(vault({ publishPolicy: saved }))).toEqual(saved)
  })
})

describe('defaultWeightFor', () => {
  it('is 1 for a helper nobody weighted', () => {
    expect(defaultWeightFor(resolvePublishPolicy(vault()), '901')).toBe(1)
  })
})

describe('publishPolicyProblems', () => {
  const ok: PublishPolicy = {
    defaultThreshold: 2,
    defaultWeights: {},
    helperRetention: { mode: 'lastN', n: 3 },
    proofCleanup: { mode: 'manual' },
  }

  it('accepts a valid policy', () => {
    expect(publishPolicyProblems(ok)).toEqual({})
  })

  it('refuses a threshold one helper could meet alone', () => {
    expect(publishPolicyProblems({ ...ok, defaultThreshold: 1 }).defaultThreshold).toMatch(/at least 2/)
  })

  it('refuses keeping fewer than one version', () => {
    expect(publishPolicyProblems({ ...ok, helperRetention: { mode: 'lastN', n: 0 } }).retentionN).toMatch(/at least 1/)
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

  it('keeps the vault\'s own policy when the roster carries no threshold', () => {
    expect(withGroupThreshold(legacy, undefined)).toBeUndefined()
  })
})
