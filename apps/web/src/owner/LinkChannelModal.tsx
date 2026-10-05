// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { ModalFrame } from '../ModalFrame'
import { useState } from 'react'
import { pairingRoleLabel } from '../pairingRoleOptions'
import { transportLabel } from '../transportLabel'
import type { PairedParticipant } from '../types'

export function LinkChannelModal({
  sourceChannel,
  candidates,
  onConfirm,
  onClose,
}: {
  sourceChannel: PairedParticipant
  candidates: PairedParticipant[]
  onConfirm: (targetChannelId: string) => void | Promise<void>
  onClose: () => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleConfirm() {
    if (!selected || submitting) return
    setSubmitting(true)
    try {
      await onConfirm(selected)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ModalFrame
      overlayClassName="modal-overlay"
      className="modal"
      labelledBy="link-channel-title"
      onEscape={submitting ? undefined : onClose}
    >
      <div className="modal-header">
        <h2 className="modal-title" id="link-channel-title">Link Channel</h2>
      </div>
      <div className="modal-body">
        <p>
          Link <strong>{sourceChannel.name}</strong>{' '}
          <span className="channel-id-inline">{sourceChannel.channelId}</span>{' '}
          to another channel. Linked channels share their stored shares.
        </p>

        {candidates.length === 0 ? (
          <p className="tab-empty-state">No other channels available to link.</p>
        ) : (
          <div className="link-channel-list" role="listbox" aria-label="Channels to link">
            {candidates.map(c => {
              const isSelected = selected === c.channelId
              return (
                <button
                  key={c.channelId}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`link-channel-option${isSelected ? ' link-channel-option--selected' : ''}`}
                  onClick={() => setSelected(c.channelId)}
                >
                  <span className="link-channel-option__name">
                    {c.name}
                    {c.peerRole && (
                      <span className={`role-tag role-tag--${c.peerRole}`}>
                        {pairingRoleLabel(c.peerRole)}
                      </span>
                    )}
                  </span>
                  {/* Names repeat — several channels to "Bob" is the normal case
                      this dialog exists for — so each option also says how the
                      peer is reached, which is what tells two Bobs apart. */}
                  <span className="link-channel-option__meta">{candidateMeta(c)}</span>
                </button>
              )
            })}
          </div>
        )}

        <div className="modal-actions">
          <button className="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            className="primary"
            onClick={handleConfirm}
            disabled={!selected || submitting}
          >
            {submitting ? 'Linking…' : 'Link'}
          </button>
        </div>
      </div>
    </ModalFrame>
  )
}

/** The line under a candidate's name: its channel, transport and endpoint host. */
function candidateMeta(c: PairedParticipant): string {
  const parts = [`channel ${c.channelId}`, transportLabel(c.transport, c.transports)]
  const host = endpointHost(c.transport.uri)
  if (host) parts.push(host)
  return parts.join(' · ')
}

function endpointHost(uri: string): string | null {
  try {
    return uri ? new URL(uri).host : null
  } catch {
    return null
  }
}
