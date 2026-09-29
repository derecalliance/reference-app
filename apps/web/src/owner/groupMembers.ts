import type { ReplicaPairingRole } from '../pairingRoles'
import { pairingRoleLabel } from '../pairingRoleOptions'
import type { ReplicaView } from '../replicaFlows'
import type { StoredReplicaMember } from '../stores'

/**
 * A replica-group member this device has no channel of its own with.
 *
 * Two destinations of the same source are in one group and never pair with each
 * other, so neither has a channel naming the other — yet each is a real member
 * of the group, on the one channel the members share. They used to be listed
 * apart, under "group members with no channel", which described the app's
 * bookkeeping rather than the protocol: from the group's point of view they are
 * ordinary members, and the screen should say so.
 *
 * What the row cannot offer is anything that needs a *direct* channel — there
 * is no fingerprint to compare with a peer this device never paired with, and
 * nothing to sync to it. Eviction still works, because the library's removal
 * names a member rather than a channel.
 */
export interface GroupMemberRow {
  /**
   * The member's replica id — the key.
   *
   * Not the channel: every member shares the group's one channel, so keying on
   * that would collapse the whole group into a single row.
   */
  replicaId: string
  name: string
  channelId: string
  /** Which side of the mirror this member is on, read from the group roster. */
  peerRole: ReplicaPairingRole
  view: ReplicaView
}

/** `Source` / `Destination`, as the roster spells it, to this app's role. */
function roleOf(member: StoredReplicaMember): ReplicaPairingRole {
  return member.role === 'Source' ? 'replica_source' : 'replica_destination'
}

/**
 * Rows for the group members this device holds no channel with.
 *
 * `known` names the members that already have a channel row, so a peer this
 * device *did* pair with is never listed twice — the channel row is richer, and
 * it is the one that can act.
 */
export function groupMemberRows(
  members: readonly StoredReplicaMember[],
  ownReplicaId: string,
  known: ReadonlySet<string>,
): GroupMemberRow[] {
  return members.flatMap(member => {
    if (member.replicaId === ownReplicaId) return []
    if (known.has(member.replicaId)) return []
    // Without the group channel there is nothing to render a channel-shaped row
    // against; the record is malformed rather than merely indirect.
    if (!member.channelId) return []

    const peerRole = roleOf(member)
    const name = member.name?.trim() || pairingRoleLabel(peerRole)

    return [{
      replicaId: member.replicaId,
      name,
      channelId: member.channelId,
      peerRole,
      view: {
        id: `replica-member:${member.replicaId}`,
        name,
        channelId: member.channelId,
        // The library's own status for the member, not an assumption. A member
        // it reports as paired is paired; anything else reads as pending.
        status: member.status === 'Paired' ? 'paired' : 'pending',
        // A backend flag this device cannot observe for a peer it never paired
        // with, so it can only read as online.
        offline: false,
        // Confirmation is a property of a pairing. There is none here, and
        // claiming one would be the row asserting something it cannot know.
        peerConfirmation: 'none',
        lastSync: null,
        establishedAt: null,
        firstSyncStarted: false,
        // This device's side of the mirror. `complementRole` widens to every
        // pairing role, so the two replica roles are named directly rather
        // than narrowed back from it.
        direction: peerRole === 'replica_source' ? 'replica_destination' : 'replica_source',
        peerReplicaId: member.replicaId,
        // No provisioned helper to name: the group roster carries replica ids,
        // not actor ids.
        helperActorId: null,
      },
    }]
  })
}
