// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState } from 'react'

import { ModalFrame } from '../ModalFrame'
import { ModalCloseButton } from './primitives'
import {
  DEFAULT_RETAINED_VERSIONS,
  publishPolicyProblems,
  type HelperRetention,
  type ProofCleanup,
  type PublishPolicy,
} from './publishPolicy'
import { scheduleProblem, type ScheduleUnit, type VerificationSchedule } from './verificationSchedule'

/** A verification schedule as the dialog edits it — `since` is the runtime's. */
type ScheduleChoice = Pick<VerificationSchedule, 'every' | 'unit'>

interface VaultSettingsModalProps {
  policy: PublishPolicy
  /** The automatic verification schedule, or `null` when verification is by hand only. */
  schedule: ScheduleChoice | null
  /**
   * The threshold the library last published with (it reuses it for the
   * publishes it starts on its own), or `null` when unknown or no version yet.
   */
  lastPublishedThreshold: number | null
  onSave: (next: PublishPolicy, schedule: ScheduleChoice | null) => void
  onClose: () => void
}

type RetentionMode = HelperRetention['mode']
type CleanupChoice = 'manual' | 'retention' | 'lastN'

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
 * The owner's standing choices for this vault: the threshold a publish starts
 * from, which versions helpers keep, when old verification copies are deleted,
 * and how often shares are verified automatically. Saving sends nothing; the
 * choices apply from the next publish or check. Per helper default weights are
 * set on the Channels list.
 */
export function VaultSettingsModal({ policy, schedule, lastPublishedThreshold, onSave, onClose }: VaultSettingsModalProps) {
  const [verifyAuto, setVerifyAuto] = useState(schedule !== null)
  const [verifyEvery, setVerifyEvery] = useState(String(schedule?.every ?? 1))
  const [verifyUnit, setVerifyUnit] = useState<ScheduleUnit>(schedule?.unit ?? 'days')
  const verifyProblem = verifyAuto ? scheduleProblem(Number(verifyEvery)) : null
  const [threshold, setThreshold] = useState(String(policy.defaultThreshold))
  const [retentionMode, setRetentionMode] = useState<RetentionMode>(policy.helperRetention.mode)
  const [retentionN, setRetentionN] = useState(
    String(policy.helperRetention.mode === 'lastN' ? policy.helperRetention.n : DEFAULT_RETAINED_VERSIONS),
  )
  const [cleanup, setCleanup] = useState<CleanupChoice>(
    policy.proofCleanup.mode === 'manual' ? 'manual' : policy.proofCleanup.criterion,
  )
  const [cleanupN, setCleanupN] = useState(
    String(policy.proofCleanup.mode === 'auto' && policy.proofCleanup.criterion === 'lastN' ? policy.proofCleanup.n : DEFAULT_RETAINED_VERSIONS),
  )

  const helperRetention: HelperRetention =
    retentionMode === 'lastN' ? { mode: 'lastN', n: Number(retentionN) } : { mode: 'select' }
  const proofCleanup: ProofCleanup =
    cleanup === 'manual'
      ? { mode: 'manual' }
      : cleanup === 'retention'
        ? { mode: 'auto', criterion: 'retention' }
        : { mode: 'auto', criterion: 'lastN', n: Number(cleanupN) }
  const next: PublishPolicy = { ...policy, defaultThreshold: Number(threshold), helperRetention, proofCleanup }
  const problems = publishPolicyProblems(next)
  const valid = Object.keys(problems).length === 0 && verifyProblem === null

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid) return
    onSave(next, verifyAuto ? { every: Number(verifyEvery), unit: verifyUnit } : null)
    onClose()
  }

  return (
    <ModalFrame overlayClassName="modal-overlay" className="modal" label="Vault settings" onEscape={onClose}>
      <div className="modal-header">
        <h2 className="modal-title">Vault Settings</h2>
        <ModalCloseButton onClose={onClose} />
      </div>
      <form className="modal-body" onSubmit={handleSubmit}>
        <p className="modal-description">
          How this vault publishes. Nothing is sent when you save: these apply from the next publish.
          They are this device’s choices — a replica of this vault keeps its own.
        </p>

        <div className="form-field">
          <label className="form-label" htmlFor="vs-threshold">Default threshold</label>
          <input
            id="vs-threshold"
            className="full-input"
            type="number"
            inputMode="numeric"
            min={2}
            step={1}
            value={threshold}
            onChange={e => setThreshold(e.target.value)}
            aria-invalid={problems.defaultThreshold !== undefined}
            aria-describedby="vs-threshold-hint"
          />
          {problems.defaultThreshold ? (
            <p className="field-error" id="vs-threshold-hint">{problems.defaultThreshold}</p>
          ) : (
            <p className="empty-hint" id="vs-threshold-hint">
              Subshares needed to recover. Each publish starts from this and can change it.
              {lastPublishedThreshold !== null && lastPublishedThreshold !== Number(threshold) &&
                ` The library last published at ${lastPublishedThreshold}, and reuses that for the publishes it starts on its own.`}
            </p>
          )}
        </div>

        <fieldset className="form-field">
          <legend className="form-label">Versions helpers keep</legend>
          <Choice
            id="vs-retention-lastN"
            name="vs-retention"
            checked={retentionMode === 'lastN'}
            label="Keep the last N versions"
            hint="Every publish tells helpers to keep the N newest versions plus any still being published."
            onSelect={() => setRetentionMode('lastN')}
          />
          {retentionMode === 'lastN' && (
            <>
              <input
                id="vs-retention-n"
                className="full-input"
                type="number"
                min={1}
                step={1}
                aria-label="Versions helpers keep"
                value={retentionN}
                onChange={e => setRetentionN(e.target.value)}
                aria-invalid={problems.retentionN !== undefined}
              />
              {problems.retentionN && <p className="field-error">{problems.retentionN}</p>}
            </>
          )}
          <Choice
            id="vs-retention-select"
            name="vs-retention"
            checked={retentionMode === 'select'}
            label="Choose at each publish"
            hint="Each publish asks which versions to keep. Publishes the library starts on its own send no list, so helpers keep everything."
            onSelect={() => setRetentionMode('select')}
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
            onSelect={() => setCleanup('manual')}
          />
          <Choice
            id="vs-cleanup-auto"
            name="vs-cleanup"
            checked={cleanup !== 'manual'}
            label="Automatically"
            hint="After each new version, delete what the rule below no longer keeps."
            onSelect={() => setCleanup(c => (c === 'manual' ? 'retention' : c))}
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
                    ? 'Helpers keep what you choose at each publish, so there is no standing rule: this keeps every copy.'
                    : 'Keep only the versions helpers were told to keep.'
                }
                onSelect={() => setCleanup('retention')}
              />
              <Choice
                id="vs-cleanup-lastN"
                name="vs-cleanup-criterion"
                checked={cleanup === 'lastN'}
                label="Keep the last N versions"
                hint="Independent of what helpers keep."
                onSelect={() => setCleanup('lastN')}
              />
              {cleanup === 'lastN' && (
                <>
                  <input
                    id="vs-cleanup-n"
                    className="full-input"
                    type="number"
                    min={1}
                    step={1}
                    aria-label="Verification copies to keep"
                    value={cleanupN}
                    onChange={e => setCleanupN(e.target.value)}
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
              checked={verifyAuto}
              onChange={e => setVerifyAuto(e.target.checked)}
            />
            <span>Verify shares automatically</span>
          </label>
          {verifyAuto && (
            <div className="schedule-row">
              <span>Every</span>
              <input
                id="vs-verify-every"
                className="helper-weight-input"
                type="number"
                min={1}
                step={1}
                aria-label="Verify every"
                value={verifyEvery}
                onChange={e => setVerifyEvery(e.target.value)}
                aria-invalid={verifyProblem !== null}
              />
              <select
                id="vs-verify-unit"
                aria-label="Unit"
                value={verifyUnit}
                onChange={e => setVerifyUnit(e.target.value as ScheduleUnit)}
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
            </div>
          )}
          {verifyProblem ? (
            <p className="field-error">{verifyProblem}</p>
          ) : (
            <p className="empty-hint">
              The same challenge as Verify Shares, on the current version, while this vault is open in a tab.
            </p>
          )}
        </fieldset>

        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            Save
          </button>
        </div>
      </form>
    </ModalFrame>
  )
}
