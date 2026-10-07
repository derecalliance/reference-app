// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import type { BagVersion, PendingProtectRound, SecretBag } from '../types'
import { describeVerifyFailure, verifyBlockedReason, verifyProgress } from './verification'

const participants = ['1', '2', '3', '4'].map(n => ({ id: `h${n}`, name: `Helper ${n}`, channelId: `90${n}` }))

function version(overrides: Partial<BagVersion> = {}): BagVersion {
  return {
    version: 4,
    participantIds: [],
    verifiedParticipantIds: [],
    failedParticipantIds: [],
    secrets: [],
    rawBytes: '',
    helpers: [],
    ...overrides,
  }
}

describe('verifyProgress', () => {
  it('times out only the participants still unverified when the deadline passes', () => {
    const progress = verifyProgress({
      participants,
      verifiedParticipantIds: ['h1', 'h2', 'h3'],
      failedChannelIds: new Set(),
      deadlinePassed: true,
    })

    // Was "3 of 4 verified · 4 failed" with the bar at 175%.
    expect(progress.verifiedCount).toBe(3)
    expect(progress.failedCount).toBe(1)
    expect(progress.percent).toBe(100)
    expect(progress.allDone).toBe(true)
    expect(progress.rows.map(r => r.state)).toEqual(['verified', 'verified', 'verified', 'timed-out'])
  })

  it('never counts a verified participant as failed, even on a channel reported failed', () => {
    const progress = verifyProgress({
      participants,
      verifiedParticipantIds: ['h1'],
      failedChannelIds: new Set(['901', '902']),
      deadlinePassed: false,
    })

    expect(progress.verifiedCount + progress.failedCount).toBeLessThanOrEqual(participants.length)
    expect(progress.rows.map(r => r.state)).toEqual(['verified', 'failed', 'waiting', 'waiting'])
    expect(progress.allDone).toBe(false)
    expect(progress.percent).toBe(50)
  })
})

describe('verifyProgress with refusals (SDK 0.0.7 ShareVerifyRejected)', () => {
  it('resolves a refusing helper to Rejected, with its memo, and counts it as answered', () => {
    const progress = verifyProgress({
      participants,
      verifiedParticipantIds: ['h1', 'h2', 'h3'],
      rejections: [{ id: 'h4', status: 10, memo: 'Rejected by user' }],
      failedChannelIds: new Set(),
      deadlinePassed: false,
    })

    expect(progress.rows[3]).toMatchObject({ state: 'rejected', detail: 'Rejected by user' })
    expect(progress.rejectedCount).toBe(1)
    expect(progress.failedCount).toBe(0)
    expect(progress.allDone).toBe(true)
    expect(progress.percent).toBe(100)
  })

  it('names the status when the helper gave no memo', () => {
    const progress = verifyProgress({
      participants: participants.slice(0, 1),
      verifiedParticipantIds: [],
      rejections: [{ id: 'h1', status: 6, memo: '' }],
      failedChannelIds: new Set(),
      deadlinePassed: false,
    })
    expect(progress.rows[0].detail).toBe('status 6')
  })
})

describe('verifyBlockedReason', () => {
  const round = { version: 5, protocolSecretId: '42', bag: {} as SecretBag, channelIds: [] } satisfies PendingProtectRound

  it('is available with no round open', () => {
    expect(verifyBlockedReason(version(), [])).toBeNull()
  })

  it('is blocked while a publish is open, naming it', () => {
    expect(verifyBlockedReason(version(), [round])).toContain('Publishing v5')
  })

  it('is blocked on a version restored from recovery, saying how to get verification back', () => {
    expect(verifyBlockedReason(version({ restoredFromRecovery: true }), [])).toContain('Publish a new version')
  })
})

describe('describeVerifyFailure', () => {
  it('explains the library’s missing-tracking-share refusal', () => {
    expect(
      describeVerifyFailure('invalid input: no committed share stored for this channel/version — cannot verify proof', 3),
    ).toContain('v3 was restored from a recovered bag')
  })

  it('passes any other error through', () => {
    expect(describeVerifyFailure('boom', 3)).toBe('boom')
  })
})
