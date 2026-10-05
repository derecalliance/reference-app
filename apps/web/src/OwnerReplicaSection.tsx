// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { ModalFrame } from './ModalFrame'
import { useState } from 'react'
import { errorText } from './errorText'

/**
 * The "add a replica" affordance, in the owner page's side panel.
 *
 * Sits directly below the provisioned helpers because that is where a user
 * looks for "another thing that holds my vault", and it is deliberately built
 * from the same classes so the two read as one panel.
 *
 * **There is no list here, and that is the point.** A replica is a pairing
 * mode, not a kind of actor: "+ Add" pairs a helper in replica mode, and what
 * that produces is a *channel*, which the Replicas tab lists alongside every
 * other replica channel — including one to another browser device, which joins
 * as an ordinary owner actor. Nothing on the roster marks either as a replica,
 * so there is nothing for a side-panel list to be built from.
 */

export interface OwnerReplicaSectionProps {
  /** Provision a helper under this name and pair it as a replica of this vault. */
  onAdd: (name: string) => Promise<void>
}

export function OwnerReplicaSection({ onAdd }: OwnerReplicaSectionProps) {
  const [addOpen, setAddOpen] = useState(false)

  return (
    <div className="side-panel-section">
      <div className="panel-header-row">
        <div>
          <h3 className="panel-heading">Replicas</h3>
          <p className="panel-subtitle">Mirror this vault onto another device</p>
        </div>
        <button
          className="secondary small"
          onClick={() => setAddOpen(true)}
          title="Pair a helper as a replica of this vault"
        >
          + Add
        </button>
      </div>

      <p className="panel-subtitle">
        “+ Add” pairs a helper as a replica of this vault. It appears on the Replicas
        tab, with every other replica channel.
      </p>

      {addOpen && (
        <AddReplicaModal
          onAdd={async name => {
            await onAdd(name)
            setAddOpen(false)
          }}
          onClose={() => setAddOpen(false)}
        />
      )}
    </div>
  )
}

function AddReplicaModal({
  onAdd,
  onClose,
}: {
  onAdd: (name: string) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setSubmitting(true)
    setError(null)
    try {
      await onAdd(trimmed)
    } catch (err) {
      setError(errorText(err))
      setSubmitting(false)
    }
  }

  return (
    <ModalFrame
      overlayClassName="modal-overlay"
      className="modal modal--form"
      label="Add replica"
      onEscape={submitting ? undefined : onClose}
    >
      <div className="modal-header">
        <h2 className="modal-title">Add Replica</h2>
      </div>
      <form onSubmit={handleSubmit}>
        <div className="modal-body">
          <p className="modal-description">
            A replica is another of your own devices. It mirrors this vault once both
            devices confirm a shared code.
          </p>
          <div className="form-field">
            <label className="form-label" htmlFor="add-replica-name">
              Name
            </label>
            <input
              id="add-replica-name"
              className="form-input"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Laptop"
              autoFocus
              disabled={submitting}
            />
          </div>
          {error && <p className="field-error">{error}</p>}
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!name.trim() || submitting}>
            {submitting ? 'Adding…' : 'Add Replica'}
          </button>
        </div>
      </form>
    </ModalFrame>
  )
}
