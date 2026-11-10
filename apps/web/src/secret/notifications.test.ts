// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import type { BagVersion, PairedParticipant, PendingAutoVerification, Secret } from '../types'
import {
  MAX_NOTIFICATIONS,
  autoVerificationResult,
  unreadCount,
  withNotification,
  withNotificationsRead,
} from './notifications'
import { secret as testSecret } from './testSecret'

function participant(n: number): PairedParticipant {
  return {
    id: `h${n}`,
    name: `Helper ${n}`,
    channelId: `90${n}`,
    transport: { protocol: 'https', uri: `http://localhost:5000/derec/h${n}` },
    secretShares: [],
    connectionStatus: 'paired',
  }
}

function withVersion(overrides: Partial<BagVersion>): Secret {
  const version: BagVersion = {
    version: 5,
    participantIds: ['h1', 'h2', 'h3'],
    verifiedParticipantIds: [],
    failedParticipantIds: [],
    items: [],
    rawBytes: '',
    helpers: [],
    ...overrides,
  }
  return testSecret({
    participants: [participant(1), participant(2), participant(3)],
    itemBag: { secretId: '42', threshold: 2, currentVersion: version, previousVersions: [] },
  })
}

const pending: PendingAutoVerification = {
  version: 5,
  startedAt: 0,
  reportBy: 60_000,
  channelIds: ['901', '902', '903'],
  notReachedChannelIds: [],
}

describe('secret notifications', () => {
  it('adds newest first, unread, and marks read by id or all', () => {
    let v = withNotification(testSecret(), { severity: 'info', title: 'one' }, 1)
    v = withNotification(v, { severity: 'critical', title: 'two' }, 2)

    expect(v.notifications?.map(n => n.title)).toEqual(['two', 'one'])
    expect(unreadCount(v.notifications)).toEqual({ total: 2, critical: 1 })

    v = withNotificationsRead(v, [v.notifications![0].id])
    expect(unreadCount(v.notifications)).toEqual({ total: 1, critical: 0 })
    v = withNotificationsRead(v, 'all')
    expect(unreadCount(v.notifications)).toEqual({ total: 0, critical: 0 })
  })

  it('returns the same record when nothing changes', () => {
    const v = withNotificationsRead(withNotification(testSecret(), { severity: 'info', title: 'one' }), 'all')
    expect(withNotificationsRead(v, 'all')).toBe(v)
  })

  it('keeps at most the cap, dropping read ones before unread ones', () => {
    let v = withNotification(testSecret(), { severity: 'critical', title: 'oldest unread' }, 0)
    for (let i = 1; i <= MAX_NOTIFICATIONS; i++) {
      v = withNotificationsRead(withNotification(v, { severity: 'info', title: `read ${i}` }, i), 'all')
      // Keep the oldest one unread throughout.
      v = { ...v, notifications: v.notifications!.map(n => (n.title === 'oldest unread' ? { ...n, read: false } : n)) }
    }

    expect(v.notifications).toHaveLength(MAX_NOTIFICATIONS)
    expect(v.notifications!.some(n => n.title === 'oldest unread')).toBe(true)
    expect(v.notifications!.some(n => n.title === 'read 1')).toBe(false)
  })
})

describe('autoVerificationResult', () => {
  it('passes when every challenged helper proved its share', () => {
    const v = withVersion({
      verifiedParticipantIds: ['h1', 'h2', 'h3'],
      verifiedSubshares: { h1: 1, h2: 1, h3: 1 },
      verifiedThreshold: 2,
    })

    const result = autoVerificationResult(v, pending, 10)

    expect(result).toMatchObject({ version: 5, at: 10, passed: true })
    expect(result.summary).toBe('3/3 helpers verified, recoverable (3 of 2 subshares)')
  })

  it('fails naming each helper that did not prove its share, and why', () => {
    const v = withVersion({
      verifiedParticipantIds: ['h1'],
      verifiedSubshares: { h1: 1 },
      verifiedThreshold: 2,
      verifyRejections: [{ id: 'h2', status: 3, memo: 'unknown version' }],
    })

    const result = autoVerificationResult(v, pending)

    expect(result.passed).toBe(false)
    expect(result.summary).toContain('Helper 2 rejected it (unknown version)')
    expect(result.summary).toContain('Helper 3 did not answer')
    expect(result.summary).toContain('1/3 helpers verified, not recoverable from verified helpers alone (1 of 2 subshares)')
  })

  it('fails on an invalid proof and on a helper that could not be reached', () => {
    const v = withVersion({ verifiedParticipantIds: ['h1'], invalidProofParticipantIds: ['h2'] })

    const result = autoVerificationResult(v, { ...pending, channelIds: ['901', '902'], notReachedChannelIds: ['903'] })

    expect(result.passed).toBe(false)
    expect(result.summary).toContain("Helper 2's proof is invalid")
    expect(result.summary).toContain('Helper 3 could not be reached')
  })
})
