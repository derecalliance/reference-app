import { BagPayloadModal } from './BagPayloadModal'
import { VerifySharesModal } from './VerifySharesModal'
import { useState } from 'react'
import { EyeIcon, EyeOffIcon } from './icons'
import type { BagVersion, PairedParticipant, SecretBag } from '../types'

function BagVersionDetails({
  version,
  participants,
  onVerify,
  onVerifyClose,
}: {
  version: BagVersion
  participants: PairedParticipant[]
  onVerify: (version: number) => Promise<void>
  onVerifyClose?: () => void
}) {
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set())
  const [verifyOpen, setVerifyOpen] = useState(false)
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
              return (
                <li key={h.id} className={`participant-tag ${isVerified ? 'participant-tag--verified' : ''}`}>
                  <span>{h.name}</span>
                  <span
                    className="participant-verification-icon"
                    title={isVerified ? 'Verified' : 'Not yet verified'}
                    aria-label={isVerified ? 'Verified' : 'Not yet verified'}
                  >
                    {isVerified ? '✓' : '○'}
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
                const reason = f.memo || (f.status === 10 ? 'Rejected' : `Status ${f.status}`)
                return (
                  <li key={f.id} className="participant-tag participant-tag--failed">
                    <span>{f.name}</span>
                    <span className="participant-failure-reason" title={reason}>{reason}</span>
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
            onClick={() => setVerifyOpen(true)}
          >
            Verify Shares
          </button>
        )}
      </div>

      {verifyOpen && (
        <VerifySharesModal
          version={version.version}
          verifiedParticipantIds={version.verifiedParticipantIds}
          confirmedParticipants={confirmedParticipants}
          onClose={() => { setVerifyOpen(false); onVerifyClose?.() }}
          onVerify={onVerify}
        />
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
  onVerify,
  onVerifyClose,
  onAddSecret,
}: {
  bag: SecretBag | null
  participants: PairedParticipant[]
  onVerify: (version: number) => Promise<void>
  onVerifyClose?: () => void
  onAddSecret: () => void
}) {
  const [showPreviousVersions, setShowPreviousVersions] = useState(false)

  if (!bag) {
    return (
      <div className="tab-empty-state">
        <p>No secrets protected yet. Add a secret to create the bag and distribute it to all paired participants.</p>
        <button type="button" className="primary" onClick={onAddSecret} style={{ marginTop: '1rem' }}>
          Protect Secret
        </button>
      </div>
    )
  }

  return (
    <div className="card-list">
      <div className="detail-card">
        <div className="card-header">
          <span className="card-title">Secret Bag</span>
          <span className="version-tag">v{bag.currentVersion.version}</span>
        </div>

        <BagVersionDetails
          version={bag.currentVersion}
          participants={participants}
          onVerify={onVerify}
          onVerifyClose={onVerifyClose}
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
                  onVerify={onVerify}
                  onVerifyClose={onVerifyClose}
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
    </div>
  )
}
