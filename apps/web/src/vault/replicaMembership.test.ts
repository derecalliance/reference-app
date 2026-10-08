// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import type { StoredReplicaMember } from '../stores'
import { replicaMembershipProblem } from './replicaMembership'

function member(replicaId: string): StoredReplicaMember {
  return { replicaId, channelId: '700', role: 'Destination', status: 'Paired', name: null }
}

describe('replicaMembershipProblem', () => {
  it('lets a vault with no replica group publish', () => {
    expect(replicaMembershipProblem([], '1001')).toBeNull()
  })

  it('lets a member of its group publish', () => {
    expect(replicaMembershipProblem([member('1001'), member('2002')], '1001')).toBeNull()
  })

  it('explains, with the way out, a group that does not list this device', () => {
    const problem = replicaMembershipProblem([member('1001'), member('2002')], '5555')
    expect(problem).toMatch(/does not list this device/)
    expect(problem).toMatch(/Recover from bag/)
  })
})
