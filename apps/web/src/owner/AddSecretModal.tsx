import { SecretDataField } from './VerifySharesModal'
import { useState } from 'react'
import { errorText } from '../errorText'
import { ModalCloseButton } from './primitives'
import { isShareTarget } from '../ownerPairing'
import type { PairedParticipant, SecretBag } from '../types'

type AddSecretStatus =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'confirming'; participantIds: string[]; version: number }
  | { kind: 'error'; message: string }

export function AddSecretModal({
  participants,
  secretBag,
  threshold,
  onClose,
  onAddSecret,
}: {
  participants: PairedParticipant[]
  secretBag: SecretBag | null
  threshold: number
  onClose: () => void
  onAddSecret: (name: string, data: string) => Promise<number | null>
}) {
  // Only owner-role channels receive shares — see `isShareTarget`.
  const pairedParticipants = participants.filter(isShareTarget)

  const [form, setForm] = useState({ name: '', data: '' })
  const [status, setStatus] = useState<AddSecretStatus>({ kind: 'idle' })

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim() || !form.data.trim()) return

    setStatus({ kind: 'sending' })
    try {
      const version = await onAddSecret(form.name.trim(), form.data.trim())
      if (version === null) {
        setStatus({ kind: 'error', message: 'The round was not dispatched — no participants were reachable.' })
        return
      }
      // Deliberately *not* `bag.version + 1`. Version progression is anchored
      // to the library's own snapshot, which also advances on pair-completion
      // auto-publish, so a guess drifts the moment anything else publishes —
      // and every `ShareConfirmed` then files against a round nobody is
      // watching, leaving this dialog stuck at "0 of N confirmed" while the
      // round underneath it completes normally.
      setStatus({ kind: 'confirming', participantIds: pairedParticipants.map(h => h.id), version })
    } catch (err) {
      setStatus({ kind: 'error', message: errorText(err) })
    }
  }

  const confirming = status.kind === 'confirming' ? status : null
  const confirmationProgress = confirming
    ? confirming.participantIds.map(id => {
        const participant = participants.find(h => h.id === id)
        const share = participant?.secretShares.find(s => s.version === confirming.version)
        return {
          id,
          name: participant?.name ?? id,
          confirmed: share?.status === 'confirmed',
          rejected: share?.status === 'rejected',
        }
      })
    : []
  const allResolved = confirming !== null && confirmationProgress.every(h => h.confirmed || h.rejected)
  const confirmedCount = confirmationProgress.filter(h => h.confirmed).length
  const rejectedCount = confirmationProgress.filter(h => h.rejected).length
  const thresholdMet = allResolved && confirmedCount >= threshold

  const canSubmit = form.name.trim().length > 0 && form.data.trim().length > 0
  const isBlocking = status.kind === 'sending' || (status.kind === 'confirming' && !allResolved)
  const isFirstSecret = !secretBag

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Add secret">
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">{isFirstSecret ? 'Protect Secret' : 'Add Secret'}</h2>
          {!isBlocking && <ModalCloseButton onClose={onClose} />}
        </div>

        {confirming ? (
          <div className="modal-body">
            <div className="verify-progress-bar-section">
              <div className="share-progress-bar-track">
                <div
                  className="share-progress-bar-fill"
                  style={{ width: `${confirmationProgress.length > 0 ? Math.round((confirmationProgress.filter(h => h.confirmed || h.rejected).length / confirmationProgress.length) * 100) : 0}%` }}
                  role="progressbar"
                  aria-valuenow={confirmationProgress.filter(h => h.confirmed || h.rejected).length}
                  aria-valuemin={0}
                  aria-valuemax={confirmationProgress.length}
                />
              </div>
              <p className="share-progress-summary">
                {confirmedCount} of {confirmationProgress.length} confirmed
                {rejectedCount > 0 && ` · ${rejectedCount} rejected`}
                {!allResolved && ` (need ${threshold})`}
              </p>
            </div>

            <ul className="share-progress-list" role="list">
              {confirmationProgress.map(h => (
                <li
                  key={h.id}
                  className={`share-progress-item ${h.confirmed ? 'share-progress-item--confirmed' : ''} ${h.rejected ? 'share-progress-item--failed' : ''}`}
                >
                  <span className="verify-progress-icon">
                    {h.confirmed
                      ? <span className="verify-progress-icon--done" aria-label="Confirmed">&#10003;</span>
                      : h.rejected
                        ? <span className="verify-progress-icon--failed" aria-label="Rejected">&#10007;</span>
                        : <span className="verify-spinner" role="status" aria-label="Waiting for confirmation" />
                    }
                  </span>
                  <span className="share-progress-item-name">{h.name}</span>
                  <span className={`share-progress-item-status ${h.confirmed ? 'status--verified' : ''} ${h.rejected ? 'status--failed' : ''}`}>
                    {h.confirmed ? 'Confirmed' : h.rejected ? 'Rejected' : 'Waiting\u2026'}
                  </span>
                </li>
              ))}
            </ul>

            {allResolved && !thresholdMet && (
              <div className="threshold-failure-banner" role="alert">
                <strong>Secret protection failed.</strong>{' '}
                Only {confirmedCount} of the required {threshold} helpers confirmed.
                The secret bag has been rolled back.
              </div>
            )}

            {allResolved && thresholdMet && rejectedCount > 0 && (
              <div className="threshold-warning-banner" role="status">
                Secret protected successfully, but {rejectedCount} helper{rejectedCount > 1 ? 's' : ''} failed.
                The secret is recoverable with the {confirmedCount} confirmed helper{confirmedCount > 1 ? 's' : ''}.
              </div>
            )}

            <div className="modal-actions">
              <button
                type="button"
                className={allResolved ? 'primary' : 'secondary'}
                onClick={onClose}
              >
                {allResolved ? 'Done' : 'Close'}
              </button>
            </div>
          </div>
        ) : (
          <form className="modal-body" onSubmit={handleSubmit}>
            {isFirstSecret && (
              <p className="modal-description">
                This will create the secret bag and distribute it to all paired participants.
              </p>
            )}

            <div className="form-field">
              <label className="form-label" htmlFor="ps-name">Name</label>
              <input
                id="ps-name"
                className="full-input"
                type="text"
                placeholder="e.g. Google Password"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                disabled={status.kind === 'sending'}
                autoFocus
              />
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="ps-data">Secret Data</label>
              <SecretDataField
                value={form.data}
                onChange={data => setForm(f => ({ ...f, data }))}
                disabled={status.kind === 'sending'}
              />
            </div>

            <div className="form-field">
              <span className="form-label">Participants ({pairedParticipants.length} paired)</span>
              {pairedParticipants.length === 0 ? (
                <p className="empty-hint">No participants paired yet.</p>
              ) : (
                <ul className="participant-check-list" role="list">
                  {pairedParticipants.map(h => (
                    <li key={h.id} className="participant-check-item">
                      <span className={`participant-dot ${h.connectionStatus}`} aria-hidden="true" />
                      <span>{h.name}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {status.kind === 'error' && (
              <p className="field-error">{status.message}</p>
            )}

            <div className="modal-actions">
              <button type="button" className="secondary" onClick={onClose} disabled={status.kind === 'sending'}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={!canSubmit || status.kind === 'sending'}>
                {status.kind === 'sending' ? 'Sending…' : isFirstSecret ? 'Protect' : 'Add Secret'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
