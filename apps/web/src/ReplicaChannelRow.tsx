import { pairingRoleLabel } from './pairingRoleOptions'
import {
  canRequestReplicaSync,
  type ReplicaExpiry,
  type ReplicaPairingRole,
  type ReplicaView,
} from './replicaFlows'
import type { ReplicaRowSyncNotice } from './replicaSyncNotice'
import { useReplicaExpiry } from './useReplicaExpiry'

/**
 * A replica channel, rendered in the Replicas tab.
 *
 * A replica is not a helper and never receives a share, so it is listed apart
 * from the participant channels rather than among them — but it *is* a channel,
 * and it is deliberately built from the same hand-rolled classes as the main
 * channel list rather than the MUI the replica dialogs use: two lists of
 * channels styled differently read as a bug.
 *
 * The row also carries the standing invitation to reopen the fingerprint modal.
 * That modal raises itself when the handshake completes, and it is dismissible —
 * which is only safe because dismissing it lands here, on a prompt that stays
 * put, with the same deadline still counting down.
 */

export interface ReplicaChannelRowProps {
  /** Display name for the peer on the other end of the channel. */
  name: string
  channelId: string
  /**
   * The peer's role — which side of the mirror *they* are on.
   *
   * Narrowed to the replica roles rather than taking `ChannelRole`: this row is
   * only ever reachable for a replica channel, and a type that admitted
   * `'helper'` would let a participant channel be rendered here badge and all.
   */
  peerRole: ReplicaPairingRole
  /**
   * The replica projection for this channel, or `null` until the roster poll
   * has produced one. `null` reads as "paired, not yet confirmed", never as
   * confirmed: the row must not be able to claim a verification it cannot see.
   */
  view: ReplicaView | null
  /** Protocol timeout in seconds — the deadline an unconfirmed channel counts down to. */
  protocolTimeoutSecs: number
  /** This row's own sync is running. */
  syncing: boolean
  /** Some row's sync is running — a protect round is global, so all are blocked. */
  syncBlocked: boolean
  /** An unpair request for this channel is in flight. */
  unpairing: boolean
  /** The sync result this row should show, or `null`. */
  syncNotice: ReplicaRowSyncNotice | null
  onDismissSyncNotice: () => void
  onOpenFingerprint: () => void
  onSyncNow: () => void
  onUnpair: () => void
  /**
   * Whether this row can be evicted from the replica group.
   *
   * `false` until the peer's replica id is known — the flow names a *member*,
   * and every member of a group answers on this one channel, so the channel id
   * cannot stand in for it.
   */
  canRemoveFromGroup: boolean
  /** A removal for this member is in flight. */
  removingFromGroup: boolean
  onRemoveFromGroup: () => void
}

/** The status word for a replica channel, with expiry outranking everything. */
function statusLabel(view: ReplicaView | null, expiry: ReplicaExpiry | null): {
  text: string
  className: string
} {
  // An expired channel has been dropped by the protocol; "pending confirmation"
  // would describe something that is no longer waiting for anything.
  if (expiry?.state === 'expired') return { text: 'Expired', className: 'expired' }
  if (view?.status === 'paired') return { text: 'Verified', className: 'paired' }
  return { text: 'Pending confirmation', className: 'available' }
}

/** Whole seconds as `m:ss`. */
function formatRemaining(secs: number): string {
  const minutes = Math.floor(secs / 60)
  return `${minutes}:${String(secs - minutes * 60).padStart(2, '0')}`
}

/**
 * The deadline in words, for the row.
 *
 * The dialog's `ReplicaExpiryNotice` says the same thing at length and in MUI;
 * this is the one-line form the channel list has room for. Both read the same
 * `replicaChannelExpiry`, so they cannot disagree about the deadline itself.
 */
function expiryText(expiry: ReplicaExpiry): string {
  if (expiry.state === 'expired') {
    return 'This channel expired before both devices confirmed — the protocol has dropped it. Pair again.'
  }
  const left = formatRemaining(expiry.remainingSecs)
  return expiry.state === 'expiring-soon'
    ? `Expiring in ${left} — confirm on both devices now, or the channel is dropped.`
    : `Confirm within ${left}, or the protocol drops this channel and you have to pair again.`
}

/** What this row mirrors, and in which direction. */
function mirrorSummary(view: ReplicaView | null): string {
  if (!view) return 'Waiting for this device to project the channel.'
  if (view.direction === 'replica_destination') {
    return 'This device is offered the peer’s vault. Nothing is erased until you accept an offer.'
  }
  if (!view.lastSync) {
    return 'Nothing mirrored yet — it goes out on the next protect round.'
  }
  return `Mirrored v${view.lastSync.version}, acknowledged ${new Date(
    view.lastSync.syncedAt,
  ).toLocaleString()}.`
}

export function ReplicaChannelRow({
  name,
  channelId,
  peerRole,
  view,
  protocolTimeoutSecs,
  syncing,
  syncBlocked,
  unpairing,
  syncNotice,
  onDismissSyncNotice,
  onOpenFingerprint,
  onSyncNow,
  onUnpair,
  canRemoveFromGroup,
  removingFromGroup,
  onRemoveFromGroup,
}: ReplicaChannelRowProps) {
  // The countdown ticks in this row and nothing above it, and a row with
  // nothing pending never arms a timer at all.
  const expiry = useReplicaExpiry(
    { status: view?.status ?? 'pending', establishedAt: view?.establishedAt ?? null },
    protocolTimeoutSecs,
  )
  const status = statusLabel(view, expiry)
  const awaitingConfirmation = view === null || view.status !== 'paired'
  const canSync = view !== null && canRequestReplicaSync(view)

  return (
    <div className="channel-block">
      <div className="channel-row-top">
        <span
          className={`participant-dot ${view?.status === 'paired' ? 'paired' : 'available'}`}
          aria-hidden="true"
        />
        <span className="channel-row-name" style={{ flex: 'none' }}>
          {name}
        </span>
        <span className={`role-tag role-tag--${peerRole}`}>{pairingRoleLabel(peerRole)}</span>
        <span className="channel-id-inline">{channelId}</span>
        <span style={{ flex: 1 }} />
        <span className={`status-tag ${status.className}`}>{status.text}</span>
        {canSync && (
          <button
            className="channel-link-btn"
            onClick={onSyncNow}
            disabled={syncBlocked}
            aria-label={`Send this vault to ${name} now`}
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        )}
        {/* Distinct from Unpair: that tears down this channel, while this
            removes the member from the roster the group publishes. */}
        {canRemoveFromGroup && (
          <button
            className="channel-unpair-btn"
            onClick={onRemoveFromGroup}
            disabled={removingFromGroup}
            aria-busy={removingFromGroup || undefined}
            title="Evict this device from the replica group"
          >
            {removingFromGroup ? 'Removing…' : 'Remove from group'}
          </button>
        )}
        <button
          className="channel-unpair-btn"
          onClick={onUnpair}
          disabled={unpairing}
          aria-busy={unpairing || undefined}
        >
          {unpairing ? 'Unpairing…' : 'Unpair'}
        </button>
      </div>

      {/*
        The standing way back into the fingerprint comparison. It is what makes
        the modal safe to dismiss: the channel stays `Pending`, the deadline
        keeps running, and nothing about the comparison is lost — it is simply
        not on screen until asked for.
      */}
      {awaitingConfirmation && (
        <div className="replica-row-prompt" role="status">
          <span className="replica-row-prompt__text">
            Not confirmed yet. Compare the code on both devices — until this device confirms,
            the channel stays pending and no vault moves across it.
            {expiry && ` ${expiryText(expiry)}`}
          </span>
          <button
            className="primary small replica-row-prompt__action"
            onClick={onOpenFingerprint}
          >
            Confirm fingerprint
          </button>
        </div>
      )}

      {!awaitingConfirmation && (
        <div className="replica-row-prompt replica-row-prompt--quiet">
          <span className="replica-row-prompt__text">
            Confirmed on this device
            {view?.peerConfirmation === 'protocol-verified'
              ? ' and by the peer.'
              : '. The peer confirms on its own screen, which this device cannot see.'}
          </span>
          <button className="channel-link-btn" onClick={onOpenFingerprint}>
            View fingerprint
          </button>
        </div>
      )}

      {syncNotice && (
        <div
          className={`replica-row-notice replica-row-notice--${syncNotice.severity}`}
          role={syncNotice.severity === 'error' ? 'alert' : 'status'}
        >
          <span className="replica-row-prompt__text">{syncNotice.message}</span>
          <button
            className="channel-link-btn"
            onClick={onDismissSyncNotice}
            aria-label="Dismiss this sync message"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="channel-row-bottom">
        <div className="channel-prop">
          <span className="channel-prop-label">Mirror</span>
          <span className="channel-prop-value">{mirrorSummary(view)}</span>
        </div>
      </div>
    </div>
  )
}
