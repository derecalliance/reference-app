// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { ModalFrame } from '../ModalFrame'
import { useEffect, useRef, useState } from 'react'
import type { ProvisionedChannel } from '../api'
import { errorText } from '../errorText'
import { ModalCloseButton } from './primitives'

/**
 * Operator-facing link picker for a provisioned helper.
 *
 * A provisioned helper has no UI of its own, so an operator stands in for the
 * authentication a real entity would perform (KYC, a call, meeting in person)
 * before declaring that a newly-paired channel belongs to an owner it already
 * helps. Nothing on the wire carries a trustworthy identity, so this is always
 * a human decision — the names below are labels, not proof.
 *
 * Until the link exists the helper cannot answer a Discovery request from the
 * re-paired owner, because it has no way to know which shares are theirs.
 */
export function ProvisionedLinkModal({
  participantName,
  myChannelId,
  loadChannels,
  onLink,
  onClose,
}: {
  participantName: string
  /** Our channel with this helper. The handshake rekey is symmetric, so this
   *  is the same id the helper holds for us. */
  myChannelId: string
  loadChannels: () => Promise<ProvisionedChannel[]>
  onLink: (linkToChannelId: string) => Promise<void>
  onClose: () => void
}) {
  const [channels, setChannels] = useState<ProvisionedChannel[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const didLoad = useRef(false)
  useEffect(() => {
    if (didLoad.current) return
    didLoad.current = true
    loadChannels()
      .then(setChannels)
      .catch((err: unknown) => {
        setError(errorText(err))
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Everything except our own channel — those are the other owners this helper
  // holds shares for, one of whom may be a previous identity of ours.
  const candidates = (channels ?? []).filter(c => c.channel_id !== myChannelId)
  const alreadyLinked = new Set(
    (channels ?? []).find(c => c.channel_id === myChannelId)?.linked_channel_ids ?? [],
  )

  async function handleConfirm() {
    if (!selected || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await onLink(selected)
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ModalFrame
      overlayClassName="modal-overlay"
      className="modal"
      labelledBy="provisioned-link-title"
      onEscape={onClose}
    >
      <div className="modal-header">
        <h2 className="modal-title" id="provisioned-link-title">
          Link on {participantName}
        </h2>
        <ModalCloseButton onClose={onClose} />
      </div>
      <div className="modal-body">
        <p className="modal-description">
          Tell <strong>{participantName}</strong> that your channel{' '}
          <span className="channel-id-inline">{myChannelId}</span> belongs to the
          same owner as one it already holds. Do this only after it would have
          authenticated you — it is the step that lets the helper answer your
          Discovery request.
        </p>

        {error && <p className="field-error">{error}</p>}

        {channels === null && !error && (
          <p className="modal-description">Loading channels…</p>
        )}

        {channels !== null && candidates.length === 0 && (
          <p className="tab-empty-state">
            {participantName} holds no other channels to link to.
          </p>
        )}

        {candidates.length > 0 && (
          <div className="link-channel-list" role="listbox" aria-label="Channels to link">
            {candidates.map(c => {
              const isSelected = selected === c.channel_id
              const linked = alreadyLinked.has(c.channel_id)
              return (
                <button
                  key={c.channel_id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`link-channel-option${isSelected ? ' link-channel-option--selected' : ''}`}
                  onClick={() => setSelected(c.channel_id)}
                  disabled={linked || submitting}
                >
                  <span className="link-channel-option__name">
                    {c.peer_name || 'Unnamed peer'}
                    {linked && <span className="status-tag">Already linked</span>}
                  </span>
                  <span className="link-channel-option__meta">channel {c.channel_id}</span>
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
