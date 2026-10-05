// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import type { ReplicaView } from './replicaFlows'
import { isSyncNoticeAnswered } from './replicaSyncNotice'

function view(lastSync: ReplicaView['lastSync']): ReplicaView {
  return {
    id: 'r',
    name: 'Laptop',
    channelId: '1',
    status: 'paired',
    offline: false,
    peerConfirmation: 'none',
    lastSync,
    establishedAt: null,
    firstSyncStarted: false,
    direction: 'replica_source',
    peerReplicaId: '7',
    helperActorId: null,
    refused: false,
  }
}

describe('isSyncNoticeAnswered', () => {
  it('clears "will acknowledge it" once an ack lands after the send', () => {
    expect(isSyncNoticeAnswered('dispatched', 1_000, view({ version: 2, syncedAt: 1_500 }))).toBe(true)
  })

  it('keeps it while the only ack on file predates the send', () => {
    expect(isSyncNoticeAnswered('dispatched', 1_000, view({ version: 1, syncedAt: 500 }))).toBe(false)
    expect(isSyncNoticeAnswered('dispatched', 1_000, view(null))).toBe(false)
  })

  it('never clears an outcome the user still has to act on', () => {
    expect(isSyncNoticeAnswered('failed', 1_000, view({ version: 2, syncedAt: 1_500 }))).toBe(false)
    expect(isSyncNoticeAnswered('busy', 1_000, view({ version: 2, syncedAt: 1_500 }))).toBe(false)
  })
})
