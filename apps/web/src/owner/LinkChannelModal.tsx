import { useState } from 'react'
import { pairingRoleLabel } from '../pairingRoleOptions'
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
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="link-channel-title">
      <div className="modal">
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
                    <span className="link-channel-option__meta">channel {c.channelId}</span>
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
      </div>
    </div>
  )
}
