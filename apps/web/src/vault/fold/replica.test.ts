// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { DeRecEvent } from '@derec-alliance/web'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadReplicaState, recordReplicaChannel } from '../../replicaFlows'
import type { PairedParticipant } from '../../types'
import { RoundTracker } from '../rounds'
import { vault } from '../testVault'
import { foldEvent, type FoldContext } from '.'

function context(overrides: Partial<FoldContext> = {}): FoldContext {
  const current = vault()
  return {
    log: vi.fn(),
    notify: { error: vi.fn(), info: vi.fn(), outcome: vi.fn() },
    effects: {
      refreshReplicas: vi.fn(),
      openFingerprint: vi.fn(),
      openAdoption: vi.fn(),
      pairingRejected: vi.fn(),
      pairingCompleted: vi.fn(),
      unpairSettled: vi.fn(),
      channelsLinked: vi.fn(),
    },
    rounds: new RoundTracker(),
    flowProgressed: vi.fn(),
    roundResolved: vi.fn(),
    getVault: () => current,
    commit: vi.fn(),
    offerReplicaAdoption: vi.fn(),
    readChannelInfo: vi.fn(() => null),
    channelInfoOutcome: vi.fn(),
    awaitingIdentityAnswer: vi.fn(() => false),
    isShareHeld: vi.fn(() => true),
    ...overrides,
  }
}

function row(channelId: string, peerRole: PairedParticipant['peerRole']): PairedParticipant {
  return {
    id: `peer-${channelId}`,
    name: `Peer ${channelId}`,
    channelId,
    transport: { protocol: 'https', uri: '' },
    connectionStatus: 'paired',
    peerRole,
    secretShares: [],
  }
}

/** A source with two destinations, B (replica 11) and C (replica 22). */
function twoDestinations(): void {
  recordReplicaChannel('v1', { channelId: '100', role: 'replica_source', peerReplicaId: '11' })
  recordReplicaChannel('v1', { channelId: '200', role: 'replica_source', peerReplicaId: '22' })
}

afterEach(() => localStorage.clear())

describe('ReplicaSecretAcked', () => {
  it('attributes the ack to the member that sent it, not the shared group channel', () => {
    twoDestinations()

    // Both members ack on the group's one channel — here, B's channel id.
    foldEvent(
      vault(),
      {
        type: 'ReplicaSecretAcked',
        channel_id: '100',
        from_replica_id: '22',
        secret_id: '42',
        version: 3,
        status: 0,
        memo: '',
      } as DeRecEvent,
      context(),
    )

    const { syncs } = loadReplicaState('v1')
    expect(syncs['200']?.version).toBe(3)
    expect(syncs['100']).toBeUndefined()
  })

  it('falls back to the event channel when no record names the member', () => {
    foldEvent(
      vault(),
      {
        type: 'ReplicaSecretAcked',
        channel_id: '100',
        from_replica_id: '99',
        secret_id: '42',
        version: 1,
        status: 0,
        memo: '',
      } as DeRecEvent,
      context(),
    )

    expect(loadReplicaState('v1').syncs['100']?.version).toBe(1)
  })
})

describe('a mirrored update to the vault this device runs', () => {
  it('records that the member it came from holds that version', () => {
    twoDestinations()
    foldEvent(
      vault(),
      {
        type: 'ReplicaSecretReceived',
        channel_id: '100',
        from_replica_id: '22',
        author_replica_id: '22',
        secret_id: '42',
        version: 5,
        secret: { helpers: [], secrets: [] },
        shares: [],
      } as unknown as DeRecEvent,
      context(),
    )

    expect(loadReplicaState('v1').syncs['200']?.version).toBe(5)
  })
})

describe('ReplicaRemoved', () => {
  it('drops the removed member’s row even when another member evicted it', () => {
    twoDestinations()
    const current = vault({
      participants: [row('100', 'replica_destination'), row('200', 'replica_destination')],
    })

    const next = foldEvent(current, { type: 'ReplicaRemoved', replica_id: '22' } as DeRecEvent, context())

    expect(next.participants.map(p => p.channelId)).toEqual(['100'])
    expect(Object.keys(loadReplicaState('v1').channels)).toEqual(['100'])
  })

  it('changes nothing for a member this device never had a row for', () => {
    const current = vault({ participants: [row('100', 'replica_destination')] })
    expect(foldEvent(current, { type: 'ReplicaRemoved', replica_id: '77' } as DeRecEvent, context())).toBe(
      current,
    )
  })
})

describe('SelfRemovedFromGroup', () => {
  it('clears the channels the library erased, and the replica bookkeeping', () => {
    recordReplicaChannel('v1', { channelId: '100', role: 'replica_destination', peerReplicaId: '11' })
    const current = vault({
      participants: [row('100', 'replica_source'), row('7', 'helper'), row('8', 'helper')],
      mainChannels: ['7'],
      secretBag: {
        secretId: '42',
        threshold: 2,
        previousVersions: [],
        currentVersion: {
          version: 4,
          participantIds: [],
          verifiedParticipantIds: [],
          failedParticipantIds: [],
          secrets: [],
          rawBytes: '',
          helpers: [],
        },
      },
    })
    const ctx = context({
      // Every helper channel went with the partition.
      readChannelInfo: vi.fn(() => null),
    })

    const next = foldEvent(current, { type: 'SelfRemovedFromGroup', version: 4 } as DeRecEvent, ctx)

    expect(next.participants).toEqual([])
    expect(next.secretBag).toBeNull()
    expect(next.mainChannels).toEqual([])
    expect(loadReplicaState('v1').channels).toEqual({})
    expect(ctx.notify.error).toHaveBeenCalledWith(expect.stringContaining('3 channel(s)'))
  })

  it('counts erased channels, not pool helpers this vault never paired with', () => {
    const pool = { ...row('', 'helper'), id: 'pool-1', connectionStatus: 'available' as const }
    const current = vault({
      participants: [row('100', 'replica_source'), row('7', 'helper'), row('8', 'helper'), pool, { ...pool, id: 'pool-2' }],
    })
    const ctx = context({ readChannelInfo: vi.fn(() => null) })

    const next = foldEvent(current, { type: 'SelfRemovedFromGroup', version: 4 } as DeRecEvent, ctx)

    expect(ctx.notify.error).toHaveBeenCalledWith(expect.stringContaining('3 channel(s)'))
    // Nothing of theirs was erased, so they stay pairable.
    expect(next.participants.map(p => p.id)).toEqual(['pool-1', 'pool-2'])
  })

  it('keeps a helper row whose channel record survived', () => {
    const current = vault({ participants: [row('7', 'helper'), row('8', 'helper')] })
    const ctx = context({
      readChannelInfo: vi.fn((channelId: string) =>
        channelId === '8' ? { name: 'Kept', transports: [] } : null,
      ),
    })

    const next = foldEvent(current, { type: 'SelfRemovedFromGroup', version: 1 } as DeRecEvent, ctx)

    expect(next.participants.map(p => p.channelId)).toEqual(['8'])
  })
})

describe('ChannelInfoUpdated', () => {
  it('reads as the peer’s answer when this vault’s update was waiting on it', () => {
    const ctx = context({ awaitingIdentityAnswer: vi.fn(() => true) })
    foldEvent(vault(), { type: 'ChannelInfoUpdated', channel_id: '7' } as DeRecEvent, ctx)
    expect(ctx.log).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining("accepted this vault's") }),
    )
  })

  it('reads as the peer’s own announcement otherwise, even when nothing changed', () => {
    const ctx = context()
    foldEvent(vault(), { type: 'ChannelInfoUpdated', channel_id: '7' } as DeRecEvent, ctx)
    expect(ctx.log).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('re-announced') }),
    )
  })
})

describe('a replica version conflict', () => {
  const rival = {
    helpers: [],
    secrets: [
      { id: new Uint8Array([0xaa]), name: 'Seed', data: new TextEncoder().encode('one two') },
      { id: new Uint8Array([0xdd]), name: 'FromDest', data: new TextEncoder().encode('y') },
    ],
  }

  function conflictEvent(version = 6): DeRecEvent {
    return {
      type: 'ReplicaVersionConflict',
      channel_id: '100',
      from_replica_id: '22',
      secret_id: '42',
      version,
      held_author_replica_id: '11',
      incoming_author_replica_id: '22',
      secret: rival,
    } as unknown as DeRecEvent
  }

  function rejectedEvent(status = 13, version = 6): DeRecEvent {
    return {
      type: 'ReplicaSyncRejected',
      replica_id: '22',
      secret_id: '42',
      version,
      status,
      memo: 'version conflict',
    } as DeRecEvent
  }

  it('marks the vault diverged, keeping the rival copy to merge from', () => {
    const ctx = context()
    const next = foldEvent(vault(), conflictEvent(), ctx)

    expect(next.replicaConflict).toMatchObject({
      version: 6,
      detectedVia: 'ReplicaVersionConflict',
      rivalReplicaId: '22',
      rivalSecrets: [
        { id: 'aa', name: 'Seed', data: 'one two' },
        { id: 'dd', name: 'FromDest', data: 'y' },
      ],
    })
    expect(ctx.notify.error).toHaveBeenCalledWith(expect.stringMatching(/Publishing from this vault is paused/), undefined, expect.anything())
  })

  it('marks the publisher diverged too when its copy is refused as a conflict', () => {
    const next = foldEvent(vault(), rejectedEvent(), context())
    expect(next.replicaConflict).toMatchObject({ version: 6, detectedVia: 'ReplicaSyncRejected', rivalSecrets: null })
  })

  it('leaves the vault alone when a member refuses for another reason', () => {
    const current = vault()
    expect(foldEvent(current, rejectedEvent(10), context()).replicaConflict).toBeUndefined()
  })

  it('keeps a rival copy already received when the refusal arrives after it', () => {
    const withRival = foldEvent(vault(), conflictEvent(), context())
    const next = foldEvent(withRival, rejectedEvent(), context())
    expect(next.replicaConflict?.rivalSecrets).toHaveLength(2)
  })

  it('is over once the group publishes past it and this device applies that version', () => {
    const diverged = foldEvent(vault(), conflictEvent(6), context())
    const ctx = context({ getVault: () => diverged })

    const stale = foldEvent(
      diverged,
      { type: 'ReplicaSecretReceived', channel_id: '100', from_replica_id: '22', author_replica_id: '22', secret_id: '42', version: 6, secret: { helpers: [], secrets: [] }, shares: [] } as unknown as DeRecEvent,
      ctx,
    )
    expect(stale.replicaConflict).toBeDefined()

    const moved = foldEvent(
      diverged,
      { type: 'ReplicaSecretReceived', channel_id: '100', from_replica_id: '22', author_replica_id: '22', secret_id: '42', version: 7, secret: { helpers: [], secrets: [] }, shares: [] } as unknown as DeRecEvent,
      ctx,
    )
    expect(moved.replicaConflict).toBeUndefined()
    expect(ctx.notify.info).toHaveBeenCalledWith(expect.stringMatching(/settling the conflict at v6/))
  })
})
