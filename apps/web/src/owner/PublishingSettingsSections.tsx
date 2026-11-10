// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { ScheduleUnit } from './verificationSchedule'
import type { SecretSettingsDraft, SecretSettingsProblems } from './secretSettingsDraft'

interface PublishingSettingsSectionsProps {
  draft: SecretSettingsDraft
  problems: SecretSettingsProblems
  onChange: (change: Partial<SecretSettingsDraft>) => void
}

/** One radio option in the app's `role-option` style. */
function Choice({
  id,
  name,
  checked,
  label,
  hint,
  onSelect,
}: {
  id: string
  name: string
  checked: boolean
  label: string
  hint: string
  onSelect: () => void
}) {
  return (
    <label className={`role-option${checked ? ' role-option--selected' : ''}`} htmlFor={id}>
      <input type="radio" id={id} name={name} checked={checked} onChange={onSelect} />
      <span className="role-option__label">{label}</span>
      <span className="role-option__hint">{hint}</span>
    </label>
  )
}

/**
 * How this secret publishes and verifies: which earlier version helpers keep,
 * when old verification copies are deleted, and how often shares are verified
 * on their own. They apply from the next publish or check.
 */
export function PublishingSettingsSections({ draft, problems, onChange }: PublishingSettingsSectionsProps) {
  const { retentionMode, cleanup } = draft

  return (
    <>
      <fieldset className="form-field">
        <legend className="form-label">Earlier version helpers keep</legend>
        <p className="empty-hint">
          Helpers hold at most the version being published and one earlier version, and drop the rest.
        </p>
        <Choice
          id="vs-retention-latest"
          name="vs-retention"
          checked={retentionMode === 'latestCommitted'}
          label="The newest committed version"
          hint="What recovery falls back to if a publish does not reach its threshold."
          onSelect={() => onChange({ retentionMode: 'latestCommitted' })}
        />
        <Choice
          id="vs-retention-select"
          name="vs-retention"
          checked={retentionMode === 'select'}
          label="Choose at each publish"
          hint="Each publish asks which version to keep, or none. Publishes the library starts on its own keep the newest committed version."
          onSelect={() => onChange({ retentionMode: 'select' })}
        />
      </fieldset>

      <fieldset className="form-field">
        <legend className="form-label">Old verification copies</legend>
        <p className="empty-hint">
          The copies this device keeps of what each helper holds, used only to verify. Deleting one never
          affects recovery; that version just can no longer be verified from here. The latest version’s
          copies are always kept.
        </p>
        <Choice
          id="vs-cleanup-manual"
          name="vs-cleanup"
          checked={cleanup === 'manual'}
          label="Manually"
          hint="Nothing is deleted on its own; delete them from the Verification Copies tab."
          onSelect={() => onChange({ cleanup: 'manual' })}
        />
        <Choice
          id="vs-cleanup-auto"
          name="vs-cleanup"
          checked={cleanup !== 'manual'}
          label="Automatically"
          hint="After each new version, delete what the rule below no longer keeps."
          onSelect={() => onChange({ cleanup: cleanup === 'manual' ? 'retention' : cleanup })}
        />
        {cleanup !== 'manual' && (
          <div className="nested-choices">
            <Choice
              id="vs-cleanup-retention"
              name="vs-cleanup-criterion"
              checked={cleanup === 'retention'}
              label="Follow what helpers keep"
              hint={
                retentionMode === 'select'
                  ? 'Keep only the version you chose at the latest publish; when that choice is not known, every copy is kept.'
                  : 'Keep only the version helpers were told to keep.'
              }
              onSelect={() => onChange({ cleanup: 'retention' })}
            />
            <Choice
              id="vs-cleanup-lastN"
              name="vs-cleanup-criterion"
              checked={cleanup === 'lastN'}
              label="Keep the last N versions"
              hint="Independent of what helpers keep."
              onSelect={() => onChange({ cleanup: 'lastN' })}
            />
            {cleanup === 'lastN' && (
              <>
                <input
                  id="vs-cleanup-n"
                  className="full-input settings-number-input"
                  type="number"
                  min={1}
                  step={1}
                  aria-label="Verification copies to keep"
                  value={draft.cleanupN}
                  onChange={e => onChange({ cleanupN: e.target.value })}
                  aria-invalid={problems.cleanupN !== undefined}
                />
                {problems.cleanupN && <p className="field-error">{problems.cleanupN}</p>}
              </>
            )}
          </div>
        )}
      </fieldset>

      <fieldset className="form-field">
        <legend className="form-label">Periodic verification</legend>
        <label className="checkbox-row" htmlFor="vs-verify-auto">
          <input
            id="vs-verify-auto"
            type="checkbox"
            checked={draft.verifyAuto}
            onChange={e => onChange({ verifyAuto: e.target.checked })}
          />
          <span>Verify shares automatically</span>
        </label>
        {draft.verifyAuto && (
          <div className="schedule-row">
            <span>Every</span>
            <input
              id="vs-verify-every"
              className="threshold-input"
              type="number"
              min={1}
              step={1}
              aria-label="Verify every"
              value={draft.verifyEvery}
              onChange={e => onChange({ verifyEvery: e.target.value })}
              aria-invalid={problems.verifyEvery !== undefined}
            />
            <select
              id="vs-verify-unit"
              className="full-input settings-select"
              aria-label="Unit"
              value={draft.verifyUnit}
              onChange={e => onChange({ verifyUnit: e.target.value as ScheduleUnit })}
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </div>
        )}
        {problems.verifyEvery ? (
          <p className="field-error">{problems.verifyEvery}</p>
        ) : (
          <p className="empty-hint">
            The same challenge as Verify Shares, on the current version, while this secret is open in a tab.
          </p>
        )}
      </fieldset>
    </>
  )
}
