// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import type { Item } from '../types'
import {
  conflictEntries,
  defaultResolution,
  isIdentical,
  mergedItems,
  replicaConflictBlockReason,
} from './replicaConflict'

const seed: Item = { id: 'aa', name: 'Seed', data: 'one two' }
const pin: Item = { id: 'bb', name: 'PIN', data: '1234' }
const fromSource: Item = { id: 'cc', name: 'FromSource', data: 'x' }
const fromDest: Item = { id: 'dd', name: 'FromDest', data: 'y' }

describe('merging two copies of a diverged secret', () => {
  it('lists every item either copy holds, once, this device’s first', () => {
    const entries = conflictEntries([seed, fromSource], [seed, fromDest])
    expect(entries.map(e => e.id)).toEqual(['aa', 'cc', 'dd'])
    expect(isIdentical(entries[0])).toBe(true)
    expect(entries[1]).toMatchObject({ theirs: null })
    expect(entries[2]).toMatchObject({ mine: null })
  })

  it('keeps everything by default, so the merge loses neither change', () => {
    const entries = conflictEntries([seed, fromSource], [seed, fromDest])
    expect(mergedItems(entries, {})).toEqual([seed, fromSource, fromDest])
  })

  it('defaults an item changed on both sides to this device’s, and lets the owner pick or drop', () => {
    const theirsPin = { ...pin, data: '9999' }
    const entries = conflictEntries([pin], [theirsPin])
    expect(isIdentical(entries[0])).toBe(false)
    expect(defaultResolution(entries[0])).toBe('mine')

    expect(mergedItems(entries, {})).toEqual([pin])
    expect(mergedItems(entries, { bb: 'theirs' })).toEqual([theirsPin])
    expect(mergedItems(entries, { bb: 'drop' })).toEqual([])
  })

  it('says why publishing is paused, naming the version', () => {
    const reason = replicaConflictBlockReason({
      version: 6,
      detectedVia: 'ReplicaSyncRejected',
      rivalReplicaId: '22',
      rivalItems: null,
      detectedAt: 0,
    })
    expect(reason).toMatch(/copy of v6 differs/)
    expect(reason).toMatch(/Publishing is paused/)
  })
})
