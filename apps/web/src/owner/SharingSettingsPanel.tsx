// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState } from 'react'

import { InfoTooltip } from '../InfoTooltip'
import type { PairedParticipant } from '../types'
import {
  thresholdModeOf,
  thresholdPercentOf,
  type PublishPolicy,
  type ThresholdMode,
  type ThresholdSetting,
} from './publishPolicy'
import {
  isFixedThreshold,
  isThresholdPercent,
  MIN_THRESHOLD,
  sharingProblems,
  sharingTotal,
  thresholdOutcome,
  thresholdRaisedText,
} from './sharingSettings'

interface SharingSettingsPanelProps {
  /** The helpers a publish goes to — see `publishTargets`. */
  helpers: readonly PairedParticipant[]
  policy: PublishPolicy
  /**
   * The threshold the library last published with (it reuses it for the
   * publishes it starts on its own), or `null` when unknown or no version yet.
   */
  lastPublishedThreshold: number | null
  onSetThreshold: (setting: ThresholdSetting) => void
}

/**
 * The threshold every publish uses, at the top of the Channels tab, beside the
 * helper weights in each channel's row: a percentage of the subshares the
 * helpers hold between them (worked out at each publish), or a fixed number.
 * An app preference: setting it sends nothing until the next publish
 * (Republish applies it to the current items).
 */
export function SharingSettingsPanel({ helpers, policy, lastPublishedThreshold, onSetThreshold }: SharingSettingsPanelProps) {
  // What the owner is typing, so the field can be cleared and retyped; `null`
  // shows the saved value. Only valid values are saved.
  const [draft, setDraft] = useState<string | null>(null)
  const mode = thresholdModeOf(policy)
  const percent = thresholdPercentOf(policy)
  const outcome = thresholdOutcome(helpers, policy)
  const threshold = outcome.threshold
  const problems = sharingProblems(helpers, policy)
  const total = sharingTotal(helpers, policy)
  const raisedText = thresholdRaisedText(outcome, total)
  const saved = mode === 'percent' ? percent : policy.defaultThreshold
  const isValid = mode === 'percent' ? isThresholdPercent : isFixedThreshold
  const typedInvalid = draft !== null && !isValidText(draft, isValid)

  function save(value: number): void {
    onSetThreshold(mode === 'percent' ? { mode, percent: value } : { mode, value })
  }

  function switchMode(next: ThresholdMode): void {
    setDraft(null)
    // Each mode keeps its own value; a fixed threshold never saved before
    // starts from the number the percentage gives today.
    if (next === 'percent') onSetThreshold({ mode: 'percent', percent })
    else onSetThreshold({ mode: 'fixed', value: isFixedThreshold(policy.defaultThreshold) ? policy.defaultThreshold : threshold })
  }

  return (
    <div className="sharing-settings">
      <fieldset className="form-field">
        <legend className="form-label">
          Threshold
          <InfoTooltip label="About the threshold" placement="bottom" align="start">
            {mode === 'percent'
              ? `At least this share of the helpers' subshares is needed to recover: rounded up, never below ${MIN_THRESHOLD}, and raised when one helper would otherwise hold enough alone. It is worked out again at every publish from who is paired.`
              : `The number of subshares needed to recover, at least ${MIN_THRESHOLD} so one helper can never recover alone.`}{' '}
            Every publish uses it with each helper’s weight below; changing either sends nothing until the next publish —
            Republish applies them to the current items.
          </InfoTooltip>
        </legend>
        <div className="threshold-controls">
          <div className="threshold-mode-row">
            <label className="checkbox-row">
              <input
                type="radio"
                name="ch-threshold-mode"
                id="ch-threshold-mode-percent"
                checked={mode === 'percent'}
                onChange={() => switchMode('percent')}
              />
              Percentage of subshares
            </label>
            <label className="checkbox-row">
              <input
                type="radio"
                name="ch-threshold-mode"
                id="ch-threshold-mode-fixed"
                checked={mode === 'fixed'}
                onChange={() => switchMode('fixed')}
              />
              Fixed number
            </label>
          </div>
          <div className="threshold-input-row">
            <input
              id="ch-threshold"
              className="threshold-input"
              type="number"
              inputMode="numeric"
              min={mode === 'percent' ? 1 : MIN_THRESHOLD}
              max={mode === 'percent' ? 100 : undefined}
              step={1}
              value={draft ?? saved}
              onChange={e => {
                setDraft(e.target.value)
                if (isValidText(e.target.value, isValid)) save(Number(e.target.value))
              }}
              onBlur={() => setDraft(null)}
              aria-label={mode === 'percent' ? 'Threshold percentage' : 'Threshold'}
              aria-invalid={typedInvalid || problems.threshold !== undefined}
            />
            {mode === 'percent' && <span aria-hidden="true">%</span>}
          </div>
        </div>
        {typedInvalid && (
          <p className="field-error">
            {mode === 'percent'
              ? 'Must be a whole percentage from 1 to 100'
              : `Must be a whole number, at least ${MIN_THRESHOLD} — one helper must never recover alone`}
          </p>
        )}
        {problems.total ? (
          <p className="field-error" role="alert">{problems.total}</p>
        ) : (
          helpers.length > 0 && (
            <p className="empty-hint">
              {mode === 'percent' && (
                <>
                  {percent}% → threshold {threshold}
                  {raisedText && (
                    <>
                      {' '}(raised)
                      <InfoTooltip label="Why the threshold is above the percentage" variant="info">
                        {raisedText}
                      </InfoTooltip>
                    </>
                  )}
                  .{' '}
                </>
              )}
              {total} subshares across {helpers.length} helper{helpers.length === 1 ? '' : 's'}; any helpers
              holding {threshold} together can recover.
              {lastPublishedThreshold !== null && lastPublishedThreshold !== threshold &&
                ` The library last published at ${lastPublishedThreshold}, and reuses that for the publishes it starts on its own (pairing a helper).`}
            </p>
          )
        )}
      </fieldset>
    </div>
  )
}

function isValidText(text: string, isValid: (value: number) => boolean): boolean {
  return text.trim() !== '' && isValid(Number(text))
}
