// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useEffect, useState } from 'react'

import { ModalFrame } from '../ModalFrame'
import { errorText } from '../errorText'
import {
  endpointProblem,
  identityUpdateCounts,
  MAX_VAULT_NAME_LENGTH,
  pinnedEndpointWarnings,
  undeliveredChannelIds,
  vaultNameProblem,
} from '../vault/identity'
import type { ChannelInfoOutcome, IdentityUpdate } from '../vault/types'
import { ModalCloseButton } from './primitives'

export interface EditIdentityInput {
  name: string
  /** `null` follows the node's address; a string pins that one. */
  endpoint: string | null
}

interface EditIdentityModalProps {
  /** This vault's id — its mailbox path is `/derec/<id>`. */
  vaultId: string
  currentName: string
  currentEndpoint: string
  /** Whether the endpoint was set by hand rather than following the node. */
  pinned: boolean
  /** Where the node says this vault lives, when it has said. */
  nodeAddress: string | null
  /**
   * The node's roster has been read at least once. Until then a missing
   * `nodeAddress` means "not asked yet", not "not listed".
   */
  rosterLoaded: boolean
  /** The protocol timeout, in seconds — how long a peer is waited on. */
  timeoutSecs: number
  /** The live result of the latest update — read from the runtime state. */
  update: IdentityUpdate | null
  onSubmit: (input: EditIdentityInput) => Promise<IdentityUpdate | null>
  /** Send the latest update again to the peers it did not reach. */
  onResend: () => Promise<IdentityUpdate | null>
  onClose: () => void
}

type Step =
  | { kind: 'editing'; error: string | null }
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'unchanged' }

const OUTCOME_LABEL: Record<ChannelInfoOutcome, string> = {
  pending: 'Waiting…',
  updated: 'Updated',
  rejected: 'Rejected',
  failed: 'Not delivered',
  'no-answer': 'No answer',
}

/**
 * Change how this vault presents itself to peers — its name and its endpoint —
 * and follow each paired peer's answer.
 *
 * The endpoint either follows the address the node advertises for this vault
 * (the default; it moves when the node is republished on another port or
 * address) or is pinned to one typed here.
 */
export function EditIdentityModal({
  vaultId,
  currentName,
  currentEndpoint,
  pinned,
  nodeAddress,
  rosterLoaded,
  timeoutSecs,
  update,
  onSubmit,
  onResend,
  onClose,
}: EditIdentityModalProps) {
  const [name, setName] = useState(currentName)
  const [followNode, setFollowNode] = useState(!pinned)
  const [endpoint, setEndpoint] = useState(currentEndpoint)
  const [step, setStep] = useState<Step>({ kind: 'editing', error: null })

  const nameError = vaultNameProblem(name)
  const endpointError = followNode ? null : endpointProblem(endpoint)
  const sending = step.kind === 'sending'
  // Only for a well-formed pinned address: the error above already covers a
  // malformed one, and following the node cannot pin anything wrong.
  const endpointWarnings =
    followNode || endpointError ? [] : pinnedEndpointWarnings(endpoint, vaultId, nodeAddress)
  const undelivered = undeliveredChannelIds(update).length

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (nameError || endpointError) return
    setStep({ kind: 'sending' })
    try {
      const result = await onSubmit({ name: name.trim(), endpoint: followNode ? null : endpoint.trim() })
      setStep(result ? { kind: 'sent' } : { kind: 'unchanged' })
    } catch (err) {
      setStep({ kind: 'editing', error: errorText(err) })
    }
  }

  return (
    <ModalFrame
      overlayClassName="modal-overlay"
      className="modal"
      labelledBy="edit-identity-title"
      onEscape={sending ? undefined : onClose}
    >
      <div className="modal-header">
        <h2 className="modal-title" id="edit-identity-title">Edit Identity</h2>
        {!sending && <ModalCloseButton onClose={onClose} />}
      </div>

      {step.kind === 'sent' && update ? (
        <IdentityUpdateResult
          update={update}
          timeoutSecs={timeoutSecs}
          onResend={onResend}
          onClose={onClose}
        />
      ) : step.kind === 'unchanged' ? (
        <div className="modal-body">
          <p className="modal-description">Nothing changed, so no peer was told.</p>
          <div className="modal-actions">
            <button type="button" className="primary" onClick={onClose}>Done</button>
          </div>
        </div>
      ) : (
        <form className="modal-body" onSubmit={e => void handleSubmit(e)} noValidate>
          <p className="modal-description">
            How peers see this vault. A change is sent to every paired peer, and
            new contacts carry it.
          </p>

          <div className="form-field">
            <label className="form-label" htmlFor="identity-name">Name</label>
            <input
              id="identity-name"
              className="full-input"
              type="text"
              value={name}
              maxLength={MAX_VAULT_NAME_LENGTH + 16}
              onChange={e => setName(e.target.value)}
              disabled={sending}
              aria-invalid={nameError !== null}
              aria-describedby={nameError ? 'identity-name-error' : undefined}
              autoFocus
            />
            {nameError && (
              <p className="field-error" id="identity-name-error">{nameError}</p>
            )}
          </div>

          <div className="form-field">
            <span className="form-label">Endpoint</span>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={followNode}
                onChange={e => setFollowNode(e.target.checked)}
                disabled={sending}
              />
              <span>Follow the address the node advertises</span>
            </label>
            {followNode ? (
              <p className="empty-hint" aria-busy={!rosterLoaded || undefined}>
                <code>{nodeAddress ?? currentEndpoint}</code>
                {nodeAddress === null &&
                  (rosterLoaded
                    ? ' — the node has not listed this vault yet.'
                    : ' — checking where the node lists this vault…')}
              </p>
            ) : (
              <>
                <input
                  id="identity-endpoint"
                  className="full-input"
                  type="url"
                  aria-label="Endpoint"
                  value={endpoint}
                  onChange={e => setEndpoint(e.target.value)}
                  disabled={sending}
                  aria-invalid={endpointError !== null}
                  aria-describedby={endpointError ? 'identity-endpoint-error' : 'identity-endpoint-hint'}
                />
                {endpointError ? (
                  <p className="field-error" id="identity-endpoint-error">{endpointError}</p>
                ) : (
                  <p className="empty-hint" id="identity-endpoint-hint">
                    Pinned: the node’s address changes will no longer move it. Peers
                    reply here, so it must reach this vault’s mailbox.
                  </p>
                )}
                {/* Non-blocking, but not quiet: an address peers cannot answer
                    leaves every one of them at "waiting" until the timeout. */}
                {endpointWarnings.length > 0 && (
                  <div className="identity-endpoint-warning" role="alert">
                    <strong>Peers may not be able to reach this address.</strong>
                    <ul>
                      {endpointWarnings.map(w => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>

          {step.kind === 'editing' && step.error && <p className="field-error">{step.error}</p>}

          {undelivered > 0 && (
            <p className="empty-hint">
              The last update did not reach {undelivered} peer{undelivered === 1 ? '' : 's'}.
              Saving without changes sends it to them again.
            </p>
          )}

          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose} disabled={sending}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              disabled={sending || nameError !== null || endpointError !== null}
            >
              {sending ? 'Sending…' : 'Save and tell peers'}
            </button>
          </div>
        </form>
      )}
    </ModalFrame>
  )
}

/** Each paired peer's answer to the update, as it arrives. */
function IdentityUpdateResult({
  update,
  timeoutSecs,
  onResend,
  onClose,
}: {
  update: IdentityUpdate
  timeoutSecs: number
  onResend: () => Promise<IdentityUpdate | null>
  onClose: () => void
}) {
  const entries = Object.entries(update.channels)
  const counts = identityUpdateCounts(update)
  const undelivered = counts.failed + counts['no-answer']
  const now = useNow(counts.pending > 0)
  const [resending, setResending] = useState(false)
  const [resendError, setResendError] = useState<string | null>(null)
  const what = [update.changed.name && 'name', update.changed.endpoint && 'endpoint']
    .filter(Boolean)
    .join(' and ')

  async function handleResend() {
    setResending(true)
    setResendError(null)
    try {
      await onResend()
    } catch (err) {
      setResendError(errorText(err))
    } finally {
      setResending(false)
    }
  }

  return (
    <div className="modal-body">
      {entries.length === 0 ? (
        <p className="modal-description">
          Saved. No peer is paired yet, so there was no one to tell — new contacts
          carry the new {what}.
        </p>
      ) : (
        <>
          <p className="share-progress-summary" role="status">
            New {what} sent to {entries.length} peer{entries.length === 1 ? '' : 's'}:{' '}
            {counts.updated} updated
            {counts.pending > 0 && ` · ${counts.pending} waiting`}
            {counts.rejected > 0 && ` · ${counts.rejected} rejected`}
            {counts.failed > 0 && ` · ${counts.failed} not delivered`}
            {counts['no-answer'] > 0 && ` · ${counts['no-answer']} no answer`}
          </p>
          <ul className="share-progress-list" role="list">
            {entries.map(([channelId, entry]) => {
              const bad = entry.outcome === 'rejected' || entry.outcome === 'failed' || entry.outcome === 'no-answer'
              return (
                <li
                  key={channelId}
                  className={`share-progress-item ${entry.outcome === 'updated' ? 'share-progress-item--confirmed' : ''} ${bad ? 'share-progress-item--failed' : ''}`}
                >
                  <span className="share-progress-item-name">{entry.peerName}</span>
                  <span
                    className={`share-progress-item-status ${entry.outcome === 'updated' ? 'status--verified' : ''} ${bad ? 'status--failed' : ''}`}
                    title={entry.detail ?? undefined}
                  >
                    {entry.outcome === 'pending'
                      ? `Waiting… ${waitedText(now - entry.sentAt)} of ${timeoutSecs}s`
                      : OUTCOME_LABEL[entry.outcome]}
                  </span>
                </li>
              )
            })}
          </ul>
          {counts.pending > 0 && (
            <p className="empty-hint">
              Closing is safe — the update is already on its way, and answers keep
              arriving in the console. A peer still silent after {timeoutSecs}s is
              marked “No answer”.
            </p>
          )}
          {resendError && <p className="field-error">{resendError}</p>}
        </>
      )}
      <div className="modal-actions">
        {undelivered > 0 && (
          <button
            type="button"
            className="secondary"
            onClick={() => void handleResend()}
            disabled={resending}
            aria-busy={resending || undefined}
          >
            {resending ? 'Resending…' : `Resend to ${undelivered} peer${undelivered === 1 ? '' : 's'} that didn’t get it`}
          </button>
        )}
        <button type="button" className="primary" onClick={onClose}>Done</button>
      </div>
    </div>
  )
}

/** Whole seconds waited, for the per-peer "Waiting…" line. */
function waitedText(ms: number): string {
  return `${Math.max(0, Math.floor(ms / 1000))}s`
}

/** The current time, re-read every second while `ticking`. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}
