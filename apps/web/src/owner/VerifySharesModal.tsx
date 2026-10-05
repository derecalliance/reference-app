// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { ModalFrame } from '../ModalFrame'
import { useEffect, useRef, useState } from 'react'
import { useProtocolTimeoutMs } from '../ProtocolConfig'
import { errorText } from '../errorText'
import { EyeIcon, EyeOffIcon } from './icons'
import { ModalCloseButton } from './primitives'
import type { PairedParticipant } from '../types'
import { verifyProgress, type VerifyDispatch, type VerifyRowState } from './verification'

export function SecretDataField({
  value,
  onChange,
  disabled,
  describedBy,
  invalid,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  /** Id of the helper or error text that describes the field. */
  describedBy?: string
  invalid?: boolean
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
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
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

const ROW_DISPLAY: Record<VerifyRowState, { label: string; itemClass: string; statusClass: string }> = {
  verified: { label: 'Verified', itemClass: 'share-progress-item--confirmed', statusClass: 'status--verified' },
  failed: { label: 'Challenge not sent', itemClass: 'share-progress-item--failed', statusClass: 'status--failed' },
  'timed-out': { label: 'Verification timed out', itemClass: 'share-progress-item--failed', statusClass: 'status--failed' },
  waiting: { label: 'Waiting…', itemClass: '', statusClass: '' },
}

/**
 * Progress of one verification round, spinner → checkmark as `ShareVerified`
 * events arrive.
 *
 * `version` is the version this dialog challenged, fixed for its lifetime, and
 * `verifiedParticipantIds` must be *that* version's — the caller looks it up by
 * number. Following "the current version" instead left the dialog waiting
 * forever whenever a publish landed mid-verification: the answers arrived for
 * the version challenged, the dialog was reading the new one.
 */
export function VerifySharesModal({
  version,
  verifiedParticipantIds,
  confirmedParticipants,
  onClose,
  onVerify,
}: {
  version: number
  /** Live-updated list of participant IDs that have passed verification for `version`. */
  verifiedParticipantIds: readonly string[]
  confirmedParticipants: PairedParticipant[]
  onClose: () => void
  onVerify: (version: number) => Promise<VerifyDispatch>
}) {
  const timeoutMs = useProtocolTimeoutMs()
  const [error, setError] = useState<string | null>(null)
  const [failedChannelIds, setFailedChannelIds] = useState<ReadonlySet<string>>(new Set())
  const [deadlinePassed, setDeadlinePassed] = useState(false)
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
    onVerify(version)
      .then(dispatch => setFailedChannelIds(new Set(dispatch.failedChannelIds)))
      .catch(err => {
        // Nothing went out, so nothing will answer: resolve every row now
        // rather than spinning until the deadline.
        setError(errorText(err))
        setFailedChannelIds(new Set(confirmedParticipants.map(h => h.channelId)))
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Only the deadline is timed. Who it catches is read at render time from
  // the live verified list — see `verifyProgress`.
  useEffect(() => {
    const timer = setTimeout(() => setDeadlinePassed(true), timeoutMs)
    return () => clearTimeout(timer)
  }, [timeoutMs])

  const { rows, verifiedCount, failedCount, allDone, percent } = verifyProgress({
    participants: confirmedParticipants,
    verifiedParticipantIds,
    failedChannelIds,
    deadlinePassed,
  })

  return (
    <ModalFrame
      overlayClassName="modal-overlay"
      className="modal verify-modal--progress"
      labelledBy="verify-progress-title"
      onEscape={onClose}
    >
      <div className="modal-header">
        <h2 className="modal-title" id="verify-progress-title">Verifying Shares · v{version}</h2>
        <ModalCloseButton onClose={onClose} />
      </div>
      <div className="modal-body">
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="verify-progress-bar-section">
          <div className="share-progress-bar-track">
            <div
              className="share-progress-bar-fill"
              style={{ width: `${percent}%` }}
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>
          <p className="share-progress-summary">
            {verifiedCount} of {rows.length} verified
            {failedCount > 0 && ` · ${failedCount} failed`}
          </p>
        </div>

        <ul className="share-progress-list" role="list">
          {rows.map(row => {
            const display = ROW_DISPLAY[row.state]
            return (
              <li key={row.id} className={`share-progress-item ${display.itemClass}`}>
                <span className="verify-progress-icon">
                  {row.state === 'verified' ? (
                    <span className="verify-progress-icon--done" aria-label="Verified">✓</span>
                  ) : row.state === 'waiting' ? (
                    <span className="verify-spinner" role="status" aria-label="Waiting for response" />
                  ) : (
                    <span className="verify-progress-icon--failed" aria-label={display.label}>✗</span>
                  )}
                </span>
                <span className="share-progress-item-name">{row.name}</span>
                <span className={`share-progress-item-status ${display.statusClass}`}>
                  {display.label}
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
    </ModalFrame>
  )
}
