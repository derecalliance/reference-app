// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import type { PairedParticipant } from '../types'
import { roundProgress } from './roundProgress'

function participant(id: string, status?: 'pending' | 'confirmed' | 'rejected', version = 4): PairedParticipant {
  return {
    id,
    name: id.toUpperCase(),
    channelId: `9${id}`,
    transport: { protocol: 'https', uri: `http://localhost:5000/derec/${id}` },
    secretShares: status ? [{ version, status, verified: false }] : [],
    connectionStatus: 'paired',
  }
}

describe('roundProgress', () => {
  it('counts confirmations and rejections for the round it is given', () => {
    const progress = roundProgress(
      [participant('a', 'confirmed'), participant('b', 'rejected'), participant('c', 'pending')],
      ['a', 'b', 'c'],
      4,
    )

    expect(progress.confirmedCount).toBe(1)
    expect(progress.failedCount).toBe(1)
    expect(progress.allResolved).toBe(false)
    expect(progress.rows.map(r => r.name)).toEqual(['A', 'B', 'C'])
  })

  it('ignores answers filed against another version', () => {
    // A guessed version would read another round's confirmations as this one's.
    const progress = roundProgress([participant('a', 'confirmed', 3)], ['a'], 4)

    expect(progress.confirmedCount).toBe(0)
    expect(progress.allResolved).toBe(false)
  })

  it('is resolved once everyone has answered', () => {
    const progress = roundProgress([participant('a', 'confirmed'), participant('b', 'rejected')], ['a', 'b'], 4)

    expect(progress.allResolved).toBe(true)
  })

  it('names a participant that has since gone by its id', () => {
    expect(roundProgress([], ['gone'], 4).rows[0].name).toBe('gone')
  })
})

describe('roundProgress failure kinds', () => {
  function failed(id: string, status: number, memo: string): PairedParticipant {
    return {
      ...participant(id),
      secretShares: [{ version: 4, status: 'rejected', verified: false, failure: { status, memo } }],
    }
  }

  it('tells a refusal from a silence from a failed send', () => {
    const progress = roundProgress(
      [failed('a', 10, ''), failed('b', 2, 'timeout'), failed('c', 2, 'transport.send promise rejected')],
      ['a', 'b', 'c'],
      4,
    )

    expect(progress.rows.map(r => r.outcome)).toEqual(['rejected', 'no-answer', 'unreachable'])
    expect(progress.failedCount).toBe(3)
    expect(progress.allResolved).toBe(true)
  })

  it('calls a failure with no recorded detail a refusal, as it always was', () => {
    expect(roundProgress([participant('a', 'rejected')], ['a'], 4).rows[0].outcome).toBe('rejected')
  })
})
