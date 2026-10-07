// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import type { BagVersion, SecretBag, SecretShareRef } from '../types'
import { committedVersionsOf, heldShareCount } from './heldShares'

function version(n: number): BagVersion {
  return {
    version: n,
    participantIds: [],
    verifiedParticipantIds: [],
    failedParticipantIds: [],
    secrets: [],
    rawBytes: '',
    helpers: [],
  }
}

const shares: SecretShareRef[] = [
  { version: 1, status: 'confirmed', verified: false },
  { version: 2, status: 'rejected', verified: false },
  { version: 3, status: 'confirmed', verified: false },
  { version: 4, status: 'pending', verified: false },
]

describe('heldShareCount', () => {
  it('counts only confirmed shares of committed versions', () => {
    // v3 was confirmed by this helper, but its round was rolled back.
    expect(heldShareCount(shares, new Set([1, 2]))).toBe(1)
  })

  it('counts every confirmed share when the committed versions are unknown', () => {
    expect(heldShareCount(shares)).toBe(2)
  })
})

describe('committedVersionsOf', () => {
  it('is the current version and those kept behind it', () => {
    const bag = {
      secretId: '1',
      currentVersion: version(3),
      previousVersions: [version(2), version(1)],
      threshold: 2,
    } as SecretBag
    expect([...committedVersionsOf(bag)].sort()).toEqual([1, 2, 3])
    expect(committedVersionsOf(null).size).toBe(0)
  })
})
