import { pairingRoleLabel } from './pairingRoleOptions'
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
  /**
   * Provisioned replicas with no channel yet.
   *
   * Listed so the tab is not lying by omission — a replica that exists but has
   * never been paired still belongs in a list of replicas. It is a listing only:
   * pairing, adding and taking a replica offline stay in the side panel, beside
   * the provisioned participants they mirror.
   */
  awaitingPairing: readonly ReplicaView[]
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
  onSyncCheck: () => void
  /** `null` when no check is running. */
  syncCheckRunning: boolean
  /**
   * Evict a member from the group by its replica id.
   *
   * Distinct from `onUnpair`, which tears down a channel: this removes a
   * *member* from the roster the group publishes.
   */
  onRemoveFromGroup: (view: ReplicaView) => void
  /** Replica ids whose removal is in flight. */
  removingReplicaIds: ReadonlySet<string>
}

export function ReplicasTab({
  channels,
  awaitingPairing,
  viewByChannelId,
  protocolTimeoutSecs,
  syncingChannelId,
  unpairingChannelIds,
  syncNoticeFor,
  onDismissSyncNotice,
  onOpenFingerprint,
  onSyncNow,
  onUnpair,
  onSyncCheck,
  syncCheckRunning,
  onRemoveFromGroup,
  removingReplicaIds,
}: ReplicasTabProps) {
  if (channels.length === 0 && awaitingPairing.length === 0) {
    return (
      <p className="tab-empty-state">
        No replicas yet. A replica is another of your own devices that mirrors this whole
        vault instead of holding a share of it. Add a hosted one under “Provisioned
        replicas”, or pair another browser as a replica with the Pair button above.
      </p>
    )
  }

  return (
    <div className="replicas-tab">
      <div className="replicas-tab-section">
        <div className="section-header-row">
          <h3 className="sub-heading">Replica channels</h3>
          {channels.length > 0 && (
            <button
              className="secondary side-action-btn"
              onClick={onSyncCheck}
              disabled={syncCheckRunning}
              title="Ask the group which version each member holds, and catch up if this device is behind"
            >
              {syncCheckRunning ? 'Checking…' : 'Check sync'}
            </button>
          )}
        </div>
        {channels.length === 0 ? (
          <p className="tab-empty-state">
            No replica channels yet. Pair a provisioned replica from the side panel, or
            pair another browser as a replica.
          </p>
        ) : (
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
                />
              )
            })}
          </div>
        )}
      </div>

      {awaitingPairing.length > 0 && (
        <div className="replicas-tab-section">
          <div className="section-header-row">
            <h3 className="sub-heading">Provisioned, not paired yet</h3>
          </div>
          <div className="channel-table">
            {awaitingPairing.map(replica => (
              <AwaitingPairingRow key={replica.id} replica={replica} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * A provisioned replica that has never completed a handshake.
 *
 * It has no channel, so there is nothing to confirm, sync or unpair — the row
 * says what it is and points at the one place that can act on it. Duplicating
 * the pair action here would mean duplicating its busy and error handling too,
 * for a control that already sits a few centimetres away.
 */
function AwaitingPairingRow({ replica }: { replica: ReplicaView }) {
  return (
    <div className="channel-block">
      <div className="channel-row-top">
        <span
          className={`participant-dot ${replica.offline ? 'offline' : 'available'}`}
          aria-hidden="true"
        />
        <span className="channel-row-name" style={{ flex: 'none' }}>
          {replica.name}
        </span>
        <span className={`role-tag role-tag--${replica.direction}`}>
          {/* The direction recorded for a replica that has not paired is what it
              *will* be, so it is stated as this device's side rather than the
              peer's — there is no peer yet. */}
          This device: {pairingRoleLabel(replica.direction)}
        </span>
        <span style={{ flex: 1 }} />
        {replica.offline && <span className="status-tag offline">Offline</span>}
        <span className="status-tag available">Not paired</span>
      </div>
      <div className="channel-row-bottom">
        <div className="channel-prop">
          <span className="channel-prop-label">Mirror</span>
          <span className="channel-prop-value">
            Nothing mirrored yet. Pair it under “Provisioned replicas” in the side panel;
            both devices then confirm a shared code before anything moves.
          </span>
        </div>
      </div>
    </div>
  )
}
