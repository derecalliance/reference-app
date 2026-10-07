// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import type { UserSecret } from '../types'
import {
  conflictEntries,
  defaultResolution,
  isIdentical,
  mergedSecrets,
  replicaConflictBlockReason,
} from './replicaConflict'

const seed: UserSecret = { id: 'aa', name: 'Seed', data: 'one two' }
const pin: UserSecret = { id: 'bb', name: 'PIN', data: '1234' }
const fromSource: UserSecret = { id: 'cc', name: 'FromSource', data: 'x' }
const fromDest: UserSecret = { id: 'dd', name: 'FromDest', data: 'y' }

describe('merging two copies of a diverged vault', () => {
  it('lists every secret either copy holds, once, this device’s first', () => {
    const entries = conflictEntries([seed, fromSource], [seed, fromDest])
    expect(entries.map(e => e.id)).toEqual(['aa', 'cc', 'dd'])
    expect(isIdentical(entries[0])).toBe(true)
    expect(entries[1]).toMatchObject({ theirs: null })
    expect(entries[2]).toMatchObject({ mine: null })
  })

  it('keeps everything by default, so the merge loses neither change', () => {
    const entries = conflictEntries([seed, fromSource], [seed, fromDest])
    expect(mergedSecrets(entries, {})).toEqual([seed, fromSource, fromDest])
  })

  it('defaults a secret changed on both sides to this device’s, and lets the owner pick or drop', () => {
    const theirsPin = { ...pin, data: '9999' }
    const entries = conflictEntries([pin], [theirsPin])
    expect(isIdentical(entries[0])).toBe(false)
    expect(defaultResolution(entries[0])).toBe('mine')

    expect(mergedSecrets(entries, {})).toEqual([pin])
    expect(mergedSecrets(entries, { bb: 'theirs' })).toEqual([theirsPin])
    expect(mergedSecrets(entries, { bb: 'drop' })).toEqual([])
  })

  it('says why publishing is paused, naming the version', () => {
    const reason = replicaConflictBlockReason({
      version: 6,
      detectedVia: 'ReplicaSyncRejected',
      rivalReplicaId: '22',
      rivalSecrets: null,
      detectedAt: 0,
    })
    expect(reason).toMatch(/copy of v6 differs/)
    expect(reason).toMatch(/Publishing is paused/)
  })
})
