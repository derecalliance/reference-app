// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { ModalFrame } from '../ModalFrame'
import { useState } from 'react'
import { fromBase64Url } from '../derecApi'
import { errorText } from '../errorText'
import { committedVersionsOf } from './heldShares'
import { EyeIcon, EyeOffIcon } from './icons'
import { ClickToCopyCode } from './primitives'
import { decodeSecretText } from './recoveredSecret'
import { findRecoveryFailure } from './recoveryFailures'
import { isReplicaChannel } from '../ownerPairing'
import { loadRawShare } from '../stores'
import type {
  HeldShare,
  Vault,
  PairedParticipant,
  RecoveredSecret,
  RecoveryProgress,
} from '../types'

/** What a helper's last discovery answer amounted to. */
type DiscoveryState = 'pending' | 'found' | 'nothing' | 'unreachable'

/** Shown on a helper that answered discovery with nothing for this device. */
const NOTHING_FOUND_HINT =
  'This helper holds no shares for this device yet. Ask it to link this channel to ' +
  'the owner it already helps, then discover again.'

function discoveryState(participant: PairedParticipant): DiscoveryState {
  if (participant.discoveryError) return 'unreachable'
  if (!participant.discoveryComplete) return 'pending'
  return (participant.discoveredVersions ?? []).length > 0 ? 'found' : 'nothing'
}

const DISCOVERY_TAG: Record<DiscoveryState, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'available' },
  found: { label: 'Discovered', className: 'paired' },
  // Not the green "Discovered": an empty answer is not a success.
  nothing: { label: 'Nothing found', className: 'available' },
  unreachable: { label: 'No answer', className: 'offline' },
}

function RecoveryParticipantCard({
  participant,
}: {
  participant: PairedParticipant
}) {
  const state = discoveryState(participant)
  const tag = DISCOVERY_TAG[state]
  return (
    <div className="recovery-helper-row">
      <span className={`participant-dot paired`} aria-hidden="true" />
      <span className="card-title">{participant.name}</span>
      <ClickToCopyCode label="Channel ID" value={participant.channelId} />
      <span
        className={`status-tag ${tag.className}`}
        title={
          state === 'nothing'
            ? NOTHING_FOUND_HINT
            : state === 'unreachable'
              ? participant.discoveryError
              : undefined
        }
      >
        {tag.label}
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
        <ModalFrame
          overlayClassName="modal-overlay"
          className="modal"
          labelledBy="restore-bag-confirm-title"
          onEscape={restoring ? undefined : () => setConfirmOpen(false)}
        >
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
              The helpers this bag names keep their channels and their
              shares: this device takes those channels back and tells each
              helper where to reach it. Any other channel — one paired only to
              recover — is unpaired on both sides. This cannot be undone.
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
        </ModalFrame>
      )}
      <div className="card-body">
        <dl className="field-list">
          <div className="field-row">
            <dt>Secret ID</dt>
            <dd>
              {/* The row's own label already names it. */}
              <ClickToCopyCode value={secret.secretId} />
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
                const displayName = h.communicationInfo?.['name'] || 'Unknown'
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
  vaultId,
  secretId,
}: {
  channelId: string
  version: number
  vaultId: string
  /**
   * This node's own secret id — the partition every share it holds is filed
   * under, including shares belonging to another owner's secret.
   */
  secretId: string
}) {
  const [format, setFormat] = useState<ShareFormat>('base64')

  const raw = loadRawShare(`vault:${vaultId}`, secretId, channelId, version)
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
  vaultId,
  secretId,
}: {
  shares: HeldShare[]
  participants: PairedParticipant[]
  vaultId: string
  secretId: string
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
                vaultId={vaultId}
                secretId={secretId}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * One version of a secret some helpers hold, as discovery reported it.
 *
 * Channel ids stay decimal strings here: this travels as a component prop, and
 * React's development build serialises props — a `bigint` there throws.
 */
interface AggregatedVersion {
  version: number
  description: string
  helperChannelIds: string[]
  helperNames: string[]
}

interface AggregatedSecret {
  secretId: string
  versions: AggregatedVersion[]
}

/**
 * Group every paired helper's discovery answer into one entry per secret, its
 * versions newest first, the secret seen most recently first.
 */
function aggregateDiscovered(helpers: readonly PairedParticipant[]): AggregatedSecret[] {
  const versionMap = new Map<string, AggregatedVersion & { secretId: string }>()
  for (const h of helpers) {
    for (const v of h.discoveredVersions ?? []) {
      const key = `${v.secretId}:${v.version}`
      const existing = versionMap.get(key)
      if (existing) {
        existing.helperChannelIds.push(h.channelId)
        existing.helperNames.push(h.name)
      } else {
        versionMap.set(key, {
          secretId: v.secretId,
          version: v.version,
          description: v.description,
          helperChannelIds: [h.channelId],
          helperNames: [h.name],
        })
      }
    }
  }
  const secretMap = new Map<string, AggregatedSecret>()
  for (const { secretId, ...version } of versionMap.values()) {
    const bucket = secretMap.get(secretId)
    if (bucket) bucket.versions.push(version)
    else secretMap.set(secretId, { secretId, versions: [version] })
  }
  for (const secret of secretMap.values()) secret.versions.sort((a, b) => b.version - a.version)
  return Array.from(secretMap.values()).sort((a, b) => b.versions[0].version - a.versions[0].version)
}

/**
 * What this device knows about `secretId` from its own record: the threshold
 * its bag was published with, and which versions were committed rather than
 * rolled back. `null` on a fresh device, which knows neither.
 */
function knownBag(vault: Vault, secretId: string): { threshold: number; committed: Set<number>; oldest: number } | null {
  const bag = vault.secretBag
  if (!bag || bag.secretId !== secretId) return null
  const committed = committedVersionsOf(bag)
  return { threshold: bag.threshold, committed, oldest: Math.min(...committed) }
}

export function RecoveryPanel({
  vault,
  onRequestDiscovery,
  onRecover,
  onRestoreFromBag,
}: {
  vault: Vault
  onRequestDiscovery: () => Promise<void>
  onRecover: (secretId: string, version: number, label: string, participantChannelIds: bigint[]) => Promise<void>
  onRestoreFromBag: (secret: RecoveredSecret) => Promise<void>
}) {
  const [discovering, setDiscovering] = useState(false)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)

  // Every paired helper is a discovery candidate. There is no separate
  // "recovery pairing" any more: a re-paired owner looks like any other, and
  // whether a helper can answer depends on it having *linked* the channel to
  // an owner it already helps — which happens on the helper's side.
  // A replica channel is never a discovery candidate: it holds no VSS share, so
  // it has nothing to answer a discovery — or a share request — with.
  const recoveryParticipants = vault.participants.filter(
    h => h.connectionStatus === 'paired' && h.channelId && !isReplicaChannel(h),
  )
  const recoveredSecrets = vault.recoveredSecrets ?? []
  const availableSecrets = aggregateDiscovered(recoveryParticipants)

  async function handleDiscover() {
    setDiscovering(true)
    setDiscoveryError(null)
    try {
      await onRequestDiscovery()
    } catch (err) {
      setDiscoveryError(errorText(err))
    } finally {
      setDiscovering(false)
    }
  }

  return (
    <div className="recovery-panel">
      {/* Recovery-paired helpers */}
      <div className="recovery-section">
        <div className="section-header-row">
          <h3 className="sub-heading">Recovery-Paired Helpers</h3>
          {recoveryParticipants.length > 0 && (
            <button className="primary" onClick={() => void handleDiscover()} disabled={discovering}>
              {discovering
                ? 'Discovering…'
                : recoveryParticipants.every(h => h.discoveryComplete)
                  ? 'Re-discover All'
                  : 'Discover All'}
            </button>
          )}
        </div>
        {discoveryError && (
          <p className="field-error" role="alert">
            {discoveryError}
          </p>
        )}
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
        {recoveryParticipants.some(h => discoveryState(h) === 'nothing') && (
          <p className="empty-hint" role="status">
            {recoveryParticipants.every(h => discoveryState(h) === 'nothing')
              ? 'Discovery found nothing. '
              : 'Some helpers found nothing. '}
            A helper can only answer once it has linked this channel to the owner it already
            helps — ask it to, then discover again.
          </p>
        )}
      </div>

      {/* Available secrets discovered from helpers — one card per secret_id,
          one row per version inside. */}
      {availableSecrets.length > 0 && (
        <div className="recovery-section">
          <h3 className="sub-heading">Available Secrets</h3>
          <div className="card-list">
            {availableSecrets.map(secret => (
              <AvailableSecretCard
                key={secret.secretId}
                secret={secret}
                vault={vault}
                onRecover={onRecover}
              />
            ))}
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

/**
 * One discovered secret and the versions helpers hold of it.
 *
 * Versions this device's own record shows were rolled back are left out —
 * helpers keep the shares of a round that never committed, and offering to
 * recover one invites restoring a bag that was never the vault's.
 */
function AvailableSecretCard({
  secret,
  vault,
  onRecover,
}: {
  secret: AggregatedSecret
  vault: Vault
  onRecover: (secretId: string, version: number, label: string, participantChannelIds: bigint[]) => Promise<void>
}) {
  const known = knownBag(vault, secret.secretId)
  const rolledBack = (v: AggregatedVersion) =>
    known !== null && v.version >= known.oldest && !known.committed.has(v.version)
  const versions = secret.versions.filter(v => !rolledBack(v))
  const hiddenCount = secret.versions.length - versions.length
  if (versions.length === 0) return null

  // The most recent version's description acts as the secret's current
  // label; older versions show their own description on the version row
  // when it diverges.
  const cardTitle = versions[0].description || 'Untitled secret'
  return (
    <div className="detail-card">
      <div className="card-header">
        <span className="card-title">{cardTitle}</span>
        <span className="mono-tag">{secret.secretId}</span>
        <span className="version-tag">
          {versions.length} version{versions.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div className="card-body">
        <div className="available-versions-list">
          {versions.map(v => (
            <AvailableVersionRow
              key={`${secret.secretId}:${v.version}`}
              secretId={secret.secretId}
              version={v}
              cardTitle={cardTitle}
              threshold={known?.threshold ?? null}
              vault={vault}
              onRecover={onRecover}
            />
          ))}
        </div>
        {hiddenCount > 0 && (
          <p className="empty-hint">
            {hiddenCount} rolled-back version{hiddenCount !== 1 ? 's' : ''} not shown — helpers
            still hold shares of {hiddenCount !== 1 ? 'rounds' : 'a round'} this vault never committed,
            until its next published version tells them to drop {hiddenCount !== 1 ? 'them' : 'it'}.
          </p>
        )}
      </div>
    </div>
  )
}

function AvailableVersionRow({
  secretId,
  version: v,
  cardTitle,
  threshold,
  vault,
  onRecover,
}: {
  secretId: string
  version: AggregatedVersion
  cardTitle: string
  /** The threshold the bag was published with, when this device knows it. */
  threshold: number | null
  vault: Vault
  onRecover: (secretId: string, version: number, label: string, participantChannelIds: bigint[]) => Promise<void>
}) {
  const [requestError, setRequestError] = useState<string | null>(null)

  const alreadyRecovered = (vault.recoveredSecrets ?? []).some(
    s => s.secretId === secretId && s.version === v.version,
  )
  const helperCount = v.helperChannelIds.length
  const recoveryProgress = vault.recoveryProgress
  const isThisVersionActive =
    recoveryProgress?.secretId === secretId && recoveryProgress?.version === v.version
  const isInProgress = isThisVersionActive && !recoveryProgress?.error
  // Persistent failure (from a prior attempt) survives when the user clicks
  // Recover on a different version; it's cleared only on retry or success of
  // THIS row.
  const pastFailure = findRecoveryFailure(vault.recoveryFailures, secretId, v.version)
  const versionError =
    requestError ??
    (isThisVersionActive ? (recoveryProgress?.error ?? null) : (pastFailure?.error ?? null))
  const belowThreshold = threshold !== null && helperCount < threshold
  const descriptionDiverges = v.description && v.description !== cardTitle

  async function handleRecover() {
    setRequestError(null)
    try {
      await onRecover(secretId, v.version, v.description || 'secret', v.helperChannelIds.map(id => BigInt(id)))
    } catch (err) {
      setRequestError(errorText(err))
    }
  }

  // Only claim "Ready" when the threshold is known. A fresh device does not
  // know it, so it says how many helpers hold the version and lets Recover
  // report whether that was enough.
  const status = alreadyRecovered
    ? { label: 'Recovered', className: 'paired' }
    : isInProgress
      ? { label: 'Recovering…', className: 'available' }
      : versionError
        ? { label: 'Incomplete', className: 'offline' }
        : threshold === null
          ? null
          : belowThreshold
            ? { label: `Needs ${threshold}`, className: 'offline' }
            : { label: 'Ready', className: 'paired' }

  return (
    <div className="available-version-row">
      <span className="version-tag">v{v.version}</span>
      {descriptionDiverges && <span className="available-version-description">{v.description}</span>}
      <span className="available-version-helpers">
        {helperCount} helper{helperCount !== 1 ? 's' : ''} hold{helperCount === 1 ? 's' : ''} it
        {v.helperNames.length > 0 && (
          <span className="available-version-helper-names"> ({v.helperNames.join(', ')})</span>
        )}
      </span>
      {isInProgress && (
        <span className="available-version-progress">
          {recoveryProgress!.sharesReceived} share
          {recoveryProgress!.sharesReceived !== 1 ? 's' : ''} received…
        </span>
      )}
      {isThisVersionActive && recoveryProgress && (
        <RecoveryAnswersWithoutShare progress={recoveryProgress} participants={vault.participants} />
      )}
      {versionError && (
        <span className="available-version-insufficient" role="alert">
          {versionError}
        </span>
      )}
      {!versionError && belowThreshold && (
        <span className="available-version-insufficient">
          Only {helperCount} of the {threshold} helpers needed hold this version.
        </span>
      )}
      {status && <span className={`status-tag ${status.className}`}>{status.label}</span>}
      {!alreadyRecovered && (
        <button
          className="primary available-version-recover-btn"
          disabled={isInProgress}
          onClick={() => void handleRecover()}
        >
          {versionError ? 'Try Again' : 'Recover'}
        </button>
      )}
    </div>
  )
}

/** `StatusEnum.UnknownShareVersion` — the helper holds no share of the version asked for. */
const UNKNOWN_SHARE_VERSION_STATUS = 6

/**
 * The helpers that answered the recovery in flight without a usable share:
 * refused (`RecoveryShareRefused`) or sent one the library set aside
 * (`RecoveryShareCorrupted`). Neither counts towards the shares received, so
 * without this a recovery stuck short of its threshold gave no hint why.
 */
function RecoveryAnswersWithoutShare({
  progress,
  participants,
}: {
  progress: RecoveryProgress
  participants: readonly PairedParticipant[]
}) {
  const refusals = progress.refusals ?? []
  const corrupted = progress.corrupted ?? []
  if (refusals.length === 0 && corrupted.length === 0) return null
  const nameOf = (channelId: string) =>
    participants.find(p => p.channelId === channelId)?.name ?? `Channel ${channelId}`

  return (
    <ul className="available-version-refusals" aria-label="Helpers that sent no usable share">
      {refusals.map(r => (
        <li key={`refused-${r.channelId}`} className="available-version-insufficient">
          {nameOf(r.channelId)} refused —{' '}
          {r.status === UNKNOWN_SHARE_VERSION_STATUS
            ? `it holds no share of v${progress.version}`
            : r.memo || `status ${r.status}`}
        </li>
      ))}
      {corrupted.map(c => (
        <li key={`corrupted-${c.channelId}`} className="available-version-insufficient">
          {nameOf(c.channelId)} sent a share that was set aside ({c.reason})
        </li>
      ))}
    </ul>
  )
}
