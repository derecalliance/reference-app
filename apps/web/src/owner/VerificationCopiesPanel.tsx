// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState } from 'react'

import { errorText } from '../errorText'
import { ModalFrame } from '../ModalFrame'
import type { SecretBag } from '../types'
import type { CleanupContext } from '../vault/types'
import { bagVersionOf } from './bag'
import { TrashIcon } from './icons'
import { ModalCloseButton } from './primitives'
import { cleanupCandidates } from './proofCleanup'
import type { ProofCleanup } from './publishPolicy'
import { formatBytes } from './secretLimits'

type DeleteStatus =
  | { kind: 'idle' }
  | { kind: 'deleting' }
  | { kind: 'done'; removed: number[] }
  | { kind: 'error'; message: string }

interface VerificationCopiesPanelProps {
  context: CleanupContext
  bag: SecretBag | null
  /** The vault's automatic cleanup setting, summarised above the table. */
  autoCleanup: ProofCleanup
  /** Delete the copies of these versions; resolves with the ones actually deleted. */
  onDelete: (versions: readonly number[]) => Promise<number[]>
  /** Open Vault Settings, where automatic cleanup is changed. */
  onOpenSettings: () => void
}

const versionList = (versions: readonly number[]) => versions.map(v => `v${v}`).join(', ')

/**
 * The verification copies this device keeps of its own secret: per version,
 * the exact share each helper was sent, kept only to check that helper's
 * answers. Deleting them never affects recovery; that version just can no
 * longer be verified from here.
 *
 * One row per version, newest — the latest — first. The latest version and any
 * still being published are locked: their copies are what verifies the
 * current secret and the round in flight. Shares this vault holds for other
 * owners are a different thing (the Shares tab) and never listed.
 */
export function VerificationCopiesPanel({
  context,
  bag,
  autoCleanup,
  onDelete,
  onOpenSettings,
}: VerificationCopiesPanelProps) {
  const { usage, floor, criterion, helperKeep, helperChannels } = context
  const [selected, setSelected] = useState<number[]>([])
  const [pendingDelete, setPendingDelete] = useState<number[] | null>(null)
  const [status, setStatus] = useState<DeleteStatus>({ kind: 'idle' })
  const deleting = status.kind === 'deleting'

  const lockReason = (version: number): string | null => {
    if (!floor) return null
    if (version === floor.latest) return 'latest'
    if (floor.open.includes(version)) return 'being published'
    return null
  }
  const deletable = usage.map(u => u.version).filter(v => lockReason(v) === null)
  // A selection can outlive its rows: a deletion elsewhere (automatic cleanup,
  // another removal) drops them from `usage`.
  const liveSelection = selected.filter(v => deletable.includes(v))
  const allSelected = deletable.length > 0 && liveSelection.length === deletable.length

  const toggle = (version: number) =>
    setSelected(current =>
      current.includes(version) ? current.filter(v => v !== version) : [...current, version],
    )

  async function confirmDelete(versions: readonly number[]) {
    setPendingDelete(null)
    setStatus({ kind: 'deleting' })
    try {
      const removed = await onDelete(versions)
      setSelected(current => current.filter(v => !removed.includes(v)))
      setStatus({ kind: 'done', removed })
    } catch (err) {
      setStatus({ kind: 'error', message: errorText(err) })
    }
  }

  if (!floor || usage.length === 0) {
    return (
      <div className="tab-empty-state">
        <p>No verification copies on this device yet. They are kept for each version you publish or receive.</p>
      </div>
    )
  }

  return (
    <div className="card-list">
      <div className="detail-card">
        <div className="card-header">
          <span className="card-title">Verification Copies</span>
        </div>

        <div className="card-body">
          <p className="empty-hint">
            For each version, this device keeps a copy of exactly what it sent each helper, used only
            to verify that helper. Deleting a version’s copies never affects recovery; that version
            just can no longer be verified from here.
          </p>
          <p className="copies-auto-line">
            Automatic cleanup: <strong>{autoCleanupText(autoCleanup)}</strong>{' '}
            <button type="button" className="secondary small" onClick={onOpenSettings}>
              Change…
            </button>
          </p>

          <div className="copies-toolbar">
            <button
              type="button"
              className="secondary small"
              onClick={() => setSelected(cleanupCandidates(usage, floor, criterion))}
              disabled={deleting}
              title={`Select what the vault’s rule would delete: ${ruleText(criterion.kind, criterion.kind === 'lastN' ? criterion.n : null)}`}
            >
              Select by rule
            </button>
            <button
              type="button"
              className="danger small"
              onClick={() => setPendingDelete(liveSelection)}
              disabled={deleting || liveSelection.length === 0}
            >
              {deleting ? 'Deleting…' : `Delete selected (${liveSelection.length})`}
            </button>
          </div>

          {status.kind === 'done' && (
            <p className="empty-hint" role="status">
              {status.removed.length > 0
                ? `Deleted the verification copies of ${versionList(status.removed)}.`
                : 'Nothing was deleted.'}
            </p>
          )}
          {status.kind === 'error' && <p className="field-error">{status.message}</p>}

          <div className="versions-table-wrap">
            <table className="versions-table">
              <thead>
                <tr>
                  <th scope="col" className="versions-table__check">
                    <input
                      type="checkbox"
                      aria-label="Select every version that can be deleted"
                      checked={allSelected}
                      disabled={deleting || deletable.length === 0}
                      onChange={() => setSelected(allSelected ? [] : deletable)}
                    />
                  </th>
                  <th scope="col">Version</th>
                  <th scope="col">In history</th>
                  <th scope="col">Copies</th>
                  <th scope="col">Size</th>
                  <th scope="col">Helpers keep it</th>
                  <th scope="col">Verified</th>
                  <th scope="col" className="versions-table__actions-th" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {usage.map(u => {
                  const lock = lockReason(u.version)
                  const recorded = bagVersionOf(bag, u.version)
                  const keeps = helpersKeep(u.version, lock, helperKeep)
                  return (
                    <tr key={u.version} className="versions-table__row">
                      <td className="versions-table__check">
                        <input
                          type="checkbox"
                          aria-label={`Select v${u.version}`}
                          checked={lock === null && liveSelection.includes(u.version)}
                          disabled={lock !== null || deleting}
                          onChange={() => toggle(u.version)}
                        />
                      </td>
                      <td>
                        <span className="version-tag">v{u.version}</span>
                        {lock && <span className="copies-lock"> {lock}</span>}
                      </td>
                      <td title={recorded ? undefined : 'This device has no record of this version — received from a replica, or removed from the Secrets tab'}>
                        {recorded ? 'Yes' : <span className="empty-hint">No</span>}
                      </td>
                      <td>
                        {u.copies} of {helperChannels} helper{helperChannels === 1 ? '' : 's'}
                      </td>
                      <td>{formatBytes(u.bytes)}</td>
                      <td>
                        {keeps ? 'Yes' : (
                          <span className="versions-table__failed" title="Helpers were told to drop this version, so verifying it would fail">
                            No
                          </span>
                        )}
                      </td>
                      <td>
                        {recorded
                          ? `${recorded.verifiedParticipantIds.length}/${recorded.participantIds.length}`
                          : <span className="empty-hint">—</span>}
                      </td>
                      <td className="versions-table__actions">
                        {lock === null && (
                          <button
                            type="button"
                            className="secondary small remove-secret-btn versions-table__remove"
                            onClick={() => setPendingDelete([u.version])}
                            disabled={deleting}
                            title={`Delete the verification copies of v${u.version}`}
                            aria-label={`Delete the verification copies of v${u.version}`}
                          >
                            <TrashIcon />
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {pendingDelete && (
        <ConfirmDeleteCopiesModal
          versions={pendingDelete}
          onConfirm={() => void confirmDelete(pendingDelete)}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  )
}

function ConfirmDeleteCopiesModal({
  versions,
  onConfirm,
  onClose,
}: {
  versions: readonly number[]
  onConfirm: () => void
  onClose: () => void
}) {
  const plural = versions.length !== 1
  return (
    <ModalFrame overlayClassName="modal-overlay" className="modal" label="Delete verification copies" onEscape={onClose}>
      <div className="modal-header">
        <h2 className="modal-title">Delete Verification Copies</h2>
        <ModalCloseButton onClose={onClose} />
      </div>
      <div className="modal-body">
        <p className="modal-description">
          Delete this device’s verification copies of <strong>{versionList([...versions].sort((a, b) => b - a))}</strong>?
          {plural ? ' Those versions' : ' That version'} can then no longer be verified from here.
          Recovery is not affected, and nothing is sent to helpers.
        </p>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={onConfirm}>
            Delete copies
          </button>
        </div>
      </div>
    </ModalFrame>
  )
}

/**
 * Whether helpers still hold `version`, so verifying it can succeed. The
 * latest and an open round are always kept; otherwise the latest version's
 * keep-list decides, and with no list helpers keep everything.
 */
function helpersKeep(version: number, lock: string | null, keep: readonly number[] | null): boolean {
  if (lock !== null || keep === null) return true
  return keep.includes(version)
}

function ruleText(kind: 'retention' | 'lastN', n: number | null): string {
  return kind === 'lastN' ? `keep the last ${n} versions` : 'follow what helpers keep'
}

function autoCleanupText(cleanup: ProofCleanup): string {
  if (cleanup.mode === 'manual') return 'off'
  return cleanup.criterion === 'lastN' ? ruleText('lastN', cleanup.n) : ruleText('retention', null)
}
