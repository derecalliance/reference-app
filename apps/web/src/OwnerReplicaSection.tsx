import { useState } from 'react'
import { pairingRoleLabel } from './pairingRoleOptions'
import type { ReplicaView } from './replicaFlows'

/**
 * Provisioned replicas, in the owner page's side panel.
 *
 * Sits directly below the provisioned participants and is deliberately built
 * from the same classes and the same affordances — add, expand, status, take
 * offline — because it is the same kind of thing: a backend-hosted actor this
 * this owner has. The only difference that matters is what the actor *is*, and
 * that is what the direction line and the confirm action say.
 *
 * A browser replica has no entry here on purpose. It is another one of the
 * user's own devices joining as an ordinary owner actor; there is nothing for
 * this owner to provision, and its channel is listed in the Replicas tab
 * alongside every other replica.
 */

export interface OwnerReplicaSectionProps {
  /** Provisioned replica rows, already filtered by the page. */
  replicas: ReplicaView[]
  /** `null` until the first roster poll lands — distinguishes "loading" from "none". */
  loaded: boolean
  onAdd: (name: string) => Promise<void>
  /** Start a `replica_source` handshake against this replica. */
  onPair: (replica: ReplicaView) => Promise<void>
  onToggleOffline: (replica: ReplicaView) => Promise<void>
  /** Open the fingerprint comparison for this replica's channel. */
  onOpenFingerprint: (channelId: string) => void
}

export function OwnerReplicaSection({
  replicas,
  loaded,
  onAdd,
  onPair,
  onToggleOffline,
  onOpenFingerprint,
}: OwnerReplicaSectionProps) {
  const [addOpen, setAddOpen] = useState(false)

  return (
    <div className="side-panel-section">
      <div className="panel-header-row">
        <div>
          <h3 className="panel-heading">Provisioned replicas</h3>
          <p className="panel-subtitle">
            {loaded ? `${replicas.length} provisioned` : 'Loading…'}
          </p>
        </div>
        <button
          className="secondary small"
          onClick={() => setAddOpen(true)}
          title="Add a backend-hosted replica of this vault"
        >
          + Add
        </button>
      </div>

      {loaded && replicas.length === 0 ? (
        <p className="panel-subtitle">
          None yet. A replica mirrors this vault to another device once both confirm a
          shared code.
        </p>
      ) : (
        <ul className="side-participant-list" role="list">
          {replicas.map(replica => (
            <SideReplicaItem
              key={replica.id}
              replica={replica}
              onPair={() => onPair(replica)}
              onToggleOffline={() => onToggleOffline(replica)}
              onOpenFingerprint={onOpenFingerprint}
            />
          ))}
        </ul>
      )}

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

/** The status word for a provisioned replica row. */
function statusLabel(replica: ReplicaView): { text: string; className: string } {
  switch (replica.status) {
    case 'unpaired':
      return { text: 'Not paired', className: 'available' }
    case 'pending':
      return { text: 'Pending', className: 'available' }
    case 'paired':
      return { text: 'Paired', className: 'paired' }
  }
}

function SideReplicaItem({
  replica,
  onPair,
  onToggleOffline,
  onOpenFingerprint,
}: {
  replica: ReplicaView
  onPair: () => Promise<void>
  onToggleOffline: () => Promise<void>
  onOpenFingerprint: (channelId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const status = statusLabel(replica)
  const { channelId } = replica

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The action could not be completed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="side-participant-item">
      <button
        className="side-participant-header"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
      >
        <span
          className={`participant-dot ${
            replica.offline ? 'offline' : replica.status === 'paired' ? 'paired' : 'available'
          }`}
          aria-hidden="true"
        />
        <span className="side-participant-name">{replica.name}</span>
        {replica.offline ? (
          <span className="status-tag offline">Offline</span>
        ) : (
          <span className={`status-tag ${status.className}`}>{status.text}</span>
        )}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`chevron-icon ${expanded ? 'expanded' : ''}`}
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {expanded && (
        <div className="side-participant-details">
          <div className="side-detail-row">
            <span className="side-detail-label">Channel ID</span>
            <span className="side-detail-value" title={channelId ?? ''}>
              {channelId ?? '—'}
            </span>
          </div>
          <p className="side-replica-direction">
            This device is the {pairingRoleLabel(replica.direction).toLowerCase()} on this
            channel.
          </p>
          {error && <p className="field-error">{error}</p>}
          <div className="side-participant-actions">
            {replica.status === 'unpaired' ? (
              <button
                className="pair-action-btn pair"
                disabled={busy}
                onClick={() => void run(onPair)}
              >
                {busy ? 'Pairing…' : 'Pair'}
              </button>
            ) : (
              channelId !== null && (
                <button className="pair-action-btn" onClick={() => onOpenFingerprint(channelId)}>
                  {replica.status === 'pending' ? 'Confirm fingerprint' : 'View fingerprint'}
                </button>
              )
            )}
            <button
              className={`pair-action-btn ${replica.offline ? 'pair' : 'unpair'}`}
              disabled={busy}
              onClick={() => void run(onToggleOffline)}
            >
              {busy ? '…' : replica.offline ? 'Go Online' : 'Go Offline'}
            </button>
          </div>
        </div>
      )}
    </li>
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
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Add replica">
      <div className="modal" style={{ maxWidth: 400 }}>
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
      </div>
    </div>
  )
}
