// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { BagPayloadModal } from './BagPayloadModal'
import { VerifySharesModal } from './VerifySharesModal'
import { useState } from 'react'
import { EyeIcon, EyeOffIcon, TrashIcon } from './icons'
import { verifyBlockedReason, type VerifyDispatch } from './verification'
import type { BagVersion, PairedParticipant, PendingProtectRound, SecretBag, UserSecret } from '../types'
import { shareFailureLabel } from './shareFailure'

/**
 * Removing a secret from the current version. Absent for earlier versions,
 * which are history: removal publishes a new version, it does not edit an old one.
 */
interface SecretRemoval {
  onRemove: (secret: UserSecret) => void
  /** Why removal is unavailable right now, shown as the button's tooltip; `null` when it is available. */
  disabledReason: string | null
}

function BagVersionDetails({
  version,
  participants,
  onVerify,
  verifyDisabledReason,
  removal,
}: {
  version: BagVersion
  participants: PairedParticipant[]
  /** Open verification for this version. */
  onVerify: (version: number) => void
  /** Why Verify Shares is unavailable right now; `null` when it is available. */
  verifyDisabledReason: string | null
  removal?: SecretRemoval
}) {
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set())
  const [payloadOpen, setPayloadOpen] = useState(false)

  function toggleSecretVisibility(secretId: string) {
    setRevealedSecrets(prev => {
      const next = new Set(prev)
      if (next.has(secretId)) next.delete(secretId)
      else next.add(secretId)
      return next
    })
  }
  const confirmedParticipants = participants.filter(h => version.participantIds.includes(h.id))
  const failedEntries = (version.failedParticipantIds ?? []).map(f => ({
    ...f,
    name: participants.find(h => h.id === f.id)?.name ?? f.id,
  }))
  const verifiedCount = version.verifiedParticipantIds.length

  return (
    <div className="card-body">
      <dl className="field-list">
        <div className="field-row">
          <dt>Version</dt>
          <dd><span className="version-tag">v{version.version}</span></dd>
        </div>
        <div className="field-row field-row--full">
          <dt>User Secrets ({version.secrets.length})</dt>
          <dd>
            <table className="secrets-table">
              <thead>
                <tr>
                  <th className="secrets-table__th">Name</th>
                  <th className="secrets-table__th">Value</th>
                  <th className="secrets-table__th secrets-table__th--action" />
                </tr>
              </thead>
              <tbody>
                {version.secrets.map(s => {
                  const visible = revealedSecrets.has(s.id)
                  return (
                    <tr key={s.id} className="secrets-table__row">
                      <td className="secrets-table__td secrets-table__name">{s.name}</td>
                      <td className="secrets-table__td secrets-table__value">
                        <code>{visible ? s.data : '••••••••'}</code>
                      </td>
                      <td className="secrets-table__td secrets-table__td--action">
                        <button
                          type="button"
                          className="secondary reveal-btn"
                          onClick={() => toggleSecretVisibility(s.id)}
                          aria-label={visible ? `Hide ${s.name}` : `Reveal ${s.name}`}
                        >
                          {visible ? <EyeOffIcon /> : <EyeIcon />}
                        </button>
                        {removal && (
                          <button
                            type="button"
                            className="secondary reveal-btn remove-secret-btn"
                            onClick={() => removal.onRemove(s)}
                            disabled={removal.disabledReason !== null}
                            title={removal.disabledReason ?? `Remove ${s.name}`}
                            aria-label={`Remove ${s.name}`}
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
          </dd>
        </div>
      </dl>

      <div className="card-sub-section">
        <div className="sub-heading-row">
          <h4 className="sub-heading">Helper Shares</h4>
          {confirmedParticipants.length > 0 && (
            <span className="verified-summary">
              {verifiedCount}/{confirmedParticipants.length} verified
            </span>
          )}
        </div>
        {confirmedParticipants.length === 0 ? (
          <p className="empty-hint">Waiting for participants to confirm…</p>
        ) : (
          <ul className="participant-tag-list" role="list">
            {confirmedParticipants.map(h => {
              const isVerified = version.verifiedParticipantIds.includes(h.id)
              // The helper's own refusal of the last challenge, if it refused.
              const rejection = isVerified
                ? undefined
                : version.verifyRejections?.find(r => r.id === h.id)
              const state = isVerified
                ? { className: 'participant-tag--verified', icon: '✓', label: 'Verified' }
                : rejection
                  ? {
                      className: 'participant-tag--failed',
                      icon: '✗',
                      label: `Rejected verification: ${rejection.memo || `status ${rejection.status}`}`,
                    }
                  : { className: '', icon: '○', label: 'Not yet verified' }
              return (
                <li key={h.id} className={`participant-tag ${state.className}`}>
                  <span>{h.name}</span>
                  <span
                    className="participant-verification-icon"
                    title={state.label}
                    aria-label={state.label}
                  >
                    {state.icon}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
        {failedEntries.length > 0 && (
          <div className="failed-helpers-section">
            <h5 className="sub-heading sub-heading--failed">Failed ({failedEntries.length})</h5>
            <ul className="participant-tag-list" role="list">
              {failedEntries.map(f => {
                // One word for the kind of failure, the same in every view; the
                // library's own memo stays in the tooltip.
                const label = shareFailureLabel(f)
                const detail = f.memo || `Status ${f.status}`
                return (
                  <li key={f.id} className="participant-tag participant-tag--failed">
                    <span>{f.name}</span>
                    <span className="participant-failure-reason" title={detail}>{label}</span>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>

      <div className="card-actions">
        <button
          type="button"
          className="secondary"
          onClick={() => setPayloadOpen(true)}
        >
          View Payload
        </button>
        {confirmedParticipants.length > 0 && (
          <button
            type="button"
            className="secondary verify-btn"
            onClick={() => onVerify(version.version)}
            disabled={verifyDisabledReason !== null}
            title={verifyDisabledReason ?? undefined}
          >
            Verify Shares
          </button>
        )}
      </div>
      {confirmedParticipants.length > 0 && verifyDisabledReason && (
        <p className="empty-hint">{verifyDisabledReason}</p>
      )}

      {payloadOpen && (
        <BagPayloadModal
          version={version}
          onClose={() => setPayloadOpen(false)}
        />
      )}
    </div>
  )
}

export function SecretBagPanel({
  bag,
  participants,
  pendingRounds,
  onVerify,
  onVerifyClose,
  onAddSecret,
  onRemoveSecret,
  removeDisabledReason,
}: {
  bag: SecretBag | null
  participants: PairedParticipant[]
  /** Publishing rounds still open, oldest first — see `Vault.pendingProtectRounds`. */
  pendingRounds: readonly PendingProtectRound[]
  onVerify: (version: number) => Promise<VerifyDispatch>
  onVerifyClose?: () => void
  onAddSecret: () => void
  onRemoveSecret: (secret: UserSecret) => void
  /** Why secrets cannot be removed right now — e.g. too few paired participants. */
  removeDisabledReason: string | null
}) {
  const [showPreviousVersions, setShowPreviousVersions] = useState(false)
  // The version being verified, by number: held here, above the per-version
  // cards, so a publish that moves the current version mid-verification
  // cannot swap the version the open dialog is reading.
  const [verifying, setVerifying] = useState<number | null>(null)

  if (!bag) {
    return (
      <div className="tab-empty-state">
        <PendingRoundsNotice rounds={pendingRounds} participants={participants} />
        <p>No secrets protected yet. Add a secret to create the bag and distribute it to all paired participants.</p>
        <button type="button" className="primary" onClick={onAddSecret} style={{ marginTop: '1rem' }}>
          Add Secret
        </button>
      </div>
    )
  }

  const verifyingVersion =
    verifying === null
      ? null
      : [bag.currentVersion, ...bag.previousVersions].find(v => v.version === verifying) ?? null

  return (
    <div className="card-list">
      <div className="detail-card">
        <div className="card-header">
          <span className="card-title">Secrets</span>
          <span className="version-tag">v{bag.currentVersion.version}</span>
        </div>

        <PendingRoundsNotice rounds={pendingRounds} participants={participants} />

        <BagVersionDetails
          version={bag.currentVersion}
          participants={participants}
          onVerify={setVerifying}
          verifyDisabledReason={verifyBlockedReason(bag.currentVersion, pendingRounds)}
          removal={{ onRemove: onRemoveSecret, disabledReason: removeDisabledReason }}
        />

        {bag.previousVersions.length > 0 && (
          <div className="card-body" style={{ borderTop: '1px solid var(--border)' }}>
            <button
              type="button"
              className="secondary"
              onClick={() => setShowPreviousVersions(v => !v)}
              style={{ width: '100%' }}
            >
              {showPreviousVersions ? 'Hide' : 'Show'} Previous Versions ({bag.previousVersions.length})
            </button>
            {showPreviousVersions && bag.previousVersions.map(v => (
              <div key={v.version} style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
                <BagVersionDetails
                  version={v}
                  participants={participants}
                  onVerify={setVerifying}
                  verifyDisabledReason={verifyBlockedReason(v, pendingRounds)}
                />
              </div>
            ))}
          </div>
        )}

        <div className="card-body" style={{ borderTop: '1px solid var(--border)' }}>
          <dl className="field-list">
            <div className="field-row">
              <dt>Secret ID</dt>
              <dd><code className="secret-id-value">{bag.secretId}</code></dd>
            </div>
            <div className="field-row">
              <dt>Threshold</dt>
              <dd><span className="threshold-value">{bag.threshold}</span></dd>
            </div>
          </dl>
        </div>
      </div>

      {verifyingVersion && (
        <VerifySharesModal
          version={verifyingVersion.version}
          verifiedParticipantIds={verifyingVersion.verifiedParticipantIds}
          rejections={verifyingVersion.verifyRejections}
          confirmedParticipants={participants.filter(h => verifyingVersion.participantIds.includes(h.id))}
          onClose={() => { setVerifying(null); onVerifyClose?.() }}
          onVerify={onVerify}
        />
      )}
    </div>
  )
}

/**
 * The publishing rounds still open, so closing the progress dialog early does
 * not make a round disappear: the version is not in the bag until the round
 * commits, and without this the tab read as though nothing had happened.
 */
function PendingRoundsNotice({
  rounds,
  participants,
}: {
  rounds: readonly PendingProtectRound[]
  participants: readonly PairedParticipant[]
}) {
  if (rounds.length === 0) return null
  return (
    <div className="card-body">
      {rounds.map(round => {
        const confirmed = round.bag.currentVersion.participantIds.length
        const total = participants.filter(p =>
          p.secretShares.some(s => s.version === round.version),
        ).length
        const threshold = round.bag.threshold
        return (
          <p key={round.version} className="round-pending-note" role="status">
            Publishing v{round.version}: {confirmed} of {total} confirmed (need {threshold}).{' '}
            {confirmed >= threshold
              ? 'Threshold reached — it is committed once the rest answer or time out.'
              : 'It is committed once enough participants confirm, or rolled back if too few do.'}
          </p>
        )
      })}
    </div>
  )
}
