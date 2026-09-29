import type { ReplicaChannel } from './ownerPairing'
import { ReplicaChannelRow } from './ReplicaChannelRow'
import type { GroupMemberRow } from './owner/groupMembers'
import type { ReplicaView } from './replicaFlows'
import type { ReplicaRowSyncNotice } from './replicaSyncNotice'

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
  /**
   * Members of the group this device holds no channel of its own with.
   *
   * Rendered in the same list as the channels, because from the group's point
   * of view that is what they are: two destinations of one source never pair
   * with each other, yet both are members. Listing them apart described the
   * app's bookkeeping rather than the protocol.
   */
  memberRows: readonly GroupMemberRow[]
  /** Evict a member by its replica id. */
  onRemoveMember: (replicaId: string) => void
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
  memberRows,
  onRemoveMember,
}: ReplicasTabProps) {
  /**
   * Members with no direct channel, rendered as the ordinary rows they are.
   *
   * `viaGroupOnly` is what withholds the actions that need a pairing — there is
   * no fingerprint to compare with a peer this device never paired with, and
   * nothing to sync to it. Passing no-op handlers instead left those buttons on
   * screen doing nothing, and the row claiming a verification that never
   * happened. Eviction stays, because the library's removal names a member
   * rather than a channel.
   */
  const members = memberRows.map(member => (
    <ReplicaChannelRow
      key={member.replicaId}
      name={member.name}
      channelId={member.channelId}
      peerRole={member.peerRole}
      view={member.view}
      protocolTimeoutSecs={protocolTimeoutSecs}
      syncing={false}
      syncBlocked={syncingChannelId !== null}
      syncNotice={null}
      onDismissSyncNotice={onDismissSyncNotice}
      viaGroupOnly
      onOpenFingerprint={() => {}}
      onSyncNow={() => {}}
      onForget={() => {}}
      canRemoveFromGroup
      removingFromGroup={removingReplicaIds.has(member.replicaId)}
      onRemoveFromGroup={() => onRemoveMember(member.replicaId)}
      canToggleOffline={false}
      offline={false}
      onToggleOffline={() => {}}
    />
  ))

  // Members count as replicas here, not just channels. A device that belongs to
  // a group it has no direct channel with — a second destination of one source,
  // or a device whose rows were forgotten — would otherwise be told it has no
  // replicas while the protocol still holds its membership and refuses to pair
  // that id again.
  if (channels.length === 0 && memberRows.length === 0) {
    return (
      <p className="tab-empty-state">
        No replicas yet. A replica is another of your own devices that mirrors this whole
        vault instead of holding a share of it. Add a hosted one under “Replicas” in the
        side panel, or pair another browser as a replica with the Pair button above.
      </p>
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
          {members}
        </div>
      </div>
    </div>
  )
}

