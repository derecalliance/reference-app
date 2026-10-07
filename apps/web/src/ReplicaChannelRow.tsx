// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { pairingRoleLabel } from './pairingRoleOptions'
import {
  canRequestReplicaSync,
  isReplicaBehind,
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
  /**
   * This device, as the destination, is still fetching the peer's copy over
   * this channel — asking again until it lands. See `ReplicaCatchUp`.
   */
  catchingUp?: boolean
  /** Some row's sync is running — a protect round is global, so all are blocked. */
  syncBlocked: boolean
  /** The sync result this row should show, or `null`. */
  syncNotice: ReplicaRowSyncNotice | null
  onDismissSyncNotice: () => void
  onOpenFingerprint: () => void
  onSyncNow: () => void
  /**
   * Drop this row from *this device only*, telling the peer nothing.
   *
   * The escape hatch, and deliberately not a teardown: a replica has no
   * channel-level unpair — the library's only removal names a member, which
   * `onRemoveFromGroup` does — so a row whose pairing never announced a replica
   * id has nothing the protocol will act on. Without this it is unremovable.
   */
  onForget: () => void
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
  /**
   * Whether this row can simulate its peer going offline.
   *
   * `false` unless the peer is a provisioned helper: a browser peer has no
   * backend actor whose delivery could be suspended.
   */
  canToggleOffline: boolean
  /** Whether the peer is currently suspended. Meaningless unless `canToggleOffline`. */
  offline: boolean
  onToggleOffline: () => void
  /**
   * This peer is known only as a member of the group — there is no channel
   * between it and this device.
   *
   * Two destinations of one source are in the same group and never pair with
   * each other, so each is a real member with nothing direct to act on. Such a
   * row must not offer Forget (there is no local record to drop), Sync now
   * (there is no channel to send over) or a fingerprint (there is no comparison
   * to make), and above all must not report itself verified — the row would be
   * asserting a check that never happened. Eviction stays: the library's
   * removal names a member, not a channel.
   */
  viaGroupOnly?: boolean
  /**
   * The version this vault currently holds, or `null` before its first protect
   * round. What a source row's last acknowledgement is measured against: a
   * destination that missed a round while offline acked an older version, and
   * without the comparison its row read as current.
   */
  vaultVersion?: number | null
  /**
   * This device, as the destination on this row, already holds the peer's
   * vault — it adopted it, or has since been receiving its updates. Once that
   * is true the "offered" wording describes a decision already made.
   */
  holdsPeerVault?: boolean
}

/** The status word for a replica channel, with expiry outranking everything. */
function statusLabel(
  view: ReplicaView | null,
  expiry: ReplicaExpiry | null,
  catchingUp: boolean,
  behind: boolean,
): {
  text: string
  className: string
} {
  // An expired channel has been dropped by the protocol; "pending confirmation"
  // would describe something that is no longer waiting for anything.
  if (expiry?.state === 'expired') return { text: 'Expired', className: 'expired' }
  // A refusal outranks the pending prompt: nothing is waiting for an answer —
  // the answer was no.
  if (view?.refused) return { text: 'Codes didn’t match', className: 'expired' }
  // Declining to adopt is the same kind of answer: nothing is waiting on it.
  if (view?.adoptionDeclined) return { text: 'Adoption declined', className: 'expired' }
  if (catchingUp) return { text: 'Syncing…', className: 'syncing' }
  if (behind) return { text: 'Behind', className: 'available' }
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
function mirrorSummary(
  view: ReplicaView | null,
  name: string,
  catchingUp: boolean,
  vaultVersion: number | null,
  holdsPeerVault: boolean,
): string {
  if (!view) return 'Waiting for this device to project the channel.'
  if (view.direction === 'replica_destination') {
    if (catchingUp) {
      return `Getting ${name}’s copy of the vault — this device keeps asking until ${name} answers, which can take until they confirm the code on their screen. Nothing is erased until you accept it.`
    }
    // After adoption the offer is history: this vault *is* the peer's now,
    // and further versions apply without a prompt.
    if (holdsPeerVault) {
      return `This vault is ${name}’s${vaultVersion === null ? '' : `, at v${vaultVersion}`}. Versions ${name} publishes are applied here automatically.`
    }
    return 'This device is offered the peer’s vault. Nothing is erased until you accept an offer.'
  }
  if (!view.lastSync) {
    return 'Nothing acknowledged yet — the vault goes out on the next protect round.'
  }
  const acked = `acknowledged ${new Date(view.lastSync.syncedAt).toLocaleString()}`
  if (isReplicaBehind(view, vaultVersion)) {
    return `Behind: last mirrored v${view.lastSync.version} (${acked}), but this vault is at v${vaultVersion}. Use “Sync now” to send the current version.`
  }
  return `Mirrored v${view.lastSync.version}, ${acked}.`
}

export function ReplicaChannelRow({
  name,
  channelId,
  peerRole,
  view,
  protocolTimeoutSecs,
  syncing,
  catchingUp = false,
  syncBlocked,
  syncNotice,
  onDismissSyncNotice,
  onOpenFingerprint,
  onSyncNow,
  onForget,
  canRemoveFromGroup,
  removingFromGroup,
  onRemoveFromGroup,
  canToggleOffline,
  offline,
  onToggleOffline,
  viaGroupOnly = false,
  vaultVersion = null,
  holdsPeerVault = false,
}: ReplicaChannelRowProps) {
  // The countdown ticks in this row and nothing above it, and a row with
  // nothing pending never arms a timer at all.
  const expiry = useReplicaExpiry(
    { status: view?.status ?? 'pending', establishedAt: view?.establishedAt ?? null },
    protocolTimeoutSecs,
  )
  const status = viaGroupOnly
    ? { text: 'Group member', className: 'available' }
    : statusLabel(view, expiry, catchingUp, isReplicaBehind(view, vaultVersion))
  // A member with no channel is waiting for nothing: there is no comparison to
  // make and no deadline to miss, so neither the prompt nor the confirmed line
  // applies to it.
  const awaitingConfirmation = !viaGroupOnly && (view === null || view.status !== 'paired')
  const canSync = !viaGroupOnly && view !== null && canRequestReplicaSync(view)

  return (
    <div className="channel-block">
      <div className="channel-row-top">
        <span
          className={`participant-dot ${
            offline ? 'offline' : view?.status === 'paired' ? 'paired' : 'available'
          }`}
          aria-hidden="true"
        />
        <span className="channel-row-name" style={{ flex: 'none' }}>
          {name}
        </span>
        <span className={`role-tag role-tag--${peerRole}`}>{pairingRoleLabel(peerRole)}</span>
        <span className="channel-id-inline">{channelId}</span>
        <span className="channel-row-spacer" />
        {/* Polite live region: "Syncing…" clears on its own when the copy lands,
            and that change is worth announcing. */}
        <span className={`status-tag ${status.className}`} aria-live="polite">
          {status.text}
        </span>
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
        {/* The real teardown: a replica is removed from the group by *member*,
            never by channel — every member answers on the one shared channel,
            so there is no channel-level unpair for the protocol to run. */}
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
        {/* Simulates the peer dropping off the network. The channel survives —
            this suspends delivery to the helper, which is what makes a missed
            mirror observable without tearing anything down. */}
        {canToggleOffline && (
          <button
            className="channel-link-btn"
            onClick={onToggleOffline}
            title={
              offline
                ? `Resume message delivery to ${name}`
                : `Suspend message delivery to ${name}`
            }
          >
            {offline ? 'Go Online' : 'Go Offline'}
          </button>
        )}
        {/* Always offered, because it is the only action that cannot fail.
            "Remove from group" needs a member id the protocol may never have
            announced, and this row used to carry an "Unpair" that dispatched
            the *helper* unpair flow — which the library rejects on every
            replica channel, leaving a row nothing could clear. */}
        {!viaGroupOnly && (
          <button
            className="channel-link-btn"
            onClick={onForget}
            title={`Remove ${name} from this device's list without telling them`}
          >
            Forget
          </button>
        )}
      </div>

      {/*
        The standing way back into the fingerprint comparison. It is what makes
        the modal safe to dismiss: the channel stays `Pending`, the deadline
        keeps running, and nothing about the comparison is lost — it is simply
        not on screen until asked for.
      */}
      {awaitingConfirmation && view?.refused && (
        <div className="replica-row-notice replica-row-notice--error" role="status">
          <span className="replica-row-prompt__text">
            You reported that the codes did not match, so this device has not confirmed the
            channel and no vault moves across it. {name} is not told — the protocol has no
            message for a refusal — and may keep waiting. Remove the row and pair again; if
            you misread the codes, compare them again.
          </span>
          <button className="channel-link-btn" onClick={onOpenFingerprint}>
            Compare again
          </button>
        </div>
      )}

      {awaitingConfirmation && !view?.refused && view?.adoptionDeclined && (
        <div className="replica-row-notice replica-row-notice--error" role="status">
          <span className="replica-row-prompt__text">
            You declined to adopt {name}’s vault, so this device has not confirmed the channel and
            this vault is unchanged. {name} is not told. Remove the row, or confirm after all to
            adopt their vault.
          </span>
          <button className="channel-link-btn" onClick={onOpenFingerprint}>
            Reconsider
          </button>
        </div>
      )}

      {awaitingConfirmation && !view?.refused && !view?.adoptionDeclined && (
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

      {viaGroupOnly && (
        <div className="replica-row-prompt replica-row-prompt--quiet">
          <span className="replica-row-prompt__text">
            In the same replica group, through the source. This device has no channel of its
            own to {name}, so there is nothing here to verify or sync — only to evict.
          </span>
        </div>
      )}

      {!viaGroupOnly && !awaitingConfirmation && (
        <div className="replica-row-prompt replica-row-prompt--quiet">
          <span className="replica-row-prompt__text">
            Confirmed on this device
            {view?.peerConfirmation === 'protocol-verified'
              ? ' and by the peer.'
              : view?.helperActorId != null
                ? '. The peer confirms itself automatically, as a helper — this device cannot observe it.'
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

      {/* No mirror line for a member with no channel: the summary would say the
          vault "goes out on the next protect round", which contradicts the line
          above it — nothing is ever sent to a peer this device has no channel
          to. */}
      {!viaGroupOnly && (
        <div className="channel-row-bottom">
          <div className="channel-prop">
            <span className="channel-prop-label">Mirror</span>
            <span className="channel-prop-value">
              {mirrorSummary(view, name, catchingUp, vaultVersion, holdsPeerVault)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
