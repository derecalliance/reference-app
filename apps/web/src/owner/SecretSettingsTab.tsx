// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState, type FormEvent } from 'react'

import { SECRET_CONFIG_DEFAULTS } from '../protocolDefaults'
import { ProtocolSettingsSection } from './ProtocolSettingsSection'
import { PublishingSettingsSections } from './PublishingSettingsSections'
import {
  draftOf,
  draftProblems,
  sameSettings,
  valuesOf,
  type SecretSettingsDraft,
  type SecretSettingsValues,
} from './secretSettingsDraft'

interface SecretSettingsTabProps {
  /** What the secret is saved with now. */
  values: SecretSettingsValues
  /**
   * Saved settings the running protocol instance does not use yet, named for
   * a person — see `SecretRuntime.settingsAwaitingRestart`.
   */
  awaitingRestart: readonly string[]
  onSave: (next: SecretSettingsValues) => void
}

/**
 * The owner's Settings tab: everything this secret runs and publishes with,
 * saved together. The protocol settings belong to this secret alone and start
 * from the app's defaults. Saving sends nothing; the publishing choices apply
 * from the next publish, the threshold and helper weights are on the Channels
 * tab.
 *
 * Mounted per secret (keyed by its id), so the form never carries one secret's
 * draft over to another.
 */
export function SecretSettingsTab({ values, awaitingRestart, onSave }: SecretSettingsTabProps) {
  const [draft, setDraft] = useState<SecretSettingsDraft>(() => draftOf(values))
  const [saved, setSaved] = useState(false)
  const problems = draftProblems(draft, values.policy)
  const valid = Object.keys(problems).length === 0
  const next = valuesOf(draft, values.policy)
  const changed = !sameSettings(next, values)
  const atDefaults = sameSettings({ ...next, protocol: SECRET_CONFIG_DEFAULTS }, next)

  function change(next: Partial<SecretSettingsDraft>): void {
    setDraft(current => ({ ...current, ...next }))
    setSaved(false)
  }

  function handleSubmit(e: FormEvent): void {
    e.preventDefault()
    if (!valid || !changed) return
    onSave(next)
    setSaved(true)
  }

  return (
    <form className="settings-tab" onSubmit={handleSubmit} aria-label="Secret settings">
      <section className="settings-section">
        <div className="settings-section-header">
          <h3 className="settings-section-title">Protocol</h3>
          <button
            type="button"
            className="secondary"
            disabled={atDefaults}
            onClick={() =>
              change({
                protocol: SECRET_CONFIG_DEFAULTS,
                timeoutText: String(SECRET_CONFIG_DEFAULTS.protocolTimeoutSecs),
              })
            }
          >
            Use the defaults
          </button>
        </div>
        <p className="empty-hint">
          How this secret runs the protocol. Each secret keeps its own; a new one starts from the defaults
          marked below. The timeout and the unpair acknowledgement apply when the secret next starts, the rest
          at once.
        </p>
        <ProtocolSettingsSection draft={draft} problems={problems} onChange={change} />
        {awaitingRestart.length > 0 && (
          <p className="settings-restart-note" role="status">
            Saved, but {awaitingRestart.join(' and ')} {awaitingRestart.length === 1 ? 'applies' : 'apply'} when
            this secret next starts. Reload the page to apply {awaitingRestart.length === 1 ? 'it' : 'them'} now.
          </p>
        )}
      </section>

      <section className="settings-section">
        <h3 className="settings-section-title">Publishing and verification</h3>
        <p className="empty-hint">
          Nothing is sent when you save: these apply from the next publish. They are this device’s choices — a
          replica of this secret keeps its own. The threshold and helper weights are on the Channels tab.
        </p>
        <PublishingSettingsSections draft={draft} problems={problems} onChange={change} />
      </section>

      <div className="settings-actions">
        <button type="submit" className="primary" disabled={!valid || !changed}>
          Save
        </button>
        <button type="button" className="secondary" disabled={!changed} onClick={() => change(draftOf(values))}>
          Discard changes
        </button>
        <span className="empty-hint" aria-live="polite">
          {!valid ? 'Fix the highlighted fields to save.' : saved && !changed ? 'Saved.' : ''}
        </span>
      </div>
    </form>
  )
}
