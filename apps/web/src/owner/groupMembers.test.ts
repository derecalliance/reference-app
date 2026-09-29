import { describe, expect, it } from 'vitest'

import type { StoredReplicaMember } from '../stores'
import { groupMemberRows } from './groupMembers'

/**
 * Members of a replica group this device never paired with.
 *
 * Two destinations of one source are in the same group and have no channel
 * between them, so neither appears in the other's channel records — yet both
 * are members, on the one channel the group shares. They used to be listed
 * apart under "group members with no channel", which described the app's
 * bookkeeping rather than the protocol.
 */
describe('groupMemberRows', () => {
  const GROUP_CHANNEL = '2335620354810298024'

  function member(over: Partial<StoredReplicaMember> = {}): StoredReplicaMember {
    return {
      replicaId: '1001',
      channelId: GROUP_CHANNEL,
      role: 'Destination',
      status: 'Paired',
      name: 'Bob',
      ...over,
    }
  }

  it('renders a member this device has no channel with', () => {
    const [row] = groupMemberRows([member()], '2002', new Set())

    expect(row.replicaId).toBe('1001')
    expect(row.name).toBe('Bob')
    expect(row.channelId).toBe(GROUP_CHANNEL)
    expect(row.peerRole).toBe('replica_destination')
    expect(row.view.status).toBe('paired')
  })

  it('never lists this device as a member of its own group', () => {
    expect(groupMemberRows([member({ replicaId: '2002' })], '2002', new Set())).toHaveLength(0)
  })

  it('leaves out members that already have a channel row', () => {
    // The channel row is richer and is the one that can act, so listing the
    // member as well would duplicate the peer with a weaker row beside it.
    expect(groupMemberRows([member()], '2002', new Set(['1001']))).toHaveLength(0)
  })

  it('keys on the replica id, because the whole group shares one channel', () => {
    const rows = groupMemberRows(
      [member({ replicaId: '1001' }), member({ replicaId: '1003', name: 'Nick' })],
      '2002',
      new Set(),
    )

    // Keying on the channel would collapse the group into a single row.
    expect(rows.map(r => r.replicaId)).toEqual(['1001', '1003'])
    expect(new Set(rows.map(r => r.channelId))).toEqual(new Set([GROUP_CHANNEL]))
  })

  it('reads the source role from the roster', () => {
    const [row] = groupMemberRows([member({ role: 'Source', name: 'Alice' })], '2002', new Set())

    expect(row.peerRole).toBe('replica_source')
    // This device is whatever the member is not.
    expect(row.view.direction).toBe('replica_destination')
  })

  it('falls back to the role when the member sent no name', () => {
    const [row] = groupMemberRows([member({ name: null })], '2002', new Set())

    expect(row.name).toBeTruthy()
    expect(row.name).not.toBe('')
  })

  it('claims no confirmation for a peer it never paired with', () => {
    // There is no fingerprint to compare with a member this device has no
    // channel to; asserting one would be the row inventing a verification.
    const [row] = groupMemberRows([member()], '2002', new Set())

    expect(row.view.peerConfirmation).toBe('none')
    expect(row.view.helperActorId).toBeNull()
  })

  it('skips a member whose record carries no channel', () => {
    expect(groupMemberRows([member({ channelId: null })], '2002', new Set())).toHaveLength(0)
  })

  it('reports a member the library does not call paired as pending', () => {
    const [row] = groupMemberRows([member({ status: 'Pending' })], '2002', new Set())

    expect(row.view.status).toBe('pending')
  })
})
