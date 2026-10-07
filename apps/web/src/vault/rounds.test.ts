// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import type { BagVersion, PairedParticipant, SecretBag, UserSecret } from '../types'
import { RoundTracker, commitRoundVersion, settleUnansweredShares } from './rounds'

function bagVersion(version: number, secrets: UserSecret[] = []): BagVersion {
  return {
    version,
    participantIds: [],
    verifiedParticipantIds: [],
    failedParticipantIds: [],
    secrets,
    rawBytes: '',
    helpers: [],
  }
}

function bag(version: number, secrets: UserSecret[] = []): SecretBag {
  return { secretId: '42', threshold: 2, previousVersions: [], currentVersion: bagVersion(version, secrets) }
}

const s1: UserSecret = { id: 'a1', name: 'S1', data: 'one' }
const s2: UserSecret = { id: 'a2', name: 'S2', data: 'two' }
const s3: UserSecret = { id: 'a3', name: 'S3', data: 'three' }

function tracker(version = 3): RoundTracker {
  const t = new RoundTracker()
  t.beginProtectRound({ bag: bag(version), version, protocolSecretId: '42', channelIds: ['c1', 'c2', ''] })
  return t
}

describe('RoundTracker', () => {
  it('awaits a share on every channel the round dispatched to, and no other', () => {
    const t = tracker()

    expect(t.isAwaitingShare('c1')).toBe(true)
    expect(t.isAwaitingShare('c2')).toBe(true)
    // An empty channel id is a participant that was never paired.
    expect(t.isAwaitingShare('')).toBe(false)
  })

  it('records a confirmation on the staged bag of the same version only', () => {
    const t = tracker(3)

    t.recordShareConfirmed(4, 'p1')
    expect(t.pendingRound(3)?.bag.currentVersion.participantIds).toEqual([])

    t.recordShareConfirmed(3, 'p1')
    expect(t.pendingRound(3)?.bag.currentVersion.participantIds).toEqual(['p1'])
    expect(t.confirmedCount(3)).toBe(1)
  })

  it('lets only its own round consume the staged bag', () => {
    // Several rounds can be in flight; another's completion must not discard
    // a bag still waiting for its own.
    const t = tracker(3)

    expect(t.completeRound(4)).toBeNull()
    expect(t.hasPendingRound(3)).toBe(true)

    expect(t.completeRound(3)?.version).toBe(3)
    expect(t.hasPendingRound(3)).toBe(false)
  })

  it('abandons only a round still pending', () => {
    const t = tracker(3)

    expect(t.abandonRound(9)).toBe(false)
    expect(t.abandonRound(3)).toBe(true)
    expect(t.isAwaitingShare('c1')).toBe(false)
    expect(t.abandonRound(3)).toBe(false)
  })

  it('hands a recovery request out once', () => {
    const t = new RoundTracker()
    t.beginRecovery({ secretId: '7', version: 1, label: 'seed' })

    expect(t.takeRecovery()?.label).toBe('seed')
    expect(t.takeRecovery()).toBeNull()
  })
})

describe('RoundTracker — persistence and late answers', () => {
  it('snapshots the open round with the channels still awaited', () => {
    const t = tracker(3)
    t.dropShare('c1', 3)

    expect(t.snapshotProtectRounds()).toEqual([
      { version: 3, protocolSecretId: '42', bag: bag(3), channelIds: ['c2'] },
    ])
  })

  it('snapshots nothing once the round is resolved', () => {
    const t = tracker(3)
    t.completeRound(3)

    expect(t.snapshotProtectRounds()).toEqual([])
  })

  it('still hands over a round the watchdog gave up on, if the library completes it after all', () => {
    // The helpers stored *this* bag; committing anything else would lose it.
    const t = tracker(3)
    t.abandonRound(3)

    expect(t.completeRound(3)?.version).toBe(3)
    expect(t.completeRound(3)).toBeNull()
  })
})

describe('RoundTracker — concurrent rounds', () => {
  function twoRounds(): RoundTracker {
    const t = new RoundTracker()
    t.beginProtectRound({ bag: bag(2, [s1, s2]), version: 2, protocolSecretId: '42', channelIds: ['c1', 'c2'] })
    t.beginProtectRound({ bag: bag(3, [s1, s2, s3]), version: 3, protocolSecretId: '42', channelIds: ['c1', 'c2'] })
    return t
  }

  it('keeps an earlier round staged when a later one begins', () => {
    const t = twoRounds()

    expect(t.pendingRounds.map(r => r.version)).toEqual([2, 3])
    expect(t.completeRound(2)?.bag.currentVersion.secrets).toEqual([s1, s2])
    expect(t.completeRound(3)?.bag.currentVersion.secrets).toEqual([s1, s2, s3])
  })

  it('files each answer against its own round', () => {
    const t = twoRounds()

    t.recordShareConfirmed(2, 'p1')
    t.dropShare('c2', 3)

    expect(t.confirmedCount(2)).toBe(1)
    expect(t.confirmedCount(3)).toBe(0)
    expect(t.isAwaitingShare('c2', 2)).toBe(true)
    expect(t.isAwaitingShare('c2', 3)).toBe(false)
  })

  it('builds a new round on the newest staged bag, not only the committed one', () => {
    const t = new RoundTracker()
    t.beginProtectRound({ bag: bag(2, [s1, s2]), version: 2, protocolSecretId: '42', channelIds: ['c1'] })

    // S2 is still waiting on its round; adding S3 must publish S1, S2 and S3.
    expect(t.latestSecrets(bag(1, [s1]))).toEqual([s1, s2])
    // Once committed, the committed bag is the newest.
    t.completeRound(2)
    expect(t.latestSecrets(bag(2, [s1, s2]))).toEqual([s1, s2])
  })

  it('persists every open round, oldest first', () => {
    const t = twoRounds()

    expect(t.snapshotProtectRounds().map(r => r.version)).toEqual([2, 3])
    t.abandonRound(2)
    expect(t.snapshotProtectRounds().map(r => r.version)).toEqual([3])
  })
})

describe('commitRoundVersion', () => {
  it('makes a newer round the current version', () => {
    const committed = commitRoundVersion(bag(1, [s1]), bag(2, [s1, s2]))

    expect(committed.currentVersion.version).toBe(2)
    expect(committed.previousVersions.map(v => v.version)).toEqual([1])
  })

  it('files an older round that completes last as history, without rolling the bag back', () => {
    const afterV3 = commitRoundVersion(bag(1, [s1]), bag(3, [s1, s2, s3]))
    const afterV2 = commitRoundVersion(afterV3, bag(2, [s1, s2]))

    expect(afterV2.currentVersion.version).toBe(3)
    expect(afterV2.currentVersion.secrets).toEqual([s1, s2, s3])
    expect(afterV2.previousVersions.map(v => v.version)).toEqual([2, 1])
  })

  it('never carries a failed round in through a later round staged on top of it', () => {
    // v3 was staged while v2 was open, so its staged bag lists v2 as history.
    // v2 then failed: committing v3 must not resurrect it.
    const v3Staged: SecretBag = { ...bag(3, [s1, s2, s3]), previousVersions: [bagVersion(2, [s1, s2])] }

    const committed = commitRoundVersion(bag(1, [s1]), v3Staged)

    expect(committed.previousVersions.map(v => v.version)).toEqual([1])
  })

  it('starts the bag from the first round to complete', () => {
    expect(commitRoundVersion(null, bag(1, [s1])).currentVersion.secrets).toEqual([s1])
  })
})

describe('settleUnansweredShares', () => {
  it('marks only the round’s unanswered shares refused, keeping confirmations', () => {
    const participants: PairedParticipant[] = [
      { id: 'p1', name: 'A', channelId: 'c1', transport: { protocol: 'https', uri: 'u1' }, connectionStatus: 'paired',
        secretShares: [{ version: 2, status: 'confirmed', verified: false }] },
      { id: 'p2', name: 'B', channelId: 'c2', transport: { protocol: 'https', uri: 'u2' }, connectionStatus: 'paired',
        secretShares: [{ version: 1, status: 'pending', verified: false }, { version: 2, status: 'pending', verified: false }] },
    ]

    const settled = settleUnansweredShares(participants, 2)

    expect(settled[0]).toBe(participants[0])
    expect(settled[1].secretShares).toEqual([
      { version: 1, status: 'pending', verified: false },
      // Recorded as a silence, not a refusal — see `owner/shareFailure.ts`.
      { version: 2, status: 'rejected', verified: false, failure: { status: 0, memo: 'No answer before the round closed' } },
    ])
  })
})
