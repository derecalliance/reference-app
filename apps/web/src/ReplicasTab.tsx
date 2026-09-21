import type { ReplicaChannel } from './ownerPairing'
import { ReplicaChannelRow } from './ReplicaChannelRow'
import type { ReplicaView } from './replicaFlows'
import type { ReplicaRowSyncNotice } from './replicaSyncNotice'
import type { StoredReplicaMember } from './stores'

/**
 * The Replicas tab — every replica this owner knows about, in one place.
 *
 * A replica is a channel, but it is not a *participant* channel: it never
 * receives a share and cannot be linked to one. Mixing the two in the main
 * channel list made a replica look like somewhere a share might go, so replicas
 * are listed here and nowhere else — the page feeds this list and the main one
 * from a single `splitPairedChannels` call, so a channel is in exactly one.
 *
 * **This tab is a place to look at replicas, not a place verification hides.**
 * The fingerprint comparison, the pairing-request confirmation and the adoption
 * offer are all modals mounted at page level, and they raise themselves whether
 * or not this tab has ever been opened. Nothing in this file renders, gates or
 * owns them; it only offers a standing way *back* into the fingerprint
 * comparison after the modal has been dismissed. Moving any of those dialogs in
 * here would recreate the bug this tab was rebuilt to avoid.
 */

export interface ReplicasTabProps {
  /** Paired replica channels, role already narrowed by `splitPairedChannels`. */
  channels: readonly ReplicaChannel[]
  /** Replica projection by channel id; a channel is missing until the poll lands. */
  viewByChannelId: ReadonlyMap<string, ReplicaView>
  /** Protocol timeout in seconds — the deadline an unconfirmed channel counts down to. */
  protocolTimeoutSecs: number
  /** The channel whose "Sync now" is in flight, or `null`. */
  syncingChannelId: string | null
  /** The sync message to show on a given row, or `null`. */
  syncNoticeFor: (view: ReplicaView) => ReplicaRowSyncNotice | null
  onDismissSyncNotice: () => void
  onOpenFingerprint: (channelId: string) => void
  onSyncNow: (view: ReplicaView) => void
  /**
   * Drop a row from this device alone, by channel id.
   *
   * Not a teardown and not a substitute for `onRemoveFromGroup`: the peer is
   * never told. It exists because a replica has no channel-level unpair, so a
   * row the protocol will not act on — a pairing that never announced a replica
   * id, most often one that failed — has no other way off the screen.
   */
  onForget: (channelId: string, name: string) => void
  /**
   * Ask the group which version its members hold and catch up if behind.
   *
   * Group-wide rather than per-row — the flow takes no parameters, reading the
   * group and this device's version from the stores — so it belongs on the
   * section header, not on a channel.
   */
  onReplicaDiscovery: () => void
  /** True while a discovery round is in flight. */
  replicaDiscoveryRunning: boolean
  /**
   * Evict a member from the group by its replica id.
   *
   * The only teardown the protocol offers for a replica, and it names a
   * *member* rather than a channel — every member of a group answers on one
   * shared channel. Unavailable until `ReplicaPaired` has announced that id,
   * which is why `onForget` exists beside it.
   */
  onRemoveFromGroup: (view: ReplicaView) => void
  /** Replica ids whose removal is in flight. */
  removingReplicaIds: ReadonlySet<string>
  /**
   * Suspend or resume message delivery to a row's peer.
   *
   * Only ever called for a row whose peer is a provisioned helper — the row
   * offers no control otherwise, because there is no actor to suspend.
   */
  onToggleOffline: (view: ReplicaView) => void
  /**
   * Members the library still holds that no row above accounts for.
   *
   * Shown because they are otherwise invisible and still consequential: a
   * member occupies its replica id whether or not the app remembers it, and the
   * peer holding that id is refused on every attempt to pair again.
   */
  orphanedMembers: readonly StoredReplicaMember[]
  /** Evict an orphan by its replica id. */
  onRemoveOrphan: (member: StoredReplicaMember) => void
}

export function ReplicasTab({
  channels,
  viewByChannelId,
  protocolTimeoutSecs,
  syncingChannelId,
  syncNoticeFor,
  onDismissSyncNotice,
  onOpenFingerprint,
  onSyncNow,
  onForget,
  onReplicaDiscovery,
  replicaDiscoveryRunning,
  onRemoveFromGroup,
  removingReplicaIds,
  onToggleOffline,
  orphanedMembers,
  onRemoveOrphan,
}: ReplicasTabProps) {
  const orphans = (
    <OrphanedMembers
      members={orphanedMembers}
      removingReplicaIds={removingReplicaIds}
      onRemove={onRemoveOrphan}
    />
  )

  if (channels.length === 0) {
    return (
      <>
        <p className="tab-empty-state">
          No replicas yet. A replica is another of your own devices that mirrors this whole
          vault instead of holding a share of it. Add a hosted one under “Replicas” in the
          side panel, or pair another browser as a replica with the Pair button above.
        </p>
        {/* Deliberately rendered even with no channels: an orphan with no row
            is exactly the case where the tab would otherwise say "no replicas"
            while the protocol still refuses to let one pair. */}
        {orphans}
      </>
    )
  }

  return (
    <div className="replicas-tab">
      <div className="replicas-tab-section">
        <div className="section-header-row">
          <h3 className="sub-heading">Replica channels</h3>
          <button
            className="secondary side-action-btn"
            onClick={onReplicaDiscovery}
            disabled={replicaDiscoveryRunning}
            title="Ask the group which version each member holds, and catch up if this device is behind"
          >
            {replicaDiscoveryRunning ? 'Checking…' : 'Check sync'}
          </button>
        </div>
        <div className="channel-table">
          {channels.map(channel => {
            const view = viewByChannelId.get(channel.channelId) ?? null
            return (
              <ReplicaChannelRow
                key={channel.channelId}
                name={channel.name}
                channelId={channel.channelId}
                peerRole={channel.peerRole}
                view={view}
                protocolTimeoutSecs={protocolTimeoutSecs}
                syncing={syncingChannelId === channel.channelId}
                // A protect round is global, so one in flight anywhere blocks
                // every row's request.
                syncBlocked={syncingChannelId !== null}
                syncNotice={view ? syncNoticeFor(view) : null}
                onDismissSyncNotice={onDismissSyncNotice}
                onOpenFingerprint={() => onOpenFingerprint(channel.channelId)}
                onSyncNow={() => view && onSyncNow(view)}
                onForget={() => onForget(channel.channelId, channel.name)}
                // Only offered once the peer's replica id is known: the flow
                // names the member, and every member shares this channel, so
                // without it there is nothing to name.
                canRemoveFromGroup={view?.peerReplicaId != null}
                removingFromGroup={
                  view?.peerReplicaId != null && removingReplicaIds.has(view.peerReplicaId)
                }
                onRemoveFromGroup={() => view && onRemoveFromGroup(view)}
                // Offered only for a peer the `/helpers` endpoints will
                // accept, which is exactly what a non-null id means.
                canToggleOffline={view?.helperActorId != null}
                offline={view?.offline === true}
                onToggleOffline={() => view && onToggleOffline(view)}
              />
            )
          })}
        </div>
      </div>
      {orphans}
    </div>
  )
}

/**
 * Group members the app cannot otherwise account for.
 *
 * Renders nothing when there are none, which is the normal state — this is a
 * diagnostic, and a heading over an empty list would imply the group is
 * routinely inconsistent when it is not.
 */
function OrphanedMembers({
  members,
  removingReplicaIds,
  onRemove,
}: {
  members: readonly StoredReplicaMember[]
  removingReplicaIds: ReadonlySet<string>
  onRemove: (member: StoredReplicaMember) => void
}) {
  if (members.length === 0) return null

  return (
    <div className="replicas-tab-section">
      <h3 className="sub-heading">Group members with no channel</h3>
      <p className="tab-section-note">
        The protocol still counts these as members of the replica group, but nothing on
        this page corresponds to them — a pairing that was forgotten or never completed.
        Each one holds its replica id, so the device behind it is refused with{' '}
        <em>“replica id is already in use by another member of the group”</em> every time it
        tries to pair again. Removing one here frees the id.
      </p>
      <div className="channel-table">
        {members.map(member => {
          const removing = removingReplicaIds.has(member.replicaId)
          return (
            <div className="channel-block" key={member.replicaId}>
              <div className="channel-row-top">
                <span className="participant-dot available" aria-hidden="true" />
                <span className="channel-row-name" style={{ flex: 'none' }}>
                  {member.name ?? 'Unnamed device'}
                </span>
                {member.role && <span className="role-tag">{member.role}</span>}
                <span className="channel-id-inline">replica {member.replicaId}</span>
                <span style={{ flex: 1 }} />
                <span className="status-tag available">{member.status}</span>
                <button
                  className="channel-unpair-btn"
                  onClick={() => onRemove(member)}
                  disabled={removing}
                  aria-busy={removing || undefined}
                  title="Evict this member so its replica id is free again"
                >
                  {removing ? 'Removing…' : 'Remove from group'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
