// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState } from 'react'

import { errorText } from '../errorText'
import { ModalFrame } from '../ModalFrame'
import type { CleanupContext } from '../vault/types'
import { ModalCloseButton } from './primitives'
import { cleanupCandidates, type CleanupCriterion } from './proofCleanup'
import { formatBytes } from './secretLimits'

interface CleanupModalProps {
  context: CleanupContext
  /** Delete the copies of these versions; resolves with the ones actually deleted. */
  onCleanup: (versions: readonly number[]) => Promise<number[]>
  onClose: () => void
}

type CleanupStatus =
  | { kind: 'idle' }
  | { kind: 'deleting' }
  | { kind: 'done'; removed: number[] }
  | { kind: 'error'; message: string }

const versionList = (versions: readonly number[]) => versions.map(v => `v${v}`).join(', ')

/** How the pre-selection was made, in the owner's terms. */
function criterionText(criterion: CleanupCriterion): string {
  if (criterion.kind === 'lastN') return `keep the last ${criterion.n} versions`
  return criterion.keep === null
    ? 'follow what helpers keep — no keep-list is known for the latest version, so nothing is pre-selected'
    : 'follow what helpers keep'
}

/**
 * Delete old verification copies: the record this device keeps of exactly
 * what each helper holds for a version, used only to verify it. Recovery is
 * never affected; a version whose copies are gone just can no longer be
 * verified from this device. The latest version and any round still open are
 * always kept, and shares held for other owners are never listed.
 */
export function CleanupModal({ context, onCleanup, onClose }: CleanupModalProps) {
  const { usage, floor, criterion } = context
  const [selected, setSelected] = useState<number[]>(() =>
    floor ? cleanupCandidates(usage, floor, criterion) : [],
  )
  const [status, setStatus] = useState<CleanupStatus>({ kind: 'idle' })
  const deleting = status.kind === 'deleting'

  const locked = (version: number) => floor !== null && (version === floor.latest || floor.open.includes(version))
  const toggle = (version: number) =>
    setSelected(current =>
      current.includes(version) ? current.filter(v => v !== version) : [...current, version].sort((a, b) => b - a),
    )

  async function handleDelete() {
    setStatus({ kind: 'deleting' })
    try {
      const removed = await onCleanup(selected)
      setStatus({ kind: 'done', removed })
    } catch (err) {
      setStatus({ kind: 'error', message: errorText(err) })
    }
  }

  return (
    <ModalFrame overlayClassName="modal-overlay" className="modal" label="Clean up verification copies" onEscape={deleting ? undefined : onClose}>
      <div className="modal-header">
        <h2 className="modal-title">Clean Up Verification Copies</h2>
        {!deleting && <ModalCloseButton onClose={onClose} />}
      </div>
      <div className="modal-body">
        <p className="modal-description">
          This device keeps a copy of what each helper holds, per version, only to verify it. Deleting a
          version’s copies never affects recovery; that version just can no longer be verified from here.
        </p>

        {!floor || usage.length === 0 ? (
          <p className="empty-hint">Nothing to clean up yet.</p>
        ) : status.kind === 'done' ? (
          <p className="empty-hint" role="status">
            {status.removed.length > 0
              ? `Deleted the verification copies of ${versionList(status.removed)}.`
              : 'Nothing was deleted.'}
          </p>
        ) : (
          <>
            <p className="empty-hint">Pre-selected by the vault’s rule: {criterionText(criterion)}.</p>
            <ul className="participant-check-list" role="list">
              {usage.map(u => {
                const isLocked = locked(u.version)
                return (
                  <li key={u.version} className="participant-check-item">
                    <label className="checkbox-row" htmlFor={`cu-${u.version}`}>
                      <input
                        id={`cu-${u.version}`}
                        type="checkbox"
                        checked={!isLocked && selected.includes(u.version)}
                        disabled={isLocked || deleting}
                        onChange={() => toggle(u.version)}
                      />
                      <span>
                        v{u.version} — {u.copies} cop{u.copies === 1 ? 'y' : 'ies'}, {formatBytes(u.bytes)}
                        {u.version === floor.latest && ' (latest — always kept)'}
                        {floor.open.includes(u.version) && ' (still being published — always kept)'}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </>
        )}

        {status.kind === 'error' && <p className="field-error">{status.message}</p>}

        <div className="modal-actions">
          {status.kind === 'done' || !floor || usage.length === 0 ? (
            <button type="button" className="primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button type="button" className="secondary" onClick={onClose} disabled={deleting}>
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => void handleDelete()}
                disabled={deleting || selected.length === 0}
              >
                {deleting
                  ? 'Deleting…'
                  : `Delete copies of ${selected.length} version${selected.length === 1 ? '' : 's'}`}
              </button>
            </>
          )}
        </div>
      </div>
    </ModalFrame>
  )
}
