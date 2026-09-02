import type { ReplicaChannel } from './ownerPairing'
import { ReplicaChannelRow } from './ReplicaChannelRow'
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
  /** Channels whose unpair request is in flight. */
  unpairingChannelIds: ReadonlySet<string>
  /** The sync message to show on a given row, or `null`. */
  syncNoticeFor: (view: ReplicaView) => ReplicaRowSyncNotice | null
  onDismissSyncNotice: () => void
  onOpenFingerprint: (channelId: string) => void
  onSyncNow: (view: ReplicaView) => void
  onUnpair: (participantId: string) => void
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
   * Distinct from `onUnpair`, which tears down a channel: this removes a
   * *member* from the roster the group publishes.
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
}

export function ReplicasTab({
  channels,
  viewByChannelId,
  protocolTimeoutSecs,
  syncingChannelId,
  unpairingChannelIds,
  syncNoticeFor,
  onDismissSyncNotice,
  onOpenFingerprint,
  onSyncNow,
  onUnpair,
  onReplicaDiscovery,
  replicaDiscoveryRunning,
  onRemoveFromGroup,
  removingReplicaIds,
  onToggleOffline,
}: ReplicasTabProps) {
  if (channels.length === 0) {
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
                unpairing={unpairingChannelIds.has(channel.channelId)}
                syncNotice={view ? syncNoticeFor(view) : null}
                onDismissSyncNotice={onDismissSyncNotice}
                onOpenFingerprint={() => onOpenFingerprint(channel.channelId)}
                onSyncNow={() => view && onSyncNow(view)}
                onUnpair={() => onUnpair(channel.id)}
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
    </div>
  )
}
