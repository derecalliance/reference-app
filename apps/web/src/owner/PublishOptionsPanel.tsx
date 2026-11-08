// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { PairedParticipant } from '../types'
import type { PublishOptionsDraft } from './publishOptions'
import { InfoTooltip } from '../InfoTooltip'
import type { PublishPolicy } from './publishPolicy'
import {
  sharingProblems,
  sharingProblemSummary,
  sharingTotal,
  sharingWeights,
  thresholdOutcome,
  thresholdRaisedText,
} from './sharingSettings'

interface PublishOptionsPanelProps {
  /** The helpers this publish goes to — see `publishTargets`. */
  helpers: readonly PairedParticipant[]
  policy: PublishPolicy
  /** Committed versions, newest first. */
  committedVersions: readonly number[]
  /** Versions still being published: dropped by helpers unless kept. */
  openVersions: readonly number[]
  /** What "keep the newest committed version" keeps and drops; `null` in "choose at each publish" mode. */
  preview: { kept: number | null; dropped: number[] } | null
  draft: PublishOptionsDraft
  onChange: (next: PublishOptionsDraft) => void
  disabled: boolean
}

const versionList = (versions: readonly number[]) => versions.map(v => `v${v}`).join(', ')

/**
 * What one publish uses, shared by every publish dialog: the threshold and
 * each helper's weight — the secret's, set on the Channels tab and shown here
 * read-only — and which earlier version helpers keep.
 */
export function PublishOptionsPanel({
  helpers,
  policy,
  committedVersions,
  openVersions,
  preview,
  draft,
  onChange,
  disabled,
}: PublishOptionsPanelProps) {
  const problem = sharingProblemSummary(sharingProblems(helpers, policy))
  const weights = sharingWeights(helpers, policy)
  const total = sharingTotal(helpers, policy)
  const outcome = thresholdOutcome(helpers, policy)
  const raisedText = thresholdRaisedText(outcome, total)

  return (
    <div className="publish-options">
      <div className="form-field">
        <span className="form-label">Threshold and weights</span>
        {helpers.length === 0 ? (
          <p className="empty-hint">No paired helpers to share with yet.</p>
        ) : (
          <>
            <p className="empty-hint">
              Threshold <strong>{outcome.threshold}</strong>
              {outcome.percent !== null && ` (at least ${outcome.percent}%)`}
              {raisedText && (
                <InfoTooltip label="Why the threshold is above the percentage" variant="info">
                  {raisedText}
                </InfoTooltip>
              )}{' '}
              of {total} subshares across {helpers.length}{' '}
              helper{helpers.length === 1 ? '' : 's'}:{' '}
              {helpers.map(h => `${h.name} ×${weights.get(h.channelId)}`).join(', ')}. Set on the Channels tab.
            </p>
            {problem && <p className="field-error" role="alert">{problem}.</p>}
          </>
        )}
      </div>

      <fieldset className="form-field">
        <legend className="form-label">Earlier version helpers keep</legend>
        <RetentionPart
          committedVersions={committedVersions}
          openVersions={openVersions}
          preview={preview}
          keep={draft.keep}
          onPick={keep => onChange({ ...draft, keep })}
          disabled={disabled}
        />
      </fieldset>
    </div>
  )
}

/**
 * The legend under "keep the newest committed version", or the one-of pick
 * under "choose at each publish". A helper holds at most the new version and
 * one earlier version (SDK 0.0.10 `keepVersion`), and drops every other
 * version it holds — rounds still being published included.
 */
function RetentionPart({
  committedVersions,
  openVersions,
  preview,
  keep,
  onPick,
  disabled,
}: {
  committedVersions: readonly number[]
  openVersions: readonly number[]
  preview: { kept: number | null; dropped: number[] } | null
  keep: number | null
  onPick: (version: number) => void
  disabled: boolean
}) {
  const stillOpen =
    openVersions.length > 0
      ? ` Still being published, and dropped by helpers that store this one: ${versionList(openVersions)}.`
      : ''

  if (committedVersions.length === 0) {
    return (
      <p className="empty-hint">
        No committed version yet, so helpers keep only this new version.{stillOpen}
      </p>
    )
  }

  if (preview) {
    return (
      <p className="empty-hint">
        Helpers will keep {preview.kept !== null ? `v${preview.kept} and ` : ''}this new version;{' '}
        {preview.dropped.length > 0 ? `${versionList(preview.dropped)} will be dropped` : 'nothing is dropped'}{' '}
        (keep the newest committed version — change it on the Settings tab).{stillOpen}
      </p>
    )
  }

  const picked = keep ?? committedVersions[0]
  return (
    <>
      <p className="empty-hint">
        Helpers keep this new version and at most one earlier version; they drop the rest.{stillOpen}
      </p>
      <ul className="participant-check-list" role="radiogroup" aria-label="Earlier version helpers keep">
        {committedVersions.map((v, index) => (
          <li key={v} className="participant-check-item">
            <label className="checkbox-row" htmlFor={`po-keep-${v}`}>
              <input
                id={`po-keep-${v}`}
                type="radio"
                name="po-keep"
                checked={picked === v}
                onChange={() => onPick(v)}
                disabled={disabled}
              />
              <span>v{v}{index === 0 ? ' — newest committed' : ''}</span>
            </label>
          </li>
        ))}
        <li className="participant-check-item">
          <label className="checkbox-row" htmlFor="po-keep-none">
            <input
              id="po-keep-none"
              type="radio"
              name="po-keep"
              checked={picked === 0}
              onChange={() => onPick(0)}
              disabled={disabled}
            />
            <span>None — helpers keep only this new version</span>
          </label>
        </li>
      </ul>
    </>
  )
}
