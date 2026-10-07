// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { DeRecEvent } from '@derec-alliance/web'
import { describe, expect, it } from 'vitest'

import type { PairedParticipant } from '../types'
import {
  endpointProblem,
  hasOutstandingPeers,
  identityUpdateCounts,
  identityUpdateFrom,
  pinnedEndpointWarnings,
  undeliveredChannelIds,
  vaultNameProblem,
  withChannelOutcome,
  withExpiredWaits,
  withIdentityResend,
} from './identity'

function peer(channelId: string, name: string): PairedParticipant {
  return {
    id: `p-${channelId}`,
    name,
    channelId,
    transport: { protocol: 'https', uri: `http://localhost:5000/derec/${channelId}` },
    secretShares: [],
    connectionStatus: 'paired',
  }
}

describe('vault identity rules', () => {
  it('accepts a sensible name and refuses empty, long or control-character ones', () => {
    expect(vaultNameProblem('  Crypto Seeds  ')).toBeNull()
    expect(vaultNameProblem('   ')).toMatch(/Enter a name/)
    expect(vaultNameProblem('x'.repeat(65))).toMatch(/64/)
    expect(vaultNameProblem('a\u0007b')).toMatch(/control/)
  })

  it('accepts an http(s) mailbox URL and explains every other shape', () => {
    expect(endpointProblem('http://192.168.0.28:5300/derec/v1')).toBeNull()
    expect(endpointProblem('')).toMatch(/follow the node/)
    expect(endpointProblem('not a url')).toMatch(/full URL/)
    expect(endpointProblem('grpc://host:50051/derec/v1')).toMatch(/cannot serve gRPC/)
    expect(endpointProblem('http://host:5000')).toMatch(/mailbox path/)
  })
})

describe('identity update bookkeeping', () => {
  const started = [
    { type: 'UpdateChannelInfoStarted', channel_id: '1', trace_id: 't' },
    { type: 'UpdateChannelInfoStarted', channel_id: '2', trace_id: 't' },
    { type: 'UpdateChannelInfoFailed', channel_id: '3', error: 'no endpoint' },
  ] as DeRecEvent[]

  it('lists every channel the update went to, by peer name', () => {
    const update = identityUpdateFrom(
      started,
      [peer('1', 'Alex'), peer('2', 'Bob-1')],
      { name: 'Family Vault' },
      0,
    )

    expect(update.changed).toEqual({ name: true, endpoint: false })
    expect(update.values).toEqual({ name: 'Family Vault' })
    expect(update.channels).toEqual({
      '1': { peerName: 'Alex', sentAt: 0, outcome: 'pending', detail: null },
      '2': { peerName: 'Bob-1', sentAt: 0, outcome: 'pending', detail: null },
      '3': { peerName: 'Channel 3', sentAt: 0, outcome: 'failed', detail: 'no endpoint' },
    })
    expect(identityUpdateCounts(update)).toEqual({
      pending: 2,
      updated: 0,
      rejected: 0,
      failed: 1,
      'no-answer': 0,
    })
  })

  it('applies a peer answer once, and ignores channels the update never went to', () => {
    const update = identityUpdateFrom(started, [], { name: 'Family Vault' }, 0)

    const answered = withChannelOutcome(update, '1', 'updated', null)
    expect(answered?.channels['1'].outcome).toBe('updated')

    // A *peer* updating this vault fires the same events on another channel.
    expect(withChannelOutcome(answered, '99', 'updated', null)).toBe(answered)
    // A settled answer is not overwritten by a late duplicate.
    expect(withChannelOutcome(answered, '1', 'rejected', 'late')).toBe(answered)
    // And with no update in flight there is nothing to apply.
    expect(withChannelOutcome(null, '1', 'updated', null)).toBeNull()
  })
})

describe('resending an identity update', () => {
  const started = [
    { type: 'UpdateChannelInfoStarted', channel_id: '1', trace_id: 't' },
    { type: 'UpdateChannelInfoStarted', channel_id: '2', trace_id: 't' },
    { type: 'UpdateChannelInfoFailed', channel_id: '3', error: 'no endpoint' },
  ] as DeRecEvent[]

  it('marks a peer silent past the timeout as no-answer, and leaves the rest', () => {
    const update = withChannelOutcome(
      identityUpdateFrom(started, [], { endpoint: 'http://n/derec/v' }, 1_000),
      '1',
      'updated',
      null,
    )

    // Not yet: nothing changes, and the same object comes back.
    expect(withExpiredWaits(update, 30_000, 60_000)).toBe(update)

    const expired = withExpiredWaits(update, 61_000, 60_000)
    expect(expired?.channels['1'].outcome).toBe('updated')
    expect(expired?.channels['2'].outcome).toBe('no-answer')
    expect(expired?.channels['3'].outcome).toBe('failed')
  })

  it('names exactly the peers that never got the update', () => {
    const update = withExpiredWaits(
      identityUpdateFrom(started, [], { name: 'X' }, 0),
      120_000,
      60_000,
    )
    expect(undeliveredChannelIds(update).sort()).toEqual(['1', '2', '3'])
    expect(undeliveredChannelIds(withChannelOutcome(
      identityUpdateFrom(started, [], { name: 'X' }, 0), '1', 'updated', null,
    ))).toEqual(['3'])
    expect(undeliveredChannelIds(null)).toEqual([])
  })

  it('folds a resend in without forgetting the peers that already answered', () => {
    const first = withChannelOutcome(
      identityUpdateFrom(started, [peer('3', 'Carol')], { name: 'X' }, 0),
      '1',
      'updated',
      null,
    )!
    const resend = [{ type: 'UpdateChannelInfoStarted', channel_id: '3', trace_id: 'r' }] as DeRecEvent[]

    const next = withIdentityResend(first, resend, [peer('3', 'Carol')], 5_000)

    expect(next.channels['1'].outcome).toBe('updated')
    expect(next.channels['3']).toEqual({ peerName: 'Carol', sentAt: 5_000, outcome: 'pending', detail: null })
    expect(next.values).toEqual({ name: 'X' })
    expect(hasOutstandingPeers(next)).toBe(true)
  })
})

describe('pinned endpoint warnings', () => {
  it('says nothing for this vault’s own mailbox on the node’s origin', () => {
    expect(
      pinnedEndpointWarnings('http://localhost:5000/derec/v1', 'v1', 'http://localhost:5000/derec/v1'),
    ).toEqual([])
  })

  it('warns when the path is not this vault’s mailbox', () => {
    const [warning] = pinnedEndpointWarnings('http://localhost:5000/derec/other', 'v1', null)
    expect(warning).toMatch(/\/derec\/v1/)
  })

  it('warns when the origin is not the node’s', () => {
    const warnings = pinnedEndpointWarnings(
      'http://127.0.0.1:5999/derec/v1',
      'v1',
      'http://localhost:5000/derec/v1',
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/localhost:5000/)
  })
})
