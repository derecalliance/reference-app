// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useId, useState } from 'react'

import { errorText } from '../errorText'
import { ModalFrame } from '../ModalFrame'
import type { RecoveredSecret, RecoveredSecretReplica } from '../types'
import { ModalCloseButton } from './primitives'
import { joinableMembers } from './replicaJoin'


interface JoinGroupModalProps {
  secret: RecoveredSecret
  onClose: () => void
  /** Open the Pair dialog set to "Replica destination" — the existing path that receives and adopts a vault. */
  onJoin: () => void
  /**
   * Pair as replica destination with `member` directly, when this node runs
   * it: the node mints that member's contact, so there is nothing to copy.
   */
  onJoinThrough: (member: RecoveredSecretReplica) => Promise<void>
}

/**
 * Recover, then restore or join (SDK 0.0.9). When the recovered vault names
 * live replicas, joining the group as a new replica is what the library
 * recommends over restoring next to them. Joining is ordinary replica pairing:
 * this device pairs with a live member as its replica destination, confirms the
 * fingerprint, and receives the vault.
 */
export function JoinGroupModal({ secret, onClose, onJoin, onJoinThrough }: JoinGroupModalProps) {
  const [joining, setJoining] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const limitationId = useId()

  async function joinThrough(member: RecoveredSecretReplica) {
    setJoining(member.replicaId)
    setError(null)
    try {
      await onJoinThrough(member)
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setJoining(null)
    }
  }

  const members = joinableMembers(secret)
  const source = secret.snapshot.replicas?.members.find(m => m.role === 'Source')
  const nameOf = (m: RecoveredSecretReplica) => m.communicationInfo?.['name'] || `replica ${m.replicaId}`

  return (
    <ModalFrame overlayClassName="modal-overlay" className="modal" label="Join the replica group" onEscape={onClose}>
      <div className="modal-header">
        <h2 className="modal-title">Join the Replica Group</h2>
        <ModalCloseButton onClose={onClose} />
      </div>
      <div className="modal-body">
        <p className="modal-description">
          <strong>{secret.label}</strong> (v{secret.version}) still lives on other devices in its replica group.
          While any of them is live, do not restore: restoring next to them makes this device claim the lost
          device’s place. Join the group as a new replica instead.
        </p>

        <div className="form-field">
          <span className="form-label">Live members you can join through</span>
          <ul className="participant-check-list" role="list">
            {members.map(m => (
              <li key={m.replicaId} className="participant-check-item join-member-row">
                <span>{nameOf(m)}</span> <code className="channel-id-inline">{m.replicaId}</code>
                <button
                  type="button"
                  className="secondary small"
                  onClick={() => void joinThrough(m)}
                  disabled={joining !== null}
                  // Left usable on purpose: the pairing itself works, and the
                  // reference app shows where the library stops (see the note).
                  title="When this node runs that member, pair with it directly — nothing to copy. Blocked by a known SDK 0.0.9 limitation: see the note below."
                  aria-describedby={limitationId}
                >
                  {joining === m.replicaId ? 'Pairing…' : `Join through ${nameOf(m)}`}
                </button>
              </li>
            ))}
          </ul>
          {source && (
            <p className="empty-hint">
              {nameOf(source)} published this version — normally the lost device. It stays in the group until you
              remove it from a live member (Replicas tab).
            </p>
          )}
        </div>

        {error && <p className="field-error" role="alert">{error}</p>}

        <p className="empty-hint">For a member this node runs, <strong>Join through</strong> does both steps below.</p>
        <ol className="join-steps">
          <li>On one of those devices, open <strong>Share Contact</strong> and copy its contact.</li>
          <li>
            Here, paste it into <strong>Pair</strong> as <strong>Replica destination</strong>. This device receives
            the vault from that member and, once you confirm the fingerprint, adopts it — replacing what this
            recovering vault holds.
          </li>
        </ol>

        <p className="field-error" role="note" id={limitationId}>
          Known SDK 0.0.9 limitation: the member hands the vault over as soon as it confirms the code, and this
          device ignores the handover until it has confirmed too — after which it cannot ask again. Confirm the
          code here before the member does. A member this node runs confirms on its own at once, so joining
          through one does not complete yet.
        </p>

        <p className="empty-hint">
          Either way, this device gets no verification copies of earlier versions: a joining device receives
          the copies of the version each sync carries, and the live members keep theirs.
        </p>

        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={onJoin}>
            Pair as replica destination
          </button>
        </div>
      </div>
    </ModalFrame>
  )
}
