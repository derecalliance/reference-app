import { useState } from 'react'
import { fromBase64Url } from '../derecApi'
import { EyeIcon, EyeOffIcon } from './icons'
import { ClickToCopyCode } from './primitives'
import { decodeSecretText } from './recoveredSecret'
import { findRecoveryFailure } from './recoveryFailures'
import { isReplicaChannel } from '../ownerPairing'
import { loadRawShare } from '../stores'
import type { HeldShare, Owner, PairedParticipant, RecoveredSecret } from '../types'

function RecoveryParticipantCard({
  participant,
}: {
  participant: PairedParticipant
}) {
  return (
    <div className="recovery-helper-row">
      <span className={`participant-dot paired`} aria-hidden="true" />
      <span className="card-title">{participant.name}</span>
      <ClickToCopyCode label="Channel ID" value={participant.channelId} />
      <span className={`status-tag ${participant.discoveryComplete ? 'paired' : 'available'}`}>
        {participant.discoveryComplete ? 'Discovered' : 'Pending'}
      </span>
    </div>
  )
}

function RecoveredSecretCard({
  secret,
  onRestoreFromBag,
}: {
  secret: RecoveredSecret
  onRestoreFromBag: (secret: RecoveredSecret) => Promise<void>
}) {
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set())
  const [restoring, setRestoring] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  function toggle(id: string) {
    setRevealedSecrets(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleConfirmRestore() {
    if (restoring) return
    setConfirmOpen(false)
    setRestoring(true)
    try {
      await onRestoreFromBag(secret)
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className="detail-card">
      <div className="card-header">
        <span className="card-title">{secret.label}</span>
        <span className="version-tag">v{secret.version}</span>
        <span className="status-tag paired">Recovered</span>
        <button
          type="button"
          className="primary recovered-restore-btn"
          onClick={() => setConfirmOpen(true)}
          disabled={restoring}
          title="Restore channels, secret bag and shares from this recovered bag and exit recovery mode."
        >
          {restoring ? 'Restoring…' : 'Recover'}
        </button>
      </div>

      {/* The most destructive action in the app, so it is confirmed the same
          way its peers are — an in-app dialog whose default is Cancel. It used
          to be a `window.confirm`, which a browser is free to suppress after
          the first one ("prevent this page from creating additional dialogs"),
          cannot autofocus the safe choice, and looks nothing like the
          equally-destructive replica adoption dialog. */}
      {confirmOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="restore-bag-confirm-title"
        >
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title" id="restore-bag-confirm-title">
                Recover from this bag?
              </h2>
            </div>
            <div className="modal-body">
              <p>
                This replaces every channel, secret and share this device holds
                with what <strong>{secret.label}</strong> (v{secret.version})
                carries, then leaves recovery mode.
              </p>
              <p>
                The recovery-paired helpers are unlinked from the app; they stay
                paired on their own side. This cannot be undone.
              </p>
              <div className="modal-actions">
                <button
                  className="secondary"
                  onClick={() => setConfirmOpen(false)}
                  disabled={restoring}
                  autoFocus
                >
                  Cancel
                </button>
                <button
                  className="danger"
                  onClick={() => void handleConfirmRestore()}
                  disabled={restoring}
                >
                  {restoring ? 'Recovering…' : 'Recover from bag'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="card-body">
        <dl className="field-list">
          <div className="field-row">
            <dt>Secret ID</dt>
            <dd>
              <ClickToCopyCode label="Secret ID" value={secret.secretId} />
            </dd>
          </div>
        </dl>

        <div className="card-sub-section">
          <h4 className="sub-heading">
            User Secrets ({secret.snapshot.secrets.length})
          </h4>
          {secret.snapshot.secrets.length === 0 ? (
            <p className="empty-hint">No user secrets in this bag.</p>
          ) : (
            <table className="secrets-table">
              <thead>
                <tr>
                  <th className="secrets-table__th">Name</th>
                  <th className="secrets-table__th">Value</th>
                  <th className="secrets-table__th secrets-table__th--action" />
                </tr>
              </thead>
              <tbody>
                {secret.snapshot.secrets.map(s => {
                  const visible = revealedSecrets.has(s.id)
                  return (
                    <tr key={s.id} className="secrets-table__row">
                      <td className="secrets-table__td secrets-table__name">{s.name}</td>
                      <td className="secrets-table__td secrets-table__value">
                        {/* Snapshot payloads are stored base64url-encoded so
                            they survive localStorage; decode for display. */}
                        <code>{visible ? decodeSecretText(s.data) : '••••••••'}</code>
                      </td>
                      <td className="secrets-table__td secrets-table__td--action">
                        <button
                          type="button"
                          className="secondary reveal-btn"
                          onClick={() => toggle(s.id)}
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
          )}
        </div>

        <div className="card-sub-section">
          <h4 className="sub-heading">
            Helpers ({secret.snapshot.helpers.length})
          </h4>
          {secret.snapshot.helpers.length === 0 ? (
            <p className="empty-hint">No helper records in this bag.</p>
          ) : (
            <ul className="participant-tag-list" role="list">
              {secret.snapshot.helpers.map(h => {
                const displayName = h.communicationInfo['name'] || 'Unknown'
                return (
                  <li key={h.channelId} className="participant-tag">
                    <span>{displayName}</span>
                    <span className="channel-id-inline">{h.channelId}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

type ShareFormat = 'base64' | 'protobuf'

function ShareDataRow({
  channelId,
  version,
  ownerId,
  ownSecretId,
}: {
  channelId: string
  version: number
  ownerId: string
  /**
   * This node's own secret id — the partition every share it holds is filed
   * under, including shares belonging to another owner's secret.
   */
  ownSecretId: string
}) {
  const [format, setFormat] = useState<ShareFormat>('base64')

  const raw = loadRawShare(`owner:${ownerId}`, ownSecretId, channelId, version)
  if (!raw) return <span className="share-data-empty">Share data not found in local storage</span>

  const display = format === 'base64'
    ? raw
    : Array.from(fromBase64Url(raw), b => b.toString(16).padStart(2, '0')).join(' ')

  return (
    <span className="share-data-display">
      <code className="share-data-value">{display}</code>
      <button
        type="button"
        className="secondary share-format-btn"
        onClick={() => setFormat(f => f === 'base64' ? 'protobuf' : 'base64')}
        title={format === 'base64' ? 'Switch to protobuf hex' : 'Switch to base64'}
        aria-label={format === 'base64' ? 'Switch to protobuf hex' : 'Switch to base64'}
      >
        {format === 'base64' ? 'b64' : 'hex'}
      </button>
    </span>
  )
}

export function HeldSharesList({
  shares,
  participants,
  ownerId,
  ownSecretId,
}: {
  shares: HeldShare[]
  participants: PairedParticipant[]
  ownerId: string
  ownSecretId: string
}) {
  if (shares.length === 0) {
    return (
      <p className="tab-empty-state">
        No shares held yet. Shares appear here when another owner sends you a secret share to store.
      </p>
    )
  }

  const peerName = (channelId: string) =>
    participants.find(p => p.channelId === channelId)?.name ?? 'Unknown peer'

  return (
    <div className="channel-table">
      {shares.map((share, i) => (
        <div key={`${share.channelId}-${share.version}-${i}`} className="channel-row">
          <div className="channel-row-top">
            <span className="channel-row-name" style={{ flex: 'none' }}>
              {peerName(share.channelId)}
            </span>
            <span className="channel-id-inline">{share.channelId}</span>
            <span style={{ flex: 1 }} />
            {share.description && <span className="channel-id-inline">{share.description}</span>}
            {share.secretId && <span className="detail-card-badge">id {share.secretId}</span>}
            <span className="detail-card-badge">v{share.version}</span>
          </div>
          <div className="channel-row-bottom">
            <div className="channel-prop channel-prop--key">
              <span className="channel-prop-label">Share</span>
              <ShareDataRow
                channelId={share.channelId}
                version={share.version}
                ownerId={ownerId}
                ownSecretId={ownSecretId}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export function RecoveryPanel({
  owner,
  onRequestDiscovery,
  onRecover,
  onRestoreFromBag,
}: {
  owner: Owner
  onRequestDiscovery: () => Promise<void>
  onRecover: (secretId: string, version: number, label: string, participantChannelIds: bigint[]) => Promise<void>
  onRestoreFromBag: (secret: RecoveredSecret) => Promise<void>
}) {
  // Every paired helper is a discovery candidate. There is no separate
  // "recovery pairing" any more: a re-paired owner looks like any other, and
  // whether a helper can answer depends on it having *linked* the channel to
  // an owner it already helps — which happens on the helper's side.
  // A replica channel is never a discovery candidate: it holds no VSS share, so
  // it has nothing to answer a discovery — or a share request — with.
  const recoveryParticipants = owner.participants.filter(
    h => h.connectionStatus === 'paired' && h.channelId && !isReplicaChannel(h),
  )
  const recoveredSecrets = owner.recoveredSecrets ?? []
  const alreadyRecoveredKeys = new Set(recoveredSecrets.map(s => `${s.secretId}:${s.version}`))
  const recoveryProgress = owner.recoveryProgress

  // Aggregate discovered versions from all paired helpers, grouped
  // by secret_id. Each version carries the helpers that hold it so the UI
  // can render one card per secret with its versions nested inside.
  type AggregatedVersion = {
    version: number
    description: string
    helperChannelIds: bigint[]
    helperNames: string[]
  }
  type AggregatedSecret = {
    secretId: string
    versions: AggregatedVersion[]
  }
  // First pass: bucket every (secretId, version) → helpers.
  const versionMap = new Map<string, AggregatedVersion & { secretId: string }>()
  for (const h of recoveryParticipants) {
    for (const v of h.discoveredVersions ?? []) {
      const key = `${v.secretId}:${v.version}`
      const existing = versionMap.get(key)
      if (existing) {
        existing.helperChannelIds.push(BigInt(h.channelId))
        existing.helperNames.push(h.name)
      } else {
        versionMap.set(key, {
          secretId: v.secretId,
          version: v.version,
          description: v.description,
          helperChannelIds: [BigInt(h.channelId)],
          helperNames: [h.name],
        })
      }
    }
  }
  // Second pass: group by secret_id, versions sorted newest-first within each
  // secret, secrets ordered by their newest version (most recently observed
  // secret rises to the top).
  const secretMap = new Map<string, AggregatedSecret>()
  for (const entry of versionMap.values()) {
    const bucket = secretMap.get(entry.secretId)
    const { secretId: _drop, ...version } = entry
    void _drop
    if (bucket) {
      bucket.versions.push(version)
    } else {
      secretMap.set(entry.secretId, { secretId: entry.secretId, versions: [version] })
    }
  }
  for (const secret of secretMap.values()) {
    secret.versions.sort((a, b) => b.version - a.version)
  }
  const availableSecrets = Array.from(secretMap.values()).sort(
    (a, b) => b.versions[0].version - a.versions[0].version,
  )

  return (
    <div className="recovery-panel">
      {/* Recovery-paired helpers */}
      <div className="recovery-section">
        <div className="section-header-row">
          <h3 className="sub-heading">Recovery-Paired Helpers</h3>
          {recoveryParticipants.length > 0 && (
            <button className="primary" onClick={() => onRequestDiscovery()}>
              {recoveryParticipants.every(h => h.discoveryComplete) ? 'Re-discover All' : 'Discover All'}
            </button>
          )}
        </div>
        {recoveryParticipants.length === 0 ? (
          <p className="tab-empty-state">
            No helpers paired yet. Pair with the people or entities that hold
            your shares, then ask each to link this channel to the owner they
            already help — only then can they answer a discovery request.
          </p>
        ) : (
          <div className="recovery-helpers-list">
            {recoveryParticipants.map(h => (
              <RecoveryParticipantCard key={h.id} participant={h} />
            ))}
          </div>
        )}
      </div>

      {/* Available secrets discovered from helpers — one card per secret_id,
          one row per version inside. */}
      {availableSecrets.length > 0 && (
        <div className="recovery-section">
          <h3 className="sub-heading">Available Secrets</h3>
          <div className="card-list">
            {availableSecrets.map(secret => {
              // The most recent version's description acts as the secret's
              // current label; older versions show their own description on
              // the version row when it diverges.
              const latest = secret.versions[0]
              const cardTitle = latest.description || 'Untitled secret'
              return (
                <div key={secret.secretId} className="detail-card">
                  <div className="card-header">
                    <span className="card-title">{cardTitle}</span>
                    <span className="mono-tag">{secret.secretId}</span>
                    <span className="version-tag">
                      {secret.versions.length} version{secret.versions.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="card-body">
                    <div className="available-versions-list">
                      {secret.versions.map(v => {
                        const key = `${secret.secretId}:${v.version}`
                        const alreadyRecovered = alreadyRecoveredKeys.has(key)
                        const helperCount = v.helperChannelIds.length
                        const isThisVersionActive =
                          recoveryProgress?.secretId === secret.secretId &&
                          recoveryProgress?.version === v.version
                        const isInProgress =
                          isThisVersionActive && !recoveryProgress?.error
                        // Persistent failure (from a prior attempt) survives
                        // when the user clicks Recover on a different version;
                        // it's cleared only on retry or success of THIS row.
                        const pastFailure = findRecoveryFailure(
                          owner.recoveryFailures,
                          secret.secretId,
                          v.version,
                        )
                        const versionError = isThisVersionActive
                          ? recoveryProgress?.error ?? null
                          : pastFailure?.error ?? null
                        const insufficientShares = versionError != null
                        const descriptionDiverges =
                          v.description && v.description !== cardTitle
                        return (
                          <div key={key} className="available-version-row">
                            <span className="version-tag">v{v.version}</span>
                            {descriptionDiverges && (
                              <span className="available-version-description">
                                {v.description}
                              </span>
                            )}
                            <span className="available-version-helpers">
                              {helperCount} helper{helperCount !== 1 ? 's' : ''}
                              {v.helperNames.length > 0 && (
                                <span className="available-version-helper-names">
                                  {' '}({v.helperNames.join(', ')})
                                </span>
                              )}
                            </span>
                            {isInProgress && (
                              <span className="available-version-progress">
                                {recoveryProgress!.sharesReceived} share
                                {recoveryProgress!.sharesReceived !== 1 ? 's' : ''} received…
                              </span>
                            )}
                            {insufficientShares && (
                              <span
                                className="available-version-insufficient"
                                title="Not enough shares — pair with more helpers and try again."
                              >
                                Insufficient shares
                              </span>
                            )}
                            <span
                              className={`status-tag ${
                                alreadyRecovered ? 'paired'
                                : isInProgress ? 'available'
                                : versionError ? 'offline'
                                : 'available'
                              }`}
                            >
                              {alreadyRecovered ? 'Recovered'
                                : isInProgress ? 'Recovering…'
                                : versionError ? 'Incomplete'
                                : 'Ready'}
                            </span>
                            {!alreadyRecovered && (
                              <button
                                className="primary available-version-recover-btn"
                                disabled={isInProgress}
                                onClick={() =>
                                  onRecover(
                                    secret.secretId,
                                    v.version,
                                    v.description || 'secret',
                                    v.helperChannelIds,
                                  )
                                }
                              >
                                {versionError ? 'Try Again' : 'Recover'}
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Recovered secrets */}
      {recoveredSecrets.length > 0 && (
        <div className="recovery-section">
          <h3 className="sub-heading">Recovered Secrets</h3>
          <div className="card-list">
            {recoveredSecrets.map(s => (
              <RecoveredSecretCard
                key={`${s.secretId}-${s.version}`}
                secret={s}
                onRestoreFromBag={onRestoreFromBag}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
