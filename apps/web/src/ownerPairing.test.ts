import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SenderKind } from '@derec-alliance/web'
import {
  applyPairingCompleted,
  isShareTarget,
  peerRoleFromKind,
  splitPairedChannels,
  type PairingCompletedEvent,
  canDrivePeerViaBackend,
  syntheticPeerId,
} from './ownerPairing'
import { loadReplicaState, replicaViews } from './replicaFlows'
import type { ChannelRole, Owner, PairedParticipant } from './types'

/**
 * The one invariant replica pairing exists to enforce: a replica channel never
 * receives a share.
 *
 * It used to be enforced by keeping replica channels out of the participant
 * roster entirely. They are in it now — flagged, in the channel list, where a
 * user can actually see and confirm them — so the exclusion is gone and the
 * *role* is the whole of the guarantee: `peerRoleFromKind` writes a replica role
 * on the row and `isShareTarget` refuses it. Both halves are asserted below, and
 * the share-target half is asserted directly rather than through the fold, so
 * deleting the role test in `isShareTarget` fails a test on its own.
 */

const EXISTING: PairedParticipant = {
  id: 'helper-1',
  name: 'Helper One',
  channelId: '900',
  transport: { protocol: 'https', uri: 'https://example.test/helper-1' },
  secretShares: [],
  connectionStatus: 'paired',
  peerRole: 'helper',
}

function owner(): Owner {
  return {
    ownerId: 'owner-1',
    ownerName: 'Alice',
    ownSecretId: '42',
    transport: { protocol: 'https', uri: 'https://example.test/owner-1' },
    participants: [EXISTING],
    secretBag: null,
    // A pending pairing carrying a `participantId` keeps the fold off the
    // backend-identity lookup, so these tests make no network calls.
    pendingPairings: [{ channelId: 7n, participantId: 'device-2' }],
    minParticipants: 2,
    recommendedParticipants: 3,
    recoveredSecrets: [],
    recoveryProgress: null,
    recoveryFailures: [],
    heldShares: [],
    mainChannels: [],
    config: {
      protocolTimeoutSecs: 300,
      authenticationMethod: 'user',
      unpairAck: 'required',
      autoAcceptUnpairRequests: false,
    },
  }
}

function event(kind: number): PairingCompletedEvent {
  return {
    type: 'PairingCompleted',
    channel_id: '1234',
    pairing_channel_id: '7',
    kind,
    peer_communication_info: { name: 'Second device' },
  } as PairingCompletedEvent
}

function deps() {
  return {
    log: vi.fn(),
    getOwner: () => owner(),
    commit: vi.fn(),
    onReplicaChannelEstablished: vi.fn(),
  }
}

/** A paired row carrying `role`, in every other respect a share target. */
function rowWithRole(role: ChannelRole): PairedParticipant {
  return { ...EXISTING, id: 'row', channelId: '1234', peerRole: role }
}

/**
 * The guarantee, asserted where it lives.
 *
 * `isShareTarget` is the only thing between a replica channel and the owner's
 * secret now that replica rows are in the roster. Deleting its replica test —
 * the `isReplicaRole` line — makes both replica cases below fail immediately,
 * because a replica role is not `'owner'` and every other condition here is
 * satisfied. That is the mutation this file is built to catch.
 */
describe('isShareTarget', () => {
  it('accepts a paired helper-role channel', () => {
    expect(isShareTarget(rowWithRole('helper'))).toBe(true)
  })

  it('refuses a channel on which the peer is the owner', () => {
    expect(isShareTarget(rowWithRole('owner'))).toBe(false)
  })

  it('refuses a replica_source channel', () => {
    expect(isShareTarget(rowWithRole('replica_source'))).toBe(false)
  })

  it('refuses a replica_destination channel', () => {
    expect(isShareTarget(rowWithRole('replica_destination'))).toBe(false)
  })

  it('refuses a replica channel that both devices have confirmed', () => {
    // Confirmation promotes the *library* channel to `Paired`; it does not turn
    // a replica into a helper. A replica holds no VSS share at any point in its
    // life, so there is no state in which it becomes a share target.
    expect(isShareTarget({ ...rowWithRole('replica_source'), connectionStatus: 'paired' })).toBe(
      false,
    )
  })

  it('refuses an unpaired channel and one with no channel id', () => {
    expect(isShareTarget({ ...rowWithRole('helper'), connectionStatus: 'available' })).toBe(false)
    expect(isShareTarget({ ...rowWithRole('helper'), channelId: '' })).toBe(false)
  })
})

/**
 * Where each channel is *listed*.
 *
 * A replica belongs in the Replicas tab and nowhere else. Both lists come out of
 * this one call, so a replica cannot be in both and cannot be in neither.
 * Deleting the `isReplicaRole` branch puts every replica back into the
 * participant list — the duplication the tab was rebuilt to remove — and the
 * two assertions below fail on their own, without the page being mounted.
 */
describe('splitPairedChannels', () => {
  it('lists a replica channel among the replicas, carrying its role', () => {
    const { replicas } = splitPairedChannels([
      rowWithRole('helper'),
      { ...rowWithRole('replica_destination'), id: 'peer-77', name: 'Laptop', channelId: '77' },
    ])
    expect(replicas).toEqual([
      { id: 'peer-77', name: 'Laptop', channelId: '77', peerRole: 'replica_destination' },
    ])
  })

  it('keeps a replica channel out of the main channel list', () => {
    const { participants } = splitPairedChannels([
      rowWithRole('helper'),
      { ...rowWithRole('replica_source'), id: 'peer-77', channelId: '77' },
      { ...rowWithRole('replica_destination'), id: 'peer-78', channelId: '78' },
    ])
    expect(participants.map(p => p.id)).toEqual(['row'])
  })

  it('lists both replica roles, so neither side of a mirror is hidden', () => {
    const { replicas } = splitPairedChannels([
      { ...rowWithRole('replica_source'), id: 'peer-77', channelId: '77' },
      { ...rowWithRole('replica_destination'), id: 'peer-78', channelId: '78' },
    ])
    expect(replicas.map(r => r.peerRole)).toEqual(['replica_source', 'replica_destination'])
  })

  it('keeps a participant channel in the main list and out of the replicas', () => {
    const split = splitPairedChannels([rowWithRole('helper'), rowWithRole('owner')])
    expect(split.participants).toHaveLength(2)
    expect(split.replicas).toEqual([])
  })

  it('lists nothing that is not a paired channel', () => {
    const split = splitPairedChannels([
      { ...rowWithRole('replica_source'), connectionStatus: 'available' },
      { ...rowWithRole('replica_source'), channelId: '' },
      { ...rowWithRole('helper'), connectionStatus: 'available' },
    ])
    expect(split).toEqual({ participants: [], replicas: [] })
  })

  it('does not drop a channel whose role predates the field', () => {
    // Legacy rows carry no `peerRole`. They are participant channels — the same
    // reading `isShareTarget` gives them — not replicas, and not nothing.
    const legacy: PairedParticipant = { ...EXISTING, peerRole: undefined }
    const split = splitPairedChannels([legacy])
    expect(split.participants).toEqual([legacy])
    expect(split.replicas).toEqual([])
  })
})

describe('peerRoleFromKind', () => {
  // The peer's role is the complement of the local one the event reports.
  // Reading a replica kind through the participant fallback would report
  // `helper`, and `isShareTarget` would then accept the row — the exact defect
  // this feature was built around.
  it.each([
    [SenderKind.Helper, 'owner'],
    [SenderKind.Owner, 'helper'],
    [SenderKind.ReplicaSource, 'replica_destination'],
    [SenderKind.ReplicaDestination, 'replica_source'],
  ])('maps kind %s to peer role %s', (kind, expected) => {
    expect(peerRoleFromKind(kind)).toBe(expected)
  })
})

describe('applyPairingCompleted', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('adds a flagged row for a ReplicaSource pairing that is not a share target', () => {
    const next = applyPairingCompleted(owner(), event(SenderKind.ReplicaSource), deps())

    const added = next.participants.find(p => p.channelId === '1234')
    expect(added?.peerRole).toBe('replica_destination')
    expect(added && isShareTarget(added)).toBe(false)
    expect(next.participants.filter(isShareTarget).map(p => p.channelId)).toEqual(['900'])
  })

  it('adds a flagged row for a ReplicaDestination pairing that is not a share target', () => {
    const next = applyPairingCompleted(owner(), event(SenderKind.ReplicaDestination), deps())

    const added = next.participants.find(p => p.channelId === '1234')
    expect(added?.peerRole).toBe('replica_source')
    expect(added && isShareTarget(added)).toBe(false)
    expect(next.participants.filter(isShareTarget).map(p => p.channelId)).toEqual(['900'])
  })

  it('does not add a second row when the same replica completion is delivered twice', () => {
    const once = applyPairingCompleted(owner(), event(SenderKind.ReplicaSource), deps())
    const twice = applyPairingCompleted(once, event(SenderKind.ReplicaSource), deps())

    expect(twice.participants.filter(p => p.channelId === '1234')).toHaveLength(1)
    expect(twice.participants.filter(isShareTarget).map(p => p.channelId)).toEqual(['900'])
  })

  it('still settles the pending pairing for a replica channel', () => {
    const next = applyPairingCompleted(owner(), event(SenderKind.ReplicaSource), deps())

    expect(next.pendingPairings).toEqual([])
  })

  it.each([SenderKind.ReplicaSource, SenderKind.ReplicaDestination])(
    'announces the established channel so the fingerprint modal can raise itself (kind %s)',
    kind => {
      const d = deps()

      applyPairingCompleted(owner(), event(kind), d)

      // Both sides get this event, so both sides raise the comparison. A device
      // that is never told cannot confirm, and an unconfirmed channel is dropped.
      expect(d.onReplicaChannelEstablished).toHaveBeenCalledWith('1234')
    },
  )

  it('does not announce anything for a participant pairing', () => {
    const d = deps()

    applyPairingCompleted(owner(), event(SenderKind.Helper), d)

    expect(d.onReplicaChannelEstablished).not.toHaveBeenCalled()
  })

  // Control: without this the assertions above would pass even if the fold
  // stopped adding rows altogether.
  it('does add a participant row for a non-replica pairing', () => {
    const next = applyPairingCompleted(owner(), event(SenderKind.Helper), deps())

    const added = next.participants.find(p => p.channelId === '1234')
    expect(added).toBeDefined()
    expect(added?.peerRole).toBe('owner')
  })
})

/**
 * The other half: the channel record the replica projection is built from.
 *
 * This fold is the only point at which *both* sides of a handshake are
 * observed, and a browser replica leaves nothing distinguishing on the actor
 * roster — so if
 * the channel is not recorded here it is not recorded anywhere, and neither the
 * row's status nor its expiry deadline exists.
 */
describe('applyPairingCompleted — replica channel record', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  /** The rows the replica projection would render from what the fold persisted. */
  function rows() {
    return replicaViews(
      // Only owner actors: exactly what a browser replica looks like on the
      // roster. Nothing here can produce a replica row on its own.
      [
        {
          id: 'owner-1',
          role: 'owner',
          name: 'Alice',
          transport: { protocol: 'https', uri: 'https://example.test/owner-1' },
          secret_id: '42',
        },
      ],
      loadReplicaState('owner-1'),
    )
  }

  it('records this device as the source when it declared ReplicaSource', () => {
    applyPairingCompleted(owner(), event(SenderKind.ReplicaSource), deps())

    expect(loadReplicaState('owner-1').channels).toEqual({
      '1234': {
        channelId: '1234',
        role: 'replica_source',
        peerName: 'Second device',
        establishedAt: expect.any(Number),
      },
    })
  })

  it('stamps when the channel was established, so its expiry can be warned about', () => {
    // The library drops a channel still `Pending` after the protocol timeout,
    // measured from the channel's creation — and it does not expose
    // `created_at`. This event *is* that creation observed here, so it is the
    // only point at which the app can record a start time at all. Without it
    // nothing can tell the user a channel is about to be dropped.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-10T12:00:00Z'))
    try {
      applyPairingCompleted(owner(), event(SenderKind.ReplicaSource), deps())
    } finally {
      vi.useRealTimers()
    }

    expect(loadReplicaState('owner-1').channels['1234']?.establishedAt).toBe(
      Date.parse('2026-08-10T12:00:00Z'),
    )
  })

  it('does not stamp — or record anything — for a non-replica pairing', () => {
    // The stamp lives inside the replica branch, behind the same early return
    // that keeps a replica channel out of the participant roster. A helper
    // pairing must reach neither.
    applyPairingCompleted(owner(), event(SenderKind.Helper), deps())

    expect(loadReplicaState('owner-1').channels).toEqual({})
  })

  it('records this device as the destination when it declared ReplicaDestination', () => {
    // `kind` is the *local* party's role. Reading it as the peer's would invert
    // every row and point the erase warning at the wrong device.
    applyPairingCompleted(owner(), event(SenderKind.ReplicaDestination), deps())

    expect(loadReplicaState('owner-1').channels['1234']?.role).toBe('replica_destination')
  })

  it('records nothing for a non-replica pairing', () => {
    applyPairingCompleted(owner(), event(SenderKind.Helper), deps())

    expect(loadReplicaState('owner-1').channels).toEqual({})
    expect(rows()).toEqual([])
  })

  it('surfaces the recorded channel as a replica row', () => {
    // End to end for this task: a browser replica pairing completes and the
    // panel has something to render, which is what makes the fingerprint
    // confirmation reachable at all.
    applyPairingCompleted(owner(), event(SenderKind.ReplicaSource), deps())

    const [row] = rows()
    expect(row).toMatchObject({
      channelId: '1234',
      name: 'Second device',
      status: 'pending',
      provisioned: false,
      direction: 'replica_source',
    })
  })
})

describe('canDrivePeerViaBackend', () => {
  it('is true for a provisioned peer the roster knows', () => {
    expect(
      canDrivePeerViaBackend({
        id: '268e44d2-ea53-41f2-ae3e-e176cbb8339c',
        browserManaged: false,
      }),
    ).toBe(true)
  })

  it('is false for a browser peer, which confirms on its own screen', () => {
    expect(
      canDrivePeerViaBackend({
        id: '268e44d2-ea53-41f2-ae3e-e176cbb8339c',
        browserManaged: true,
      }),
    ).toBe(false)
  })

  it('is false for a synthetic row even though `browserManaged` is undefined', () => {
    // The regression this exists for. A peer that pairs without appearing on
    // the roster — a second browser, or a phone — gets a `peer-<channelId>` id
    // and no `browserManaged` flag at all. Reading `!row.browserManaged` calls
    // that "provisioned" and sends the id to an endpoint expecting a UUID:
    //
    //   actor fingerprint failed: 400
    //   Cannot parse `actor_id` with value `peer-7309387836687491522`
    expect(canDrivePeerViaBackend({ id: syntheticPeerId('7309387836687491522') })).toBe(false)
  })

  it('is false for a missing row', () => {
    expect(canDrivePeerViaBackend(undefined)).toBe(false)
  })
})
