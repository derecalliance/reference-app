// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useId } from 'react'
import { isActorId } from './wizardForm'

/** Minimal view of an existing actor surfaced by the picker. Mirrors the
 *  fields the wizard renders; not a full BE DTO. */
export interface ClaimableActor {
  id: string
  name: string
  /** When the node last saw this actor's mailbox drained, if it says. */
  lastPolledAt: string | null
}

export interface StepClaimActorProps {
  actors: ClaimableActor[]
  selectedId: string
  onChange: (id: string) => void
  loading: boolean
  error: string | null
  /**
   * The selected actor's mailbox was drained moments ago — another browser is
   * probably driving it. Claiming anyway splits one mailbox between two
   * devices, each draining messages the other then never sees.
   */
  activeElsewhere: boolean
  /** The user has acknowledged `activeElsewhere` and wants to claim anyway. */
  confirmedActive: boolean
  onConfirmActiveChange: (confirmed: boolean) => void
  /** The threshold the claimed vault will run with, as typed. */
  threshold: string
  /** Why `threshold` is unusable, or `null`. */
  thresholdError: string | null
  onThresholdChange: (text: string) => void
}

/**
 * Step where a recovering user picks an existing owner actor whose mailbox this
 * tab will adopt. Two equivalent inputs are offered:
 *  - select from the loaded list of `role === 'owner'` actors on the server;
 *  - paste a UUID directly (matches the "in a real app, auth hands you the
 *    id" model and works when the picker doesn't surface the right entry).
 *
 * `selectedId` reflects whichever input was used last. Listing and paste
 * keep each other in sync — clicking a row fills the paste field, typing
 * a valid UUID highlights the matching row.
 *
 * A pasted value is checked for the UUID shape here. The server would refuse a
 * malformed one anyway, but only as an extractor rejection — a status code and
 * a parser message — after the user had already pressed Claim.
 */
export function StepClaimActor({
  actors,
  selectedId,
  onChange,
  loading,
  error,
  activeElsewhere,
  confirmedActive,
  onConfirmActiveChange,
  threshold,
  thresholdError,
  onThresholdChange,
}: StepClaimActorProps) {
  const hintId = useId()
  const thresholdHintId = useId()
  const trimmed = selectedId.trim()
  const malformed = trimmed !== '' && !isActorId(trimmed)

  return (
    <div className="wizard-step">
      <h2>Recover as which owner?</h2>
      <p>
        Pick an existing owner from the server below, or paste their actor ID.
        After recovery your tab adopts that actor's mailbox so helpers'
        replies — verification, share retrieval, future protect rounds — keep
        flowing to the same transport URI they already know.
      </p>

      {loading ? (
        <p className="wizard-field-hint">Loading owners…</p>
      ) : actors.length === 0 ? (
        <p className="wizard-field-hint">
          No other owners found on this server. Paste an actor ID below if you
          have one.
        </p>
      ) : (
        <div
          className="link-channel-list"
          role="listbox"
          aria-label="Existing owners on this server"
        >
          {actors.map(a => {
            const isSelected = trimmed === a.id
            return (
              <button
                key={a.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`link-channel-option${isSelected ? ' link-channel-option--selected' : ''}`}
                onClick={() => onChange(a.id)}
              >
                <span className="link-channel-option__name">{a.name}</span>
                <span className="link-channel-option__meta">{a.id}</span>
              </button>
            )
          })}
        </div>
      )}

      <label className="wizard-field-label wizard-field-label--spaced">
        Or paste an actor ID
        <input
          className="full-input"
          type="text"
          placeholder="e.g. a1b2c3d4-…"
          value={selectedId}
          onChange={e => onChange(e.target.value)}
          aria-invalid={malformed}
          aria-describedby={malformed ? hintId : undefined}
        />
      </label>
      {malformed && (
        <p id={hintId} className="wizard-field-error">
          That is not an actor ID. Actor IDs are UUIDs, like
          {' '}<code>3f2b8c1e-5d4a-4b6f-9e2d-1a7c0b9d8e6f</code> — copy one from the list
          above or from the Inspect section.
        </p>
      )}

      <label className="wizard-field-label wizard-field-label--spaced">
        Shares needed to recover (threshold)
        <input
          className="full-input"
          type="number"
          min={2}
          step={1}
          value={threshold}
          onChange={e => onThresholdChange(e.target.value)}
          aria-invalid={thresholdError !== null}
          aria-describedby={thresholdHintId}
        />
      </label>
      <p
        id={thresholdHintId}
        className={thresholdError ? 'wizard-field-error' : 'wizard-field-hint'}
      >
        {thresholdError ??
          'The node does not record the threshold a vault was set up with, so confirm it here. ' +
            'Prefilled with this node’s default — change it if the original vault used another.'}
      </p>

      {activeElsewhere && (
        <div className="wizard-claim-warning" role="alert">
          <p>
            <strong>This owner looks active in another browser.</strong> The node saw its
            mailbox drained in the last few seconds. Claiming it here means two devices
            drain one mailbox — each takes messages the other never sees, and flows on
            both break. Close it in the other browser first if you can.
          </p>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={confirmedActive}
              onChange={e => onConfirmActiveChange(e.target.checked)}
            />
            <span>Claim it anyway — I understand the other browser will miss messages</span>
          </label>
        </div>
      )}

      {error && <p className="wizard-field-error">{error}</p>}
    </div>
  )
}
