import { useEffect, useRef, useState } from 'react'
import { useProtocolTimeoutMs } from '../ProtocolConfig'
import { errorText } from '../errorText'
import { EyeIcon, EyeOffIcon } from './icons'
import { ModalCloseButton } from './primitives'
import type { PairedParticipant } from '../types'

export function SecretDataField({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="shared-key-field">
      <input
        className="key-input"
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="Enter secret data…"
        aria-label="Secret data"
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
      />
      <button
        type="button"
        className="secondary reveal-btn"
        onClick={() => setVisible(v => !v)}
        aria-label={visible ? 'Hide data' : 'Reveal data'}
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  )
}

//
// Two-step modal:
//   Step 1 — select participants (checkbox list, all pre-selected)
//   Step 2 — progress (spinner → checkmark as ShareVerified events arrive)
//
// Progress updates automatically: `secret` is a prop that refreshes from owner
// state whenever a ShareVerified event is applied, so no callbacks or refs needed.

export function VerifySharesModal({
  version,
  verifiedParticipantIds,
  confirmedParticipants,
  onClose,
  onVerify,
}: {
  version: number
  /** Live-updated list of participant IDs that have passed verification for this version. */
  verifiedParticipantIds: string[]
  confirmedParticipants: PairedParticipant[]
  onClose: () => void
  onVerify: (version: number) => Promise<void>
}) {
  const timeoutMs = useProtocolTimeoutMs()
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [timedOut, setTimedOut] = useState<Set<string>>(new Set())
  // State-based guards don't protect against React 18 StrictMode's double-
  // invoke of effects: the state update scheduled in the first setup hasn't
  // been flushed before the second setup runs, so a `sent` flag still reads
  // `false` and `onVerify` fires twice — which causes Bob to send two verify
  // requests per channel, and Alice sees the same modal twice per channel.
  // A ref is synchronous and persists across both setups, so the call fires
  // exactly once.
  const hasStartedRef = useRef(false)

  useEffect(() => {
    if (hasStartedRef.current) return
    hasStartedRef.current = true
    setSent(true)
    onVerify(version).catch(err => {
      setError(errorText(err))
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!sent) return
    const timer = setTimeout(() => {
      const pending = confirmedParticipants.filter(
        h => !verifiedParticipantIds.includes(h.id),
      )
      if (pending.length > 0) {
        setTimedOut(new Set(pending.map(h => h.channelId)))
      }
    }, timeoutMs)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sent])

  const totalCount = confirmedParticipants.length
  const verifiedCount = confirmedParticipants.filter(
    h => verifiedParticipantIds.includes(h.id),
  ).length
  const failedCount = confirmedParticipants.filter(
    h => timedOut.has(h.channelId),
  ).length
  const resolvedCount = verifiedCount + failedCount
  const allDone = totalCount > 0 && resolvedCount === totalCount
  const pct = totalCount > 0
    ? Math.round((resolvedCount / totalCount) * 100)
    : 0

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="verify-progress-title">
      <div className="modal verify-modal--progress">
        <div className="modal-header">
          <h2 className="modal-title" id="verify-progress-title">Verifying Shares</h2>
          <ModalCloseButton onClose={onClose} />
        </div>
        <div className="modal-body">
          {error && <p className="field-error">{error}</p>}
          <div className="verify-progress-bar-section">
            <div className="share-progress-bar-track">
              <div
                className="share-progress-bar-fill"
                style={{ width: `${pct}%` }}
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            </div>
            <p className="share-progress-summary">
              {verifiedCount} of {totalCount} verified
              {failedCount > 0 && ` · ${failedCount} failed`}
            </p>
          </div>

          <ul className="share-progress-list" role="list">
            {confirmedParticipants.map(h => {
              const isVerified = verifiedParticipantIds.includes(h.id)
              const isTimedOut = timedOut.has(h.channelId)

              let icon: React.ReactNode
              let statusText: string
              let statusClass = ''

              if (isVerified) {
                icon = <span className="verify-progress-icon--done" aria-label="Verified">✓</span>
                statusText = 'Verified'
                statusClass = 'status--verified'
              } else if (isTimedOut) {
                icon = <span className="verify-progress-icon--failed" aria-label="Timed out">✗</span>
                statusText = 'Verification timed out'
                statusClass = 'status--failed'
              } else {
                icon = <span className="verify-spinner" role="status" aria-label="Waiting for response" />
                statusText = 'Waiting…'
              }

              return (
                <li
                  key={h.id}
                  className={`share-progress-item ${isVerified ? 'share-progress-item--confirmed' : ''} ${isTimedOut ? 'share-progress-item--failed' : ''}`}
                >
                  <span className="verify-progress-icon">{icon}</span>
                  <span className="share-progress-item-name">{h.name}</span>
                  <span className={`share-progress-item-status ${statusClass}`}>
                    {statusText}
                  </span>
                </li>
              )
            })}
          </ul>

          <div className="modal-actions">
            <button
              type="button"
              className={allDone ? 'primary' : 'secondary'}
              onClick={onClose}
            >
              {allDone ? 'Done' : 'Close'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
