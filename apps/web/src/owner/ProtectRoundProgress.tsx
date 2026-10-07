// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { ParticipantOutcome, RoundProgress } from './roundProgress'
import { SHARE_FAILURE_LABEL, type ShareFailureKind } from './shareFailure'

interface ProtectRoundProgressProps {
  progress: RoundProgress
  threshold: number
  /** The bag version this round publishes, as the library assigned it. */
  version: number
  /** Leads the failure banner, e.g. "Secret protection failed." */
  failureHeading: string
  onClose: () => void
}

/** How each outcome is said on a row — failures in the words every view uses. */
const OUTCOME_LABEL: Record<ParticipantOutcome, string> = {
  waiting: 'Waiting…',
  confirmed: 'Confirmed',
  ...SHARE_FAILURE_LABEL,
}

/** "1 rejected · 2 no answer", for the failures present. */
function failureSummary(rows: RoundProgress['rows']): string {
  const kinds: ShareFailureKind[] = ['rejected', 'no-answer', 'unreachable']
  return kinds
    .map(kind => ({ kind, count: rows.filter(r => r.outcome === kind).length }))
    .filter(({ count }) => count > 0)
    .map(({ kind, count }) => `${count} ${SHARE_FAILURE_LABEL[kind].toLowerCase()}`)
    .join(' · ')
}

/**
 * The per-participant view of a protect round in flight: who confirmed, who
 * refused, who never answered or could not be reached, and whether enough did. Shared by adding and removing a secret,
 * which publish a new bag version the same way.
 */
export function ProtectRoundProgress({ progress, threshold, version, failureHeading, onClose }: ProtectRoundProgressProps) {
  const { rows, confirmedCount, failedCount, allResolved } = progress
  const resolvedCount = confirmedCount + failedCount
  const failures = failureSummary(rows)
  const waitingCount = rows.length - resolvedCount
  const thresholdMet = allResolved && confirmedCount >= threshold

  return (
    <div className="modal-body">
      <div className="verify-progress-bar-section">
        <div className="share-progress-bar-track">
          <div
            className="share-progress-bar-fill"
            style={{ width: `${rows.length > 0 ? Math.round((resolvedCount / rows.length) * 100) : 0}%` }}
            role="progressbar"
            aria-valuenow={resolvedCount}
            aria-valuemin={0}
            aria-valuemax={rows.length}
          />
        </div>
        <p className="share-progress-summary">
          {confirmedCount} of {rows.length} confirmed
          {failures && ` · ${failures}`}
          {!allResolved && ` · ${waitingCount} waiting (need ${threshold})`}
        </p>
      </div>

      {!allResolved && (
        <RoundStillOpen
          version={version}
          confirmedCount={confirmedCount}
          threshold={threshold}
          waitingCount={waitingCount}
        />
      )}

      <ul className="share-progress-list" role="list">
        {rows.map(h => {
          const confirmed = h.outcome === 'confirmed'
          const failed = !confirmed && h.outcome !== 'waiting'
          const label = OUTCOME_LABEL[h.outcome]
          return (
            <li
              key={h.id}
              className={`share-progress-item ${confirmed ? 'share-progress-item--confirmed' : ''} ${failed ? 'share-progress-item--failed' : ''}`}
            >
              <span className="verify-progress-icon">
                {confirmed
                  ? <span className="verify-progress-icon--done" aria-label={label}>&#10003;</span>
                  : failed
                    ? <span className="verify-progress-icon--failed" aria-label={label}>&#10007;</span>
                    : <span className="verify-spinner" role="status" aria-label="Waiting for confirmation" />
                }
              </span>
              <span className="share-progress-item-name">{h.name}</span>
              <span className={`share-progress-item-status ${confirmed ? 'status--verified' : ''} ${failed ? 'status--failed' : ''}`}>
                {label}
              </span>
            </li>
          )
        })}
      </ul>

      {allResolved && !thresholdMet && (
        <div className="threshold-failure-banner" role="alert">
          <strong>{failureHeading}</strong>{' '}
          Only {confirmedCount} of the required {threshold} helpers confirmed.
          The secret bag has been rolled back.
        </div>
      )}

      {allResolved && thresholdMet && failedCount > 0 && (
        <div className="threshold-warning-banner" role="status">
          New version published, but {failedCount} helper{failedCount > 1 ? 's' : ''} did not
          store it ({failures}).
          The secrets are recoverable with the {confirmedCount} confirmed helper{confirmedCount > 1 ? 's' : ''}.
        </div>
      )}

      <div className="modal-actions">
        <button type="button" className={allResolved ? 'primary' : 'secondary'} onClick={onClose}>
          {allResolved ? 'Done' : 'Close'}
        </button>
      </div>
    </div>
  )
}

interface RoundStillOpenProps {
  version: number
  confirmedCount: number
  threshold: number
  waitingCount: number
}

/**
 * What an unfinished round is waiting for, said in words.
 *
 * The version is committed only when the library resolves the round — every
 * participant answered, or the ones that did not are given up on, which for a
 * participant gone offline takes about a minute. Showing just "2 of 3
 * confirmed (need 2)" in that window read as finished-but-broken: the
 * threshold visibly met, the bag visibly unchanged. Naming the wait, and that
 * closing is safe, is what keeps an early close from looking like a failure.
 */
function RoundStillOpen({ version, confirmedCount, threshold, waitingCount }: RoundStillOpenProps) {
  const waiting = `${waitingCount} participant${waitingCount === 1 ? '' : 's'}`
  if (confirmedCount >= threshold) {
    return (
      <p className="round-pending-note" role="status">
        Threshold reached — {confirmedCount} of the {threshold} needed have confirmed. Still waiting
        on {waiting}: v{version} is committed once{' '}
        {waitingCount === 1 ? 'it answers or times out' : 'they answer or time out'}. You can close
        this; the round keeps running.
      </p>
    )
  }
  const needed = threshold - confirmedCount
  return (
    <p className="round-pending-note" role="status">
      Waiting on {waiting} — {needed} more confirmation{needed === 1 ? '' : 's'} needed before v
      {version} can be committed.
    </p>
  )
}
