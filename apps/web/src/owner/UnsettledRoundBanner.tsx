// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState } from 'react'

import type { UnsettledRound } from '../types'

interface UnsettledRoundBannerProps {
  round: UnsettledRound
  /** Publish the round's items again as a new round. */
  onRetry: () => Promise<unknown>
  /** Accept the round as it ended. */
  onDismiss: () => void
  /** Why a retry cannot start now — a round still open, say — or `null`. */
  retryDisabledReason: string | null
}

type RetryStatus = { kind: 'idle' } | { kind: 'sending' } | { kind: 'error'; message: string }

/**
 * The latest publishing round closed without every helper storing its share.
 * A warning when the helpers that did hold enough to recover the version, a
 * danger alert when the round rolled back and the version is not recoverable.
 * Retry publishes the same items as a new round.
 */
export function UnsettledRoundBanner({ round, onRetry, onDismiss, retryDisabledReason }: UnsettledRoundBannerProps) {
  const [status, setStatus] = useState<RetryStatus>({ kind: 'idle' })
  const sending = status.kind === 'sending'
  const helpers = (n: number) => `${n} helper${n === 1 ? '' : 's'}`

  async function handleRetry() {
    setStatus({ kind: 'sending' })
    try {
      await onRetry()
      setStatus({ kind: 'idle' })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div
      className={`owner-banner owner-banner--${round.recoverable ? 'warning' : 'error'} owner-banner--with-actions`}
      role={round.recoverable ? 'status' : 'alert'}
    >
      <p className="owner-banner__text">
        {round.recoverable ? (
          <>
            <strong>v{round.version} is not fully settled.</strong> {helpers(round.failedCount)} did not store
            {round.failedCount === 1 ? ' its' : ' their'} share. It is recoverable from the{' '}
            {helpers(round.confirmedCount)} that did. Retry to publish it again to every helper.
          </>
        ) : (
          <>
            <strong>v{round.version} did not reach its threshold and is not recoverable.</strong> Only{' '}
            {helpers(round.confirmedCount)} stored {round.confirmedCount === 1 ? 'its' : 'their'} share, so the
            change was rolled back and helpers keep the last committed version. Retry to publish it again, or
            discard it.
          </>
        )}
        {status.kind === 'error' && <span className="owner-banner__error"> {status.message}</span>}
      </p>
      <div className="owner-banner__actions">
        <button
          type="button"
          className="primary small"
          onClick={() => void handleRetry()}
          disabled={sending || retryDisabledReason !== null}
          title={retryDisabledReason ?? `Publish v${round.version}'s items again as a new round`}
        >
          {sending ? 'Retrying…' : 'Retry'}
        </button>
        <button type="button" className="secondary small" onClick={onDismiss} disabled={sending}>
          {round.recoverable ? 'Dismiss' : `Discard v${round.version}`}
        </button>
      </div>
    </div>
  )
}
