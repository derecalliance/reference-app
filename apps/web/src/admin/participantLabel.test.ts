// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import { participantLabel } from './participantLabel'

describe('participantLabel', () => {
  const alex1 = { id: 'aaaaaaaa-1111', name: 'Alex' }
  const alex2 = { id: 'bbbbbbbb-2222', name: 'Alex' }
  const bob = { id: 'cccccccc-3333', name: 'Bob' }

  it('is just the name when it is unique', () => {
    expect(participantLabel(bob, [alex1, bob])).toBe('Bob')
  })

  it('adds a short id when another participant shares the name', () => {
    expect(participantLabel(alex1, [alex1, alex2, bob])).toBe('Alex (aaaaaaaa)')
    expect(participantLabel(alex2, [alex1, alex2, bob])).toBe('Alex (bbbbbbbb)')
  })
})
