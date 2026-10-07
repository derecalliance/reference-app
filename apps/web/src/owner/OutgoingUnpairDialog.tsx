// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState } from 'react'

import { ModalFrame } from '../ModalFrame'

export interface OutgoingUnpairConfirmation {
  participantId: string
  peerName: string
  channelId: string
  /**
   * Set when the unpair did not go through — it could not be sent, or the
   * peer never acknowledged it. The dialog then says why and offers to forget
   * the channel on this device alone.
   */
  failure?: string
}

interface OutgoingUnpairDialogProps {
  confirmation: OutgoingUnpairConfirmation
  /** The request is on the wire and the peer has not answered yet. */
  inFlight: boolean
  onCancel: () => void
  /** Send (or resend) the unpair request. */
  onConfirm: () => void
  /** Remove the channel from this device only, telling nobody. */
  onForget: () => void
}

/**
 * Ending a pairing from this side: the confirmation, the wait for the peer's
 * acknowledgement, and — when the unpair did not go through — the way out.
 *
 * A peer deleted from its node can never acknowledge an unpair, so without the
 * last step its channel could not be removed at all. Forgetting is offered only
 * then, and behind its own confirmation: it is one-sided, and a peer that still
 * exists keeps its half of the channel and any share it holds.
 */
export function OutgoingUnpairDialog({
  confirmation,
  inFlight,
  onCancel,
  onConfirm,
  onForget,
}: OutgoingUnpairDialogProps) {
  const [confirmingForget, setConfirmingForget] = useState(false)
  const { peerName, channelId, failure } = confirmation
  const title = inFlight
    ? 'Unpairing channel…'
    : confirmingForget
      ? 'Forget this channel?'
      : failure
        ? 'Unpair did not go through'
        : 'Unpair channel?'

  return (
    <ModalFrame
      overlayClassName="modal-overlay"
      className="modal"
      labelledBy="outgoing-unpair-confirm-title"
      onEscape={inFlight ? undefined : onCancel}
    >
      <div className="modal-header">
        <h2 className="modal-title" id="outgoing-unpair-confirm-title">
          {title}
        </h2>
      </div>
      <div className="modal-body">
        {inFlight ? (
          <p>
            Waiting for <strong>{peerName}</strong> to acknowledge the unpair on channel{' '}
            <code>{channelId}</code>.
          </p>
        ) : confirmingForget ? (
          <>
            <p>
              This removes channel <code>{channelId}</code> and everything this device keeps for
              it — the shared key and any shares stored under it — from <em>this device only</em>.
            </p>
            <p>
              <strong>{peerName}</strong> is not told. If it still exists it keeps its side of the
              channel, and any share it holds stays with it. This cannot be undone; pair again to
              reach it.
            </p>
          </>
        ) : failure ? (
          <>
            <p role="alert">{failure}</p>
            <p>
              If <strong>{peerName}</strong> is gone for good — deleted from its node, say — it can
              never acknowledge an unpair. You can instead forget the channel on this device.
            </p>
          </>
        ) : (
          <>
            <p>
              End the pairing with <strong>{peerName}</strong> on channel <code>{channelId}</code>?
            </p>
            <p>
              This drops the shared key, channel record, and any shares stored under this channel
              on <em>both</em> sides. The peer must acknowledge before the channel is torn down
              locally.
            </p>
          </>
        )}
        <div className="modal-actions">
          {confirmingForget ? (
            <>
              <button className="secondary" onClick={() => setConfirmingForget(false)} autoFocus>
                Back
              </button>
              <button className="danger" onClick={onForget}>
                Forget channel
              </button>
            </>
          ) : (
            <>
              <button className="secondary" onClick={onCancel} disabled={inFlight}>
                {failure ? 'Close' : 'Cancel'}
              </button>
              {failure && !inFlight && (
                <button className="danger" onClick={() => setConfirmingForget(true)}>
                  Forget this channel…
                </button>
              )}
              <button
                className="primary"
                onClick={onConfirm}
                disabled={inFlight}
                aria-busy={inFlight || undefined}
              >
                {inFlight ? (
                  <>
                    <span className="modal-btn-spinner" aria-hidden="true" />
                    Unpairing…
                  </>
                ) : failure ? (
                  'Try again'
                ) : (
                  'Unpair'
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </ModalFrame>
  )
}
