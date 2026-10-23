// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { PairedParticipant } from '../types'
import { publishOptionsProblems, type PublishOptionsDraft } from './publishOptions'
import type { PublishPolicy } from './publishPolicy'
import { DEFAULT_WEIGHT, maxWeight } from './weights'

interface PublishOptionsPanelProps {
  /** The helpers this publish goes to — see `publishTargets`. */
  helpers: readonly PairedParticipant[]
  policy: PublishPolicy
  /** Committed versions, newest first. */
  committedVersions: readonly number[]
  /** Versions still being published: always kept, whatever the rule. */
  openVersions: readonly number[]
  /** What "keep the last N" keeps and drops; `null` in "choose at each publish" mode. */
  preview: { kept: number[]; dropped: number[] } | null
  draft: PublishOptionsDraft
  onChange: (next: PublishOptionsDraft) => void
  disabled: boolean
}

const versionList = (versions: readonly number[]) => versions.map(v => `v${v}`).join(', ')

/**
 * The owner's choices for one publish, shared by every publish dialog: the
 * threshold this version is split with, each helper's weight, and which
 * earlier versions helpers keep. Starts from the vault's defaults (Vault
 * Settings and the Channels list); changes here apply to this publish only,
 * unless the owner asks to remember a changed threshold.
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
  const problems = publishOptionsProblems(draft, helpers)
  const threshold = Number(draft.threshold)
  const thresholdChanged = problems.threshold === undefined && threshold !== policy.defaultThreshold
  const weightMax = problems.threshold === undefined ? maxWeight(threshold) : undefined
  const total = helpers.reduce((sum, h) => sum + (Number(draft.weights[h.channelId]) || 0), 0)

  const toggleKept = (version: number) =>
    onChange({
      ...draft,
      dropped: draft.dropped.includes(version)
        ? draft.dropped.filter(v => v !== version)
        : [...draft.dropped, version],
    })

  return (
    <div className="publish-options">
      <div className="form-field">
        <label className="form-label" htmlFor="po-threshold">Threshold</label>
        <input
          id="po-threshold"
          className="full-input"
          type="number"
          inputMode="numeric"
          min={2}
          step={1}
          value={draft.threshold}
          onChange={e => onChange({ ...draft, threshold: e.target.value })}
          disabled={disabled}
          aria-invalid={problems.threshold !== undefined}
          aria-describedby="po-threshold-hint"
        />
        {problems.threshold ? (
          <p className="field-error" id="po-threshold-hint">{problems.threshold}</p>
        ) : (
          <p className="empty-hint" id="po-threshold-hint">
            Subshares needed to recover this version. Default {policy.defaultThreshold} (Vault Settings).
          </p>
        )}
        {thresholdChanged && (
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.rememberThreshold}
              onChange={e => onChange({ ...draft, rememberThreshold: e.target.checked })}
              disabled={disabled}
            />
            <span>Remember this threshold for future publishes</span>
          </label>
        )}
      </div>

      <fieldset className="form-field">
        <legend className="form-label">Helper weights</legend>
        {helpers.length === 0 ? (
          <p className="empty-hint">No paired helpers to share with yet.</p>
        ) : (
          <ul className="participant-check-list" role="list">
            {helpers.map(h => {
              const inputId = `po-weight-${h.channelId}`
              const problem = problems.weights[h.channelId]
              return (
                <li key={h.id} className="participant-check-item helper-weight-row">
                  <label className="form-label" htmlFor={inputId}>{h.name}</label>
                  <input
                    id={inputId}
                    className="helper-weight-input"
                    type="number"
                    inputMode="numeric"
                    min={DEFAULT_WEIGHT}
                    max={weightMax}
                    step={1}
                    value={draft.weights[h.channelId] ?? ''}
                    onChange={e => onChange({ ...draft, weights: { ...draft.weights, [h.channelId]: e.target.value } })}
                    disabled={disabled}
                    aria-invalid={problem !== undefined}
                    aria-describedby={problem ? `${inputId}-error` : undefined}
                  />
                  {problem && <p className="field-error" id={`${inputId}-error`}>{problem}</p>}
                </li>
              )
            })}
          </ul>
        )}
        {problems.total ? (
          <p className="field-error" role="alert">{problems.total}</p>
        ) : (
          problems.threshold === undefined && (
            <p className="empty-hint">
              Total: {total} subshares across {helpers.length} helper{helpers.length === 1 ? '' : 's'}; any
              helpers holding {threshold} together can recover.
            </p>
          )
        )}
      </fieldset>

      <fieldset className="form-field">
        <legend className="form-label">Versions helpers keep</legend>
        <RetentionPart
          policy={policy}
          committedVersions={committedVersions}
          openVersions={openVersions}
          preview={preview}
          dropped={draft.dropped}
          onToggle={toggleKept}
          disabled={disabled}
        />
      </fieldset>
    </div>
  )
}

/** The legend under "keep the last N", or the checklist under "choose at each publish". */
function RetentionPart({
  policy,
  committedVersions,
  openVersions,
  preview,
  dropped,
  onToggle,
  disabled,
}: {
  policy: PublishPolicy
  committedVersions: readonly number[]
  openVersions: readonly number[]
  preview: { kept: number[]; dropped: number[] } | null
  dropped: readonly number[]
  onToggle: (version: number) => void
  disabled: boolean
}) {
  const stillOpen = openVersions.length > 0 ? ` Still being published, and kept: ${versionList(openVersions)}.` : ''

  if (committedVersions.length === 0) {
    return (
      <p className="empty-hint">
        No committed version yet, so no list is sent and helpers keep everything they hold.{stillOpen}
      </p>
    )
  }

  if (policy.helperRetention.mode === 'lastN' && preview) {
    return (
      <p className="empty-hint">
        Helpers will keep {preview.kept.length > 0 ? `${versionList(preview.kept)} and ` : ''}this new version;{' '}
        {preview.dropped.length > 0 ? `${versionList(preview.dropped)} will be dropped` : 'nothing is dropped'}{' '}
        (keep the last {policy.helperRetention.n} — change in Vault Settings).{stillOpen}
      </p>
    )
  }

  return (
    <>
      <p className="empty-hint">
        Choose the earlier versions helpers keep; they drop the rest. This new version is always kept.
      </p>
      <ul className="participant-check-list" role="list">
        {openVersions.map(v => (
          <li key={`open-${v}`} className="participant-check-item">
            <label className="checkbox-row" htmlFor={`po-keep-${v}`}>
              <input id={`po-keep-${v}`} type="checkbox" checked disabled />
              <span>v{v} — still being published, always kept</span>
            </label>
          </li>
        ))}
        {committedVersions.map(v => (
          <li key={v} className="participant-check-item">
            <label className="checkbox-row" htmlFor={`po-keep-${v}`}>
              <input
                id={`po-keep-${v}`}
                type="checkbox"
                checked={!dropped.includes(v)}
                onChange={() => onToggle(v)}
                disabled={disabled}
              />
              <span>v{v}</span>
            </label>
          </li>
        ))}
      </ul>
    </>
  )
}
