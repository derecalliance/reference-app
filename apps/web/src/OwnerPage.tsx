import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Alert, Button, Stack } from '@mui/material'
import { QRCodeSVG } from 'qrcode.react'
import {
  DeRecProtocol,
  DeRecProtocolBuilder,
  SenderKind,
  FlowKind,
  ContactMode,
  type ContactMessage,
  type DeRecEvent,
} from '@derec-alliance/web'
import './OwnerPage.css'
import type { ParticipantConnectionStatus, Owner, PairedParticipant, PendingPairing, BagVersion, SecretBag, UserSecret, RecoveredSecret, RecoveredSecretSnapshot, RecoveryFailure, SecretShareRef, Transport, HeldShare } from './types'
import { useConsole } from './ConsoleContext'
import { reportError, reportInfo } from './toastBus'
import { protocolTimeoutMs, DEFAULT_PROTOCOL_TIMEOUT_SECS, DEFAULT_UNPAIR_ACK } from './config'
import { ProtocolConfigProvider, useProtocolTimeoutMs } from './ProtocolConfig'
import { sendMessage, pollMailbox, fromBase64Url, toBase64Url, type MailboxMessage } from './derecApi'
import { makeChannelStore, makeSecretStore, makeShareStore, makeStateStore, makeUserSecretStore, makeTransport, clearNamespace, loadRawShare, readHelperChannelStatus } from './stores'
import { getOrCreateReplicaId } from './replicaIdentity'
import { QrScanner } from './QrScanner'
import {
  describeQrScanUnavailable,
  qrScanSupport,
  type QrScanSupport,
} from './qrScanning'
import {
  CONTACT_MODE_OPTIONS,
  DEFAULT_CONTACT_MODE,
  humanNonce,
  toContactMode,
  type ContactModeKey,
} from './contactModes'
import { selectAutoPairTargets } from './autoPairSelection'
import { type BEActorWithStatus, type ProvisionedChannel, type ProvisioningSettings, apiAddReplica, apiListParticipantChannels, apiLinkParticipantChannels, apiAddParticipant, apiCreateActorContact, apiGetActors, apiGetBrowserContact, apiPostBrowserContact, apiStartActorPairing, apiToggleParticipantStatus, apiToggleReplicaStatus, type ContactMessageDto } from './api'
import { complementRole, senderKindFor, type PairingRole } from './pairingRoles'
import { canDrivePeerViaBackend } from './ownerPairing'
import {
  BROWSER_PAIRING_ROLE_OPTIONS,
  pairingRoleLabel,
  pairingSuccessMessage,
  participantPairingRoleOptions,
  type PairingRoleOption,
} from './pairingRoleOptions'
import { requestPairingConsent } from './replicaPairingConsent'
import {
  ReplicaPairingWarningDialog,
  useReplicaEraseConsent,
} from './ReplicaPairingWarningDialog'
import { ReplicaPairingRequestDialog } from './ReplicaPairingRequestDialog'
import {
  classifyInboundPairing,
  type PendingPairingConfirmation,
} from './inboundPairing'
import {
  applyPairingCompleted,
  isReplicaChannel,
  isShareTarget,
  splitPairedChannels,
} from './ownerPairing'
import {
  ReplicaAdoptionError,
  adoptReplicaSecret,
  adoptedVaultState,
  adoptionSourceLabel,
  automaticSyncNeedsAttention,
  canRequestReplicaSync,
  clearReplicaState,
  createReplicaFirstSyncTrigger,
  describeRestoreFailure,
  forgetReplicaMember,
  loadReplicaState,
  markReplicaFirstSyncStarted,
  mergeReplicaSecretReceipt,
  pairReplica,
  recordConfirmation,
  recordPeerReplicaId,
  recordReplicaSync,
  removeReplicaMember,
  replicaSyncTargets,
  replicaViews,
  startSyncCheck,
  type PendingReplicaAdoption,
  type ReplicaAdoptionOutcome,
  type ReplicaFirstSyncTrigger,
  type ReplicaProtocol,
  type ReplicaRecord,
  type ReplicaSyncReason,
  type ReplicaSyncRoundResult,
  type ReplicaSyncTarget,
  type ReplicaView,
  type RestoreFailure,
  type UnresolvedAutomaticSync,
} from './replicaFlows'
import { loadReplicaAdoptionBlock, saveReplicaAdoptionBlock } from './replicaAdoptionBlock'
import { TRANSPORT_PROTOCOL_HTTPS, contactMessageToDto, dtoToContactMessage } from './contactDto'
import { AppMuiTheme } from './AppMuiTheme'
import { ReplicaAdoptionDialog } from './ReplicaAdoptionDialog'
import { ReplicaFingerprintDialog } from './ReplicaFingerprintDialog'
import { ChannelFingerprintDialog } from './ChannelFingerprintDialog'
import { ReplicasTab } from './ReplicasTab'
import {
  describeAutomaticSyncOutcome,
  describeManualSyncOutcome,
  type ReplicaRowSyncNotice,
} from './replicaSyncNotice'
import { OwnerReplicaSection } from './OwnerReplicaSection'
import { ReplicaAdoptionBlockedScreen } from './ReplicaAdoptionBlockedScreen'
import { faker } from '@faker-js/faker'

// ── Protocol instance registry ───────────────────────────────────────────────
//
// A DeRecProtocol instance is bound to exactly one `secret_id`, and both ends
// of a relationship must bind to the same one. This node therefore runs
// several instances at once: one for the secret it owns, plus one per owner it
// acts as Helper for. They share a localStorage namespace because every store
// is internally partitioned by secret id.

/**
 * How often the page advances time-driven protocol state.
 *
 * `process()` is the only other thing that moves protocol time forward, so a
 * publishing round whose helpers all go quiet has nothing left to close it —
 * no `SharingComplete` is ever emitted and the flow watchdog fires instead of
 * the real result. Must stay well below the configured protocol timeout.
 */
const TICK_INTERVAL_MS = 15_000

/**
 * How long a `Pending` channel may wait for out-of-band confirmation.
 *
 * The library's automatic sweep is disabled in favour of this. Its default (5
 * minutes) is also the budget a *human* gets to compare a fingerprint out of
 * band — every `NoKeys` pairing and every replica pairing waits in `Pending`
 * for exactly that — and five minutes is far too short for someone reading
 * codes between two browser windows.
 */
const PENDING_CHANNEL_TTL_SECS = 3600

/**
 * `StatusEnum.VERSION_CONFLICT` — two members published the same version with
 * different content, and the round has to be resolved and republished at a new
 * version. Identical bytes are accepted as idempotent, so this only ever means
 * a genuine divergence.
 */
const VERSION_CONFLICT_STATUS = 13

/** A protocol instance plus the stores the app reads directly. */
interface ProtocolInstance {
  /** u64 decimal string — the registry key. */
  secretId: string
  protocol: DeRecProtocol
  channelStore: ReturnType<typeof makeChannelStore>
  shareStore: ReturnType<typeof makeShareStore>
}

interface BuildProtocolOptions {
  namespace: string
  secretId: string
  ownTransportUri: string
  communicationInfo: Record<string, string>
  threshold: number
  keepVersionsCount: number
  timeoutSecs: number
  unpairAck: 'required' | 'not_required'
  replicaId: bigint
  /**
   * When `true`, every outbound request from this instance stamps
   * `replyTo = ownTransport`, overriding the channel's stored peer endpoint
   * for that exchange. Needed only by a replica destination that has just
   * adopted a source's vault: the helpers it drives still have the
   * *source's* endpoint on file, and without this every response would be
   * delivered there instead of here. Default `false` — the ordinary owner
   * and helper instances pair directly with their peers, whose stored
   * endpoint is already correct, so forcing this on for them would be an
   * unrequested change to the wire format of every request they send.
   */
  autoReplyTo?: boolean
}

function buildProtocolInstance(opts: BuildProtocolOptions): ProtocolInstance {
  const channelStore = makeChannelStore(opts.namespace)
  const shareStore = makeShareStore(opts.namespace)

  const builder = new DeRecProtocolBuilder(BigInt(opts.secretId))
    .withChannelStore(channelStore)
    .withShareStore(shareStore)
    .withSecretStore(makeSecretStore(opts.namespace))
    .withUserSecretStore(makeUserSecretStore(opts.namespace))
    .withStateStore(makeStateStore(opts.namespace))
    .withTransport(makeTransport(sendMessage))
    .withOwnTransport({ uri: opts.ownTransportUri, protocol: 'https' })
    // Derived, not hardcoded: the guardrail comes back on its own the moment
    // this app is served over https.
    //
    // Loopback is *not* enough to skip it. The library exempts plaintext
    // loopback only for the endpoint a device configures for **itself**; a
    // peer's endpoint may never be plaintext by default, and every peer here
    // is `http://localhost:5000/derec/...`. Pairing fails without this with a
    // message naming the flag.
    .withUnsafeHttp(!opts.ownTransportUri.startsWith('https://'))
    .withThreshold(opts.threshold)
    .withKeepVersionsCount(opts.keepVersionsCount)
    .withTimeouts({
      // The wizard's single "protocol timeout" is the replay window, which is
      // the meaning it has always carried: how stale an inbound envelope may
      // be and still be accepted.
      //
      // The liveness budgets — how long to keep hoping a silent peer answers —
      // deliberately keep the library's defaults rather than inheriting that
      // number. They answer a different question, and a five-minute wait on one
      // unreachable replica is five minutes of a modal that looks hung: a
      // publishing round is not reported complete until the replica leg
      // resolves too.
      inbound_message_secs: opts.timeoutSecs,
      // Cleanup is driven from this page's own tick instead — see
      // `PENDING_CHANNEL_TTL_SECS`.
      expired_channels: { enabled: false, timeout_in_secs: PENDING_CHANNEL_TTL_SECS },
    })
    .withCommunicationInfo(opts.communicationInfo)
    .withUnpairAck(opts.unpairAck)
    .withReplicaId(opts.replicaId)
    .withAutoReplyTo(opts.autoReplyTo ?? false)

  return {
    secretId: opts.secretId,
    protocol: builder.build(),
    channelStore,
    shareStore,
  }
}

/**
 * Insert or replace the failure entry for a (secret_id, version) pair.
 * Used when an in-flight recovery attempt reaches a terminal failure state;
 * the entry must survive subsequent Recover clicks on other versions so the
 * row keeps its "Incomplete" status until the user retries it specifically.
 */
function upsertRecoveryFailure(
  failures: RecoveryFailure[],
  secretId: string,
  version: number,
  error: string,
): RecoveryFailure[] {
  const without = failures.filter(f => !(f.secretId === secretId && f.version === version))
  return [...without, { secretId, version, error }]
}

/**
 * Drop the failure entry for a (secret_id, version) pair. Used on a fresh
 * Recover click for that version (the new attempt's outcome supersedes the
 * old one) and on `SecretRecovered` (success).
 */
function removeRecoveryFailure(
  failures: RecoveryFailure[],
  secretId: string,
  version: number,
): RecoveryFailure[] {
  return failures.filter(f => !(f.secretId === secretId && f.version === version))
}

function findRecoveryFailure(
  failures: RecoveryFailure[] | undefined,
  secretId: string,
  version: number,
): RecoveryFailure | undefined {
  return failures?.find(f => f.secretId === secretId && f.version === version)
}


// ── Recovered secret snapshot ────────────────────────────────────────────────
//
// `SecretRecovered` carries a typed roster snapshot — the library handles the
// two-stage DeRecSecret -> Secret protobuf decode internally. The app only
// converts between that in-memory shape (binary fields as Uint8Array) and the
// persisted one (base64url), because `protocol.restore` needs the original
// shape back after a reload.

/** The `secret` payload of a SecretRecovered event. */
type RecoveredSecretPayload = Extract<DeRecEvent, { type: 'SecretRecovered' }>['secret']

/**
 * The version the library assigned to the round this `start(ProtectSecret)`
 * call just dispatched.
 *
 * Version progression is anchored to the library's own user-secret snapshot,
 * which also bumps on pair-completion auto-publish — so the app cannot derive
 * it from its own bag history without drifting out of step. Read it back from
 * the dispatch events instead.
 *
 * `ProtectSecretStarted` is checked across **all** the events before falling
 * back to `SharingComplete`, and the order matters. Rounds are keyed by version
 * and run concurrently, so this call's result can also carry the completion of
 * an *older* round that happened to finish in the same batch — a replica
 * pairing's auto-publish, typically. Taking whichever came first would then
 * attribute the previous round's version to this one, and every subsequent
 * `ShareConfirmed` would be filed against a round the user is not watching:
 * the progress dialog sits at "0 of N confirmed" while the round underneath it
 * completes normally.
 *
 * `SharingComplete` remains a fallback for the case where a round resolves
 * without dispatching anything.
 */
function protectVersionFrom(events: DeRecEvent[]): number | null {
  const started = events.find(e => e.type === 'ProtectSecretStarted')
  if (started) return started.version

  const completed = events.find(e => e.type === 'SharingComplete')
  return completed ? completed.version : null
}

/**
 * Pull the pairing channel id out of a `start(Pairing)` result.
 *
 * `start` no longer returns the channel id — it reports the dispatched
 * handshake as a `PairingStarted` event. This is the *transient* id that
 * travelled on the ContactMessage; the handshake atomically rotates to a
 * long-term id that arrives later on `PairingCompleted`.
 */
function pairingChannelIdFrom(events: DeRecEvent[]): bigint {
  const started = events.find(e => e.type === 'PairingStarted')
  if (!started) throw new Error('pairing dispatched no PairingStarted event')
  return BigInt(started.channel_id)
}

function asBytes(v: Uint8Array | number[]): Uint8Array {
  return v instanceof Uint8Array ? v : new Uint8Array(v)
}

function snapshotFromEvent(secret: RecoveredSecretPayload): RecoveredSecretSnapshot {
  return {
    helpers: secret.helpers.map(h => ({
      channelId: h.channel_id,
      transportUri: h.transport_uri,
      communicationInfo: h.communication_info,
      sharedKey: toBase64Url(asBytes(h.shared_key)),
    })),
    secrets: secret.secrets.map(s => ({
      id: toBase64Url(asBytes(s.id)),
      name: s.name,
      data: toBase64Url(asBytes(s.data)),
    })),
    replicas: secret.replicas
      ? {
          channelId: secret.replicas.channel_id,
          members: secret.replicas.members.map(m => ({
            transportUri: m.transport_uri,
            communicationInfo: m.communication_info,
            replicaId: m.replica_id,
            role: m.role,
          })),
          sharedKey: toBase64Url(asBytes(secret.replicas.shared_key)),
        }
      : undefined,
  }
}

/** Rebuild the event payload `protocol.restore` expects from a persisted snapshot. */
function snapshotToPayload(snapshot: RecoveredSecretSnapshot): RecoveredSecretPayload {
  return {
    helpers: snapshot.helpers.map(h => ({
      channel_id: h.channelId,
      transport_uri: h.transportUri,
      communication_info: h.communicationInfo,
      shared_key: fromBase64Url(h.sharedKey),
    })),
    secrets: snapshot.secrets.map(s => ({
      id: fromBase64Url(s.id),
      name: s.name,
      data: fromBase64Url(s.data),
    })),
    replicas: snapshot.replicas
      ? {
          channel_id: snapshot.replicas.channelId,
          members: snapshot.replicas.members.map(m => ({
            replica_id: m.replicaId,
            transport_uri: m.transportUri,
            role: m.role,
            communication_info: m.communicationInfo,
          })),
          shared_key: fromBase64Url(snapshot.replicas.sharedKey),
        }
      : undefined,
  }
}

/** Secret payloads are text in this app; decode lossily for display so a
 *  binary surprise renders as replacement chars instead of throwing. */
function decodeSecretText(base64: string): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(fromBase64Url(base64))
}

/** QR/clipboard payload — same wire form as the signaling DTO. */
function serializeContact(contact: ContactMessage): string {
  return JSON.stringify(contactMessageToDto(contact))
}

function deserializeContact(payload: string): ContactMessage {
  return dtoToContactMessage(JSON.parse(payload) as ContactMessageDto)
}

const EyeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

const EyeOffIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
)

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
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
  )
}

function ClickToCopyCode({ label, value }: { label?: string; value: string }) {
  const [copied, setCopied] = useState(false)

  function handleClick() {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <span className="click-to-copy" onClick={handleClick} title="Click to copy" role="button" tabIndex={0}>
      {label && <span className="click-to-copy-label">{label}</span>}
      <code className="click-to-copy-value">{copied ? 'Copied!' : value}</code>
    </span>
  )
}

function CopyButton({
  label,
  text,
  disabled,
}: {
  label: string
  text: string
  /** Set while `text` is known to be about to change, so nobody copies a value
   *  that is one render away from being superseded. */
  disabled?: boolean
}) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <button className="secondary copy-field-btn" onClick={handleCopy} disabled={disabled}>
      {copied ? '✓ Copied' : `Copy ${label}`}
    </button>
  )
}

function SharedKeyRow({ value, label }: { value: string; label?: boolean }) {
  const [visible, setVisible] = useState(false)
  const content = (
    <span className="shared-key-display">
      <code className="shared-key-value">{visible ? value : '••••••••••••'}</code>
      <button
        type="button"
        className="secondary reveal-btn"
        onClick={() => setVisible(v => !v)}
        aria-label={visible ? 'Hide shared key' : 'Reveal shared key'}
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </span>
  )
  if (label === false) return content
  return (
    <div className="side-detail-row">
      <span className="side-detail-label">Shared Key</span>
      {content}
    </div>
  )
}

function ModalCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button className="modal-close" onClick={onClose} aria-label="Close">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  )
}

type AddSecretStatus =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'confirming'; participantIds: string[]; version: number }
  | { kind: 'error'; message: string }

function AddSecretModal({
  participants,
  secretBag,
  threshold,
  onClose,
  onAddSecret,
}: {
  participants: PairedParticipant[]
  secretBag: SecretBag | null
  threshold: number
  onClose: () => void
  onAddSecret: (name: string, data: string) => Promise<number | null>
}) {
  // Only owner-role channels receive shares — see `isShareTarget`.
  const pairedParticipants = participants.filter(isShareTarget)

  const [form, setForm] = useState({ name: '', data: '' })
  const [status, setStatus] = useState<AddSecretStatus>({ kind: 'idle' })

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim() || !form.data.trim()) return

    setStatus({ kind: 'sending' })
    try {
      const version = await onAddSecret(form.name.trim(), form.data.trim())
      if (version === null) {
        setStatus({ kind: 'error', message: 'The round was not dispatched — no participants were reachable.' })
        return
      }
      // Deliberately *not* `bag.version + 1`. Version progression is anchored
      // to the library's own snapshot, which also advances on pair-completion
      // auto-publish, so a guess drifts the moment anything else publishes —
      // and every `ShareConfirmed` then files against a round nobody is
      // watching, leaving this dialog stuck at "0 of N confirmed" while the
      // round underneath it completes normally.
      setStatus({ kind: 'confirming', participantIds: pairedParticipants.map(h => h.id), version })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const confirming = status.kind === 'confirming' ? status : null
  const confirmationProgress = confirming
    ? confirming.participantIds.map(id => {
        const participant = participants.find(h => h.id === id)
        const share = participant?.secretShares.find(s => s.version === confirming.version)
        return {
          id,
          name: participant?.name ?? id,
          confirmed: share?.status === 'confirmed',
          rejected: share?.status === 'rejected',
        }
      })
    : []
  const allResolved = confirming !== null && confirmationProgress.every(h => h.confirmed || h.rejected)
  const confirmedCount = confirmationProgress.filter(h => h.confirmed).length
  const rejectedCount = confirmationProgress.filter(h => h.rejected).length
  const thresholdMet = allResolved && confirmedCount >= threshold

  const canSubmit = form.name.trim().length > 0 && form.data.trim().length > 0
  const isBlocking = status.kind === 'sending' || (status.kind === 'confirming' && !allResolved)
  const isFirstSecret = !secretBag

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Add secret">
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">{isFirstSecret ? 'Protect Secret' : 'Add Secret'}</h2>
          {!isBlocking && <ModalCloseButton onClose={onClose} />}
        </div>

        {confirming ? (
          <div className="modal-body">
            <div className="verify-progress-bar-section">
              <div className="share-progress-bar-track">
                <div
                  className="share-progress-bar-fill"
                  style={{ width: `${confirmationProgress.length > 0 ? Math.round((confirmationProgress.filter(h => h.confirmed || h.rejected).length / confirmationProgress.length) * 100) : 0}%` }}
                  role="progressbar"
                  aria-valuenow={confirmationProgress.filter(h => h.confirmed || h.rejected).length}
                  aria-valuemin={0}
                  aria-valuemax={confirmationProgress.length}
                />
              </div>
              <p className="share-progress-summary">
                {confirmedCount} of {confirmationProgress.length} confirmed
                {rejectedCount > 0 && ` · ${rejectedCount} rejected`}
                {!allResolved && ` (need ${threshold})`}
              </p>
            </div>

            <ul className="share-progress-list" role="list">
              {confirmationProgress.map(h => (
                <li
                  key={h.id}
                  className={`share-progress-item ${h.confirmed ? 'share-progress-item--confirmed' : ''} ${h.rejected ? 'share-progress-item--failed' : ''}`}
                >
                  <span className="verify-progress-icon">
                    {h.confirmed
                      ? <span className="verify-progress-icon--done" aria-label="Confirmed">&#10003;</span>
                      : h.rejected
                        ? <span className="verify-progress-icon--failed" aria-label="Rejected">&#10007;</span>
                        : <span className="verify-spinner" role="status" aria-label="Waiting for confirmation" />
                    }
                  </span>
                  <span className="share-progress-item-name">{h.name}</span>
                  <span className={`share-progress-item-status ${h.confirmed ? 'status--verified' : ''} ${h.rejected ? 'status--failed' : ''}`}>
                    {h.confirmed ? 'Confirmed' : h.rejected ? 'Rejected' : 'Waiting\u2026'}
                  </span>
                </li>
              ))}
            </ul>

            {allResolved && !thresholdMet && (
              <div className="threshold-failure-banner" role="alert">
                <strong>Secret protection failed.</strong>{' '}
                Only {confirmedCount} of the required {threshold} helpers confirmed.
                The secret bag has been rolled back.
              </div>
            )}

            {allResolved && thresholdMet && rejectedCount > 0 && (
              <div className="threshold-warning-banner" role="status">
                Secret protected successfully, but {rejectedCount} helper{rejectedCount > 1 ? 's' : ''} failed.
                The secret is recoverable with the {confirmedCount} confirmed helper{confirmedCount > 1 ? 's' : ''}.
              </div>
            )}

            <div className="modal-actions">
              <button
                type="button"
                className={allResolved ? 'primary' : 'secondary'}
                onClick={onClose}
              >
                {allResolved ? 'Done' : 'Close'}
              </button>
            </div>
          </div>
        ) : (
          <form className="modal-body" onSubmit={handleSubmit}>
            {isFirstSecret && (
              <p className="modal-description">
                This will create the secret bag and distribute it to all paired participants.
              </p>
            )}

            <div className="form-field">
              <label className="form-label" htmlFor="ps-name">Name</label>
              <input
                id="ps-name"
                className="full-input"
                type="text"
                placeholder="e.g. Google Password"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                disabled={status.kind === 'sending'}
                autoFocus
              />
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="ps-data">Secret Data</label>
              <SecretDataField
                value={form.data}
                onChange={data => setForm(f => ({ ...f, data }))}
                disabled={status.kind === 'sending'}
              />
            </div>

            <div className="form-field">
              <span className="form-label">Participants ({pairedParticipants.length} paired)</span>
              {pairedParticipants.length === 0 ? (
                <p className="empty-hint">No participants paired yet.</p>
              ) : (
                <ul className="participant-check-list" role="list">
                  {pairedParticipants.map(h => (
                    <li key={h.id} className="participant-check-item">
                      <span className={`participant-dot ${h.connectionStatus}`} aria-hidden="true" />
                      <span>{h.name}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {status.kind === 'error' && (
              <p className="field-error">{status.message}</p>
            )}

            <div className="modal-actions">
              <button type="button" className="secondary" onClick={onClose} disabled={status.kind === 'sending'}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={!canSubmit || status.kind === 'sending'}>
                {status.kind === 'sending' ? 'Sending…' : isFirstSecret ? 'Protect' : 'Add Secret'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

// Works for both directions: owner showing their QR (participant scans) and
// participant showing their QR (owner scans). `createContact` abstracts which
// protocol instance to call.
type ShareContactStep =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; channelId: bigint; qrPayload: string; rawHex: string }

/**
 * Role picker for a pairing.
 *
 * Pairing is unidirectional in every mode: whichever side initiates declares its
 * own role on the wire and the responder takes the complement. Which roles are
 * on offer depends on the surface — the browser path offers all four, including
 * the replica roles, while provisioned pairing offers only Owner/Helper — so the
 * option list is supplied by the caller and `R` narrows to whatever it holds.
 */
function PairingRoleSelector<R extends PairingRole>({
  value,
  onChange,
  options,
  disabled,
  idPrefix,
  legend = 'Your role',
}: {
  value: R
  onChange: (role: R) => void
  options: readonly PairingRoleOption<R>[]
  disabled?: boolean
  idPrefix: string
  legend?: string
}) {
  return (
    <fieldset className="role-selector" disabled={disabled}>
      <legend className="sub-heading">{legend}</legend>
      <div className="role-selector__options">
        {options.map(({ role, label, hint }) => (
          <label
            key={role}
            className={`role-option${value === role ? ' role-option--selected' : ''}`}
            htmlFor={`${idPrefix}-role-${role}`}
          >
            <input
              type="radio"
              id={`${idPrefix}-role-${role}`}
              name={`${idPrefix}-role`}
              value={role}
              checked={value === role}
              onChange={() => onChange(role)}
            />
            <span className="role-option__label">{label}</span>
            <span className="role-option__hint">{hint}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/**
 * Picks how a contact publishes its keys.
 *
 * Mirrors `PairingRoleSelector` — same markup and classes — because both are
 * "choose one option before pairing" controls and the panel should not grow a
 * second visual language for the same job.
 */
function ContactModeSelector({
  value,
  onChange,
  disabled,
  idPrefix,
  legend = 'Contact mode',
}: {
  value: ContactModeKey
  onChange: (mode: ContactModeKey) => void
  disabled?: boolean
  idPrefix: string
  legend?: string
}) {
  return (
    <fieldset className="role-selector" disabled={disabled}>
      <legend className="sub-heading">{legend}</legend>
      <div className="role-selector__options">
        {CONTACT_MODE_OPTIONS.map(({ key, label, hint }) => (
          // The hint is on hover rather than on its own line: three modes ×
          // a line of explanation is most of this control's height, and this
          // selector also renders inside the Share Contact modal, which has a
          // QR code to fit. `title` gives the pointer affordance; the
          // visually-hidden copy keeps it reachable by screen reader, which a
          // `title` alone is not.
          <label
            key={key}
            className={`role-option${value === key ? ' role-option--selected' : ''}`}
            htmlFor={`${idPrefix}-mode-${key}`}
            title={hint}
          >
            <input
              type="radio"
              id={`${idPrefix}-mode-${key}`}
              name={`${idPrefix}-mode`}
              value={key}
              checked={value === key}
              onChange={() => onChange(key)}
              aria-describedby={`${idPrefix}-mode-${key}-hint`}
            />
            <span className="role-option__label">{label}</span>
            <span id={`${idPrefix}-mode-${key}-hint`} className="visually-hidden">
              {hint}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function ShareContactModal({
  title,
  transport,
  createContact,
  onClose,
  onPairingCreated,
}: {
  title: string
  transport: Transport
  createContact: (mode: ContactModeKey) => Promise<ContactMessage>
  onClose: () => void
  onPairingCreated?: (channelId: bigint) => void
}) {
  const { log } = useConsole()
  const [step, setStep] = useState<ShareContactStep>({ kind: 'loading' })
  const [contact, setContact] = useState<ContactMessage | null>(null)
  const [mode, setMode] = useState<ContactModeKey>(DEFAULT_CONTACT_MODE)
  const [refreshing, setRefreshing] = useState(false)
  /**
   * The mode a contact has already been requested for.
   *
   * `StrictMode` runs effects twice in development, and this effect's side
   * effect is a *remote* one: it asks the peer to mint a contact, which creates
   * a real pending channel on the server. The cleanup flag stops the second
   * result being applied, but cannot un-send the request — so without this the
   * modal mints two channels every time it opens, and two concurrent
   * `create_contact` messages to the same actor can make one of them fail.
   */
  const requestedModeRef = useRef<ContactModeKey | null>(null)
  /**
   * The mode currently selected, readable from inside an in-flight request.
   *
   * Written during render rather than from an effect so it is already correct
   * when the effect below compares against it. This is what decides whether a
   * resolved request is still wanted — a per-run `cancelled` flag cannot,
   * because `StrictMode`'s immediate cleanup would mark the *first* run
   * cancelled and the second run skips as a duplicate, leaving nothing to
   * apply and no contact ever appearing.
   */
  const latestModeRef = useRef<ContactModeKey>(mode)
  latestModeRef.current = mode

  // Re-mints the contact whenever the mode changes: the mode is baked into the
  // contact at creation, so it cannot be applied to one already generated. The
  // abandoned contact is a `Pending` channel and gets swept by the tick.
  //
  // Deliberately does *not* drop back to the loading step. On the first open
  // there is nothing on screen to keep, but on a mode change there is — and
  // unmounting the QR, the copy row and the transport block collapses the modal
  // to its header and springs it back a moment later, which reads as a flicker.
  // The layout stays put and is marked stale instead.
  useEffect(() => {
    if (requestedModeRef.current === mode) return
    requestedModeRef.current = mode

    setRefreshing(true)

    createContact(mode)
      .then(c => {
        // Superseded only by a newer *mode*, not by a re-run of this effect.
        if (latestModeRef.current !== mode) return
        setContact(c)
        onPairingCreated?.(BigInt(c.channel_id))
        log({
          role: 'owner',
          flow: 'pairing',
          step: 'create_contact',
          description: `Contact created for ${transport.uri} (${mode})`,
          payload: {
            channelId: c.channel_id.toString(),
            transportUri: transport.uri,
            contactMode: mode,
          },
        })
      })
      .catch((err: unknown) => {
        if (latestModeRef.current !== mode) return
        setStep({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        // A superseded run must not clear the flag out from under the newer one.
        if (latestModeRef.current === mode) setRefreshing(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  useEffect(() => {
    if (!contact) return
    setStep({
      kind: 'ready',
      channelId: BigInt(contact.channel_id),
      qrPayload: serializeContact(contact),
      rawHex: contact.channel_id.toString(),
    })
  }, [contact])

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="share-contact-title">
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title" id="share-contact-title">{title}</h2>
          <ModalCloseButton onClose={onClose} />
        </div>

        <div className="modal-body">
          <ContactModeSelector
            value={mode}
            onChange={setMode}
            idPrefix="share-contact"
          />

          {step.kind === 'loading' && (
            <p className="modal-description">Generating contact message…</p>
          )}

          {step.kind === 'error' && (
            <p className="field-error">{step.message}</p>
          )}

          {step.kind === 'ready' && (
            <>
              {/* Same box either way, so the modal keeps its height while a new
                  contact is minted. The old QR is *replaced* rather than dimmed:
                  it encodes a real, still-pending channel in the previous mode,
                  and someone scanning it mid-swap would pair in a mode the user
                  has just moved away from. */}
              <div className="qr-wrapper" aria-busy={refreshing || undefined}>
                {refreshing ? (
                  <div className="qr-placeholder">Generating…</div>
                ) : (
                  /* Deliberately does not follow the colour scheme: a QR needs
                     dark modules on a light field to scan. The wrapper supplies
                     the cream field, so the code itself draws transparent. */
                  <QRCodeSVG
                    value={step.qrPayload}
                    size={200}
                    bgColor="transparent"
                    fgColor="#0f1512"
                  />
                )}
              </div>

              <div className="modal-section">
                <h3 className="sub-heading">Copy</h3>
                <div className="copy-row">
                  {/* Copying is disabled for the same reason the QR is hidden —
                      the payload on screen is about to be superseded. */}
                  <CopyButton label="QR Payload" text={step.qrPayload} disabled={refreshing} />
                  <CopyButton label="Raw Bytes (hex)" text={step.rawHex} disabled={refreshing} />
                </div>
              </div>

              <div className="modal-section">
                <h3 className="sub-heading">Transport</h3>
                <TransportBlock transport={transport} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function TransportBlock({ transport }: { transport: Transport }) {
  return (
    <div className="transport-block">
      <div className="transport-row">
        <span className="meta-label">Protocol</span>
        <span className="protocol-badge">{transport.protocol.toUpperCase()}</span>
      </div>
      <div className="transport-row">
        <span className="meta-label">URI</span>
        <code className="uri-value">{transport.uri}</code>
      </div>
    </div>
  )
}

// Handles scanning/pasting a peer's contact QR. `startPairing` abstracts
// which protocol instance (owner or recovery) to route the request through.
type PairInitiatorStep =
  | { kind: 'input' }
  | { kind: 'sending' }
  | { kind: 'waiting'; channelId: bigint }
  | { kind: 'success'; channelId: bigint }
  | { kind: 'failed'; reason: string }

interface NonOkStatus {
  status: number
  memo: string
  channelId?: string
}

/**
 * A `process()` failure for a channel this device has no key for.
 *
 * The library reports it as a generic `DEREC_ERROR`, so the message text is
 * the only discriminator available.
 */
function isUnknownChannelError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const obj = err as Record<string, unknown>
  return (
    obj.code === 'DEREC_ERROR' &&
    typeof obj.message === 'string' &&
    obj.message.includes('unknown channel_id')
  )
}

/** Channel id carried by a WASM error, when it reports one. */
function unknownChannelId(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const id = (err as Record<string, unknown>).channel_id
  return typeof id === 'string' ? id : undefined
}

/** Extract structured NonOkStatus from a WASM process() error, or null if it's a different error. */
function asNonOkStatus(err: unknown): NonOkStatus | null {
  if (typeof err === 'object' && err !== null && 'code' in err && (err as Record<string, unknown>).code === 'NON_OK_STATUS') {
    const obj = err as Record<string, unknown>
    return {
      status: obj.status as number,
      memo: (obj.memo as string) ?? '',
      channelId: obj.channel_id as string | undefined,
    }
  }
  return null
}

function PairInitiatorModal<R extends PairingRole>({
  label,
  placeholder,
  participantId,
  pairedChannelIds,
  pairingRejectionCount,
  pairingCompletedSignal,
  onClose,
  onSuccess,
  onPairingRequestSent,
  resolveParticipantId,
  startPairing,
  roleOptions,
  fixedRole,
  defaultRole,
  initiatorLabel,
}: {
  label: string
  placeholder: string
  /** Known participant to associate with this pairing attempt, if applicable. */
  participantId?: string
  /** Set of channel IDs (decimal strings) that are currently paired — used to detect pairing completion. */
  pairedChannelIds: Set<string>
  /** Incremented when a pairing rejection is detected — signals the modal to exit waiting. */
  pairingRejectionCount: number
  /**
   * Incremented when any PairingCompleted event fires. Used as a fallback success signal
   * for recovery pairings where the established channel ID may differ from the one returned
   * by protocol.start() — making the pairedChannelIds set check unreliable.
   */
  pairingCompletedSignal: number
  onClose: () => void
  onSuccess: () => void
  onPairingRequestSent: (
    channelId: bigint,
    participantId?: string,
    peerTransportUri?: string,
  ) => void
  /**
   * Optional: given a contact, resolve which participant ID it belongs to.
   * Used to associate a PairingCompleted event with the correct provisioned
   * participant when the caller doesn't already know the participant ID.
   * Resolved by matching contact.transport_protocol.uri against participant.transport.uri.
   */
  resolveParticipantId?: (contact: ContactMessage) => string | undefined
  /** Called with the role the **initiator** declares on the wire. */
  startPairing: (contact: ContactMessage, role: R) => Promise<bigint>
  /**
   * Roles the initiator may declare, in the order they are offered.
   *
   * The browser path passes all four (`BROWSER_PAIRING_ROLE_OPTIONS`); the
   * provisioned path passes only Owner/Helper, because the backend's
   * `start-pairing` route accepts nothing else.
   */
  roleOptions: readonly PairingRoleOption<R>[]
  /** Role the initiator takes. Fixed for flows that only make sense one way;
   *  selectable otherwise. */
  fixedRole?: R
  /** Which role the selector starts on. Defaults to the first option. */
  defaultRole?: R
  /** Who is doing the pairing, for the selector's labels. Defaults to us. */
  initiatorLabel?: string
}) {
  const { log } = useConsole()
  const timeoutMs = useProtocolTimeoutMs()
  const [payload, setPayload] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<PairInitiatorStep>({ kind: 'input' })
  // The camera view replaces the textarea while open, rather than sitting
  // alongside it: the modal is already the tallest surface in the app, and both
  // fill the same field anyway.
  const [scanning, setScanning] = useState(false)
  // `null` until probed. Probing is async (it enumerates devices) and must not
  // prompt for permission, so the affordance appears a beat after the modal.
  const [scanSupport, setScanSupport] = useState<QrScanSupport | null>(null)

  useEffect(() => {
    let cancelled = false
    void qrScanSupport().then(support => { if (!cancelled) setScanSupport(support) })
    return () => { cancelled = true }
  }, [])
  // A contact carries no role, so nothing here is inferred from the payload:
  // the initiator picks its own side and the responder gets the complement.
  const [role, setRole] = useState<R>(fixedRole ?? defaultRole ?? roleOptions[0].role)
  // Consent for the one destructive choice on offer. Opening it starts nothing
  // and erases nothing; a denial aborts before `startPairing` is ever called.
  const eraseConsent = useReplicaEraseConsent()

  // Snapshotted when entering the waiting state so we only react to events after the request.
  const rejectionCountAtWaitRef = useRef(pairingRejectionCount)
  const completedSignalAtWaitRef = useRef(pairingCompletedSignal)

  // `pairedChannelIds` gains the new channel once PairingCompleted fires, so
  // success is detectable here. The signal fallback below covers the case
  // where the long-term id differs from the transient one we started with.
  useEffect(() => {
    if (step.kind !== 'waiting') return
    const channelIdStr = step.channelId.toString()
    const found = pairedChannelIds.has(channelIdStr)

    if (found) {

       
      setStep({ kind: 'success', channelId: step.channelId })
    }
  }, [step, pairedChannelIds])

  // Fallback for the rekey case (see comment above).
  // Only the 'waiting' variant carries a channel id; narrow it out here so the
  // dependency array does not reach for a field the other variants lack.
  const waitingChannelId = step.kind === 'waiting' ? step.channelId : null

  useEffect(() => {
    if (waitingChannelId === null) return
    if (pairingCompletedSignal > completedSignalAtWaitRef.current) {

       
      setStep({ kind: 'success', channelId: waitingChannelId })
    }
  }, [waitingChannelId, pairingCompletedSignal])

  useEffect(() => {
    if (step.kind !== 'waiting') return
    if (pairingRejectionCount > rejectionCountAtWaitRef.current) {
       
      setStep({ kind: 'failed', reason: 'The peer rejected the pairing request.' })
    }
  }, [step.kind, pairingRejectionCount])

  useEffect(() => {
    if (step.kind !== 'waiting') return
    const timer = setTimeout(() => {
      setStep({ kind: 'failed', reason: 'Pairing request timed out. The peer may not have responded.' })
    }, timeoutMs)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.kind])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    let contact: ContactMessage
    try {
      contact = deserializeContact(payload.trim())
    } catch (err) {
      setError(`Failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    // Gate before anything is dispatched. A destructive role has to be consented
    // to first; cancelling leaves the form untouched and starts no pairing.
    const consent = await requestPairingConsent(role, eraseConsent.request)
    if (consent.kind === 'cancelled') return

    setStep({ kind: 'sending' })
    try {
      const channelId = await startPairing(contact, role)

      log({
        role: 'owner',
        flow: 'pairing',
        step: 'start_pairing',
        description: `Pairing request sent for channel ${channelId.toString()} as ${role}`,
        // `senderKind` is what actually reaches the wire — logged so a replica
        // pairing that silently degraded to a helper one would be visible here.
        payload: {
          channelId: channelId.toString(),
          role,
          peerRole: consent.pairing.peerRole,
          senderKind: consent.pairing.senderKind,
        },
      })

      // Resolve participant ID from the contact's transport URI when it wasn't
      // provided statically. This handles the case where a provisioned participant's
      // contact JSON is pasted into the generic Pair modal.
      const resolvedParticipantId = participantId ?? resolveParticipantId?.(contact)
      // Carry the contact's URI regardless: browser peers have no participant
      // row to resolve against, and it is what identifies them once the
      // pairing completes.
      onPairingRequestSent(channelId, resolvedParticipantId, contact.transport_protocol?.uri)
      rejectionCountAtWaitRef.current = pairingRejectionCount
      completedSignalAtWaitRef.current = pairingCompletedSignal
      setStep({ kind: 'waiting', channelId })
    } catch (err) {

      setError(`Failed: ${err instanceof Error ? err.message : String(err)}`)
      setStep({ kind: 'input' })
    }
  }

  function handleClose() {
    if (step.kind === 'success') {
      onSuccess()
    }
    onClose()
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="pair-modal-title">
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title" id="pair-modal-title">
            {step.kind === 'success' ? 'Pairing Complete' : step.kind === 'failed' ? 'Pairing Failed' : 'Pair'}
          </h2>
          {step.kind !== 'waiting' && <ModalCloseButton onClose={handleClose} />}
        </div>

        {step.kind === 'waiting' ? (
          <div className="modal-body">
            <div className="pairing-waiting-indicator">
              <div className="spinner" />
              <p className="modal-description">Pairing request sent. Waiting for the peer to respond…</p>
            </div>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={handleClose}>Cancel</button>
            </div>
          </div>
        ) : step.kind === 'success' ? (
          <div className="modal-body">
            <p className="modal-description">{pairingSuccessMessage(role)}</p>
            <div className="modal-actions">
              <button className="primary" onClick={handleClose}>Done</button>
            </div>
          </div>
        ) : step.kind === 'failed' ? (
          <div className="modal-body">
            <p className="modal-description pairing-error-text">{step.reason}</p>
            <div className="modal-actions">
              <button className="primary" onClick={handleClose}>Close</button>
            </div>
          </div>
        ) : (
          <form className="modal-body" onSubmit={handleSubmit}>
            <div className="form-field">
              <div className="form-label-row">
                <label className="form-label" htmlFor="qr-payload">{label}</label>
                {/* Offered only where it can actually work — no camera, no
                    `BarcodeDetector`, or an insecure origin all leave paste as
                    the single path rather than a button that fails on click.
                    The reason is on the tooltip so a missing button is
                    explicable. */}
                {scanning ? null : scanSupport?.supported ? (
                  <button
                    type="button"
                    className="secondary copy-field-btn"
                    onClick={() => { setScanning(true); setError(null) }}
                    disabled={step.kind === 'sending'}
                  >
                    Scan QR
                  </button>
                ) : scanSupport ? (
                  <span
                    className="form-label-hint"
                    title={describeQrScanUnavailable(scanSupport.reason)}
                  >
                    Scanning unavailable
                  </span>
                ) : null}
              </div>

              {scanning ? (
                <QrScanner
                  onScan={value => {
                    setScanning(false)
                    // Straight into the same field the paste path fills, so
                    // everything downstream — validation, role, submission — is
                    // one code path regardless of how the payload arrived.
                    setPayload(value)
                  }}
                  onCancel={() => setScanning(false)}
                />
              ) : (
                <textarea
                  id="qr-payload"
                  className="full-input mono-textarea"
                  rows={4}
                  placeholder={placeholder}
                  value={payload}
                  onChange={e => setPayload(e.target.value)}
                  disabled={step.kind === 'sending'}
                  autoFocus
                  spellCheck={false}
                />
              )}
              {error && <p className="field-error">{error}</p>}
            </div>

            {!fixedRole && (
              <>
                <PairingRoleSelector
                  value={role}
                  onChange={setRole}
                  options={roleOptions}
                  disabled={step.kind === 'sending'}
                  idPrefix="pair"
                  legend={initiatorLabel ? `${initiatorLabel} role` : 'Your role'}
                />
                <p className="modal-description">
                  The other side becomes <strong>{pairingRoleLabel(complementRole(role))}</strong> on
                  this channel.
                </p>
              </>
            )}

            <div className="modal-actions">
              <button type="button" className="secondary" onClick={handleClose} disabled={step.kind === 'sending'}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={payload.trim().length === 0 || step.kind === 'sending'}>
                {step.kind === 'sending' ? 'Sending…' : `Pair as ${pairingRoleLabel(role)}`}
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Consent gate for `replica_destination`. Rendered here only; it decides
          whether `handleSubmit` proceeds and touches no storage either way. */}
      <ReplicaPairingWarningDialog {...eraseConsent.dialogProps} />
    </div>
  )
}

function SecretDataField({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="shared-key-field">
      <input
        className="key-input"
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="Enter secret data…"
        aria-label="Secret data"
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
      />
      <button
        type="button"
        className="secondary reveal-btn"
        onClick={() => setVisible(v => !v)}
        aria-label={visible ? 'Hide data' : 'Reveal data'}
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  )
}

//
// Two-step modal:
//   Step 1 — select participants (checkbox list, all pre-selected)
//   Step 2 — progress (spinner → checkmark as ShareVerified events arrive)
//
// Progress updates automatically: `secret` is a prop that refreshes from owner
// state whenever a ShareVerified event is applied, so no callbacks or refs needed.

function VerifySharesModal({
  version,
  verifiedParticipantIds,
  confirmedParticipants,
  onClose,
  onVerify,
}: {
  version: number
  /** Live-updated list of participant IDs that have passed verification for this version. */
  verifiedParticipantIds: string[]
  confirmedParticipants: PairedParticipant[]
  onClose: () => void
  onVerify: (version: number) => Promise<void>
}) {
  const timeoutMs = useProtocolTimeoutMs()
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [timedOut, setTimedOut] = useState<Set<string>>(new Set())
  // State-based guards don't protect against React 18 StrictMode's double-
  // invoke of effects: the state update scheduled in the first setup hasn't
  // been flushed before the second setup runs, so a `sent` flag still reads
  // `false` and `onVerify` fires twice — which causes Bob to send two verify
  // requests per channel, and Alice sees the same modal twice per channel.
  // A ref is synchronous and persists across both setups, so the call fires
  // exactly once.
  const hasStartedRef = useRef(false)

  useEffect(() => {
    if (hasStartedRef.current) return
    hasStartedRef.current = true
    setSent(true)
    onVerify(version).catch(err => {
      setError(err instanceof Error ? err.message : String(err))
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!sent) return
    const timer = setTimeout(() => {
      const pending = confirmedParticipants.filter(
        h => !verifiedParticipantIds.includes(h.id),
      )
      if (pending.length > 0) {
        setTimedOut(new Set(pending.map(h => h.channelId)))
      }
    }, timeoutMs)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sent])

  const totalCount = confirmedParticipants.length
  const verifiedCount = confirmedParticipants.filter(
    h => verifiedParticipantIds.includes(h.id),
  ).length
  const failedCount = confirmedParticipants.filter(
    h => timedOut.has(h.channelId),
  ).length
  const resolvedCount = verifiedCount + failedCount
  const allDone = totalCount > 0 && resolvedCount === totalCount
  const pct = totalCount > 0
    ? Math.round((resolvedCount / totalCount) * 100)
    : 0

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="verify-progress-title">
      <div className="modal verify-modal--progress">
        <div className="modal-header">
          <h2 className="modal-title" id="verify-progress-title">Verifying Shares</h2>
          <ModalCloseButton onClose={onClose} />
        </div>
        <div className="modal-body">
          {error && <p className="field-error">{error}</p>}
          <div className="verify-progress-bar-section">
            <div className="share-progress-bar-track">
              <div
                className="share-progress-bar-fill"
                style={{ width: `${pct}%` }}
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            </div>
            <p className="share-progress-summary">
              {verifiedCount} of {totalCount} verified
              {failedCount > 0 && ` · ${failedCount} failed`}
            </p>
          </div>

          <ul className="share-progress-list" role="list">
            {confirmedParticipants.map(h => {
              const isVerified = verifiedParticipantIds.includes(h.id)
              const isTimedOut = timedOut.has(h.channelId)

              let icon: React.ReactNode
              let statusText: string
              let statusClass = ''

              if (isVerified) {
                icon = <span className="verify-progress-icon--done" aria-label="Verified">✓</span>
                statusText = 'Verified'
                statusClass = 'status--verified'
              } else if (isTimedOut) {
                icon = <span className="verify-progress-icon--failed" aria-label="Timed out">✗</span>
                statusText = 'Verification timed out'
                statusClass = 'status--failed'
              } else {
                icon = <span className="verify-spinner" role="status" aria-label="Waiting for response" />
                statusText = 'Waiting…'
              }

              return (
                <li
                  key={h.id}
                  className={`share-progress-item ${isVerified ? 'share-progress-item--confirmed' : ''} ${isTimedOut ? 'share-progress-item--failed' : ''}`}
                >
                  <span className="verify-progress-icon">{icon}</span>
                  <span className="share-progress-item-name">{h.name}</span>
                  <span className={`share-progress-item-status ${statusClass}`}>
                    {statusText}
                  </span>
                </li>
              )
            })}
          </ul>

          <div className="modal-actions">
            <button
              type="button"
              className={allDone ? 'primary' : 'secondary'}
              onClick={onClose}
            >
              {allDone ? 'Done' : 'Close'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Builds a structured representation of the SecretContainer that gets protobuf-encoded and distributed. */
function buildSecretContainerPayload(version: BagVersion) {
  return {
    helpers: version.helpers.map(h => ({
      channel_id: h.channelId,
      transport_uri: `(paired endpoint)`,
      name: h.name,
      shared_key: '(32-byte symmetric key)',
    })),
    secrets: version.secrets.map(s => ({
      id: s.id,
      name: s.name,
      data: s.data,
    })),
  }
}

/** Returns a hex dump of the UTF-8 JSON payload, 32 bytes per line. */
function hexDump(data: Uint8Array): string[] {
  const lines: string[] = []
  const bytesPerLine = 16
  for (let offset = 0; offset < data.length; offset += bytesPerLine) {
    const slice = data.slice(offset, offset + bytesPerLine)
    const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = Array.from(slice).map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('')
    const addr = offset.toString(16).padStart(8, '0')
    lines.push(`${addr}  ${hex.padEnd(bytesPerLine * 3 - 1)}  ${ascii}`)
  }
  return lines
}

function BagPayloadModal({
  version,
  onClose,
}: {
  version: BagVersion
  onClose: () => void
}) {
  const [activeTab, setActiveTab] = useState<'structured' | 'raw'>('structured')

  const payload = buildSecretContainerPayload(version)
  const jsonString = JSON.stringify(payload, null, 2)
  const jsonBytes = new TextEncoder().encode(jsonString)
  const dump = hexDump(jsonBytes)

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="payload-modal-title">
      <div className="modal payload-modal">
        <div className="modal-header">
          <h2 className="modal-title" id="payload-modal-title">
            Secret Bag Payload — v{version.version}
          </h2>
          <ModalCloseButton onClose={onClose} />
        </div>
        <div className="modal-body">
          <div className="payload-tabs">
            <button
              type="button"
              className={`payload-tab ${activeTab === 'structured' ? 'payload-tab--active' : ''}`}
              onClick={() => setActiveTab('structured')}
            >
              Structured
            </button>
            <button
              type="button"
              className={`payload-tab ${activeTab === 'raw' ? 'payload-tab--active' : ''}`}
              onClick={() => setActiveTab('raw')}
            >
              Raw Bytes ({jsonBytes.length} B)
            </button>
          </div>

          {activeTab === 'structured' ? (
            <pre className="payload-pre">{jsonString}</pre>
          ) : (
            <pre className="payload-pre payload-pre--hex">{dump.join('\n')}</pre>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

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

function SecretBagPanel({
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

/** A group of paired channels that belong to the same Owner identity. */
interface LinkGroup {
  /** Stable key (sorted member channel IDs joined). */
  key: string
  /** Display name (the "main" channel's name; all members share it by construction). */
  name: string
  /** The name-bearing channel; used as the Link-button source for the group. */
  mainChannelId: string
  /** Member participants, one per channel, sorted for stable rendering. */
  channels: PairedParticipant[]
}

/** Channel detail line shown under a channel (shared key + share count). */
function ChannelDetails({ h }: { h: PairedParticipant }) {
  return (
    <div className="channel-row-bottom">
      {h.sharedKey && (
        <div className="channel-prop channel-prop--key">
          <span className="channel-prop-label">Shared Key</span>
          <SharedKeyRow value={h.sharedKey} label={false} />
        </div>
      )}
      <div className="channel-prop">
        <span className="channel-prop-label">Shares</span>
        <span className="channel-prop-value">{h.secretShares.length}</span>
      </div>
    </div>
  )
}

/**
 * The main channel list — participant channels only.
 *
 * Replica channels are deliberately absent: they are listed in the Replicas tab
 * and nowhere else, so a row in this list is always somewhere a share can go.
 * The page feeds both lists from one `splitPairedChannels` call, so neither can
 * show what the other does.
 */
function PairedParticipantsList({
  groups,
  unpairingChannelIds,
  onTogglePair,
  onLink,
}: {
  groups: LinkGroup[]
  /** Channel IDs whose unpair request is currently in flight — disables the
   *  Unpair button so a repeated click doesn't send a second envelope. */
  unpairingChannelIds: Set<string>
  onTogglePair: (id: string) => void
  onLink: (channelId: string) => void
}) {
  if (groups.length === 0) {
    return <p className="tab-empty-state">No paired participant channels yet. Pair a participant from the side panel. Replicas are listed in the Replicas tab.</p>
  }

  function unpairButton(channelId: string, participantId: string) {
    const inFlight = unpairingChannelIds.has(channelId)
    return (
      <button
        className="channel-unpair-btn"
        onClick={() => onTogglePair(participantId)}
        disabled={inFlight}
        aria-busy={inFlight || undefined}
      >
        {inFlight ? 'Unpairing…' : 'Unpair'}
      </button>
    )
  }

  return (
    <div className="channel-table">
      {groups.map(group => {
        // Singleton (unlinked) channel — compact single row with Link + Unpair.
        if (group.channels.length === 1) {
          const h = group.channels[0]

          return (
            <div key={group.key} className="channel-block">
              <div className="channel-row-top">
                <span className={`participant-dot ${h.offline ? 'offline' : 'paired'}`} aria-hidden="true" />
                <span className="channel-row-name" style={{ flex: 'none' }}>{group.name}</span>
                {h.peerRole && (
                  <span className={`role-tag role-tag--${h.peerRole}`}>
                    {pairingRoleLabel(h.peerRole)}
                  </span>
                )}
                <span className="channel-id-inline">{h.channelId}</span>
                <span style={{ flex: 1 }} />
                {h.offline && <span className="status-tag offline">Offline</span>}
                <button className="channel-link-btn" onClick={() => onLink(h.channelId)}>
                  Link
                </button>
                {unpairButton(h.channelId, h.id)}
              </div>
              <ChannelDetails h={h} />
            </div>
          )
        }

        // Linked group — name header (group-level Link) + one sub-row per channel.
        return (
          <div key={group.key} className="channel-block">
            <div className="channel-group-header">
              <span className="participant-dot paired" aria-hidden="true" />
              <span className="channel-row-name" style={{ flex: 'none' }}>{group.name}</span>
              <span style={{ flex: 1 }} />
              <button className="channel-link-btn" onClick={() => onLink(group.mainChannelId)}>
                Link
              </button>
            </div>
            {group.channels.map(h => (
              <div key={h.id} className="channel-sub">
                <div className="channel-sub-top">
                  <span className={`participant-dot ${h.offline ? 'offline' : 'paired'}`} aria-hidden="true" />
                  {h.peerRole && (
                    <span className={`role-tag role-tag--${h.peerRole}`}>
                      {pairingRoleLabel(h.peerRole)}
                    </span>
                  )}
                  <span className="channel-id-inline">{h.channelId}</span>
                  <span style={{ flex: 1 }} />
                  {h.offline && <span className="status-tag offline">Offline</span>}
                  {unpairButton(h.channelId, h.id)}
                </div>
                <ChannelDetails h={h} />
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Operator-facing link picker for a provisioned helper.
 *
 * A provisioned helper has no UI of its own, so an operator stands in for the
 * authentication a real entity would perform (KYC, a call, meeting in person)
 * before declaring that a newly-paired channel belongs to an owner it already
 * helps. Nothing on the wire carries a trustworthy identity, so this is always
 * a human decision — the names below are labels, not proof.
 *
 * Until the link exists the helper cannot answer a Discovery request from the
 * re-paired owner, because it has no way to know which shares are theirs.
 */
function ProvisionedLinkModal({
  participantName,
  myChannelId,
  loadChannels,
  onLink,
  onClose,
}: {
  participantName: string
  /** Our channel with this helper. The handshake rekey is symmetric, so this
   *  is the same id the helper holds for us. */
  myChannelId: string
  loadChannels: () => Promise<ProvisionedChannel[]>
  onLink: (linkToChannelId: string) => Promise<void>
  onClose: () => void
}) {
  const [channels, setChannels] = useState<ProvisionedChannel[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const didLoad = useRef(false)
  useEffect(() => {
    if (didLoad.current) return
    didLoad.current = true
    loadChannels()
      .then(setChannels)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Everything except our own channel — those are the other owners this helper
  // holds shares for, one of whom may be a previous identity of ours.
  const candidates = (channels ?? []).filter(c => c.channel_id !== myChannelId)
  const alreadyLinked = new Set(
    (channels ?? []).find(c => c.channel_id === myChannelId)?.linked_channel_ids ?? [],
  )

  async function handleConfirm() {
    if (!selected || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await onLink(selected)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="provisioned-link-title">
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title" id="provisioned-link-title">
            Link on {participantName}
          </h2>
          <ModalCloseButton onClose={onClose} />
        </div>
        <div className="modal-body">
          <p className="modal-description">
            Tell <strong>{participantName}</strong> that your channel{' '}
            <span className="channel-id-inline">{myChannelId}</span> belongs to the
            same owner as one it already holds. Do this only after it would have
            authenticated you — it is the step that lets the helper answer your
            Discovery request.
          </p>

          {error && <p className="field-error">{error}</p>}

          {channels === null && !error && (
            <p className="modal-description">Loading channels…</p>
          )}

          {channels !== null && candidates.length === 0 && (
            <p className="tab-empty-state">
              {participantName} holds no other channels to link to.
            </p>
          )}

          {candidates.length > 0 && (
            <div className="link-channel-list" role="listbox" aria-label="Channels to link">
              {candidates.map(c => {
                const isSelected = selected === c.channel_id
                const linked = alreadyLinked.has(c.channel_id)
                return (
                  <button
                    key={c.channel_id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`link-channel-option${isSelected ? ' link-channel-option--selected' : ''}`}
                    onClick={() => setSelected(c.channel_id)}
                    disabled={linked || submitting}
                  >
                    <span className="link-channel-option__name">
                      {c.peer_name || 'Unnamed peer'}
                      {linked && <span className="status-tag">Already linked</span>}
                    </span>
                    <span className="link-channel-option__meta">channel {c.channel_id}</span>
                  </button>
                )
              })}
            </div>
          )}

          <div className="modal-actions">
            <button className="secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button
              className="primary"
              onClick={handleConfirm}
              disabled={!selected || submitting}
            >
              {submitting ? 'Linking…' : 'Link'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function LinkChannelModal({
  sourceChannel,
  candidates,
  onConfirm,
  onClose,
}: {
  sourceChannel: PairedParticipant
  candidates: PairedParticipant[]
  onConfirm: (targetChannelId: string) => void | Promise<void>
  onClose: () => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleConfirm() {
    if (!selected || submitting) return
    setSubmitting(true)
    try {
      await onConfirm(selected)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="link-channel-title">
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title" id="link-channel-title">Link Channel</h2>
        </div>
        <div className="modal-body">
          <p>
            Link <strong>{sourceChannel.name}</strong>{' '}
            <span className="channel-id-inline">{sourceChannel.channelId}</span>{' '}
            to another channel. Linked channels share their stored shares.
          </p>

          {candidates.length === 0 ? (
            <p className="tab-empty-state">No other channels available to link.</p>
          ) : (
            <div className="link-channel-list" role="listbox" aria-label="Channels to link">
              {candidates.map(c => {
                const isSelected = selected === c.channelId
                return (
                  <button
                    key={c.channelId}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`link-channel-option${isSelected ? ' link-channel-option--selected' : ''}`}
                    onClick={() => setSelected(c.channelId)}
                  >
                    <span className="link-channel-option__name">
                      {c.name}
                      {c.peerRole && (
                        <span className={`role-tag role-tag--${c.peerRole}`}>
                          {pairingRoleLabel(c.peerRole)}
                        </span>
                      )}
                    </span>
                    <span className="link-channel-option__meta">channel {c.channelId}</span>
                  </button>
                )
              })}
            </div>
          )}

          <div className="modal-actions">
            <button className="secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button
              className="primary"
              onClick={handleConfirm}
              disabled={!selected || submitting}
            >
              {submitting ? 'Linking…' : 'Link'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

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

function HeldSharesList({
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

function RecoveryPanel({
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

function connectionStatusLabel(status: ParticipantConnectionStatus): string {
  switch (status) {
    case 'paired':    return 'Paired'
    case 'available': return 'Available'
  }
}

function SidePanelParticipantItem({
  participant,
  onTogglePair,
  onToggleStatus,
  onPairingRequestSent,
  createParticipantContact,
  listChannels,
  linkChannels,
  startParticipantPairing,
  startPairingAsInitiator,
  pairedChannelIds,
  pairingRejectionCount,
  pairingCompletedSignal,
  unconfirmed,
  onConfirmFingerprint,
}: {
  participant: PairedParticipant
  onTogglePair: (id: string) => void
  onToggleStatus: (participantId: string) => Promise<void>
  onPairingRequestSent: (channelId: bigint, participantId: string) => void
  createParticipantContact: (mode: ContactModeKey) => Promise<ContactMessage>
  /** List the channels this provisioned helper holds, for the link picker. */
  listChannels: (participantId: string) => Promise<ProvisionedChannel[]>
  /** Declare that two of its channels belong to the same owner. */
  linkChannels: (participantId: string, channelId: string, linkTo: string) => Promise<void>
  startParticipantPairing: (contact: ContactMessage, role: PairingRole) => Promise<bigint>
  /**
   * When defined, the Pair button opens a modal for the user to paste the peer's
   * contact JSON. The backend actor then initiates pairing using that contact,
   * taking the complement of the role chosen here.
   *
   *  Drives a backend-managed (provisioned) actor via `apiStartActorPairing`,
   *  which only supports participant roles — narrower than `PairingRole`.
   */
  startPairingAsInitiator?: (ownerContact: ContactMessage, role: 'owner' | 'helper') => Promise<bigint>
  pairedChannelIds: Set<string>
  pairingRejectionCount: number
  pairingCompletedSignal: number
  /** The handshake completed but the library still holds the channel `Pending`. */
  unconfirmed: boolean
  onConfirmFingerprint: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [shareContactOpen, setShareContactOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [pairAsInitiatorOpen, setPairAsInitiatorOpen] = useState(false)
  const [isPairing, setIsPairing] = useState(false)
  const [pairError, setPairError] = useState<string | null>(null)
  const [togglingStatus, setTogglingStatus] = useState(false)
  const [contactMode, setContactMode] = useState<ContactModeKey>(DEFAULT_CONTACT_MODE)
  const isPaired = participant.connectionStatus === 'paired'
  const isOffline = !!participant.offline

  /**
   * Pair with this participant, this device initiating.
   *
   * The participant mints a contact in the selected mode and this device pairs
   * against it. That direction is the only one that can express a contact
   * mode at all — the mode is fixed when the contact is created, so whoever
   * creates it chooses. The other direction, where the actor initiates against
   * a contact pasted from this device, is behind "Let them initiate".
   */
  async function handlePair() {
    setIsPairing(true)
    setPairError(null)
    try {
      const contact = await createParticipantContact(contactMode)
      // The inline Pair button on a provisioned participant is the owner-side
      // shortcut: we protect, they help. Role selection lives in the Pair
      // modal for the cases where either direction makes sense.
      const channelId = await startParticipantPairing(contact, 'owner')
      onPairingRequestSent(channelId, participant.id)
    } catch (err) {
      setPairError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsPairing(false)
    }
  }

  return (
    <li className="side-participant-item">
      <button
        className="side-participant-header"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
      >
        <span className={`participant-dot ${isOffline ? 'offline' : participant.connectionStatus}`} aria-hidden="true" />
        <span className="side-participant-name">{participant.name}</span>
        {isOffline ? (
          <span className="status-tag offline">Offline</span>
        ) : unconfirmed ? (
          // Deliberately *not* "Paired": the handshake completed, but the
          // library holds the channel `Pending` — it takes no shares, is no
          // recovery source, and ignores anything sent on it. Showing "Paired"
          // here is how a NoKeys channel silently swallows a secret.
          <span className="status-tag available" title="Awaiting an out-of-band fingerprint confirmation">
            Unconfirmed
          </span>
        ) : (
          <span className={`status-tag ${participant.connectionStatus}`}>
            {connectionStatusLabel(participant.connectionStatus)}
          </span>
        )}
        <ChevronIcon expanded={expanded} />
      </button>

      {expanded && (
        <div className="side-participant-details">
          <div className="side-detail-row">
            <span className="side-detail-label">Channel ID</span>
            <span className="side-detail-value" title={participant.channelId}>{participant.channelId}</span>
          </div>
          {participant.sharedKey && (
            <SharedKeyRow value={participant.sharedKey} />
          )}
          <div className="side-detail-row">
            <span className="side-detail-label">Shares</span>
            <span className="side-detail-value">{participant.secretShares.length}</span>
          </div>
          {/* Mode is baked into the contact, so it has to be chosen before
              pairing starts — not after. Hidden once paired, when it no longer
              applies to anything. */}
          {!isPaired && !isOffline && (
            <ContactModeSelector
              value={contactMode}
              onChange={setContactMode}
              idPrefix={`participant-${participant.id}`}
              disabled={isPairing}
            />
          )}
          {pairError && <p className="field-error">{pairError}</p>}
          <div className="side-participant-actions">
            <button
              className="secondary side-action-btn"
              onClick={() => setShareContactOpen(true)}
            >
              Share Contact
            </button>
            {!participant.browserManaged && (
              <button
                className={`pair-action-btn ${isOffline ? 'pair' : 'unpair'}`}
                disabled={togglingStatus}
                onClick={async () => {
                  setTogglingStatus(true)
                  try { await onToggleStatus(participant.id) } finally { setTogglingStatus(false) }
                }}
              >
                {togglingStatus ? '…' : isOffline ? 'Go Online' : 'Go Offline'}
              </button>
            )}
            {isPaired && !participant.browserManaged && participant.channelId && (
              <button
                className="pair-action-btn"
                onClick={() => setLinkOpen(true)}
                title={`Tell ${participant.name} that this channel belongs to an owner it already helps`}
              >
                Link
              </button>
            )}
            {/* A standing way back into the comparison after the modal has
                been dismissed — the channel is unusable until it is done. */}
            {unconfirmed && (
              <button className="pair-action-btn pair" onClick={onConfirmFingerprint}>
                Confirm fingerprint
              </button>
            )}
            {isPaired ? (
              <button className="pair-action-btn unpair" onClick={() => onTogglePair(participant.id)}>
                Unpair
              </button>
            ) : !isOffline ? (
              <>
                <button
                  className="pair-action-btn pair"
                  disabled={isPairing}
                  onClick={handlePair}
                >
                  {isPairing ? 'Pairing…' : 'Pair'}
                </button>
                {/* The other direction: the actor initiates against a contact
                    pasted from this device, so it declares its own role. Kept
                    separate because the contact — and therefore the mode — is
                    then this device's, not the participant's. */}
                {startPairingAsInitiator && (
                  <button
                    className="secondary side-action-btn"
                    disabled={isPairing}
                    onClick={() => setPairAsInitiatorOpen(true)}
                  >
                    Let them initiate
                  </button>
                )}
              </>
            ) : null}
          </div>
        </div>
      )}

      {linkOpen && participant.channelId && (
        <ProvisionedLinkModal
          participantName={participant.name}
          myChannelId={participant.channelId}
          loadChannels={() => listChannels(participant.id)}
          onLink={linkTo => linkChannels(participant.id, participant.channelId, linkTo)}
          onClose={() => setLinkOpen(false)}
        />
      )}

      {shareContactOpen && (
        <ShareContactModal
          title={`Share ${participant.name} Contact`}
          transport={participant.transport}
          createContact={createParticipantContact}
          onClose={() => setShareContactOpen(false)}
        />
      )}

      {pairAsInitiatorOpen && startPairingAsInitiator && (
        <PairInitiatorModal
          label="Your Contact (QR Payload)"
          placeholder="Paste the JSON payload from your own Share Contact QR code"
          pairedChannelIds={pairedChannelIds}
          pairingRejectionCount={pairingRejectionCount}
          pairingCompletedSignal={pairingCompletedSignal}
          onClose={() => setPairAsInitiatorOpen(false)}
          onSuccess={() => setPairAsInitiatorOpen(false)}
          onPairingRequestSent={(channelId) => {
            setPairAsInitiatorOpen(false)
            onPairingRequestSent(channelId, participant.id)
          }}
          startPairing={startPairingAsInitiator}
          // The participant is the one scanning, so this picks *its* role;
          // we end up on the other side of the channel. Owner/Helper only —
          // this goes through the backend's `start-pairing` route.
          roleOptions={participantPairingRoleOptions(
            `${participant.name} protects a secret; you hold a share for them.`,
            `${participant.name} holds a share; you protect the secret.`,
          )}
          defaultRole="helper"
          initiatorLabel={`${participant.name}'s`}
        />
      )}
    </li>
  )
}

function AddParticipantModal({
  onAdd,
  onClose,
}: {
  onAdd: (name: string, autoPair: boolean) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(() => `${faker.person.firstName()} ${faker.person.lastName()}`)
  const [autoPair, setAutoPair] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      await onAdd(name.trim(), autoPair)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Add participant">
      <div className="modal" style={{ maxWidth: 400 }}>
        <div className="modal-header">
          <h2 className="modal-title">Add Participant</h2>
          <ModalCloseButton onClose={onClose} />
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-field">
              <label className="form-label" htmlFor="add-participant-name">Name</label>
              <input
                id="add-participant-name"
                className="form-input"
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                autoFocus
                disabled={submitting}
              />
            </div>
            <div className="form-field">
              <label className="participant-check-label">
                <input
                  type="checkbox"
                  className="participant-checkbox"
                  checked={autoPair}
                  onChange={e => setAutoPair(e.target.checked)}
                  disabled={submitting}
                />
                <span>Auto-pair after adding</span>
              </label>
            </div>
            {error && <p className="field-error">{error}</p>}
          </div>
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose} disabled={submitting}>Cancel</button>
            <button type="submit" className="primary" disabled={!name.trim() || submitting}>
              {submitting ? 'Adding…' : 'Add Participant'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function OwnerParticipantPanel({
  participants,
  replicaSection,
  onTogglePair,
  onToggleParticipantStatus,
  onPairingRequestSent,
  listChannels,
  linkChannels,
  onAddParticipant,
  getParticipantFunctions,
  pairedChannelIds,
  pairingRejectionCount,
  pairingCompletedSignal,
  unconfirmedChannelIds,
  onConfirmFingerprint,
}: {
  participants: PairedParticipant[]
  /**
   * The provisioned-replica section, rendered directly below the participants.
   *
   * Injected rather than built here so this panel keeps knowing only about
   * participants, and the replica section keeps its own props typed on its own
   * terms.
   */
  replicaSection: React.ReactNode
  onTogglePair: (id: string) => void
  onToggleParticipantStatus: (participantId: string) => Promise<void>
  onPairingRequestSent: (channelId: bigint, actorId: string) => void
  onAddParticipant: (name: string, autoPair: boolean) => Promise<void>
  listChannels: (participantId: string) => Promise<ProvisionedChannel[]>
  linkChannels: (participantId: string, channelId: string, linkTo: string) => Promise<void>
  getParticipantFunctions: (participantId: string) => {
    createContact: (mode: ContactModeKey) => Promise<ContactMessage>
    startPairing: (contact: ContactMessage, role: PairingRole) => Promise<bigint>
    /** Participant-only — see the field of the same name above. */
    startPairingAsInitiator?: (ownerContact: ContactMessage, role: 'owner' | 'helper') => Promise<bigint>
  }
  pairedChannelIds: Set<string>
  pairingRejectionCount: number
  pairingCompletedSignal: number
  /**
   * Channels whose handshake completed but which the library still holds
   * `Pending`, awaiting an out-of-band fingerprint. Only `NoKeys` pairings
   * land here.
   */
  unconfirmedChannelIds: ReadonlySet<string>
  /** Reopen the fingerprint comparison for a channel. */
  onConfirmFingerprint: (channelId: string) => void
}) {
  const [addParticipantOpen, setAddParticipantOpen] = useState(false)

  return (
    <aside className="side-panel" aria-label="Actors">
      {/* ── Participants section ─────────────────────────────────────────── */}
      <div className="side-panel-section">
        <div className="panel-header-row">
          <div>
            <h3 className="panel-heading">Provisioned participants</h3>
            <p className="panel-subtitle">{participants.length} provisioned</p>
          </div>
          <button
            className="secondary small"
            onClick={() => setAddParticipantOpen(true)}
            title="Provision a new participant on the server"
          >
            + Add
          </button>
        </div>
        <ul className="side-participant-list" role="list">
          {participants.map(h => {
            const { createContact, startPairing, startPairingAsInitiator } = getParticipantFunctions(h.id)
            return (
              <SidePanelParticipantItem
                key={h.id}
                participant={h}
                onTogglePair={onTogglePair}
                onToggleStatus={onToggleParticipantStatus}
                onPairingRequestSent={onPairingRequestSent}
                createParticipantContact={createContact}
                listChannels={listChannels}
                linkChannels={linkChannels}
                startParticipantPairing={startPairing}
                startPairingAsInitiator={startPairingAsInitiator}
                pairedChannelIds={pairedChannelIds}
                pairingRejectionCount={pairingRejectionCount}
                pairingCompletedSignal={pairingCompletedSignal}
                unconfirmed={!!h.channelId && unconfirmedChannelIds.has(h.channelId)}
                onConfirmFingerprint={() => h.channelId && onConfirmFingerprint(h.channelId)}
              />
            )
          })}
        </ul>
      </div>

      {/* ── Replicas section ──────────────────────────────────────────────── */}
      {replicaSection}

      {addParticipantOpen && (
        <AddParticipantModal
          onAdd={async (name, autoPair) => {
            await onAddParticipant(name, autoPair)
            setAddParticipantOpen(false)
          }}
          onClose={() => setAddParticipantOpen(false)}
        />
      )}
    </aside>
  )
}

function updateBagVersion(bag: SecretBag, version: number, updater: (v: BagVersion) => BagVersion): SecretBag {
  if (bag.currentVersion.version === version) {
    return { ...bag, currentVersion: updater(bag.currentVersion) }
  }
  return {
    ...bag,
    previousVersions: bag.previousVersions.map(v => v.version === version ? updater(v) : v),
  }
}

function updateBagParticipant(bag: SecretBag, version: number, participantId: string): SecretBag {
  return updateBagVersion(bag, version, v =>
    v.participantIds.includes(participantId) ? v : { ...v, participantIds: [...v.participantIds, participantId] },
  )
}

function updateBagVerified(bag: SecretBag, version: number, participantId: string): SecretBag {
  return updateBagVersion(bag, version, v =>
    v.verifiedParticipantIds.includes(participantId) ? v : { ...v, verifiedParticipantIds: [...v.verifiedParticipantIds, participantId] },
  )
}

interface PendingShare {
  version: number
}

/** What one dispatched `ProtectSecret` round produced. */
interface ProtectRoundResult {
  /** The version the library assigned to the round. */
  version: number
  /** The participants the round registered pending shares for. */
  participants: PairedParticipant[]
  /** The replica destinations the round is expected to mirror to. */
  replicaTargets: ReplicaSyncTarget[]
}

/**
 * The owner page tabs.
 *
 * `replicas` is a *listing* only. Every replica dialog — fingerprint
 * comparison, pairing-request confirmation, adoption offer — is mounted at page
 * level, outside this switch, and raises itself whichever tab is selected. None
 * of them is gated on this value.
 */
type ActiveTab = 'participants' | 'replicas' | 'secrets' | 'shares' | 'recovery'

interface Props {
  owner: Owner
  onUpdate: (updated: Owner) => void
}

export default function OwnerPage({ owner, onUpdate }: Props) {
  const { log } = useConsole()
  // Single protocol timeout (ms) — drives the FE watchdog and all
  // app-level wall-clock timers; the same value (in seconds) is passed to the
  // WASM constructor for the library's passive process() expiry.
  const flowTimeoutMs = protocolTimeoutMs(owner.config?.protocolTimeoutSecs)

  // Protocol settings this device pushes to the backend whenever it provisions
  // an actor. Configuration is FE-owned, so the backend has no policy of its
  // own for a new participant or replica to inherit.
  const provisioningSettings: ProvisioningSettings = {
    protocolTimeoutSecs: owner.config?.protocolTimeoutSecs ?? DEFAULT_PROTOCOL_TIMEOUT_SECS,
    unpairAck: owner.config?.unpairAck ?? DEFAULT_UNPAIR_ACK,
  }
  const [activeTab, setActiveTab] = useState<ActiveTab>(
    'participants',
  )
  const [shareOpen, setShareOpen] = useState(false)
  const [pairOpen, setPairOpen] = useState(false)
  const [protectOpen, setProtectOpen] = useState(false)
  const [protocolBusy, setProtocolBusy] = useState(false)

  // Set of paired channel IDs watched by PairInitiatorModal to detect when pairing completes.
  const pairedChannelIds = useMemo(() => {
    const ids = new Set<string>()
    for (const p of owner.participants) {
      if (p.connectionStatus === 'paired' && p.channelId) ids.add(p.channelId)
    }
    return ids
  }, [owner.participants])

  // Polled by PairInitiatorModal — incremented on process() errors with "non-ok status".
  const [pairingRejectionCount, setPairingRejectionCount] = useState(0)

  // Fallback success signal for recovery pairings where protocol.start() returns a
  // different channel ID than PairingCompleted.channel_id (so pairedChannelIds won't match).
  const [pairingCompletedSignal, setPairingCompletedSignal] = useState(0)

  // Non-empty while participants are being auto-paired; shows a setup gate in the UI.
  const [autoPairingIds, setAutoPairingIds] = useState<string[]>([])

  // Shape and replica/participant discrimination live in `inboundPairing.ts`;
  // both verdicts share this one slot so the accept/reject handlers, and the
  // poll gate that holds back the destructive mailbox drain, stay single-path.
  const [pendingPairingConfirmation, setPendingPairingConfirmation] = useState<PendingPairingConfirmation | null>(null)
  const pendingPairingConfirmationRef = useRef<PendingPairingConfirmation | null>(null)
  useEffect(() => { pendingPairingConfirmationRef.current = pendingPairingConfirmation }, [pendingPairingConfirmation])

  // ── Pairing modal: in-modal "accept + link" path (User auth method) ────────
  // The modal has two views: the decision view (Accept / Reject / Link) and an
  // in-place link picker. Switching to the picker does NOT send the pairing
  // response yet — the response is sent only when the user confirms the link,
  // at which point we accept the pairing and then call `linkChannelsAtomic`.
  type PairingModalView = 'decision' | 'linking'
  const [pairingModalView, setPairingModalView] = useState<PairingModalView>('decision')
  const [pairingLinkTarget, setPairingLinkTarget] = useState<string | null>(null)
  const [pairingLinkSubmitting, setPairingLinkSubmitting] = useState(false)

  // Reset the modal view + selection whenever a new pairing confirmation opens.
  useEffect(() => {
    setPairingModalView('decision')
    setPairingLinkTarget(null)
    setPairingLinkSubmitting(false)
  }, [pendingPairingConfirmation?.channelId])

  interface PendingStoreShareConfirmation {
    peerName: string
    channelId: string
    secretId: string
    version: number
    description: string
    /** Opaque action token from ActionRequired event — pass to accept() or reject(). */
    action: Uint8Array
  }

  const [pendingStoreShareConfirmation, setPendingStoreShareConfirmation] = useState<PendingStoreShareConfirmation | null>(null)
  const pendingStoreShareConfirmationRef = useRef<PendingStoreShareConfirmation | null>(null)
  useEffect(() => { pendingStoreShareConfirmationRef.current = pendingStoreShareConfirmation }, [pendingStoreShareConfirmation])

  interface PendingVerifyShareConfirmation {
    peerName: string
    channelId: string
    version: number
    secretId: string
    /** Opaque action token from ActionRequired event — pass to accept() or reject(). */
    action: Uint8Array
  }

  const [pendingVerifyShareConfirmation, setPendingVerifyShareConfirmation] = useState<PendingVerifyShareConfirmation | null>(null)
  const pendingVerifyShareConfirmationRef = useRef<PendingVerifyShareConfirmation | null>(null)
  useEffect(() => { pendingVerifyShareConfirmationRef.current = pendingVerifyShareConfirmation }, [pendingVerifyShareConfirmation])

  interface PendingUnpairConfirmation {
    peerName: string
    channelId: string
    /** Opaque action token from ActionRequired event — pass to accept() or reject(). */
    action: Uint8Array
  }

  const [pendingUnpairConfirmation, setPendingUnpairConfirmation] = useState<PendingUnpairConfirmation | null>(null)
  const pendingUnpairConfirmationRef = useRef<PendingUnpairConfirmation | null>(null)
  useEffect(() => { pendingUnpairConfirmationRef.current = pendingUnpairConfirmation }, [pendingUnpairConfirmation])

  /**
   * A helper channel that completed its handshake but is still `Pending`,
   * awaiting an out-of-band fingerprint comparison.
   *
   * Only `NoKeys` pairings land here — `InlineKeys` and `HashedKeys` both
   * commit to the keys, so the library promotes them to `Paired` immediately.
   */
  interface PendingFingerprintGate {
    channelId: string
    peerName: string
    /** `null` when the peer is another browser, which confirms on its own screen. */
    peerActorId: string | null
  }

  const [pendingFingerprintGate, setPendingFingerprintGate] =
    useState<PendingFingerprintGate | null>(null)

  /**
   * Bumped whenever a channel's stored status may have moved, so the derived
   * set below is recomputed. The status lives in the library's own store rather
   * than in React state, and nothing re-renders when the library writes to it.
   */
  const [channelStatusNonce, setChannelStatusNonce] = useState(0)

  /**
   * Channels whose handshake completed but which the library still holds
   * `Pending`.
   *
   * Read from the channel store rather than tracked alongside the roster: the
   * library owns this state and promotes the channel itself, so a second copy
   * in app state could only drift — and drifting the wrong way means telling
   * the user a channel is paired while every share sent to it is dropped.
   */
  const unconfirmedChannelIds = useMemo<ReadonlySet<string>>(() => {
    const pending = new Set<string>()
    const namespace = `owner:${owner.ownerId}`

    for (const participant of owner.participants) {
      if (!participant.channelId) continue
      if (readHelperChannelStatus(namespace, owner.ownSecretId, participant.channelId) === 'Pending') {
        pending.add(participant.channelId)
      }
    }
    return pending
    // `channelStatusNonce` is deliberately a dependency the body never reads:
    // the status lives in the library's store, not in React state, so bumping
    // the nonce is the only way to make this recompute after a confirmation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner.ownerId, owner.ownSecretId, owner.participants, channelStatusNonce])

  /**
   * Raise the fingerprint gate if the library left `channelId` `Pending`.
   *
   * Reading the stored status rather than remembering which mode was chosen is
   * what makes this work on the *responding* side too, where the app never saw
   * the contact and so never knew its mode. It is also the library's own answer
   * rather than the app's guess about it.
   */
  function maybeRaiseFingerprintGate(channelId: string, snapshot: Owner): void {
    const status = readHelperChannelStatus(`owner:${snapshot.ownerId}`, ownSecretIdRef.current, channelId)
    if (status !== 'Pending') return

    const peer = snapshot.participants.find(p => p.channelId === channelId)
    setPendingFingerprintGate({
      channelId,
      peerName: peer?.name ?? 'this peer',
      // Only when the backend actually knows this peer — see
      // `canDrivePeerViaBackend`. A browser peer confirms on its own screen,
      // and a synthetic row has no actor id to ask about.
      peerActorId: canDrivePeerViaBackend(peer) ? peer!.id : null,
    })

    log({
      role: 'owner',
      flow: 'pairing',
      step: 'fingerprint_gate_raised',
      description: `Channel ${channelId} is pending an out-of-band fingerprint confirmation`,
      payload: { channelId, peerName: peer?.name ?? null },
    })
  }

  // A mirrored secret this device (as a replica destination) has received but
  // not yet been asked to adopt. Deliberately plain component state, not part
  // of `Owner` or persisted storage: adopting it — wiping this device's
  // vault and calling `protocol.restore` — is Task 11's explicit, user-gated
  // step, and nothing here performs it or survives a reload to retry it
  // automatically. Losing an unconfirmed offer on refresh is the safe
  // direction; the source's next sync round re-offers it.
  const [pendingReplicaAdoption, setPendingReplicaAdoption] = useState<PendingReplicaAdoption | null>(null)

  // The last automatic replica sync round that sent nothing. That round is
  // never retried, so the user has to be told, on screen and durably, that the
  // copy did not go out and that "Sync now" is how they send it — a toast that
  // scrolls away is not that. Cleared by a round that does dispatch.
  const [replicaAutoSyncOutcome, setReplicaAutoSyncOutcome] =
    useState<UnresolvedAutomaticSync | null>(null)

  // ── Replica projection ─────────────────────────────────────────────────────
  //
  // One projection, read by three surfaces: the replica rows in the channel
  // list, the provisioned-replica section in the side panel, and the fingerprint
  // modal. It is fed by the roster poll that already runs below — the old panel
  // ran a second poll of its own, which is what let the two disagree about a
  // row's status.
  const [replicaRows, setReplicaRows] = useState<ReplicaView[]>([])
  const [replicaRowsLoaded, setReplicaRowsLoaded] = useState(false)
  /** Last roster read, kept so the projection can be recomputed without a request. */
  const rosterSnapshotRef = useRef<readonly BEActorWithStatus[] | null>(null)

  /**
   * Recompute the projection from the roster already in hand.
   *
   * Local replica state is written synchronously — by the pairing fold, by a
   * fingerprint confirmation — so after either of those this is current
   * immediately, and the row does not have to wait a poll interval to stop
   * lying about its status.
   */
  const refreshReplicaRows = useCallback(() => {
    const snapshot = rosterSnapshotRef.current
    if (!snapshot) return
    setReplicaRows(replicaViews(snapshot, loadReplicaState(owner.ownerId)))
  }, [owner.ownerId])

  // Prime the roster once on mount. The poll below is the steady-state source,
  // but its first tick is a full interval away — and a handshake that completes
  // inside that window would raise the fingerprint modal against a projection
  // that does not exist yet, leaving the user staring at a channel with no
  // dialog until the poll caught up.
  useEffect(() => {
    let cancelled = false
    apiGetActors()
      .then(resp => {
        if (cancelled) return
        rosterSnapshotRef.current = resp
        setReplicaRows(replicaViews(resp, loadReplicaState(owner.ownerId)))
        setReplicaRowsLoaded(true)
      })
      // Silent: the poll below surfaces connectivity problems, and a failure
      // here only means the projection arrives on the next tick instead.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [owner.ownerId])

  /**
   * The replica channel whose fingerprint comparison is on screen, or `null`.
   *
   * Raised automatically when a replica handshake completes — on both sides —
   * and re-openable from the row for as long as the channel is unconfirmed.
   * Dismissing writes nothing and cancels nothing: the channel stays `Pending`,
   * the row keeps its prompt, and the expiry keeps counting down.
   */
  const [fingerprintChannelId, setFingerprintChannelId] = useState<string | null>(null)

  /** The replica channel whose "Sync now" is in flight. One at a time: a round is global. */
  const [syncingChannelId, setSyncingChannelId] = useState<string | null>(null)
  /** The result of a sync the user explicitly asked for, and the row they asked on. */
  const [manualSyncNotice, setManualSyncNotice] =
    useState<{ channelId: string; notice: ReplicaRowSyncNotice } | null>(null)

  /** Whether the pending adoption's confirmation dialog is open. */
  const [adoptionOpen, setAdoptionOpen] = useState(false)
  /**
   * Spent adoption verdicts, keyed by channel — deliberately not by version.
   *
   * The source re-sends the mirrored vault every round, so a failed attempt is
   * always followed by a v+1 offer. Keying by channel is what stops that newer
   * offer from re-arming the destructive confirm with the prior failure's
   * evidence erased.
   */
  const [adoptionFailures, setAdoptionFailures] = useState<Record<string, RestoreFailure>>({})

  // Set when a wipe-and-adopt erased this device's namespace and then failed.
  // The instance the page still holds is bound to stores that no longer exist,
  // so the page is not merely showing an error — it is unusable, and says so.
  // Terminal by design: no retry, no automatic repair, and no path back until
  // the user erases this browser's DeRec data.
  //
  // Seeded from storage rather than from `null`: the erase does not touch the
  // persisted owner envelope, so a reload would otherwise restore a roster of
  // helpers whose stores are gone and let the user protect against them.
  const [adoptionBlock, setAdoptionBlock] = useState<RestoreFailure | null>(() =>
    loadReplicaAdoptionBlock(owner.ownerId),
  )
  // Read from interval callbacks and other closures that must stop immediately,
  // without waiting for the state update to land. Seeded with the same value —
  // `useRef` only reads its argument on the first render, which is exactly when
  // the persisted block is in `adoptionBlock`.
  const adoptionBlockRef = useRef<RestoreFailure | null>(adoptionBlock)

  // Outgoing-unpair confirmation: when the Owner clicks "Unpair" on a paired
  // channel, surface a modal so the user sees an immediate response (and
  // can't fire a second request before the first is processed).
  interface OutgoingUnpairConfirmation {
    participantId: string
    peerName: string
    channelId: string
  }
  const [outgoingUnpairConfirmation, setOutgoingUnpairConfirmation] = useState<OutgoingUnpairConfirmation | null>(null)

  // Channels whose unpair request has been sent and is awaiting the peer's
  // response (or timeout). Used to disable the Unpair button so a repeated
  // click can't push a second envelope down a channel whose shared key the
  // peer has already deleted — which surfaces on the peer side as
  // "unknown channel_id: no shared key or pairing secret found".
  const [unpairingChannelIds, setUnpairingChannelIds] = useState<Set<string>>(() => new Set())

  // A group-wide sync check is in flight. Group-wide rather than per-row: the
  // flow takes no parameters and asks every member at once.
  const [syncCheckRunning, setSyncCheckRunning] = useState(false)
  // Replica ids whose eviction is in flight, keyed by the protocol-level
  // replica id the flow names — not the backend actor id.
  const [removingReplicaIds, setRemovingReplicaIds] = useState<Set<string>>(() => new Set())

  // Channel whose "Link" button was clicked; drives the link modal.
  const [linkSourceChannelId, setLinkSourceChannelId] = useState<string | null>(null)
  // Bumped after a successful link so the grouped channel view recomputes.
  const [linkVersion, setLinkVersion] = useState(0)
  // Paired channels grouped by their channel-link connected component.
  const [linkGroups, setLinkGroups] = useState<LinkGroup[]>([])

  // ── Protocol instance ──────────────────────────────────────────────────────
  // One per node, bound to the secret this node protects as Owner. Helper-role
  // channels live in the same instance, separated by channel id; each share it
  // holds carries its own Owner's `secret_id` on the record.
  const instanceRef = useRef<ProtocolInstance | null>(null)

  // The secret this node protects as Owner.
  const ownSecretIdRef = useRef<string>('')

  /** The node's protocol instance, or null before init. */
  function ownInstance(): ProtocolInstance | null {
    return instanceRef.current
  }

  // Serialises access to the WASM protocol object.  WASM borrows &mut self for
  // async calls — concurrent access triggers "recursive use of an object".
  const protocolLockRef = useRef<Promise<void>>(Promise.resolve())
  function withProtocolLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = protocolLockRef.current
    let resolve: () => void
    protocolLockRef.current = new Promise<void>(r => { resolve = r })
    return prev.then(fn).finally(() => resolve!())
  }

  /**
   * The replica flows' view of this node's protocol, lock-guarded.
   *
   * Stable for the life of the page and **never** null. The instance itself is
   * built in an effect and held in a ref, so a component handed
   * `instanceRef.current` *during render* can be handed `null` on the first
   * render and never re-rendered when the ref later fills — React does not
   * re-render on ref mutation. That is exactly what disabled the old panel's
   * fingerprint button permanently. Each method here reads the ref at **call**
   * time instead, which is the moment the answer is actually needed, and throws
   * a legible error rather than silently disabling a control if the instance is
   * genuinely absent.
   */
  const replicaProtocol = useMemo<ReplicaProtocol>(() => {
    const currentProtocol = (): DeRecProtocol => {
      const protocol = instanceRef.current?.protocol
      if (!protocol) throw new Error('Protocol not initialised yet — try again in a moment.')
      return protocol
    }
    return {
      start: (flowKind, params) =>
        withProtocolLock(() => currentProtocol().start(flowKind, params)),
      getFingerprint: channelId =>
        withProtocolLock(() => currentProtocol().getFingerprint(channelId)),
      verifyFingerprint: (channelId, fingerprint) =>
        withProtocolLock(() => currentProtocol().verifyFingerprint(channelId, fingerprint)),
      startSyncCheck: () =>
        withProtocolLock(() => currentProtocol().start(FlowKind.SyncCheck)),
      startRemoveReplica: params =>
        withProtocolLock(() => currentProtocol().start(FlowKind.RemoveReplica, params)),
    }
    // `withProtocolLock` and `instanceRef` are stable for the life of the page;
    // rebuilding this object would defeat the point of it being stable.
  }, [])

  // Pending shares keyed by participant channelId; matched against ShareConfirmed events.
  const pendingSharesRef = useRef<Map<string, PendingShare>>(new Map())

  // Holds the bag version being built during a sharing round. Committed only when
  // SharingComplete arrives with threshold_met=true; discarded otherwise.
  const pendingBagRef = useRef<{ bag: SecretBag; version: number; protocolSecretId: string } | null>(null)

  // Inbound messages drained from the (destructive) backend mailbox but not yet
  // processed because a confirmation modal was open. Replayed on a later tick so
  // draining the mailbox never loses messages.
  const pendingInboundRef = useRef<MailboxMessage[]>([])

  // Single generic wall-clock watchdog for any in-flight owner-initiated flow
  // (protect / verify / discovery / recovery). Armed when a flow starts,
  // refreshed by inbound progress, cleared on completion. If it fires, the
  // flow made no progress within the protocol timeout and the UI recovers.
  const flowTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const protocolBusyRef = useRef(false)
  useEffect(() => {
    protocolBusyRef.current = protocolBusy
    // When no owner flow is in flight, the watchdog has nothing to guard.
    if (!protocolBusy) clearFlowWatchdog()
     
  }, [protocolBusy])
  useEffect(() => () => {
    if (flowTimeoutRef.current) clearTimeout(flowTimeoutRef.current)
  }, [])

  function clearFlowWatchdog() {
    if (flowTimeoutRef.current) {
      clearTimeout(flowTimeoutRef.current)
      flowTimeoutRef.current = null
    }
  }

  function onFlowTimeout() {
    flowTimeoutRef.current = null
    const pendingBag = pendingBagRef.current
    if (pendingBag) {
      // Sharing round: roll back the pending bag (also toasts + resets busy).
      failSharingRound(pendingBag.version, 'timeout')
      return
    }
    if (!protocolBusyRef.current) return // nothing actually in flight
    pendingSharesRef.current.clear()
    pendingVerificationsRef.current.clear()
    setProtocolBusy(false)
    reportError(`Operation timed out — no response within ${Math.round(flowTimeoutMs / 1000)}s`)
  }

  /** (Re)arm the generic flow watchdog. Call when a flow starts or progresses. */
  function armFlowWatchdog() {
    clearFlowWatchdog()
    flowTimeoutRef.current = setTimeout(onFlowTimeout, flowTimeoutMs)
  }

  // Tracks in-flight verification challenges keyed by participant channelId.
  const pendingVerificationsRef = useRef<Map<string, { protocolSecretId: string; version: number }>>(new Map())

  // Tracks in-flight recovery requests so SecretRecovered events can be correlated.
  const pendingRecoveryRef = useRef<{ secretId: string; version: number; label: string } | null>(null)

  // Channel ID for the contact this owner posted to the signaling endpoint.
  const ownerContactChannelRef = useRef<string | null>(null)

  // Use a stable owner ref so polling closures always see the latest value without
  // being listed as a dependency (avoids tearing down intervals on every render).
  const ownerRef = useRef(owner)
  useEffect(() => { ownerRef.current = owner }, [owner])
  const onUpdateRef = useRef(onUpdate)
  useEffect(() => { onUpdateRef.current = onUpdate }, [onUpdate])

  // Derive linked-channel groups for the Channels tab. The channel-link graph
  // lives in the channel store (localStorage); group membership is its
  // transitive closure via the existing `linkedChannels` mechanism. Recomputed
  // when participants change, after a link (`linkVersion`), or when the
  // main-channel hint changes.
  useEffect(() => {
    let cancelled = false
    const channelStore = ownInstance()?.channelStore ?? null
    // Participant channels only. A replica is listed in the Replicas tab and
    // nowhere else, so it never enters the grouping that feeds this list —
    // which also means it can never be swallowed into a linked group by a stale
    // link record and drawn with participant markup.
    const paired = splitPairedChannels(owner.participants).participants

    async function computeGroups() {
      const pairedIds = new Set(paired.map(p => p.channelId))

      // Union-find over paired channels using each channel's link closure.
      const parent = new Map<string, string>()
      const find = (x: string): string => {
        const p = parent.get(x)
        if (p === undefined || p === x) {
          parent.set(x, x)
          return x
        }
        const root = find(p)
        parent.set(x, root)
        return root
      }
      const union = (a: string, b: string) => {
        const ra = find(a)
        const rb = find(b)
        if (ra !== rb) parent.set(rb, ra)
      }

      for (const p of paired) {
        find(p.channelId)
        let closure: string[] = [p.channelId]
        if (channelStore) {
          try {
            closure = await channelStore.linkedChannels(ownSecretIdRef.current, p.channelId)
          } catch {
            closure = [p.channelId]
          }
        }
        for (const c of closure) {
          if (pairedIds.has(c)) union(p.channelId, c)
        }
      }

      const byRoot = new Map<string, PairedParticipant[]>()
      for (const p of paired) {
        const r = find(p.channelId)
        const arr = byRoot.get(r) ?? []
        arr.push(p)
        byRoot.set(r, arr)
      }

      const mains = owner.mainChannels ?? []
      const groups: LinkGroup[] = []
      for (const members of byRoot.values()) {
        const channels = [...members].sort((a, b) =>
          a.channelId.localeCompare(b.channelId),
        )
        const mainCh =
          channels.find(m => mains.includes(m.channelId))?.channelId ??
          channels[0].channelId
        const name =
          channels.find(m => m.channelId === mainCh)?.name ?? channels[0].name
        groups.push({
          key: channels.map(m => m.channelId).join('|'),
          name,
          mainChannelId: mainCh,
          channels,
        })
      }
      groups.sort(
        (a, b) =>
          a.name.localeCompare(b.name) ||
          a.mainChannelId.localeCompare(b.mainChannelId),
      )

      if (!cancelled) setLinkGroups(groups)
    }

    void computeGroups()
    return () => {
      cancelled = true
    }
     
  }, [owner.participants, owner.mainChannels, linkVersion])

  useEffect(() => {
    const { ownerId, transport, participants } = owner

    const ns = `owner:${ownerId}`

    // The secret this node owns, allocated by the backend and published on
    // its actor record so peers can bind a helper-role instance to it.
    // Recovery re-pairs into the same secret namespace: the whole point is to
    // reconstruct *this* secret, and helpers still hold shares keyed by it.
    const ownSecretId = owner.ownSecretId
    ownSecretIdRef.current = ownSecretId

    const timeoutSecs = owner.config?.protocolTimeoutSecs ?? DEFAULT_PROTOCOL_TIMEOUT_SECS
    const unpairAck = owner.config?.unpairAck ?? 'required'

    instanceRef.current = buildProtocolInstance({
      namespace: ns,
      secretId: ownSecretId,
      ownTransportUri: transport.uri,
      communicationInfo: { name: owner.ownerName },
      threshold: owner.minParticipants,
      keepVersionsCount: 3,
      timeoutSecs,
      unpairAck,
      replicaId: getOrCreateReplicaId(owner.ownerId),
    })

    log({
      role: 'owner',
      flow: 'setup',
      step: 'protocol_init',
      description: `Protocol initialized for owner ${ownerId}`,
      payload: { ownerId, ownSecretId, participantCount: participants.length },
    })

    // In recovery mode Alice is not protecting secrets and doesn't need to be
    // discoverable by other owners, so skip the normal-mode setup below.
    {
      // The backend's disabled_participants set is in-memory and resets on restart;
      // re-apply any offline flags the FE has persisted.
      for (const h of participants) {
        if (h.offline) {
          apiToggleParticipantStatus(h.id, true).catch(() => {})
        }
      }

      async function postOwnerContact() {
        const instance = instanceRef.current
        if (!instance) return
        try {
          // Inline keys: the peer pairs directly against this contact.
          // HashedKeys/NoKeys need the PrePair round-trip, which this
          // signaling path does not carry.
          const contact = await withProtocolLock(() =>
            instance.protocol.createContact(null, ContactMode.InlineKeys),
          )
          ownerContactChannelRef.current = contact.channel_id.toString()

          await apiPostBrowserContact(ownerId, JSON.stringify(contactMessageToDto(contact)))
          log({
            role: 'owner',
            flow: 'pairing',
            step: 'owner_contact_posted',
            description: 'Contact published for peer discovery',
            payload: { ownerId, contactChannelId: ownerContactChannelRef.current },
          })
        } catch (err) {
          reportError('Failed to publish the contact for peer discovery', err, { ownerId })
        }
      }
      postOwnerContact()
    }

    return () => {
      instanceRef.current = null
      ownSecretIdRef.current = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner.ownerId])


  const didAutoPair = useRef(false)
  useEffect(() => {
    if (didAutoPair.current) return
    const count = owner.prePairedCount ?? 0
    if (count === 0) return
    didAutoPair.current = true

    // Chosen at random, not off the top of the roster: the participant pool is
    // shared, so taking the first N would hand every browser context the same
    // few and leave the rest idle.
    const participantsToAutoPair = selectAutoPairTargets(owner.participants, count)
    if (participantsToAutoPair.length === 0) return

    setAutoPairingIds(participantsToAutoPair.map(h => h.id))

    async function autoPair() {
      const protocol = ownInstance()?.protocol ?? null
      if (!protocol) return

      const newPairings: Array<{ channelId: bigint; participantId: string }> = []

      for (const participant of participantsToAutoPair) {
        try {
          const dto = await apiCreateActorContact(participant.id)
          const contact = dtoToContactMessage(dto)
          const channelId = await withProtocolLock(() =>
            protocol.start(FlowKind.Pairing, {
              kind: SenderKind.Owner,
              contact,
              peerCommunicationInfo: peerCommInfo(participant.name),
            }).then(pairingChannelIdFrom),
          )

          newPairings.push({ channelId, participantId: participant.id })

          log({
            role: 'owner',
            flow: 'pairing',
            step: 'auto_pair_initiated',
            description: `Auto-pair initiated for ${participant.name}`,
            payload: { participantId: participant.id, channelId: channelId.toString() },
          })
        } catch (err) {
          reportError(`Auto-pairing with "${participant.name}" failed`, err, {
            participantId: participant.id,
          })
        }
      }

      if (newPairings.length > 0) {
        const snapshot = ownerRef.current
        onUpdateRef.current({
          ...snapshot,
          prePairedCount: 0,
          pendingPairings: [
            ...snapshot.pendingPairings,
            ...newPairings.map(({ channelId, participantId }) => ({ channelId, participantId })),
          ],
        })
      }
    }

    autoPair()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner.ownerId])

  // Clear the auto-pair gate once all targeted participants have paired.
  useEffect(() => {
    if (autoPairingIds.length === 0) return
    const allPaired = autoPairingIds.every(id =>
      owner.participants.some(h => h.id === id && h.connectionStatus === 'paired'),
    )
    if (allPaired) setAutoPairingIds([])
  }, [autoPairingIds, owner.participants])

  /** Fold one protocol event into owner state. */
  function applyOwnerEvent(current: Owner, event: DeRecEvent): Owner {
    if (event.type === 'PairingCompleted' && event.channel_id) {
      return applyPairingCompleted(current, event, {
        log,
        getOwner: () => ownerRef.current,
        commit: next => onUpdateRef.current(next),
        // Both sides of a replica handshake get this event, so both raise the
        // comparison. Nothing here is destructive and nothing is committed by
        // opening it — it is a modal precisely because verification buried
        // behind a control is verification nobody performs.
        onReplicaChannelEstablished: channelId => {
          refreshReplicaRows()
          setFingerprintChannelId(channelId)
        },
      })
    }

    if (event.type === 'Unpaired' && event.channel_id) {
      const channelId = event.channel_id

      log({
        role: 'owner',
        flow: 'unpairing',
        step: 'unpaired',
        description: `Channel ${channelId} torn down (unpair flow complete)`,
        payload: { channelId },
      })

      // Drop every local trace of the channel: participants, held shares,
      // pending pairings, and the secret bag participant lists. The library
      // already removed channel-store and share-store entries via the trait
      // callbacks during accept().
      const participantHit = current.participants.find(p => p.channelId === channelId)

      let updated: Owner = {
        ...current,
        participants: current.participants.filter(p => p.channelId !== channelId),
        heldShares: (current.heldShares ?? []).filter(s => s.channelId !== channelId),
        pendingPairings: current.pendingPairings.filter(
          p => p.channelId.toString() !== channelId,
        ),
        mainChannels: (current.mainChannels ?? []).filter(c => c !== channelId),
      }

      if (updated.secretBag && participantHit) {
        updated = {
          ...updated,
          secretBag: updateBagVersion(
            updated.secretBag,
            updated.secretBag.currentVersion.version,
            v => ({
              ...v,
              participantIds: v.participantIds.filter(id => id !== participantHit.id),
              verifiedParticipantIds: v.verifiedParticipantIds.filter(
                id => id !== participantHit.id,
              ),
              failedParticipantIds: v.failedParticipantIds.filter(
                f => f.id !== participantHit.id,
              ),
            }),
          ),
        }
      }

      const peerName = participantHit?.name ?? 'Peer'
      reportInfo(`${peerName} unpaired (channel ${channelId})`)

      return updated
    }

    if (event.type === 'UnpairRejected' && event.channel_id) {
      const channelId = event.channel_id
      const peer = current.participants.find(p => p.channelId === channelId)

      log({
        role: 'owner',
        flow: 'unpairing',
        step: 'unpair_rejected',
        description: `Peer rejected unpair on channel ${channelId} (status ${event.status ?? '?'}): ${event.memo ?? ''}`,
        payload: { channelId, status: event.status, memo: event.memo },
      })

      reportError(
        `${peer?.name ?? 'Peer'} rejected unpair`,
        event.memo || `status ${event.status ?? '?'}`,
        { channelId, status: event.status, memo: event.memo },
      )

      return current
    }

    if (event.type === 'ShareStored' && event.channel_id) {
      const channelId = event.channel_id
      const version = event.version ?? 1
      const existing = current.heldShares ?? []
      const alreadyTracked = existing.some(s => s.channelId === channelId && s.version === version)
      if (!alreadyTracked) {
        return {
          ...current,
          heldShares: [...existing, { channelId, secretId: '', version, description: '' }],
        }
      }
      return current
    }

    if (event.type === 'ShareConfirmed' && event.channel_id) {
      const channelId = event.channel_id
      const version = event.version ?? 1
      const pending = pendingSharesRef.current.get(channelId)

      log({
        role: 'owner',
        flow: 'sharing',
        step: 'ShareConfirmed',
        description: `Share confirmed by participant on channel ${channelId}`,
        payload: { channelId, version },
      })

      if (!pending) return current

      const participant = current.participants.find(h => h.channelId === channelId)
      if (!participant) return current

      const shareRef: SecretShareRef = {
        version,
        status: 'confirmed',
        verified: false,
      }

      // Update the pending bag (not yet committed to owner state).
      if (pendingBagRef.current && pendingBagRef.current.version === version) {
        pendingBagRef.current = {
          ...pendingBagRef.current,
          bag: updateBagParticipant(pendingBagRef.current.bag, version, participant.id),
        }
      }

      return {
        ...current,
        participants: current.participants.map(h =>
          h.id === participant.id
            ? { ...h, secretShares: [...h.secretShares.filter(s => s.version !== version), shareRef] }
            : h,
        ),
      }
    }

    // This device, as a replica destination, received the full mirrored
    // secret from its source.
    //
    // Stash only — never adopt here. Wiping this device's vault and calling
    // `protocol.restore` is Task 11, gated on an explicit user confirmation
    // (adoption destroys whatever this device currently holds). This arm's
    // only job is to hold the payload where the adoption prompt can find it
    // and log that it arrived. `mergeReplicaSecretReceipt` keeps the newer of
    // what is already staged and what the mailbox just (re)delivered, so an
    // at-least-once replay of a stale round can never regress an already
    // staged, fresher offer back to an older one.
    // `ReplicaSecretInstalled` carries the identical payload and differs only in
    // being the *first* sync for a `secret_id` this device held nothing for.
    // Both stage the same offer: the library has written the mirror to its own
    // stores either way, but adopting it — wiping this device's vault and
    // calling `restore` — stays the user's explicit decision.
    if (
      (event.type === 'ReplicaSecretReceived' || event.type === 'ReplicaSecretInstalled') &&
      event.channel_id
    ) {
      const {
        channel_id: channelId,
        from_replica_id: fromReplicaId,
        secret_id: secretId,
        version,
        secret,
        shares,
      } = event

      setPendingReplicaAdoption(existing =>
        mergeReplicaSecretReceipt(existing, { channelId, fromReplicaId, secretId, version, secret, shares }),
      )

      log({
        role: 'owner',
        flow: 'sharing',
        step: event.type,
        description:
          event.type === 'ReplicaSecretInstalled'
            ? `First mirrored copy of secret ${secretId} (v${version}) installed from replica source ${fromReplicaId}`
            : `Mirrored secret v${version} received from replica source ${fromReplicaId} on channel ${channelId}`,
        payload: { channelId, fromReplicaId, secretId, version, shareCount: shares.length },
      })

      return current
    }

    // A replica destination acknowledged a mirrored secret.
    //
    // Handled entirely outside the participant roster, on purpose. The roster
    // row a replica channel now carries exists to be *shown* and to be refused
    // by `isShareTarget`; it holds no sync state, so routing an ack through it
    // would only invent a second place for that state to live. The channel id
    // on the ack is already the key replica-local state is organised by, so
    // nothing has to be looked up in the roster at all — the replica projection
    // picks the record up on its next refresh.
    if (event.type === 'ReplicaSecretAcked' && event.channel_id) {
      const { channel_id: channelId, version, status, memo } = event

      // `status` is the wire `StatusEnum`; 0 is Ok. Anything else means the
      // destination declined the mirror, so no sync is recorded — leaving the
      // replica visibly behind rather than falsely up to date.
      if (status !== 0) {
        log({
          role: 'owner',
          flow: 'sharing',
          step: 'ReplicaSecretRejected',
          description: `Replica on channel ${channelId} rejected the mirrored secret v${version} (status=${status}, memo=${memo})`,
          payload: { channelId, version, status, memo },
        })
        reportError(
          `A replica rejected the mirrored secret (v${version})`,
          memo || `status ${status}`,
          { channelId, version, status, memo },
        )
        return current
      }

      recordReplicaSync(current.ownerId, channelId, { version, syncedAt: Date.now() })

      log({
        role: 'owner',
        flow: 'sharing',
        step: 'ReplicaSecretAcked',
        description: `Replica on channel ${channelId} mirrored the secret (v${version})`,
        payload: { channelId, version, fromReplicaId: event.from_replica_id },
      })

      return current
    }

    if (event.type === 'ShareRejected' && event.channel_id) {
      const channelId = event.channel_id
      const version = event.version ?? 1
      const status = event.status ?? 0
      const memo = event.memo ?? ''

      log({
        role: 'owner',
        flow: 'sharing',
        step: 'ShareRejected',
        description: `Share rejected by participant on channel ${channelId} (status=${status}, memo=${memo})`,
        payload: { channelId, version, status, memo },
      })

      pendingSharesRef.current.delete(channelId)

      const participant = current.participants.find(h => h.channelId === channelId)
      if (!participant) return current

      const rejectedRef: SecretShareRef = {
        version,
        status: 'rejected',
        verified: false,
      }

      // Track the failure in the pending bag (not yet committed to owner state).
      if (pendingBagRef.current && pendingBagRef.current.version === version) {
        pendingBagRef.current = {
          ...pendingBagRef.current,
          bag: updateBagVersion(pendingBagRef.current.bag, version, v => ({
            ...v,
            failedParticipantIds: [
              ...(v.failedParticipantIds ?? []),
              { id: participant.id, status, memo },
            ],
          })),
        }
      }

      return {
        ...current,
        participants: current.participants.map(h =>
          h.id === participant.id
            ? { ...h, secretShares: [...h.secretShares.filter(s => s.version !== version), rejectedRef] }
            : h,
        ),
      }
    }

    if (event.type === 'SharingComplete') {
      // Round resolved by the protocol — cancel the flow watchdog.
      clearFlowWatchdog()
      const version = event.version ?? 1
      const confirmedCount = event.confirmed_count ?? 0
      const failedCount = event.failed_count ?? 0
      const thresholdMet = event.threshold_met ?? false

      log({
        role: 'owner',
        flow: 'sharing',
        step: 'SharingComplete',
        description: `Sharing round v${version} complete: ${confirmedCount} confirmed, ${failedCount} failed${thresholdMet ? '' : ' — threshold NOT met'}`,
        payload: { version, confirmedCount, failedCount, thresholdMet },
      })

      // Only *this* round's completion may consume the staged bag. Rounds are
      // keyed by version and several can be in flight at once — the
      // pair-completion hook and the promotion inside `verifyFingerprint` both
      // publish without the user asking — so clearing on any completion lets an
      // unrelated round discard a bag that is still waiting for its own, and
      // the secret is then never committed.
      const pending = pendingBagRef.current
      const isThisRound = pending !== null && pending.version === version
      if (isThisRound) pendingBagRef.current = null

      // The share store now derives `latestVersion` from the versions it
      // actually holds — the owner persists its own committed shares — so
      // there is no separate counter to advance or roll back here.
      if (thresholdMet && isThisRound) {
        return {
          ...current,
          secretBag: pending.bag,
        }
      }

      return current
    }

    if (event.type === 'ShareVerified' && event.channel_id) {
      const channelId = event.channel_id
      const version = event.version ?? 1
      const pending = pendingVerificationsRef.current.get(channelId)

      log({
        role: 'owner',
        flow: 'verification',
        step: 'ShareVerified',
        description: `Share verified for channel ${channelId}`,
        payload: { channelId, version },
      })

      if (!pending) return current

      const participant = current.participants.find(h => h.channelId === channelId)
      if (!participant) return current

      const bag = current.secretBag
      const updatedBag = bag ? updateBagVerified(bag, version, participant.id) : null

      return {
        ...current,
        participants: current.participants.map(h =>
          h.id === participant.id
            ? {
                ...h,
                secretShares: h.secretShares.map(s =>
                  s.version === version ? { ...s, verified: true } : s,
                ),
              }
            : h,
        ),
        secretBag: updatedBag,
      }
    }

    if (event.type === 'SecretsDiscovered' && event.channel_id && event.secrets) {
      const channelId = event.channel_id
      const participant = current.participants.find(
        h => h.channelId === channelId
      )
      if (!participant) return current

      const discoveredVersions = event.secrets.flatMap(s => {
        const secretId = String(s.secret_id)
        return s.versions.map(v => ({
          secretId,
          version: v.version,
          description: v.description,
        }))
      })

      // Always mark discovery complete on response — including the empty case.
      // An empty response means the helper genuinely holds no shares for this
      // owner (e.g. a freshly-paired helper that was never used before). It is
      // *not* a race: Discovery is fired only after the poll loop sees
      // `PairingCompleted`, which means the helper's pair handler had already
      // run to completion before her discovery handler did. Leaving the
      // participant at `discoveryComplete=false` here would make the recovery
      // retry loop fan out Discovery every 3 s forever.
      log({
        role: 'owner',
        flow: 'recovery',
        step: 'SecretsDiscovered',
        description: discoveredVersions.length === 0
          ? `Discovery complete from ${participant.name} — helper holds no shares for this owner`
          : `Discovered ${discoveredVersions.length} version(s) from ${participant.name}`,
        payload: { channelId, versions: discoveredVersions },
      })

      return {
        ...current,
        participants: current.participants.map(h =>
          h.id === participant.id
            ? { ...h, discoveryComplete: true, discoveredVersions }
            : h,
        ),
      }
    }

    if (event.type === 'RecoveryShareReceived') {
      const progress = current.recoveryProgress
      if (!progress) return current

      const sharesReceived = event.shares_received ?? progress.sharesReceived

      // The library emits RecoveryShareReceived (not RecoveryShareError) when
      // InsufficientShares — it keeps the bucket open waiting for more shares.
      // The frontend must detect when all requested responses are in and
      // reconstruction still failed, then surface the error itself.
      const allResponsesIn = sharesReceived >= progress.totalRequested
      const error = allResponsesIn
        ? 'Not enough shares to reconstruct the secret. Pair with more helpers and try again.'
        : null

      log({
        role: 'owner',
        flow: 'recovery',
        step: 'RecoveryShareReceived',
        description: `Share received (${sharesReceived}/${progress.totalRequested})${allResponsesIn ? ' — insufficient, giving up' : ''}`,
        payload: { channelId: event.channel_id, sharesReceived, totalRequested: progress.totalRequested },
      })

      // Once the attempt has reached a terminal "insufficient" state, persist
      // it on the per-version failure list so it survives subsequent Recover
      // clicks on other versions.
      const failures = error
        ? upsertRecoveryFailure(current.recoveryFailures, progress.secretId, progress.version, error)
        : current.recoveryFailures

      return {
        ...current,
        recoveryProgress: { ...progress, sharesReceived, error },
        recoveryFailures: failures,
      }
    }

    if (event.type === 'RecoveryShareError') {
      log({
        role: 'owner',
        flow: 'recovery',
        step: 'RecoveryShareError',
        description: `Recovery share error: ${event.error}`,
        payload: { channelId: event.channel_id, sharesReceived: event.shares_received, error: event.error },
      })

      const progress = current.recoveryProgress
      if (!progress) return current

      const message = event.error ?? 'Unknown recovery error'
      return {
        ...current,
        recoveryProgress: {
          ...progress,
          sharesReceived: event.shares_received ?? progress.sharesReceived,
          error: message,
        },
        recoveryFailures: upsertRecoveryFailure(
          current.recoveryFailures,
          progress.secretId,
          progress.version,
          message,
        ),
      }
    }

    if (event.type === 'SecretRecovered' && event.secret) {
      const pending = pendingRecoveryRef.current
      // The library now performs the two-stage DeRecSecret -> Secret decode
      // itself and hands over a typed snapshot, so there is no app-side bag
      // parsing left — only encoding it for localStorage.
      const snapshot = snapshotFromEvent(event.secret)

      log({
        role: 'owner',
        flow: 'recovery',
        step: 'SecretRecovered',
        description: `Secret recovered: ${pending?.label ?? 'unknown'}`,
        payload: {
          secretId: pending?.secretId,
          version: pending?.version,
          helperCount: snapshot.helpers.length,
          secretCount: snapshot.secrets.length,
          replicaCount: snapshot.replicas?.members.length ?? 0,
        },
      })

      if (!pending) return current

      pendingRecoveryRef.current = null

      return {
        ...current,
        recoveryProgress: null,
        recoveryFailures: removeRecoveryFailure(
          current.recoveryFailures,
          pending.secretId,
          pending.version,
        ),
        recoveredSecrets: [
          ...(current.recoveredSecrets ?? []),
          {
            secretId: pending.secretId,
            version: pending.version,
            label: pending.label,
            snapshot,
          },
        ],
      }
    }

    // ── Channel info updates ─────────────────────────────────────────────
    // Emitted on both sides of `start(UpdateChannelInfo)` — the initiator sees
    // its own update echo back once the peer accepts.
    if (event.type === 'ChannelInfoUpdated') {
      log({
        role: 'owner',
        flow: 'pairing',
        step: 'ChannelInfoUpdated',
        description: `Channel ${event.channel_id} accepted the endpoint/info update`,
        payload: { channelId: event.channel_id },
      })
      return current
    }

    if (event.type === 'ChannelInfoUpdateRejected') {
      log({
        role: 'owner',
        flow: 'pairing',
        step: 'ChannelInfoUpdateRejected',
        description: `Channel ${event.channel_id} rejected the endpoint update: ${event.memo}`,
        payload: { channelId: event.channel_id, status: event.status, memo: event.memo },
      })
      reportError('A peer rejected the channel endpoint update', event.memo, {
        channelId: event.channel_id,
      })
      return current
    }

    if (event.type === 'PrePairRejected') {
      reportError('A peer refused the pre-pair key exchange', event.memo, {
        channelId: event.channel_id,
      })
      return current
    }

    // ── Flow dispatch outcomes ───────────────────────────────────────────
    // `start()` reports per-target dispatch results. The `*Started` variants
    // are real progress, so they refresh the watchdog rather than letting it
    // time out a flow that is in fact advancing; the `*Failed` variants name
    // the channel that could not be reached instead of failing silently.
    if (
      event.type === 'PairingStarted' ||
      event.type === 'DiscoveryStarted' ||
      event.type === 'ProtectSecretStarted' ||
      event.type === 'VerifySharesStarted' ||
      event.type === 'RecoverSecretStarted' ||
      event.type === 'UnpairStarted' ||
      event.type === 'UpdateChannelInfoStarted'
    ) {
      // A dispatch confirms the flow is moving; restart the wall-clock budget.
      if (protocolBusyRef.current) armFlowWatchdog()
      return current
    }

    if (
      event.type === 'DiscoveryFailed' ||
      event.type === 'ProtectSecretFailed' ||
      event.type === 'VerifySharesFailed' ||
      event.type === 'RecoverSecretFailed' ||
      event.type === 'UpdateChannelInfoFailed'
    ) {
      log({
        role: 'owner',
        flow: 'protocol',
        step: event.type,
        description: `${event.type} on channel ${event.channel_id}: ${event.error}`,
        payload: { channelId: event.channel_id, error: event.error },
      })
      reportError(`A protocol request could not be dispatched (${event.type})`, event.error, {
        channelId: event.channel_id,
      })
      return current
    }

    if (event.type === 'UnpairFailed') {
      // A teardown the peer never received. `restore` emits these for
      // recovery channels whose helper has gone away — local state is dropped
      // regardless, so this is informational, not a failure to act on.
      log({
        role: 'owner',
        flow: 'unpairing',
        step: 'UnpairFailed',
        description: `Unpair could not be delivered on channel ${event.channel_id} — local state dropped anyway`,
        payload: { channelId: event.channel_id, error: event.error },
      })
      return current
    }

    // The library processed a message and deliberately did nothing with it.
    // Worth surfacing rather than ignoring: this is what a channel still
    // awaiting its out-of-band fingerprint does with everything sent to it, so
    // it is the one visible symptom of "my NoKeys or replica channel is
    // silently swallowing traffic" — a question that is otherwise very hard to
    // answer from the outside.
    if (event.type === 'NoOp') {
      log({
        role: 'owner',
        flow: 'protocol',
        step: 'NoOp',
        description:
          'A message was processed with no effect — usually a channel still pending fingerprint confirmation',
        payload: {},
      })
      return current
    }

    if (event.type === 'AutoAccepted') {
      log({
        role: 'owner',
        flow: 'protocol',
        step: 'AutoAccepted',
        description: `Auto-accepted an inbound ${event.action_kind} on channel ${event.channel_id}`,
        payload: { channelId: event.channel_id, actionKind: event.action_kind },
      })
      return current
    }

    // ── Replica group membership ────────────────────────────────────────────

    // Fires alongside `PairingCompleted` on a replica handshake, and is the only
    // announcement of the peer's replica id — which `RemoveReplica` needs, since
    // every member answers on the one group channel and so the channel cannot
    // say who is being evicted.
    if (event.type === 'ReplicaPaired' && event.channel_id) {
      recordPeerReplicaId(current.ownerId, event.channel_id, event.peer_replica_id)
      log({
        role: 'owner',
        flow: 'pairing',
        step: 'ReplicaPaired',
        description: `Replica channel ${event.channel_id} belongs to replica ${event.peer_replica_id}`,
        payload: { channelId: event.channel_id, peerReplicaId: event.peer_replica_id },
      })
      refreshReplicaRows()
      return current
    }

    // A member refused a sync. Keyed by `replica_id`, not `channel_id`: every
    // member answers on the one group channel, so the channel cannot say who
    // this was.
    if (event.type === 'ReplicaSyncRejected') {
      const conflict = event.status === VERSION_CONFLICT_STATUS
      reportError(
        conflict
          ? `Replica ${event.replica_id} already holds a different v${event.version}. Re-publish at a new version.`
          : `Replica ${event.replica_id} refused the sync of v${event.version}: ${event.memo}`,
        undefined,
        { replicaId: event.replica_id, version: event.version, status: event.status },
      )
      log({
        role: 'owner',
        flow: 'sharing',
        step: 'ReplicaSyncRejected',
        description: `Replica ${event.replica_id} rejected v${event.version} (status ${event.status})`,
        payload: {
          replicaId: event.replica_id,
          secretId: event.secret_id,
          version: event.version,
          status: event.status,
          memo: event.memo,
          versionConflict: conflict,
        },
      })
      return current
    }

    // Distinct from a rejection: the member never got the message at all.
    if (event.type === 'ReplicaSyncFailed') {
      log({
        role: 'owner',
        flow: 'sharing',
        step: 'ReplicaSyncFailed',
        description: `Could not deliver v${event.version} to replica ${event.replica_id}: ${event.reason}`,
        payload: { replicaId: event.replica_id, version: event.version, reason: event.reason },
      })
      return current
    }

    // Per-round report of who acknowledged and who did not. The library keeps
    // no durable per-member sync state, so this list is the only retry hook
    // there is — surfaced rather than acted on, since replicas are best-effort
    // and a member being behind does not fail the round.
    if (event.type === 'ReplicaSyncComplete') {
      log({
        role: 'owner',
        flow: 'sharing',
        step: 'ReplicaSyncComplete',
        description:
          event.behind.length === 0
            ? `Every replica is current at v${event.version}`
            : `v${event.version}: ${event.synced.length} synced, ${event.behind.length} behind`,
        payload: { version: event.version, synced: event.synced, behind: event.behind },
      })
      return current
    }

    if (event.type === 'SyncCheckComplete') {
      const caughtUp = event.fetched_from !== undefined
      log({
        role: 'owner',
        flow: 'sharing',
        step: 'SyncCheckComplete',
        description: caughtUp
          ? `Caught up from v${event.local_version} to v${event.group_version} via replica ${event.fetched_from}`
          : `Already current at v${event.local_version}`,
        payload: {
          localVersion: event.local_version,
          groupVersion: event.group_version,
          fetchedFrom: event.fetched_from ?? null,
        },
      })
      if (caughtUp) reportInfo(`Caught up to v${event.group_version} from the replica group`)
      return current
    }

    if (event.type === 'ReplicaRemoved') {
      log({
        role: 'owner',
        flow: 'unpairing',
        step: 'ReplicaRemoved',
        description: `Replica ${event.replica_id} left the group`,
        payload: { replicaId: event.replica_id },
      })
      refreshReplicaRows()
      return current
    }

    // Source succession. The library promotes the first eligible entry of
    // `listReplicas` when the source leaves; this only reports the outcome.
    if (event.type === 'ReplicaSourceChanged') {
      log({
        role: 'owner',
        flow: 'unpairing',
        step: 'ReplicaSourceChanged',
        description: `Replica ${event.replica_id} is now the group's source`,
        payload: { replicaId: event.replica_id },
      })
      reportInfo(`Replica ${event.replica_id} is now the source for this group`)
      refreshReplicaRows()
      return current
    }

    // This device was evicted and has torn down its own `secret_id` partition —
    // group channel, helper channels, shares, secrets and snapshot are gone.
    // Fires only after it was told to leave *and* saw a roster excluding it;
    // absence alone never destroys a copy.
    if (event.type === 'SelfRemovedFromGroup') {
      log({
        role: 'owner',
        flow: 'unpairing',
        step: 'SelfRemovedFromGroup',
        description: `This device was removed from the replica group at v${event.version} — local state for this secret is gone`,
        payload: { version: event.version },
      })
      reportError(
        'This device was removed from its replica group. Everything it held for that secret has been erased.',
      )
      refreshReplicaRows()
      return {
        ...current,
        secretBag: null,
        heldShares: [],
        participants: current.participants.filter(p => !isReplicaChannel(p)),
      }
    }

    return current
  }

  // Poll faster (500ms) during auto-pair so the setup gate clears quickly.

  const pollInterval = (autoPairingIds.length > 0 || protocolBusy) ? 500 : 5000

  useEffect(() => {
    let ownerPollRunning = false
    const id = setInterval(async () => {
      if (ownerPollRunning) return
      // A failed adoption erased the namespace this instance reads from, so
      // every message processed after it would run against empty stores.
      // Stop polling outright rather than draining the (destructive) mailbox
      // into a vault that no longer exists.
      if (adoptionBlockRef.current) return
      // Skip processing while a confirmation modal is open. New messages
      // arriving in this window are stashed in `pendingInboundRef` by the
      // event handler so they're processed (in order) once the user
      // resolves the modal — the destructive mailbox poll must not drain
      // them in the meantime.
      if (
        pendingPairingConfirmationRef.current ||
        pendingStoreShareConfirmationRef.current ||
        pendingVerifyShareConfirmationRef.current ||
        pendingUnpairConfirmationRef.current
      ) return
      ownerPollRunning = true
      try {
        const { ownerId } = ownerRef.current
        const protocol = ownInstance()?.protocol ?? null
        if (!protocol) return

        let messages
        try {
          messages = await pollMailbox('owners', ownerId)
        } catch (err) {
          reportError('Mailbox poll failed', err, { ownerId })
          return
        }

        // Replay any messages drained on a previous tick but held back behind a
        // confirmation modal (the backend mailbox is destructive — a poll drains
        // it, so unprocessed messages must be buffered, never dropped). Buffered
        // (older) messages are processed before freshly polled ones.
        if (pendingInboundRef.current.length > 0) {
          messages = [...pendingInboundRef.current, ...messages]
          pendingInboundRef.current = []
        }

        if (messages.length === 0) return

        await withProtocolLock(async () => {
          const initial = ownerRef.current
          let updated = initial
          let shouldBreak = false

          for (let mi = 0; mi < messages!.length; mi++) {
            const { bytes } = messages![mi]
            if (shouldBreak) break

            const instance = ownInstance()
            if (!instance) continue
            const protocol = instance.protocol

            let events: DeRecEvent[]
            try {
              events = Array.from(await protocol.process(bytes))
            } catch (err) {
              const nonOk = asNonOkStatus(err)
              if (nonOk) {
                console.log('[derec] process() non-OK status', { messageBytes: bytes.length, status: nonOk.status, memo: nonOk.memo, channelId: nonOk.channelId })
                log({
                  role: 'owner',
                  flow: 'protocol',
                  step: 'non_ok_status',
                  description: `Counterparty responded with status ${nonOk.status}: ${nonOk.memo}`,
                  payload: { status: nonOk.status, memo: nonOk.memo, channelId: nonOk.channelId },
                })

                // Sharing rejections are now emitted as ShareRejected events (not errors),
                // so any NonOkStatus error here is a pairing or other flow rejection.
                setPairingRejectionCount(c => c + 1)
              } else if (isUnknownChannelError(err)) {
                // Expected, not a fault: mailboxes are store-and-forward, so a
                // peer still holding a channel this device has dropped (a
                // retired recovery channel, an unpair that crossed in flight)
                // can always deliver one more message. Nothing here is
                // actionable, so it stays out of the error surface.
                log({
                  role: 'owner',
                  flow: 'protocol',
                  step: 'unknown_channel_ignored',
                  description: `Ignored a message on unknown channel ${unknownChannelId(err) ?? '(unreported)'} — the sender still holds a channel this device has dropped`,
                  payload: { channelId: unknownChannelId(err), messageBytes: bytes.length },
                })
              } else {
                reportError('Failed to process an incoming message', err, { messageBytes: bytes.length })
              }
              continue
            }

            for (const event of events) {
              // Handle ActionRequired events: pairing needs user confirmation,
              // all other action kinds are auto-accepted for now.
              if (event.type === 'ActionRequired' && event.action) {
                if (event.action_kind === 'Pairing') {
                  // Alice always initiates pairing with provisioned actors, so any
                  // ActionRequired(Pairing) here is from a browser peer (another owner)
                  // who initiated WITH Alice — show user confirmation.
                  //
                  // Which confirmation depends on the kind the initiator declared:
                  // a replica pairing is not a participant pairing, cannot be
                  // linked, and — on the destination side — commits this device's
                  // vault. `classifyInboundPairing` resolves that; it touches
                  // nothing.
                  const channelId = event.channel_id!
                  const peerName = event.peer_communication_info?.name || 'Unknown peer'
                  const confirmation = classifyInboundPairing(
                    { peerName, channelId, action: event.action },
                    event.sender_kind,
                  )
                  setPendingPairingConfirmation(confirmation)

                  log({
                    role: 'owner',
                    flow: 'pairing',
                    step: confirmation.replica
                      ? 'replica_pairing_confirmation_pending'
                      : 'pairing_confirmation_pending',
                    description: confirmation.replica
                      ? `Replica pairing request from "${peerName}" — this device would be the ${confirmation.replica.localRole} — waiting for user confirmation`
                      : `Pairing request from "${peerName}" — waiting for user confirmation`,
                    payload: {
                      channelId,
                      senderKind: event.sender_kind,
                      localRole: confirmation.replica?.localRole ?? null,
                    },
                  })

                  // Hold back the remaining drained messages so they aren't
                  // lost (mailbox is destructive); they replay once this
                  // confirmation is resolved.
                  pendingInboundRef.current = messages!.slice(mi + 1)
                  shouldBreak = true
                  break
                } else if (event.action_kind === 'StoreShare') {
                  // Browser-based user must confirm before storing a share.
                  const channelId = event.channel_id!
                  const peer = updated.participants.find(h => h.channelId === channelId)
                  const peerName = peer?.name || 'Unknown peer'

                  setPendingStoreShareConfirmation({
                    peerName,
                    channelId,
                    secretId: event.share_secret_id ?? '0',
                    version: event.version ?? 0,
                    description: event.share_description || '',
                    action: event.action,
                  })

                  log({
                    role: 'owner',
                    flow: 'sharing',
                    step: 'store_share_confirmation_pending',
                    description: `Share storage request from "${peerName}" — waiting for confirmation`,
                    payload: { channelId, version: event.version },
                  })

                  // Hold back the remaining drained messages so they aren't
                  // lost (mailbox is destructive); they replay once this
                  // confirmation is resolved.
                  pendingInboundRef.current = messages!.slice(mi + 1)
                  shouldBreak = true
                  break
                } else if (event.action_kind === 'VerifyShare') {
                  // Browser-based user must confirm before responding to verification.
                  const channelId = event.channel_id!
                  const peer = updated.participants.find(h => h.channelId === channelId)
                  const peerName = peer?.name || 'Unknown peer'

                  setPendingVerifyShareConfirmation({
                    peerName,
                    channelId,
                    version: event.version ?? 0,
                    secretId: event.share_secret_id ?? '0',
                    action: event.action,
                  })

                  log({
                    role: 'owner',
                    flow: 'verification',
                    step: 'verify_share_confirmation_pending',
                    description: `Verification request from "${peerName}" — waiting for confirmation`,
                    payload: { channelId, version: event.version },
                  })

                  // Hold back the remaining drained messages so they aren't
                  // lost (mailbox is destructive); they replay once this
                  // confirmation is resolved.
                  pendingInboundRef.current = messages!.slice(mi + 1)
                  shouldBreak = true
                  break
                } else if (event.action_kind === 'Unpair') {
                  // Peer-initiated unpair. This owner's FE config decides
                  // by the backend on join) decides whether to auto-accept or
                  // surface a modal so the operator can visually verify the
                  // flow before letting it complete.
                  //
                  // The fallback when the value is missing is **show modal**
                  // (the safer side): we'd rather make the user click than
                  // silently tear down a channel because a persisted owner
                  // hasn't yet caught up with the backend's config.
                  const channelId = event.channel_id!
                  const peer = updated.participants.find(h => h.channelId === channelId)
                  const peerName = peer?.name || 'Unknown peer'
                  const autoAccept = updated.config?.autoAcceptUnpairRequests ?? false

                  log({
                    role: 'owner',
                    flow: 'unpairing',
                    step: 'unpair_action_required',
                    description: `Incoming Unpair from "${peerName}" — ${autoAccept ? 'auto-accepting' : 'showing modal'}`,
                    payload: {
                      channelId,
                      autoAcceptUnpairRequests: updated.config?.autoAcceptUnpairRequests ?? null,
                    },
                  })

                  if (autoAccept) {
                    try {
                      const acceptEvents = Array.from(await protocol.accept(event.action)) as typeof events
                      for (const e of acceptEvents) {
                        updated = applyOwnerEvent(updated, e)
                      }
                    } catch (err) {
                      reportError('Failed to auto-accept incoming unpair request', err, {
                        channelId,
                      })
                    }
                  } else {
                    setPendingUnpairConfirmation({
                      peerName,
                      channelId,
                      action: event.action,
                    })

                    log({
                      role: 'owner',
                      flow: 'unpairing',
                      step: 'unpair_confirmation_pending',
                      description: `Unpair request from "${peerName}" — waiting for confirmation`,
                      payload: { channelId },
                    })

                    pendingInboundRef.current = messages!.slice(mi + 1)
                    shouldBreak = true
                    break
                  }
                  continue
                } else {
                  // Auto-accept remaining requests (Discovery, GetShare).
                  try {
                    const acceptEvents = Array.from(await protocol.accept(event.action)) as typeof events
                    for (const e of acceptEvents) {
                      updated = applyOwnerEvent(updated, e)
                    }
                  } catch (err) {
                    reportError(`Failed to auto-accept ${event.action_kind ?? 'a protocol'} request`, err, { channelId: event.channel_id })
                  }
                }
                continue
              }

              try {
                updated = applyOwnerEvent(updated, event)
              } catch (err) {
                // Not every event variant carries a channel (SharingComplete,
                // NoOp), so read it defensively for the error context.
                reportError(`Failed to handle a ${event.type} event`, err, {
                  channelId: 'channel_id' in event ? event.channel_id : undefined,
                })
              }

              // Signal any waiting PairInitiatorModal that a pairing completed.
              // This is the fallback path for recovery pairings where protocol.start()
              // returns a different channel ID than PairingCompleted.channel_id.
              if (event.type === 'PairingCompleted') {
                setPairingCompletedSignal(c => c + 1)
                // A `NoKeys` handshake completes into `Pending`, not `Paired`.
                maybeRaiseFingerprintGate(event.channel_id, updated)
              }

              // Terminal events for the discovery/recovery owner flows: the
              // expected responses arrived, so the flow is resolved — drop the
              // busy state (which clears the generic flow watchdog).
              if (
                event.type === 'SecretsDiscovered' ||
                event.type === 'SecretRecovered' ||
                event.type === 'RecoveryShareError'
              ) {
                setProtocolBusy(false)
              }

              // Outgoing-unpair terminal events: the channel either went
              // through (Unpaired) or the peer refused (UnpairRejected) —
              // either way the in-flight marker is no longer accurate and
              // the confirmation modal (if open) can close.
              if (
                (event.type === 'Unpaired' || event.type === 'UnpairRejected') &&
                event.channel_id
              ) {
                const cid = event.channel_id
                setUnpairingChannelIds(prev => {
                  if (!prev.has(cid)) return prev
                  const next = new Set(prev)
                  next.delete(cid)
                  return next
                })
                setOutgoingUnpairConfirmation(cur =>
                  cur?.channelId === cid ? null : cur,
                )
              }

            }
          }

          if (updated !== initial) {
            ownerRef.current = updated
            onUpdateRef.current(updated)
          }

          // Inbound progress while a flow is in flight resets the watchdog
          // deadline, so a slow-but-progressing multi-helper round isn't
          // false-killed; a fully stalled flow still times out.
          if (protocolBusyRef.current && messages!.length > 0) {
            armFlowWatchdog()
          }
        })
      } catch (err) {
        reportError('Polling loop error', err)
      } finally {
        ownerPollRunning = false
      }
    }, pollInterval)

    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner.ownerId, pollInterval])

  // Advance time-driven state. The mailbox poll only moves protocol time
  // forward when a message actually arrives, so a round whose peers all go
  // quiet — the common case for a helper that closed its tab — would otherwise
  // stay open forever. Shares `withProtocolLock` with the poll because `tick`
  // mutates the same round state `process` does.
  useEffect(() => {
    let tickRunning = false

    const id = setInterval(async () => {
      if (tickRunning || adoptionBlockRef.current) return
      // Same modal gate as the poll: applying timeout events underneath an open
      // confirmation would mutate state the user is being asked about.
      if (
        pendingPairingConfirmationRef.current ||
        pendingStoreShareConfirmationRef.current ||
        pendingVerifyShareConfirmationRef.current ||
        pendingUnpairConfirmationRef.current
      ) return

      tickRunning = true
      try {
        await withProtocolLock(async () => {
          const protocol = ownInstance()?.protocol
          if (!protocol) return

          const events = Array.from(await protocol.tick())
          // Stands in for the library's automatic sweep, which is disabled so
          // a human-paced fingerprint comparison is not deleted mid-flow.
          const swept = await protocol.removeExpiredChannels(PENDING_CHANNEL_TTL_SECS)

          if (swept.length > 0) {
            log({
              role: 'owner',
              flow: 'pairing',
              step: 'pending_channels_swept',
              description: `Removed ${swept.length} pending channel(s) never confirmed out of band`,
              payload: { channelIds: swept },
            })
          }

          if (events.length === 0) return

          const initial = ownerRef.current
          let updated = initial
          for (const event of events) {
            try {
              updated = applyOwnerEvent(updated, event)
            } catch (err) {
              reportError(`Failed to handle a ${event.type} event from tick`, err)
            }
          }
          if (updated !== initial) {
            ownerRef.current = updated
            onUpdateRef.current(updated)
          }
        })
      } catch (err) {
        reportError('Protocol tick failed', err)
      } finally {
        tickRunning = false
      }
    }, TICK_INTERVAL_MS)

    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner.ownerId])

  async function handleAcceptPairing() {
    const confirmation = pendingPairingConfirmation
    if (!confirmation) return

    const instance = ownInstance()
    const protocol = instance?.protocol ?? null
    if (!protocol || !instance) return

    try {
      const events = await withProtocolLock(() => protocol.accept(confirmation.action))
      const eventArray = Array.from(events)

      let updated = ownerRef.current
      let pairedChannelId: string | null = null
      for (const event of eventArray) {
        try {
          updated = applyOwnerEvent(updated, event)
        } catch (err) {
          reportError(`Failed to handle a ${event.type} event`, err)
        }
        if (event.type === 'PairingCompleted') pairedChannelId = event.channel_id
      }
      if (pairedChannelId !== null) {
        // No discovery is fired here. A helper can only answer once it has
        // linked this channel to an owner it already helps, which happens on
        // its side and out of band — so discovery is driven explicitly from
        // the Recovery tab once that has happened.
        setPairingCompletedSignal(c => c + 1)
        // Accepting a `NoKeys` request leaves the channel `Pending` on this
        // side too — the responder has to compare codes just as the initiator
        // does, and until it does, nothing sent here is processed.
        maybeRaiseFingerprintGate(pairedChannelId, updated)
      }

      if (updated !== ownerRef.current) {
        ownerRef.current = updated
        onUpdateRef.current(updated)
      }
    } catch (err) {
      reportError('Failed to accept pairing request', err, { channelId: confirmation.channelId })
    }

    log({
      role: 'owner',
      flow: 'pairing',
      step: 'pairing_confirmed',
      description: `Accepted pairing request from "${confirmation.peerName}"`,
      payload: { channelId: confirmation.channelId },
    })

    setPendingPairingConfirmation(null)
  }

  async function handleRejectPairing() {
    const confirmation = pendingPairingConfirmation
    if (!confirmation) return

    const instance = ownInstance()
    const protocol = instance?.protocol ?? null
    if (!protocol || !instance) return

    try {
      await withProtocolLock(() => protocol.reject(confirmation.action, /* REJECTED */ 10, 'Pairing request rejected by user'))

      log({
        role: 'owner',
        flow: 'pairing',
        step: 'pairing_rejected',
        description: `Rejected pairing request from "${confirmation.peerName}"`,
        payload: { channelId: confirmation.channelId },
      })
    } catch (err) {
      reportError('Failed to reject pairing request', err, { channelId: confirmation.channelId })
    }

    setPendingPairingConfirmation(null)
  }

  /**
   * Atomic "accept pairing + link to existing channel" — User authentication
   * method. The pairing response is sent only after the user picks a target
   * channel and confirms. If accept succeeds, the new channel is linked into
   * the target's group so subsequent flows (notably recovery discovery on the
   * requester's side) can transitively reach prior shares held under sibling
   * channels of this peer.
   */
  async function handleAcceptAndLinkPairing(targetChannelId: string) {
    const confirmation = pendingPairingConfirmation
    if (!confirmation) return

    const instance = ownInstance()
    const protocol = instance?.protocol ?? null
    if (!protocol || !instance) return

    setPairingLinkSubmitting(true)
    try {
      // Accept first: this sends the pairing response to the requester and
      // marks the channel as paired on this side.
      const events = await withProtocolLock(() => protocol.accept(confirmation.action))
      const eventArray = Array.from(events)

      let updated = ownerRef.current
      let pairingCompleted = false
      // Accepting rotates the handshake off the transient pairing id that the
      // ActionRequired event (and `confirmation.channelId`) carries: the
      // library saves the channel under a fresh long-term id and deletes the
      // transient one. Linking the transient id would record an edge to a
      // channel that no longer exists, so take the id off the completion event.
      let pairedChannelId: string | null = null
      for (const event of eventArray) {
        try {
          updated = applyOwnerEvent(updated, event)
        } catch (err) {
          reportError(`Failed to handle a ${event.type} event`, err)
        }
        if (event.type === 'PairingCompleted') {
          pairingCompleted = true
          pairedChannelId = event.channel_id ?? null
        }
      }
      if (pairingCompleted) setPairingCompletedSignal(c => c + 1)

      if (updated !== ownerRef.current) {
        ownerRef.current = updated
        onUpdateRef.current(updated)
      }

      // Link only after accept succeeds. The requester's auto-discovery (in
      // recovery mode) will be sent on the new channel; by the time it reaches
      // this side, `linked_channels` already includes the target's closure, so
      // the discovery response aggregates shares from sibling channels.
      if (!pairedChannelId) {
        reportError(
          'Pairing accepted but no channel to link',
          new Error('accept() returned no PairingCompleted event'),
          { pairingChannelId: confirmation.channelId, linkTo: targetChannelId },
        )
      } else {
        try {
          // The target is the established side of this peer, so it keeps the
          // group's name — the channel just paired is only known by whatever
          // the requester declared on the wire.
          await linkChannelsAtomic(pairedChannelId, targetChannelId, { mainChannelId: targetChannelId })
        } catch (err) {
          // Pairing succeeded; surface link failure but don't tear down pairing.
          reportError(
            'Pairing accepted but linking failed',
            err,
            { channelId: pairedChannelId, linkTo: targetChannelId },
          )
        }
      }

      log({
        role: 'owner',
        flow: 'pairing',
        step: 'pairing_confirmed_and_linked',
        description: `Accepted pairing from "${confirmation.peerName}" and linked to channel ${targetChannelId}`,
        payload: {
          pairingChannelId: confirmation.channelId,
          channelId: pairedChannelId,
          linkedTo: targetChannelId,
        },
      })
    } catch (err) {
      reportError('Failed to accept pairing for link', err, { channelId: confirmation.channelId })
    } finally {
      setPairingLinkSubmitting(false)
    }

    setPendingPairingConfirmation(null)
  }

  async function handleAcceptStoreShare() {
    const confirmation = pendingStoreShareConfirmation
    if (!confirmation) return

    const instance = ownInstance()
    const protocol = instance?.protocol ?? null
    if (!protocol || !instance) return

    try {
      const events = await withProtocolLock(() => protocol.accept(confirmation.action))
      const eventArray = Array.from(events)

      // Record the held share with full metadata BEFORE applying events.
      // applyOwnerEvent's ShareStored handler will see it's already tracked and skip
      // its entry (which lacks secretId/description).
      let updated: Owner = {
        ...ownerRef.current,
        heldShares: [...(ownerRef.current.heldShares ?? []), {
          channelId: confirmation.channelId,
          secretId: confirmation.secretId,
          version: confirmation.version,
          description: confirmation.description,
        }],
      }

      for (const event of eventArray) {
        try {
          updated = applyOwnerEvent(updated, event)
        } catch (err) {
          reportError(`Failed to handle a ${event.type} event`, err)
        }
      }

      if (updated !== ownerRef.current) {
        ownerRef.current = updated
        onUpdateRef.current(updated)
      }
    } catch (err) {
      reportError('Failed to accept share-storage request', err, { channelId: confirmation.channelId, version: confirmation.version })
    }

    log({
      role: 'owner',
      flow: 'sharing',
      step: 'store_share_confirmed',
      description: `Accepted share storage from "${confirmation.peerName}" (version ${confirmation.version})`,
      payload: { channelId: confirmation.channelId, version: confirmation.version },
    })

    setPendingStoreShareConfirmation(null)
  }

  async function handleRejectStoreShare() {
    const confirmation = pendingStoreShareConfirmation
    if (!confirmation) return

    const instance = ownInstance()
    const protocol = instance?.protocol ?? null
    if (!protocol || !instance) return

    try {
      await withProtocolLock(() => protocol.reject(confirmation.action, /* REJECTED */ 10, 'Share storage rejected by user'))

      log({
        role: 'owner',
        flow: 'sharing',
        step: 'store_share_rejected',
        description: `Rejected share storage from "${confirmation.peerName}" (version ${confirmation.version})`,
        payload: { channelId: confirmation.channelId, version: confirmation.version },
      })
    } catch (err) {
      reportError('Failed to reject share-storage request', err, { channelId: confirmation.channelId, version: confirmation.version })
    }

    setPendingStoreShareConfirmation(null)
  }

  // Auto-reject store-share requests after timeout.
  useEffect(() => {
    if (!pendingStoreShareConfirmation) return
    const timer = setTimeout(() => {
      handleRejectStoreShare()
    }, flowTimeoutMs)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingStoreShareConfirmation])

  async function handleAcceptVerifyShare() {
    const confirmation = pendingVerifyShareConfirmation
    if (!confirmation) return

    const instance = ownInstance()
    const protocol = instance?.protocol ?? null
    if (!protocol || !instance) return

    try {
      const events = await withProtocolLock(() => protocol.accept(confirmation.action))
      const eventArray = Array.from(events)

      let updated = ownerRef.current
      for (const event of eventArray) {
        try {
          updated = applyOwnerEvent(updated, event)
        } catch (err) {
          reportError(`Failed to handle a ${event.type} event`, err)
        }
      }

      if (updated !== ownerRef.current) {
        ownerRef.current = updated
        onUpdateRef.current(updated)
      }
    } catch (err) {
      reportError('Failed to accept verification request', err, { channelId: confirmation.channelId, version: confirmation.version })
    }

    log({
      role: 'owner',
      flow: 'verification',
      step: 'verify_share_confirmed',
      description: `Accepted verification from "${confirmation.peerName}" (version ${confirmation.version})`,
      payload: { channelId: confirmation.channelId, version: confirmation.version },
    })

    setPendingVerifyShareConfirmation(null)
  }

  async function handleRejectVerifyShare() {
    const confirmation = pendingVerifyShareConfirmation
    if (!confirmation) return

    const instance = ownInstance()
    const protocol = instance?.protocol ?? null
    if (!protocol || !instance) return

    try {
      await withProtocolLock(() => protocol.reject(confirmation.action, /* REJECTED */ 10, 'Helper rejected the verification request'))

      log({
        role: 'owner',
        flow: 'verification',
        step: 'verify_share_rejected',
        description: `Rejected verification from "${confirmation.peerName}" (version ${confirmation.version})`,
        payload: { channelId: confirmation.channelId, version: confirmation.version },
      })
    } catch (err) {
      reportError('Failed to reject verification request', err, { channelId: confirmation.channelId, version: confirmation.version })
    }

    setPendingVerifyShareConfirmation(null)
  }

  // Auto-reject verify-share requests after timeout.
  useEffect(() => {
    if (!pendingVerifyShareConfirmation) return
    const timer = setTimeout(() => {
      handleRejectVerifyShare()
    }, flowTimeoutMs)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingVerifyShareConfirmation])

  async function handleAcceptUnpair() {
    const confirmation = pendingUnpairConfirmation
    if (!confirmation) return

    const instance = ownInstance()
    const protocol = instance?.protocol ?? null
    if (!protocol || !instance) return

    try {
      const events = await withProtocolLock(() => protocol.accept(confirmation.action))
      const eventArray = Array.from(events)

      let updated = ownerRef.current
      for (const event of eventArray) {
        try {
          updated = applyOwnerEvent(updated, event)
        } catch (err) {
          reportError(`Failed to handle a ${event.type} event`, err)
        }
      }

      if (updated !== ownerRef.current) {
        ownerRef.current = updated
        onUpdateRef.current(updated)
      }
    } catch (err) {
      reportError('Failed to accept unpair request', err, { channelId: confirmation.channelId })
    }

    log({
      role: 'owner',
      flow: 'unpairing',
      step: 'unpair_accepted',
      description: `Accepted unpair from "${confirmation.peerName}"`,
      payload: { channelId: confirmation.channelId },
    })

    setPendingUnpairConfirmation(null)
  }

  async function handleRejectUnpair() {
    const confirmation = pendingUnpairConfirmation
    if (!confirmation) return

    const instance = ownInstance()
    const protocol = instance?.protocol ?? null
    if (!protocol || !instance) return

    try {
      await withProtocolLock(() =>
        protocol.reject(confirmation.action, /* REJECTED */ 10, 'Owner rejected the unpair request'),
      )

      log({
        role: 'owner',
        flow: 'unpairing',
        step: 'unpair_request_rejected',
        description: `Rejected unpair from "${confirmation.peerName}"`,
        payload: { channelId: confirmation.channelId },
      })
    } catch (err) {
      reportError('Failed to reject unpair request', err, { channelId: confirmation.channelId })
    }

    setPendingUnpairConfirmation(null)
  }

  // Auto-reject incoming unpair confirmations after the flow timeout so we
  // don't strand the requester waiting on a modal nobody answered.
  useEffect(() => {
    if (!pendingUnpairConfirmation) return
    const timer = setTimeout(() => {
      handleRejectUnpair()
    }, flowTimeoutMs)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingUnpairConfirmation])

  // Syncs participant pairing status from the backend's participant_channels data.
  // This catches participant-initiated pairings that never produce an owner-side event.

  useEffect(() => {
    const id = setInterval(async () => {
      // A failed adoption left this device's namespace erased; reconciling the
      // roster into it would only write state onto a vault that is gone.
      if (adoptionBlockRef.current) return
      const { ownerId } = ownerRef.current
      try {
        const actors = await apiGetActors()
        // Re-read after the async call so we see any updates from the owner
        // mailbox poll that completed while the API request was in flight.
        const current = ownerRef.current
        let updated = current
        let changed = false

        // Config is deliberately *not* reconciled from the backend. It is owned
        // by this browser context — chosen in the setup wizard, persisted here,
        // and pushed to the backend only when provisioning actors. There is no
        // server-held policy to drift from.

        // Discover new participants. Every actor on the server is visible to
        // every owner. New participants always start as 'available' — the
        // backend's channel_id may belong to another owner's pairing. This
        // owner's pairing status is managed exclusively via PairingCompleted.
        for (const actor of actors) {
          if (actor.role !== 'participant') continue
          if (updated.participants.some(h => h.id === actor.id)) continue
          changed = true
          updated = {
            ...updated,
            participants: [...updated.participants, {
              id: actor.id,
              name: actor.name,
              channelId: '',
              transport: { protocol: actor.transport.protocol, uri: actor.transport.uri },
              connectionStatus: 'available' as const,
              secretShares: [],
              browserManaged: actor.browser_managed ?? false,
            }],
          }
        }

        for (const actor of actors) {
          const participant = updated.participants.find(h => h.id === actor.id)
          if (!participant) continue

          // Sync shared key once available.
          if (actor.shared_key && !participant.sharedKey) {
            changed = true
            updated = {
              ...updated,
              participants: updated.participants.map(h =>
                h.id === actor.id
                  ? { ...h, sharedKey: actor.shared_key! }
                  : h,
              ),
            }
          }

        }

        if (changed) {
          ownerRef.current = updated
          onUpdateRef.current(updated)
        }

        // One projection, computed once and used by everything: the channel-list
        // replica rows, the provisioned-replica section, the fingerprint modal,
        // and the automatic first-sync trigger below.
        const views = replicaViews(actors, loadReplicaState(ownerId))
        rosterSnapshotRef.current = actors
        setReplicaRows(views)
        setReplicaRowsLoaded(true)

        // Mirror to a replica destination the moment it becomes eligible.
        // Driven from this poll on purpose: the promotion to `paired` can
        // complete with nothing replica-shaped on screen (the peer confirms
        // last), and it keys off the status transition alone, so it holds for a
        // provisioned replica and a second browser device alike. Only rows this
        // device is the `replica_source` of are ever due — see
        // `replicaSyncTargets`. The round itself is fired and forgotten — the
        // trigger owns its own in-flight guard and reports its own failures.
        void replicaFirstSyncRef.current?.observe(views)
      } catch {
        // Silently ignore — the owner mailbox poll will surface connectivity issues.
      }
    }, pollInterval)

    return () => clearInterval(id)
     
  }, [owner.ownerId, pollInterval])

  async function createOwnerContact(
    mode: ContactModeKey = DEFAULT_CONTACT_MODE,
  ): Promise<ContactMessage> {
    return withProtocolLock(async () => {
      const protocol = ownInstance()?.protocol ?? null
      if (!protocol) throw new Error('Protocol not initialized')
      // `NoKeys` contacts are meant to be dictated, so they carry a short
      // human-readable nonce rather than a random u64.
      const nonce = mode === 'no_keys' ? humanNonce() : null
      return protocol.createContact(null, toContactMode(mode), nonce)
    })
  }

  function getParticipantFunctions(participantId: string) {
    const participant = owner.participants.find(h => h.id === participantId)

    // Browser-managed participants (other owners) post their own contact via the
    // browser-contact endpoint. Pairing is always initiated by Alice's WASM.
    if (participant?.browserManaged) {
      return {
        // No mode parameter is honoured here: this fetches a contact the peer
        // browser already minted, so the mode was theirs to choose.
        createContact: async (): Promise<ContactMessage> => {
          const dto = await apiGetBrowserContact(participantId)
          if (!dto) throw new Error('Peer contact not available yet — they may still be loading.')
          return dtoToContactMessage(dto)
        },
        startPairing: async (contact: ContactMessage, role: PairingRole): Promise<bigint> => {
          return withProtocolLock(async () => {
            const protocol = ownInstance()?.protocol ?? null
            if (!protocol) throw new Error('Protocol not initialized')
            return protocol.start(FlowKind.Pairing, {
              kind: senderKindFor(role),
              contact,
              peerCommunicationInfo: peerCommInfo(participant.name),
            }).then(pairingChannelIdFrom)
          })
        },
        startPairingAsInitiator: undefined,
      }
    }

    // Backend-managed participants: the actor initiates pairing using the owner's contact (Flow 1).
    // The owner's WASM creates a contact and the backend actor calls protocol.start with it.
    return {
      createContact: async (
        mode: ContactModeKey = DEFAULT_CONTACT_MODE,
      ): Promise<ContactMessage> => {
        const nonce = mode === 'no_keys' ? humanNonce() : undefined
        const dto = await apiCreateActorContact(participantId, mode, nonce)
        return dtoToContactMessage(dto)
      },
      startPairing: async (contact: ContactMessage, role: PairingRole): Promise<bigint> => {
        return withProtocolLock(async () => {
          const protocol = ownInstance()?.protocol ?? null
          if (!protocol) throw new Error('Protocol not initialized')
          return protocol.start(FlowKind.Pairing, {
            kind: senderKindFor(role),
            contact,
            peerCommunicationInfo: peerCommInfo(participant?.name),
          }).then(pairingChannelIdFrom)
        })
      },
      startPairingAsInitiator: async (
        ownContact: ContactMessage,
        role: 'owner' | 'helper',
      ): Promise<bigint> => {
        // The backend actor scans our contact and initiates, so `role` is
        // already that actor's own declaration — it goes through unchanged.
        // We become the complement when its request reaches us.
        const dto = contactMessageToDto(ownContact)
        const result = await apiStartActorPairing(participantId, dto, role)
        return BigInt(result.channel_id)
      },
    }
  }

  /** Channels a provisioned helper holds, for the operator's link picker. */
  async function listParticipantChannels(participantId: string): Promise<ProvisionedChannel[]> {
    return apiListParticipantChannels(participantId)
  }

  /**
   * Declare, on a provisioned helper, that our channel and one it already
   * holds belong to the same owner.
   *
   * This is the step a real helper would take only after authenticating the
   * person — and the step that lets it answer a Discovery request from a
   * re-paired owner. Nothing on the wire can establish it.
   */
  async function linkParticipantChannels(
    participantId: string,
    channelId: string,
    linkTo: string,
  ): Promise<void> {
    await apiLinkParticipantChannels(participantId, channelId, linkTo)
    log({
      role: 'owner',
      flow: 'pairing',
      step: 'operator_link',
      description: `Linked channel ${channelId} to ${linkTo} on a provisioned helper`,
      payload: { participantId, channelId, linkTo },
    })
    reportInfo('Channels linked — the helper can now answer discovery for this owner.')
  }

  /** Build the `peerCommunicationInfo` payload for an owner-initiated pair.
   *  Currently records only `name`; extend here if the app starts attaching
   *  more identity metadata per peer. */
  function peerCommInfo(peerName: string | undefined): Record<string, string> {
    return peerName ? { name: peerName } : {}
  }

  /**
   * Initiate pairing against `contact`, declaring `role` as our side.
   *
   * `role` is load-bearing: it is the only thing that reaches the wire as
   * `sender_kind`, and the responder derives the complement from it.
   */
  async function ownerStartPairing(
    contact: ContactMessage,
    role: PairingRole,
    peerName?: string,
  ): Promise<bigint> {
    return withProtocolLock(async () => {
      const protocol = ownInstance()?.protocol ?? null
      if (!protocol) throw new Error('Protocol not initialized')
      return protocol.start(FlowKind.Pairing, {
        kind: senderKindFor(role),
        contact,
        peerCommunicationInfo: peerCommInfo(peerName),
      }).then(pairingChannelIdFrom)
    })
  }

  /**
   * Force-fail the in-flight sharing round `version` (e.g. on timeout): discard
   * the pending bag, clear the pending share marks, release the busy state,
   * and surface a visible error.
   */
  function failSharingRound(version: number, reason: string) {
    const pending = pendingBagRef.current
    if (!pending || pending.version !== version) return // already resolved
    pendingBagRef.current = null
    clearFlowWatchdog()

    // Clear the "pending" share marks for this round so the UI stops showing
    // perpetual pending state.
    const cur = ownerRef.current
    const reverted = {
      ...cur,
      participants: cur.participants.map(h => ({
        ...h,
        secretShares: h.secretShares.filter(s => s.version !== version),
      })),
    }
    ownerRef.current = reverted
    onUpdateRef.current(reverted)

    pendingSharesRef.current.clear()
    setProtocolBusy(false)

    reportError(`Sharing round v${version} did not complete (${reason})`, undefined, { version, reason })
    log({
      role: 'owner',
      flow: 'sharing',
      step: 'sharing_round_failed',
      description: `Sharing round v${version} did not complete (${reason}). Some helpers never confirmed — please try again.`,
      payload: { version, reason },
    })
  }

  /**
   * The confirmed replica destinations a `ProtectSecret` round mirrors to.
   *
   * `ProtectSecretParams` carries no target list — the library fans out from
   * its own channel table, sending a `StoreShareRequest` to each paired helper
   * and a `ReplicaSecretPayload` (the full secret plus every helper's share) to
   * each paired replica destination. So this does not select targets; it
   * reproduces the selection for the console, which is the only way to tell a
   * destination that never acked from one that was never sent to.
   *
   * Best-effort by design: the roster lives on the backend and this is
   * bookkeeping, not a precondition. A failed read must not fail a round the
   * library has already dispatched, so it degrades to an empty list.
   */
  async function confirmedReplicaTargets(): Promise<ReplicaSyncTarget[]> {
    try {
      const roster = await apiGetActors()
      return replicaSyncTargets(replicaViews(roster, loadReplicaState(owner.ownerId)))
    } catch {
      return []
    }
  }

  /**
   * Dispatch one `ProtectSecret` round carrying `allUserSecrets`, stage the bag
   * version it produces, and report what the round is expected to reach.
   *
   * The single `start(FlowKind.ProtectSecret, …)` call site in the app: adding a
   * secret and the post-pairing replica sync both come through here, so a round
   * is dispatched, versioned and staged in exactly one way. `ProtectSecretParams`
   * carries no target list — the library fans out from its own channel table —
   * so neither caller says anything about who receives the round.
   *
   * Returns `null` when the library dispatched no round; that failure is already
   * reported and the pending bag already unwound.
   */
  async function runProtectRound(allUserSecrets: UserSecret[]): Promise<ProtectRoundResult | null> {
    // Belt and braces behind the blocked screen: the instance still installed
    // after a failed adoption reads an erased namespace, so protecting a secret
    // here would build a bag against channels that no longer exist.
    if (adoptionBlockRef.current) {
      throw new Error(
        'This device is blocked: adopting a mirrored vault failed after its own vault was erased.',
      )
    }
    setProtocolBusy(true)
    const protocol = ownInstance()?.protocol ?? null
    if (!protocol) throw new Error('Protocol not initialized')

    const current = ownerRef.current
    const existingBag = current.secretBag

    // Build the JS array the WASM binding expects: Array<{ id: Uint8Array, name: string, data: Uint8Array }>
    const wasmSecrets = allUserSecrets.map(s => ({
      id: Uint8Array.from(s.id.match(/.{2}/g)!.map(b => parseInt(b, 16))),
      name: s.name,
      data: new TextEncoder().encode(s.data),
    }))

    const startEvents = await withProtocolLock(() =>
      protocol.start(FlowKind.ProtectSecret, { secrets: wasmSecrets, description: 'DeRec Vault' }),
    )

    // Take the version the library assigned rather than deriving one: it also
    // bumps on pair-completion auto-publish, so any locally-computed number
    // drifts and the SharingComplete match below silently fails — leaving the
    // bag uncommitted even though helpers stored their shares.
    const newVersion = protectVersionFrom(startEvents)
    if (newVersion === null) {
      clearFlowWatchdog()
      setProtocolBusy(false)
      reportError(
        'Protect failed: the protocol dispatched no share requests',
        'No ProtectSecretStarted event was emitted — check that enough helpers are paired.',
      )
      return null
    }

    const pairedParticipants = current.participants.filter(isShareTarget)

    // Register pending shares for correlation.
    const pendingShare: PendingShare = { version: newVersion }
    for (const h of pairedParticipants) {
      if (h.channelId) pendingSharesRef.current.set(h.channelId, pendingShare)
    }

    // Build the new bag version (not committed to owner state yet — waits for SharingComplete).
    const newBagVersion: BagVersion = {
      version: newVersion,
      participantIds: [],
      verifiedParticipantIds: [],
      failedParticipantIds: [],
      secrets: allUserSecrets,
      rawBytes: '',
      helpers: pairedParticipants.map(h => ({ id: h.id, name: h.name, channelId: h.channelId })),
    }

    const pendingBag: SecretBag = existingBag
      ? {
          ...existingBag,
          currentVersion: newBagVersion,
          previousVersions: [existingBag.currentVersion, ...existingBag.previousVersions],
        }
      : {
          secretId: ownSecretIdRef.current,
          currentVersion: newBagVersion,
          previousVersions: [],
          threshold: current.minParticipants,
        }
    pendingBagRef.current = { bag: pendingBag, version: newVersion, protocolSecretId: ownSecretIdRef.current }

    // Arm the generic flow watchdog: if the round makes no progress within
    // the protocol timeout (a helper never answers), recover instead of hanging.
    armFlowWatchdog()

    // Mark participants with pending shares so the modal can track progress,
    // but do NOT commit the bag to owner state yet. Clear any stale refs for
    // this version from a previous failed attempt.
    onUpdate({
      ...current,
      participants: current.participants.map(h =>
        pairedParticipants.some(ph => ph.id === h.id)
          ? { ...h, secretShares: [...h.secretShares.filter(s => s.version !== newVersion), { version: newVersion, status: 'pending' as const, verified: false }] }
          : h,
      ),
    })

    // The same `start` call fans out to confirmed replica destinations. They
    // are not participants and never enter the bag roster, so record what the
    // round is expected to reach separately. This list is log-only: an inbound
    // `ReplicaSecretAcked` resolves purely by `channel_id`, never against it.
    const replicaTargets = await confirmedReplicaTargets()

    return { version: newVersion, participants: pairedParticipants, replicaTargets }
  }

  async function ownerAddSecret(name: string, data: string): Promise<number | null> {
    const existingBag = ownerRef.current.secretBag

    // Build the full list of user secrets (existing + new).
    // Per-user-secret IDs are application-level random identifiers (hex-encoded).
    const newUserSecretIdBytes = crypto.getRandomValues(new Uint8Array(16))
    const newUserSecretId = Array.from(newUserSecretIdBytes).map(b => b.toString(16).padStart(2, '0')).join('')
    const newUserSecret: UserSecret = { id: newUserSecretId, name, data }

    const allUserSecrets = existingBag
      ? [...existingBag.currentVersion.secrets, newUserSecret]
      : [newUserSecret]

    const round = await runProtectRound(allUserSecrets)
    if (!round) return null

    log({
      role: 'owner',
      flow: 'sharing',
      step: 'protect_secret',
      description: `Secret "${name}" added to bag (v${round.version}), distributed to ${round.participants.length} participant(s) and mirrored to ${round.replicaTargets.length} replica(s)`,
      payload: {
        version: round.version,
        secretCount: allUserSecrets.length,
        replicas: round.replicaTargets.map(r => ({ name: r.name, channelId: r.channelId })),
      },
    })

    setActiveTab('secrets')
    // The version the *library* assigned, not one derived here. Rounds are keyed
    // by version and several run concurrently — a pairing auto-publish can move
    // the version between this call and the previous bag state — so anything
    // watching this round has to be told which one it is.
    return round.version
  }

  /**
   * Mirror this vault to every replica destination the library holds `Paired`.
   *
   * Runs the ordinary protect round — the library mirrors to each such
   * destination on its own, so "sync now" *is* "protect now". Nothing here
   * names a destination, and nothing here can reach one the library has not
   * itself promoted. `reason` only colours the log line.
   *
   * With nothing in the bag there is nothing to mirror, and a round carrying no
   * secrets would only churn the version. For the automatic path the
   * destination is still marked as synced-for: it is not behind, and the
   * owner's first protect round will reach it through the ordinary path. For a
   * manual request the caller reports `nothing-to-mirror` on screen, so a
   * button that dispatched nothing never looks like one that worked.
   */
  async function runReplicaSyncRound(reason: ReplicaSyncReason): Promise<ReplicaSyncRoundResult> {
    const secrets = ownerRef.current.secretBag?.currentVersion.secrets ?? []
    if (secrets.length === 0) {
      log({
        role: 'owner',
        flow: 'sharing',
        step: 'replica_sync_skipped',
        description:
          reason === 'manual'
            ? 'A replica sync was requested, but this vault holds no secrets yet — there is nothing to mirror'
            : 'A replica destination was confirmed, but this vault holds no secrets yet — it will receive them on the first protect round',
        payload: { reason },
      })
      return 'nothing-to-mirror'
    }

    const round = await runProtectRound([...secrets])
    if (!round) {
      // The round was rejected and already reported; the pending bag is unwound.
      // Surfacing it as a dispatch would tell the user a copy is on its way.
      throw new Error('The protocol dispatched no share requests — check that helpers are paired.')
    }

    log({
      role: 'owner',
      flow: 'sharing',
      step: reason === 'manual' ? 'replica_sync_requested' : 'replica_sync_on_pairing',
      description:
        reason === 'manual'
          ? `Replica sync requested — vault mirrored in round v${round.version} to ${round.replicaTargets.length} replica(s)`
          : `Replica destination confirmed — vault mirrored in round v${round.version} to ${round.replicaTargets.length} replica(s)`,
      payload: {
        version: round.version,
        reason,
        replicas: round.replicaTargets.map(r => ({ name: r.name, channelId: r.channelId })),
      },
    })
    return 'dispatched'
  }

  // The trigger below is built once and outlives every re-render, so it must
  // reach the *current* runner rather than the one that existed when it was
  // built — `runProtectRound` closes over this render's `onUpdate`.
  const replicaSyncRunnerRef = useRef<(reason: ReplicaSyncReason) => Promise<ReplicaSyncRoundResult>>(
    () => Promise.resolve('nothing-to-mirror'),
  )
  useEffect(() => {
    replicaSyncRunnerRef.current = runReplicaSyncRound
  })

  /**
   * Owns *both* replica sync paths: the automatic round the first time a
   * destination becomes eligible, and the user's explicit "Sync now".
   *
   * Built once and held in a ref for two reasons: its "already dispatched for"
   * bookkeeping is what stops a repeated confirmation from starting a second
   * round, and its single in-flight flag is what stops the manual action from
   * overlapping the automatic one. Either would reset with a render.
   */
  const replicaFirstSyncRef = useRef<ReplicaFirstSyncTrigger | null>(null)
  if (!replicaFirstSyncRef.current) {
    replicaFirstSyncRef.current = createReplicaFirstSyncTrigger({
      // A round stages a pending bag and arms the flow watchdog, so it must
      // not land on top of another in-flight flow. Deferring is free: the
      // destination stays due and the next poll tick tries again, and a manual
      // request is reported as `busy` rather than queued.
      canProtect: () =>
        !adoptionBlockRef.current && !protocolBusyRef.current && ownInstance()?.protocol != null,
      markStarted: replicaIds =>
        markReplicaFirstSyncStarted(ownerRef.current.ownerId, replicaIds),
      runProtectRound: reason => replicaSyncRunnerRef.current(reason),
      // An automatic round nobody watched. A failure keeps its full-detail
      // console record, but neither a failure nor an empty round may stop
      // there: both leave a confirmed replica without the copy, the round is
      // never retried, and the panel's banner is where the user learns to press
      // "Sync now". A round that did dispatch clears any earlier notice.
      onOutcome: outcome => {
        if (outcome.kind === 'failed') {
          reportError(
            'Could not mirror this vault to a newly confirmed replica',
            outcome.error,
          )
        }
        setReplicaAutoSyncOutcome(automaticSyncNeedsAttention(outcome) ? outcome : null)
      },
    })
  }
  const replicaSyncTrigger = replicaFirstSyncRef.current

  async function ownerVerifyShares(version: number): Promise<void> {
    setProtocolBusy(true)
    armFlowWatchdog()
    const protocol = ownInstance()?.protocol ?? null
    if (!protocol) throw new Error('Protocol not initialized')

    const current = ownerRef.current
    const bag = current.secretBag
    if (!bag) throw new Error('No secret bag — protect a secret first')

    const bagVersion = bag.currentVersion.version === version
      ? bag.currentVersion
      : bag.previousVersions.find(v => v.version === version)
    if (!bagVersion) throw new Error(`Version ${version} not found in bag`)

    // Clear prior verification results so this run can track fresh responses.
    const clearedBag = updateBagVersion(bag, version, v => ({ ...v, verifiedParticipantIds: [] }))
    onUpdate({ ...current, secretBag: clearedBag })

    // Register pending verifications only for participants that confirmed this version.
    const confirmedParticipants = current.participants.filter(
      h => bagVersion.participantIds.includes(h.id) && h.channelId,
    )
    const targetChannelIds = confirmedParticipants.map(h => BigInt(h.channelId))
    for (const participant of confirmedParticipants) {
      pendingVerificationsRef.current.set(participant.channelId, { protocolSecretId: bag.secretId, version })
    }

    await withProtocolLock(() => protocol.start(FlowKind.VerifyShares, { secretId: bag.secretId, version, target: targetChannelIds }))

    log({
      role: 'owner',
      flow: 'verification',
      step: 'verify_shares',
      description: `Verification challenges sent for bag v${version} to ${confirmedParticipants.length} participant(s)`,
      payload: { version, participantCount: confirmedParticipants.length },
    })
  }

  async function ownerRequestDiscovery(): Promise<void> {
    const protocol = ownInstance()?.protocol ?? null
    if (!protocol) throw new Error('Protocol not initialized')
    setProtocolBusy(true)
    armFlowWatchdog()
    await withProtocolLock(() => protocol.start(FlowKind.Discovery, {}))

    log({
      role: 'owner',
      flow: 'recovery',
      step: 'request_discovery',
      description: 'Discovery requested for all paired helpers',
    })
  }

  async function ownerRecoverSecret(
    secretId: string,
    version: number,
    label: string,
    participantChannelIds: bigint[],
  ): Promise<void> {
    const protocol = ownInstance()?.protocol ?? null
    if (!protocol) throw new Error('Protocol not initialized')

    pendingRecoveryRef.current = { secretId, version, label }
    setProtocolBusy(true)
    armFlowWatchdog()
    const current = ownerRef.current
    // Drop any prior failure for THIS (secretId, version) so its row drops
    // back to "Recovering…" instead of clinging to the previous "Incomplete".
    // Failures on OTHER versions are preserved.
    const updated = {
      ...current,
      recoveryProgress: { secretId, version, sharesReceived: 0, totalRequested: participantChannelIds.length, error: null },
      recoveryFailures: removeRecoveryFailure(current.recoveryFailures, secretId, version),
    }
    ownerRef.current = updated
    onUpdateRef.current(updated)
    const startEvents = Array.from(
      await withProtocolLock(() =>
        protocol.start(FlowKind.RecoverSecret, { secretId: BigInt(secretId), version }),
      ),
    )

    log({
      role: 'owner',
      flow: 'recovery',
      step: 'recover_secret',
      description: `Recovery requested for "${label}" v${version} from ${participantChannelIds.length} participant(s)`,
      payload: { secretId, version, channels: participantChannelIds.map(c => c.toString()) },
    })

    // `start` reports one dispatch result per channel it reached. Surfacing
    // them is what separates "requests are in flight" from "nothing was sent",
    // which otherwise looks identical: a progress bar parked at 0 received.
    for (const event of startEvents) {
      if (event.type !== 'RecoverSecretFailed') continue
      log({
        role: 'owner',
        flow: 'recovery',
        step: 'RecoverSecretFailed',
        description: `Share request could not be dispatched on channel ${event.channel_id}: ${event.error}`,
        payload: { channelId: event.channel_id, error: event.error },
      })
    }

    const dispatched = startEvents.filter(e => e.type === 'RecoverSecretStarted').length
    if (dispatched > 0) return

    // The protocol looks for the channels to ask under the partition of the
    // secret being recovered. A device whose instance is bound to a different
    // secret has none there, so nothing goes on the wire and no response can
    // ever arrive — fail now instead of waiting out the watchdog.
    const ownSecretId = ownSecretIdRef.current
    const message =
      secretId === ownSecretId
        ? 'No helper channel could be reached for this secret. Pair with the helpers holding it and try again.'
        : `This device is bound to secret ${ownSecretId}, but "${label}" belongs to secret ${secretId}, ` +
          'and no share requests were sent. Set up again in recovery mode and claim the original ' +
          'owner actor so this device binds to the secret being recovered.'

    clearFlowWatchdog()
    setProtocolBusy(false)
    const failed = ownerRef.current
    const withError = {
      ...failed,
      recoveryProgress: failed.recoveryProgress
        ? { ...failed.recoveryProgress, error: message }
        : failed.recoveryProgress,
      recoveryFailures: upsertRecoveryFailure(failed.recoveryFailures, secretId, version, message),
    }
    ownerRef.current = withError
    onUpdateRef.current(withError)

    log({
      role: 'owner',
      flow: 'recovery',
      step: 'recover_secret_not_dispatched',
      description: message,
      payload: { secretId, ownSecretId, version },
    })
    reportError('Recovery request was not sent to any helper', message, { secretId, ownSecretId, version })
  }

  /**
   * Restore the app to a "normal" working state from a recovered secret.
   *
   * Concretely:
   * 1. Wipes both the non-recovery and recovery namespaces (clean slate).
   * 2. Builds a protocol instance bound to the recovered `secret_id` and calls
   *    `restore()` on it, which repopulates that secret's channel / secret /
   *    share partitions from the snapshot the library decoded.
   * 3. Announces this device's endpoint to the restored helpers via
   *    `UpdateChannelInfo` — the snapshot carries the *pre-loss* transport,
   *    which is what those helpers still have on their channel records.
   * 4. Rebuilds FE owner state — participants, secret bag, threshold —
   *    so the UI matches the protocol's restored stores.
   * 5. Exits recovery mode; the protocol useEffect rebuilds the instance
   *    registry against the now-populated non-recovery namespace.
   *
   * The recovery-mode helpers stay paired on their side. They simply drop out
   * of this app's view.
   */
  async function handleRestoreFromBag(secret: RecoveredSecret): Promise<void> {
    try {
      const current = ownerRef.current
      const targetNs = `owner:${current.ownerId}`

      // 0. Retire the ephemeral recovery channels while their keys still
      //    exist. They served one purpose — carrying discovery and share
      //    retrieval — and the restored snapshot replaces them with the
      //    originals. Wiping the namespace without telling the peers leaves
      //    them paired to a channel this device can no longer decrypt: every
      //    message they send afterwards lands as an "unknown channel_id"
      //    error, indefinitely. Best-effort — a peer we cannot reach must not
      //    block the restore.
      //    Replica channels are excluded: they were not part of the recovery
      //    and the restored snapshot does not replace them, so retiring one
      //    here would silently drop a mirror the user never asked to end.
      const recoveryChannelIds = current.participants
        .filter(p => p.connectionStatus === 'paired' && p.channelId && !isReplicaChannel(p))
        .map(p => p.channelId)

      if (recoveryChannelIds.length > 0) {
        const recoveryInstance = ownInstance()
        if (recoveryInstance) {
          for (const channelId of recoveryChannelIds) {
            try {
              await withProtocolLock(() =>
                recoveryInstance.protocol.start(FlowKind.Unpair, {
                  channel_id: channelId,
                  memo: 'recovery complete — ephemeral channel retired',
                }),
              )
            } catch (err) {
              reportError('Failed to retire a recovery channel', err, { channelId })
            }
          }
          log({
            role: 'owner',
            flow: 'recovery',
            step: 'recovery_channels_retired',
            description: `Unpaired ${recoveryChannelIds.length} ephemeral recovery channel(s)`,
            payload: { channelIds: recoveryChannelIds },
          })
        }
      }

      // 1. Clean the namespace so the restored state has no stale neighbours.
      // Recovering onto a device that already holds state is allowed — the
      // recovered snapshot replaces it. Clearing first also avoids `restore`
      // failing with ALREADY_RESTORED against an existing snapshot.
      clearNamespace(targetNs)

      // 2. Replay the snapshot through a protocol instance bound to the
      //    recovered secret. `restore` is a protocol method now, so it needs a
      //    live instance over the freshly-cleared namespace — the effect that
      //    rebuilds the instance against the populated
      //    stores once we exit recovery below.
      const restoreInstance = buildProtocolInstance({
        namespace: targetNs,
        secretId: secret.secretId,
        ownTransportUri: current.transport.uri,
        communicationInfo: { name: current.ownerName },
        threshold: current.minParticipants,
        keepVersionsCount: 3,
        timeoutSecs: current.config?.protocolTimeoutSecs ?? DEFAULT_PROTOCOL_TIMEOUT_SECS,
        unpairAck: current.config?.unpairAck ?? 'required',
        replicaId: getOrCreateReplicaId(owner.ownerId),
      })
      // `restore` returns the events from its own recovery-channel teardown
      // (one `Unpaired` per wiped channel, `UnpairFailed` for any the peer
      // never received). Drain them so the teardown is visible rather than
      // discarded.
      const restoreEvents = Array.from(
        await restoreInstance.protocol.restore(snapshotToPayload(secret.snapshot), secret.version),
      )
      // The state each fold returns is intentionally dropped: step 4 below
      // replaces participants wholesale from the snapshot, so only these
      // handlers' console output is wanted here.
      for (const event of restoreEvents) {
        try {
          applyOwnerEvent(ownerRef.current, event)
        } catch (err) {
          reportError(`Failed to handle a ${event.type} event from restore`, err)
        }
      }

      // 3. FE state derived from the snapshot. Helpers become paired
      //    participants; the secret bag is reconstructed with one version and
      //    no history.
      //
      //    Peers are re-identified against the server's actor list by
      //    transport URI, which is unique per actor. Snapshot records carry
      //    only what travelled on the wire, so without this the restored rows
      //    would be anonymous placeholders: backend polling reconciles
      //    participant state by actor id, and would never match.
      let actorByUri = new Map<string, BEActorWithStatus>()
      try {
        const actors = await apiGetActors()
        actorByUri = new Map(actors.map(a => [a.transport.uri, a]))
      } catch (err) {
        // Non-fatal: fall back to snapshot-only identities.
        reportError('Could not re-identify restored peers against the roster', err, {
          secretId: secret.secretId,
        })
      }

      const participants: PairedParticipant[] = secret.snapshot.helpers.map(h => {
        const actor = actorByUri.get(h.transportUri)
        return {
          id: actor?.id ?? `peer-${h.channelId}`,
          name: actor?.name || h.communicationInfo['name'] || 'Unknown',
          channelId: h.channelId,
          transport: { protocol: 'https' as const, uri: h.transportUri },
          connectionStatus: 'paired' as const,
          // Every peer in a recovered snapshot held a share for us.
          peerRole: 'helper' as const,
          secretShares: [{ version: secret.version, status: 'confirmed' as const, verified: false }],
          browserManaged: actor?.browser_managed,
        }
      })

      const bagVersion: BagVersion = {
        version: secret.version,
        participantIds: participants.map(p => p.id),
        verifiedParticipantIds: [],
        failedParticipantIds: [],
        secrets: secret.snapshot.secrets.map(s => ({
          id: s.id,
          name: s.name,
          data: decodeSecretText(s.data),
        })),
        // The library no longer surfaces the raw wire bytes — it decodes the
        // snapshot itself — and this field is display-only and unread.
        rawBytes: '',
        helpers: participants.map(p => ({ id: p.id, name: p.name, channelId: p.channelId })),
      }
      const secretBag: SecretBag = {
        secretId: secret.secretId,
        currentVersion: bagVersion,
        previousVersions: [],
        // The threshold isn't carried in the bag; reuse the owner's
        // configured minimum as the most sensible default.
        threshold: current.minParticipants,
      }

      // 3b. Announce our current endpoint to every restored helper.
      //
      //     The snapshot carries the transport this owner had *before* the
      //     loss, which is what the helpers still hold on their channel
      //     records. `UpdateChannelInfo` is the protocol-level way to move
      //     them onto the endpoint this device actually listens on, so the
      //     app no longer depends on reclaiming the old actor's mailbox to
      //     stay reachable.
      if (participants.length > 0) {
        try {
          // Both local setters before announcing: `start(UpdateChannelInfo)`
          // tells the peers, but it does not change what *this* node believes
          // about itself. Skipping these leaves the local endpoint and comm
          // info stale, and the next pairing then advertises the pre-recovery
          // values to a peer that was never told about them.
          await restoreInstance.protocol.setOwnTransport(current.transport.uri, 'https')
          restoreInstance.protocol.setCommunicationInfo({ name: current.ownerName })
          await restoreInstance.protocol.start(FlowKind.UpdateChannelInfo, {
            target: participants.map(p => BigInt(p.channelId)),
            communication_info: { name: current.ownerName },
            transport_protocol: {
              uri: current.transport.uri,
              protocol: TRANSPORT_PROTOCOL_HTTPS,
            },
          })
          log({
            role: 'owner',
            flow: 'recovery',
            step: 'announce_endpoint',
            description: `Announced the recovered endpoint to ${participants.length} helper(s)`,
            payload: { transportUri: current.transport.uri, secretId: secret.secretId },
          })
        } catch (err) {
          // Non-fatal: the restore itself succeeded, and helpers can still be
          // reached if they already point at this endpoint.
          reportError('Failed to announce the recovered endpoint to helpers', err, {
            secretId: secret.secretId,
          })
        }
      }

      // 4. Commit the restored owner. `ownSecretId` becomes the *recovered*
      //    secret: `restore` rebuilt state under that id, so the instance must
      //    be rebound to it or it would look at an empty namespace.
      setActiveTab('participants')
      onUpdate({
        ...current,
        participants,
        secretBag,
        pendingPairings: [],
        heldShares: [],
        recoveredSecrets: [],
        recoveryProgress: null,
        recoveryFailures: [],
        mainChannels: [],
        ownSecretId: secret.secretId,
      })

      log({
        role: 'owner',
        flow: 'recovery',
        step: 'recovery_completed',
        description: `Restored ${participants.length} helper(s) and ${secret.snapshot.secrets.length} secret(s) from recovered bag`,
        payload: {
          secretId: secret.secretId,
          version: secret.version,
          helperCount: participants.length,
          secretCount: secret.snapshot.secrets.length,
        },
      })
    } catch (err) {
      reportError('Failed to restore from recovered bag', err, {
        secretId: secret.secretId,
        version: secret.version,
      })
    }
  }

  // ── Replica actions ────────────────────────────────────────────────────────

  /** Provision a backend-hosted replica of this owner's vault. */
  async function handleAddReplica(name: string): Promise<void> {
    await apiAddReplica(name, owner.ownerId, provisioningSettings)
    await refreshRosterSnapshot()
  }

  /**
   * Start a replica handshake against a provisioned replica.
   *
   * This device is always the `replica_source` here: a provisioned replica has
   * no UI to consent with, so the only direction that makes sense is mirroring
   * *out*. The role goes through `pairReplica`, which resolves it via
   * `senderKindFor` — the wire kind is the whole of what distinguishes a replica
   * pairing from a helper one.
   */
  /**
   * Ask the replica group which version its members hold.
   *
   * The events land through the ordinary event fold: `SyncCheckComplete`
   * reports the outcome, and a hydration event follows only if this device
   * actually was behind.
   */
  async function handleSyncCheck(): Promise<void> {
    setSyncCheckRunning(true)
    try {
      const events = await startSyncCheck(replicaProtocol)
      let updated = ownerRef.current
      for (const event of events) {
        updated = applyOwnerEvent(updated, event)
      }
      if (updated !== ownerRef.current) {
        ownerRef.current = updated
        onUpdateRef.current(updated)
      }
    } catch (err) {
      reportError('Sync check failed', err)
    } finally {
      setSyncCheckRunning(false)
    }
  }

  /**
   * Evict a member from the replica group.
   *
   * Two steps, and the second is not optional. `start(RemoveReplica)` only
   * *announces* the eviction: it flags the member so the next roster omits it
   * while leaving it on the distribution list, which is how the evicted device
   * learns it may tear itself down. Publishing that roster is the application's
   * job — without it the member is marked and nothing else ever happens, no
   * `ReplicaRemoved` is emitted, and the row stays put forever.
   */
  async function handleRemoveFromGroup(replica: ReplicaView): Promise<void> {
    const peerReplicaId = replica.peerReplicaId
    if (!peerReplicaId) return

    setRemovingReplicaIds(prev => new Set(prev).add(peerReplicaId))
    try {
      const events = await removeReplicaMember(
        replicaProtocol,
        peerReplicaId,
        `Removed by ${owner.ownerName}`,
      )
      let updated = ownerRef.current
      for (const event of events) {
        updated = applyOwnerEvent(updated, event)
      }
      if (updated !== ownerRef.current) {
        ownerRef.current = updated
        onUpdateRef.current(updated)
      }

      // Publish the roster the announcement just changed. A vault with no
      // secret has no roster to publish, so the eviction stays pending until
      // one exists — there is nothing to carry it.
      if (ownerRef.current.secretBag) {
        await replicaSyncTrigger.syncNow()

        // The library has dropped the member from its roster. Two app-side
        // records outlive it and neither is reachable from the library: the
        // per-channel replica bookkeeping, and the roster row the Replicas tab
        // actually renders. Left behind, the row keeps offering actions on a
        // member that is no longer in the group.
        forgetReplicaMember(owner.ownerId, peerReplicaId)

        const evictedChannelId = replica.channelId
        if (evictedChannelId) {
          const next: Owner = {
            ...ownerRef.current,
            participants: ownerRef.current.participants.filter(
              p => p.channelId !== evictedChannelId,
            ),
          }
          ownerRef.current = next
          onUpdateRef.current(next)
        }
      } else {
        reportInfo(
          'Eviction announced. It completes on the next protect round — this vault holds no secret to publish yet.',
        )
      }
      refreshReplicaRows()
    } catch (err) {
      reportError(`Could not remove replica ${peerReplicaId} from the group`, err, {
        replicaId: peerReplicaId,
      })
    } finally {
      setRemovingReplicaIds(prev => {
        const next = new Set(prev)
        next.delete(peerReplicaId)
        return next
      })
    }
  }

  async function handlePairReplica(replica: ReplicaView): Promise<void> {
    await pairReplica({
      protocol: replicaProtocol,
      ownerId: owner.ownerId,
      replicaId: replica.id,
      replicaName: replica.name,
      role: 'replica_source',
    })
    // The handshake completes over the mailbox poll; `PairingCompleted` is what
    // raises the fingerprint modal, on this device and on the replica alike.
  }

  async function handleToggleReplicaOffline(replica: ReplicaView): Promise<void> {
    await apiToggleReplicaStatus(replica.id, !replica.offline)
    await refreshRosterSnapshot()
  }

  /** Re-read the roster now rather than waiting out a poll interval. */
  async function refreshRosterSnapshot(): Promise<void> {
    const resp = await apiGetActors()
    rosterSnapshotRef.current = resp
    setReplicaRows(replicaViews(resp, loadReplicaState(owner.ownerId)))
    setReplicaRowsLoaded(true)
  }

  /**
   * Record one side of a fingerprint comparison.
   *
   * The projection is re-derived from what was just persisted rather than
   * patched beside it, so a row can never disagree with the next poll about
   * whether this device has confirmed.
   */
  function handleReplicaConfirmed(replicaId: string, patch: Partial<ReplicaRecord>) {
    recordConfirmation(owner.ownerId, replicaId, patch)
    refreshReplicaRows()
  }

  /**
   * Mirror this vault on demand, from a replica row.
   *
   * The round reaches every `Paired` destination, not just this row — the
   * library picks its own targets — so the row is only where the request is
   * made. Every outcome is reported, including the two that dispatch nothing:
   * an action that appears to do nothing is precisely the failure this exists
   * to recover from.
   */
  async function handleReplicaSyncNow(replica: ReplicaView): Promise<void> {
    const channelId = replica.channelId
    if (!channelId) return
    setSyncingChannelId(channelId)
    setManualSyncNotice(null)
    try {
      const outcome = await replicaSyncTrigger.syncNow()
      setManualSyncNotice({
        channelId,
        notice: describeManualSyncOutcome(outcome, replica.name),
      })
      // A round the user watched supersedes the automatic notice that told them
      // to run it.
      setReplicaAutoSyncOutcome(null)
    } finally {
      setSyncingChannelId(null)
      refreshReplicaRows()
    }
  }

  /**
   * The sync message a given replica row should show.
   *
   * A result the user just asked for wins on the row they asked it on. The
   * automatic notice has no row of its own — the trigger dispatches a global
   * round and is told nothing about who it was for — so it goes on every row
   * that can act on it, which is exactly where its "use Sync now" instruction
   * points.
   */
  function replicaSyncNoticeFor(replica: ReplicaView): ReplicaRowSyncNotice | null {
    if (manualSyncNotice?.channelId === replica.channelId) return manualSyncNotice.notice
    if (manualSyncNotice) return null
    if (!replicaAutoSyncOutcome || !canRequestReplicaSync(replica)) return null
    return describeAutomaticSyncOutcome(replicaAutoSyncOutcome)
  }

  function dismissReplicaSyncNotice() {
    if (manualSyncNotice) setManualSyncNotice(null)
    else setReplicaAutoSyncOutcome(null)
  }

  /**
   * Adopt a mirrored vault offered by a replica source.
   *
   * Destructive, and gated behind `ReplicaAdoptionDialog` — this only runs on
   * an explicit confirmation. The sequence itself lives in
   * `adoptReplicaSecret`; everything here is wiring: the protocol
   * configuration, the effectful collaborators, and the commit of the resulting
   * FE state.
   *
   * Failures are deliberately **not** recovered from. `restore` refusing means
   * the wipe did not take, and the caller has to see the library's own words —
   * swallowed into a toast, a half-adopted device would look like it simply did
   * nothing. The rejection is re-thrown unchanged after the page has been put
   * into `adoptionBlock`; nothing here retries.
   */
  async function handleAdoptReplicaSecret(adoption: PendingReplicaAdoption): Promise<void> {
    const current = ownerRef.current
    const ns = `owner:${current.ownerId}`
    // Captured out of the injected builder: `adoptReplicaSecret` only knows the
    // structural slice it drives, while the page has to install the full
    // instance below.
    const built: { instance: ProtocolInstance | null } = { instance: null }

    let outcome: ReplicaAdoptionOutcome
    try {
      outcome = await withProtocolLock(() =>
        adoptReplicaSecret({
          adoption,
          namespace: ns,
          config: {
            ownTransportUri: current.transport.uri,
            communicationInfo: { name: current.ownerName },
            threshold: current.minParticipants,
            keepVersionsCount: 3,
            timeoutSecs: current.config?.protocolTimeoutSecs ?? DEFAULT_PROTOCOL_TIMEOUT_SECS,
            unpairAck: current.config?.unpairAck ?? 'required',
          },
          deps: {
            clearNamespace,
            clearReplicaBookkeeping: () => clearReplicaState(current.ownerId),
            getReplicaId: () => getOrCreateReplicaId(current.ownerId),
            buildInstance: params => {
              const instance = buildProtocolInstance(params)
              built.instance = instance
              return instance
            },
            // The state each fold returns is dropped: the commit below replaces
            // participants and bag wholesale from the adopted snapshot, so only
            // these handlers' console output is wanted.
            onEvent: event => {
              try {
                applyOwnerEvent(ownerRef.current, event)
              } catch (err) {
                reportError(`Failed to handle a ${event.type} event from adoption`, err)
              }
            },
          },
        }),
      )
    } catch (err) {
      // The namespace is erased before `adoptReplicaSecret` can reject, so by
      // the time this runs the page's still-installed instance is bound to
      // stores that no longer exist. Continuing to poll, or letting the user
      // add a secret to a vault whose channels are gone, would quietly
      // manufacture state on top of a wipe — so the page stops being usable
      // until the device is inspected. Nothing is retried or repaired here.
      const failure = err instanceof ReplicaAdoptionError ? err.failure : describeRestoreFailure(err)
      // Persisted first: a reload must not be able to un-block a wiped device,
      // and the two in-memory copies below are gone the moment the tab is.
      saveReplicaAdoptionBlock(owner.ownerId, failure)
      adoptionBlockRef.current = failure
      setAdoptionBlock(failure)

      log({
        role: 'owner',
        flow: 'sharing',
        step: 'replica_adoption_failed',
        description: `Adoption of the mirrored vault failed after this device's vault was erased — the page is blocked: ${failure.text}`,
        payload: {
          code: failure.code,
          channelIds: failure.channelIds,
          wipeDidNotTake: failure.wipeDidNotTake,
          channelId: adoption.channelId,
          secretId: adoption.secretId,
          version: adoption.version,
        },
      })

      throw err
    }

    // Rebind this device to the adopted vault. The instance the page held was
    // bound to its own secret id over a namespace that no longer exists, so
    // leaving it in place would run every later flow against empty stores.
    if (built.instance) {
      instanceRef.current = built.instance
      ownSecretIdRef.current = outcome.secretId
    }

    // Non-fatal: without the roster the adopted helpers keep snapshot-only
    // identities, which backend polling cannot reconcile — but the adoption
    // itself has already committed.
    let actors: BEActorWithStatus[] = []
    try {
      actors = await apiGetActors()
    } catch (err) {
      reportError('Could not re-identify the adopted helpers against the roster', err, {
        secretId: outcome.secretId,
      })
    }

    const { participants, secretBag } = adoptedVaultState(adoption, actors, current.minParticipants)

    setActiveTab('participants')
    onUpdate({
      ...ownerRef.current,
      participants,
      secretBag,
      pendingPairings: [],
      heldShares: [],
      recoveredSecrets: [],
      recoveryProgress: null,
      recoveryFailures: [],
      mainChannels: [],
      ownSecretId: outcome.secretId,
    })

    log({
      role: 'owner',
      flow: 'sharing',
      step: 'replica_secret_adopted',
      description: `Adopted mirrored vault v${outcome.version} (${participants.length} helper(s), ${secretBag.currentVersion.secrets.length} secret(s)) — this device's own vault was erased`,
      payload: {
        secretId: outcome.secretId,
        version: outcome.version,
        replicaId: outcome.replicaId.toString(),
        fromReplicaId: adoption.fromReplicaId,
        channelId: adoption.channelId,
        teardownEvents: outcome.events.map(e => e.type),
      },
    })
  }

  function addPendingPairing(
    channelId: bigint,
    participantId?: string,
    peerTransportUri?: string,
  ) {
    const pending: PendingPairing = { channelId, participantId, peerTransportUri }
    const current = ownerRef.current
    const updated = { ...current, pendingPairings: [...current.pendingPairings, pending] }
    ownerRef.current = updated
    onUpdateRef.current(updated)
  }

  async function handleAddParticipant(name: string, autoPair: boolean) {
    const resp = await apiAddParticipant(name, provisioningSettings)
    const newParticipant: PairedParticipant = {
      id: resp.id,
      name: resp.name,
      channelId: '',
      transport: { protocol: resp.transport.protocol, uri: resp.transport.uri },
      connectionStatus: 'available',
      secretShares: [],
    }

    let updated = { ...owner, participants: [...owner.participants, newParticipant] }

    log({
      role: 'owner',
      flow: 'setup',
      step: 'participant_added',
      description: `Participant "${name}" added${autoPair ? ' (auto-pair)' : ''}`,
      payload: { participantId: resp.id, name, autoPair },
    })

    if (autoPair) {
      const protocol = ownInstance()?.protocol ?? null
      if (!protocol) {
        onUpdate(updated)
        return
      }
      try {
        const dto = await apiCreateActorContact(resp.id)
        const contact = dtoToContactMessage(dto)
        const channelId = await withProtocolLock(() =>
          protocol.start(FlowKind.Pairing, {
            kind: SenderKind.Owner,
            contact,
            peerCommunicationInfo: peerCommInfo(resp.name),
          }).then(pairingChannelIdFrom),
        )
        updated = {
          ...updated,
          pendingPairings: [...updated.pendingPairings, { channelId, participantId: resp.id }],
        }

        log({
          role: 'owner',
          flow: 'pairing',
          step: 'auto_pair_initiated',
          description: `Auto-pair initiated for ${name}`,
          payload: { participantId: resp.id, channelId: channelId.toString() },
        })
      } catch (err) {
        reportError(`Auto-pairing with "${name}" failed`, err, { participantId: resp.id })
      }
    }

    onUpdate(updated)
  }

  async function handleToggleStatus(participantId: string) {
    const resp = await apiToggleParticipantStatus(participantId)
    onUpdate({
      ...owner,
      participants: owner.participants.map(h =>
        h.id === participantId ? { ...h, offline: resp.disabled } : h,
      ),
    })

    log({
      role: 'owner',
      flow: 'setup',
      step: 'participant_status_toggled',
      description: `${owner.participants.find(h => h.id === participantId)?.name ?? participantId} is now ${resp.disabled ? 'offline' : 'online'}`,
      payload: { participantId, disabled: resp.disabled },
    })
  }

  /**
   * Send the actual `protocol.start(Unpair, …)`. Marks the channel as
   * in-flight before firing and clears the marker (and any open modal) on
   * dispatch failure. Terminal `Unpaired` / `UnpairRejected` events are
   * what normally clear the in-flight state (see the polling loop).
   */
  async function dispatchUnpair(
    channelId: string,
    peerName: string,
    participantId: string,
  ): Promise<void> {
    const protocol = ownInstance()?.protocol ?? null
    if (!protocol) {
      reportError('Unpair failed: protocol not initialised')
      return
    }

    setUnpairingChannelIds(prev => {
      const next = new Set(prev)
      next.add(channelId)
      return next
    })

    try {
      await withProtocolLock(() =>
        protocol.start(FlowKind.Unpair, {
          channel_id: channelId,
          memo: `unpair ${peerName}`,
        }),
      )
      log({
        role: 'owner',
        flow: 'unpairing',
        step: 'unpair_started',
        description: `Unpair request sent on channel ${channelId} (${peerName})`,
        payload: {
          channelId,
          participantId,
          unpairAck: owner.config?.unpairAck ?? 'required',
        },
      })
    } catch (err) {
      reportError('Failed to start unpair flow', err, { channelId, participantId })
      setUnpairingChannelIds(prev => {
        if (!prev.has(channelId)) return prev
        const next = new Set(prev)
        next.delete(channelId)
        return next
      })
      // If the modal was opened for this channel (Required path), close it
      // — the user shouldn't be stuck on a spinner that will never resolve.
      setOutgoingUnpairConfirmation(cur =>
        cur?.channelId === channelId ? null : cur,
      )
    }
  }

  /**
   * Entry point for the Unpair button. Branches on the owner's
   * `unpairAck` policy:
   *
   *   - **Required**: open a confirmation modal. Clicking "Unpair" inside
   *     the modal calls `dispatchUnpair` and keeps the modal open with a
   *     spinner — same pattern as the pairing modal. The modal closes when
   *     `Unpaired` / `UnpairRejected` arrives (or on the safety-net
   *     timeout below).
   *   - **NotRequired (fire-and-forget)**: skip the modal entirely. The
   *     library drops local state on `start(Unpair)` and emits `Unpaired`
   *     synchronously, which the polling loop turns into the channel being
   *     removed from the owner.
   *
   * Placeholder rows for not-yet-paired actors carry no channel ID — they
   * have no protocol state to tear down, so we drop them locally.
   */
  function handleTogglePair(participantId: string) {
    const participant = owner.participants.find(h => h.id === participantId)
    if (!participant) return

    if (participant.connectionStatus !== 'paired' || !participant.channelId) {
      onUpdate({
        ...owner,
        participants: owner.participants.filter(p => p.id !== participantId),
      })
      return
    }

    // An unpair request is already in flight for this channel — ignore the
    // click (the button is also disabled in the UI, but guard anyway).
    if (unpairingChannelIds.has(participant.channelId)) return

    const unpairAck = owner.config?.unpairAck ?? 'required'
    if (unpairAck === 'not_required') {
      void dispatchUnpair(participant.channelId, participant.name, participantId)
      return
    }

    setOutgoingUnpairConfirmation({
      participantId,
      peerName: participant.name,
      channelId: participant.channelId,
    })
  }

  /**
   * Cancel is only allowed before the request has been dispatched. Once the
   * envelope is on the wire we have to wait for the peer's ACK (or the
   * timeout sweep), otherwise we'd desync state from the peer.
   */
  function handleCancelOutgoingUnpair() {
    if (
      outgoingUnpairConfirmation &&
      unpairingChannelIds.has(outgoingUnpairConfirmation.channelId)
    ) {
      return
    }
    setOutgoingUnpairConfirmation(null)
  }

  async function handleConfirmOutgoingUnpair() {
    const confirmation = outgoingUnpairConfirmation
    if (!confirmation) return
    if (unpairingChannelIds.has(confirmation.channelId)) return

    // Intentionally do NOT close the modal here — under `UnpairAck::Required`
    // the user should see the in-flight state until the peer responds. The
    // modal closes when the polling loop receives the terminal `Unpaired` /
    // `UnpairRejected` event for this channel.
    await dispatchUnpair(
      confirmation.channelId,
      confirmation.peerName,
      confirmation.participantId,
    )
  }

  // Safety-net: if the library's internal timeout sweep doesn't emit an
  // Unpaired event for an in-flight outgoing unpair within the protocol
  // timeout window (plus a small grace), close the modal client-side. The
  // library should normally beat us to it — this just prevents the user
  // from being stranded on a spinner if the event never arrives.
  useEffect(() => {
    if (!outgoingUnpairConfirmation) return
    const cid = outgoingUnpairConfirmation.channelId
    if (!unpairingChannelIds.has(cid)) return

    const timer = setTimeout(() => {
      setUnpairingChannelIds(prev => {
        if (!prev.has(cid)) return prev
        const next = new Set(prev)
        next.delete(cid)
        return next
      })
      setOutgoingUnpairConfirmation(cur => (cur?.channelId === cid ? null : cur))
      reportError(
        `Unpair timed out — peer did not respond within ${Math.round(flowTimeoutMs / 1000)}s`,
        undefined,
        { channelId: cid },
      )
    }, flowTimeoutMs + 5000)

    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outgoingUnpairConfirmation, unpairingChannelIds])

  function handleLinkChannel(channelId: string) {
    setLinkSourceChannelId(channelId)
  }

  /**
   * Link two channels (undirected, transitive) and update the UI's
   * "main channel" presentation hint for the merged group. Shared by the
   * explicit "Link" action on the Channels tab and by the in-modal
   * "accept + link" path of the pairing-confirmation modal.
   *
   * Throws if the channel store isn't initialized — callers must handle.
   */
  async function linkChannelsAtomic(
    sourceChannelId: string,
    targetChannelId: string,
    options?: { mainChannelId?: string },
  ): Promise<void> {
    const channelStore = ownInstance()?.channelStore ?? null
    if (!channelStore) {
      throw new Error('Channel store not initialized')
    }

    // Determine the merged group's "main" (name-bearing) channel BEFORE
    // linking, from the pre-link closures:
    //  - `options.mainChannelId` wins when the caller knows which side carries
    //    the identity (the accept-and-link path, where the source is a channel
    //    that was named by whatever the requester declared on the wire)
    //  - if the source's group already has >1 channel, it keeps its main
    //  - else if the target's group already has >1 channel, it keeps its main
    //  - else (first-time link of two singletons) the clicked source is main
    const cur = ownerRef.current
    const pairedIds = new Set(
      cur.participants
        .filter(p => p.connectionStatus === 'paired' && p.channelId)
        .map(p => p.channelId),
    )
    const srcClosure = (await channelStore.linkedChannels(ownSecretIdRef.current, sourceChannelId))
      .filter(id => pairedIds.has(id))
    const tgtClosure = (await channelStore.linkedChannels(ownSecretIdRef.current, targetChannelId))
      .filter(id => pairedIds.has(id))
    const mains = cur.mainChannels ?? []
    const srcMain = srcClosure.find(id => mains.includes(id))
    const tgtMain = tgtClosure.find(id => mains.includes(id))

    let newMain: string
    if (options?.mainChannelId) newMain = options.mainChannelId
    else if (srcClosure.length > 1) newMain = srcMain ?? sourceChannelId
    else if (tgtClosure.length > 1) newMain = tgtMain ?? targetChannelId
    else newMain = sourceChannelId

    // Drop any prior mains that fall inside the now-merged component, then
    // record the single chosen main. Persist via owner state.
    const mergedIds = new Set<string>([
      ...srcClosure,
      ...tgtClosure,
      sourceChannelId,
      targetChannelId,
    ])
    const nextMains = (cur.mainChannels ?? []).filter(id => !mergedIds.has(id))
    nextMains.push(newMain)
    const updated = { ...cur, mainChannels: nextMains }
    ownerRef.current = updated
    onUpdateRef.current(updated)

    await channelStore.linkChannel(ownSecretIdRef.current, sourceChannelId, targetChannelId)
    setLinkVersion(v => v + 1)
    log({
      role: 'owner',
      flow: 'pairing',
      step: 'channel_linked',
      description: `Linked channel ${sourceChannelId} ↔ ${targetChannelId} (group main ${newMain})`,
      payload: { sourceChannelId, targetChannelId, mainChannelId: newMain },
    })
  }

  async function handleConfirmLink(targetChannelId: string) {
    const sourceChannelId = linkSourceChannelId
    if (!sourceChannelId) return

    try {
      await linkChannelsAtomic(sourceChannelId, targetChannelId)
    } catch (err) {
      log({
        role: 'owner',
        flow: 'pairing',
        step: 'channel_link_failed',
        description: `Failed to link channels: ${err instanceof Error ? err.message : String(err)}`,
        payload: { sourceChannelId, targetChannelId },
      })
    } finally {
      setLinkSourceChannelId(null)
    }
  }

  // A wipe-and-adopt erased this device's vault and then failed. Everything
  // below this point would operate over the erased namespace, so nothing below
  // renders. The library's own words are shown verbatim — this screen is the
  // only place they now live, since the dialog that raised them is unmounted
  // with the rest of the page.
  if (adoptionBlock) {
    return (
      <ReplicaAdoptionBlockedScreen failure={adoptionBlock} ownerName={owner.ownerName} />
    )
  }

  // Show a setup gate while auto-pairing is in progress.
  if (autoPairingIds.length > 0) {
    const pairedCount = autoPairingIds.filter(id =>
      owner.participants.some(h => h.id === id && h.connectionStatus === 'paired'),
    ).length
    const total = autoPairingIds.length

    return (
      <div className="owner-setup-gate">
        <h2 className="setup-gate-title">Setting up</h2>
        <p className="setup-gate-description">
          Pairing {total} participant{total > 1 ? 's' : ''}…
        </p>

        <div className="setup-gate-progress">
          <div className="share-progress-bar-track">
            <div
              className="share-progress-bar-fill"
              style={{ width: `${Math.round((pairedCount / total) * 100)}%` }}
              role="progressbar"
              aria-valuenow={pairedCount}
              aria-valuemin={0}
              aria-valuemax={total}
            />
          </div>
          <p className="share-progress-summary">{pairedCount} of {total} paired</p>
        </div>

        <ul className="share-progress-list" role="list">
          {autoPairingIds.map(id => {
            const participant = owner.participants.find(h => h.id === id)
            const isPaired = participant?.connectionStatus === 'paired'
            return (
              <li
                key={id}
                className={`share-progress-item ${isPaired ? 'share-progress-item--confirmed' : ''}`}
              >
                <span className="verify-progress-icon">
                  {isPaired
                    ? <span className="verify-progress-icon--done" aria-label="Paired">✓</span>
                    : <span className="verify-spinner" role="status" aria-label="Pairing…" />
                  }
                </span>
                <span className="share-progress-item-name">{participant?.name ?? id}</span>
                <span className={`share-progress-item-status ${isPaired ? 'status--verified' : ''}`}>
                  {isPaired ? 'Paired' : 'Pairing…'}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
    )
  }

  // The same timeout the protocol instance was built with, so every replica
  // countdown runs against the deadline the library will actually drop the
  // channel on.
  const protocolTimeoutSecs =
    owner.config?.protocolTimeoutSecs ?? DEFAULT_PROTOCOL_TIMEOUT_SECS

  const replicaViewByChannelId = new Map(
    replicaRows.flatMap(view => (view.channelId === null ? [] : [[view.channelId, view] as const])),
  )
  const provisionedReplicas = replicaRows.filter(view => view.provisioned)

  // The two channel lists, from one pass over the roster: participant channels
  // go to the Channels tab and replica channels to the Replicas tab, and a
  // channel is in exactly one of them.
  //
  // Channels the library still holds `Pending` are excluded outright rather
  // than listed with a caveat. They carry no shares and ignore inbound
  // messages, so counting one here would put a channel in the tally of what
  // protects this secret when it protects nothing.
  const pairedChannels = splitPairedChannels(
    owner.participants.filter(p => !p.channelId || !unconfirmedChannelIds.has(p.channelId)),
  )
  // Provisioned replicas that have never completed a handshake. A browser
  // replica always has a channel, so this can only be a hosted one waiting to
  // be paired from the side panel.
  const replicasAwaitingPairing = replicaRows.filter(view => view.channelId === null)

  // The row the fingerprint modal is for. Resolved by channel because that is
  // what both the auto-raise and the row's own prompt carry, and because a
  // provisioned replica and a browser peer are keyed differently everywhere
  // else.
  const fingerprintReplica =
    fingerprintChannelId === null ? null : replicaViewByChannelId.get(fingerprintChannelId) ?? null

  const adoptionLabel = pendingReplicaAdoption
    ? adoptionSourceLabel(pendingReplicaAdoption, rosterSnapshotRef.current ?? null)
    : ''
  const adoptionFailure = pendingReplicaAdoption
    ? (adoptionFailures[pendingReplicaAdoption.channelId] ?? null)
    : null

  return (
    <ProtocolConfigProvider timeoutMs={flowTimeoutMs}>
    <div className="owner-page">
      <div className="owner-info-bar">
        <div className="owner-badge">
          <span className="meta-label">Owner</span>
          <span className="owner-name">{owner.ownerName}</span>
        </div>

        <div className="header-transport">
          <span className="protocol-badge">{owner.transport.protocol.toUpperCase()}</span>
          <code className="header-uri">{owner.transport.uri}</code>
        </div>

        <div className="header-actions">
          <button className="primary" onClick={() => setShareOpen(true)}>
            Share Contact
          </button>
          <button className="secondary" onClick={() => setPairOpen(true)}>
            Pair
          </button>
          {(() => {
            // Count only channels that can actually receive a share.
            const pairedCount = owner.participants.filter(isShareTarget).length
            const belowMin = pairedCount < owner.minParticipants
            // No guard against a round already being in flight: the library
            // keys each publishing round by its version, so concurrent rounds
            // accumulate independently. They are routine here — pairing a
            // helper auto-publishes, and confirming a gated channel publishes
            // from `verifyFingerprint` — so blocking on one would disable this
            // button for reasons the user never caused.
            return (
              <button
                className="primary"
                onClick={() => setProtectOpen(true)}
                disabled={belowMin}
                title={
                  belowMin
                    ? `Need at least ${owner.minParticipants} paired participant${owner.minParticipants !== 1 ? 's' : ''} (currently ${pairedCount})`
                    : undefined
                }
              >
                {owner.secretBag ? 'Add Secret' : 'Protect Secret'}
              </button>
            )
          })()}
        </div>
      </div>

      {shareOpen && (
        <ShareContactModal
          title="Share Contact"
          transport={owner.transport}
          createContact={createOwnerContact}
          onClose={() => setShareOpen(false)}
        />
      )}

      {pairOpen && (
        <PairInitiatorModal
          label="Participant Contact QR Payload"
          placeholder="Paste the JSON payload from the participant's Share Contact QR code"
          pairedChannelIds={pairedChannelIds}
          pairingRejectionCount={pairingRejectionCount}
          pairingCompletedSignal={pairingCompletedSignal}
          onClose={() => setPairOpen(false)}
          onSuccess={() => {}}
          onPairingRequestSent={(channelId, participantId, peerTransportUri) =>
            addPendingPairing(channelId, participantId, peerTransportUri)
          }
          resolveParticipantId={contact =>
            owner.participants.find(p => p.transport.uri === contact.transport_protocol?.uri)?.id
          }
          startPairing={ownerStartPairing}
          // Browser-to-browser pairing does not go through the backend's
          // `start-pairing` route, so it is not bound by that route's
          // Owner/Helper contract: all four roles are on offer here, and a
          // browser replica is established by picking one of them.
          roleOptions={BROWSER_PAIRING_ROLE_OPTIONS}
        />
      )}

      {protectOpen && (
        <AddSecretModal
          participants={owner.participants}
          secretBag={owner.secretBag}
          threshold={owner.minParticipants}
          onClose={() => { setProtectOpen(false); setProtocolBusy(false) }}
          onAddSecret={ownerAddSecret}
        />
      )}

      {(() => {
        const pairedCount = owner.participants.filter(isShareTarget).length
        const belowMin = pairedCount < owner.minParticipants
        const belowRecommended = !belowMin && pairedCount < owner.recommendedParticipants
        if (belowMin) {
          return (
            <div className="owner-banner owner-banner--error" role="alert">
              Secret protection is disabled — {pairedCount} of {owner.minParticipants} required participants paired.
            </div>
          )
        }
        if (belowRecommended) {
          return (
            <div className="owner-banner owner-banner--warning" role="status">
              Only {pairedCount} of {owner.recommendedParticipants} recommended participants paired. Consider pairing more before protecting secrets.
            </div>
          )
        }
        return null
      })()}

      <div className="owner-layout">
        <div className="owner-content">
          <div className="tab-bar" role="tablist">
            <button
              role="tab"
              className={`tab-btn ${activeTab === 'participants' ? 'active' : ''}`}
              onClick={() => setActiveTab('participants')}
              aria-selected={activeTab === 'participants'}
            >
              Channels
              <span className="tab-count">{pairedChannels.participants.length}</span>
            </button>
            <button
              role="tab"
              className={`tab-btn ${activeTab === 'replicas' ? 'active' : ''}`}
              onClick={() => setActiveTab('replicas')}
              aria-selected={activeTab === 'replicas'}
            >
              Replicas
              <span className="tab-count">
                {pairedChannels.replicas.length + replicasAwaitingPairing.length}
              </span>
            </button>
            <button
              role="tab"
              className={`tab-btn ${activeTab === 'secrets' ? 'active' : ''}`}
              onClick={() => setActiveTab('secrets')}
              aria-selected={activeTab === 'secrets'}
            >
              Secret Bag
              <span className="tab-count">{owner.secretBag?.currentVersion.secrets.length ?? 0}</span>
            </button>
            <button
              role="tab"
              className={`tab-btn ${activeTab === 'shares' ? 'active' : ''}`}
              onClick={() => setActiveTab('shares')}
              aria-selected={activeTab === 'shares'}
            >
              Shares
              <span className="tab-count">{(owner.heldShares ?? []).length}</span>
            </button>
            {(
              <button
                role="tab"
                className={`tab-btn ${activeTab === 'recovery' ? 'active' : ''}`}
                onClick={() => setActiveTab('recovery')}
                aria-selected={activeTab === 'recovery'}
              >
                Recovery
                <span className="tab-count">{(owner.recoveredSecrets ?? []).length}</span>
              </button>
            )}
          </div>

          <div className="tab-panel" role="tabpanel">
            {activeTab === 'participants' && (
              <PairedParticipantsList
                groups={linkGroups}
                unpairingChannelIds={unpairingChannelIds}
                onTogglePair={handleTogglePair}
                onLink={handleLinkChannel}
              />
            )}
            {/*
              A listing only. The fingerprint modal is mounted below, outside
              this switch, and raises itself whether or not this tab has ever
              been opened — the tab offers the way *back* into it after a
              dismissal, nothing more.
            */}
            {activeTab === 'replicas' && (
              <ReplicasTab
                channels={pairedChannels.replicas}
                awaitingPairing={replicasAwaitingPairing}
                viewByChannelId={replicaViewByChannelId}
                protocolTimeoutSecs={protocolTimeoutSecs}
                syncingChannelId={syncingChannelId}
                unpairingChannelIds={unpairingChannelIds}
                syncNoticeFor={replicaSyncNoticeFor}
                onDismissSyncNotice={dismissReplicaSyncNotice}
                onOpenFingerprint={setFingerprintChannelId}
                onSyncNow={replica => void handleReplicaSyncNow(replica)}
                onUnpair={handleTogglePair}
                onSyncCheck={() => void handleSyncCheck()}
                syncCheckRunning={syncCheckRunning}
                onRemoveFromGroup={replica => void handleRemoveFromGroup(replica)}
                removingReplicaIds={removingReplicaIds}
              />
            )}
            {activeTab === 'secrets' && (
              <SecretBagPanel bag={owner.secretBag} participants={owner.participants} onVerify={ownerVerifyShares} onVerifyClose={() => setProtocolBusy(false)} onAddSecret={() => setProtectOpen(true)} />
            )}
            {activeTab === 'shares' && (
              <HeldSharesList
                shares={owner.heldShares ?? []}
                participants={owner.participants}
                ownerId={owner.ownerId}
                ownSecretId={owner.ownSecretId}
              />
            )}
            {activeTab === 'recovery' && (
              <RecoveryPanel
                owner={owner}
                onRequestDiscovery={ownerRequestDiscovery}
                onRecover={ownerRecoverSecret}
                onRestoreFromBag={handleRestoreFromBag}
              />
            )}
          </div>
        </div>

        <OwnerParticipantPanel
          participants={owner.participants.filter(
            p => !p.browserManaged && !isReplicaChannel(p),
          )}
          replicaSection={
            <OwnerReplicaSection
              replicas={provisionedReplicas}
              loaded={replicaRowsLoaded}
              onAdd={handleAddReplica}
              onPair={handlePairReplica}
              onToggleOffline={handleToggleReplicaOffline}
              onOpenFingerprint={setFingerprintChannelId}
            />
          }
          listChannels={listParticipantChannels}
          linkChannels={linkParticipantChannels}
          onTogglePair={handleTogglePair}
          onToggleParticipantStatus={handleToggleStatus}
          onPairingRequestSent={(channelId, actorId) => addPendingPairing(channelId, actorId)}
          onAddParticipant={handleAddParticipant}
          getParticipantFunctions={getParticipantFunctions}
          pairedChannelIds={pairedChannelIds}
          pairingRejectionCount={pairingRejectionCount}
          pairingCompletedSignal={pairingCompletedSignal}
          unconfirmedChannelIds={unconfirmedChannelIds}
          onConfirmFingerprint={channelId =>
            maybeRaiseFingerprintGate(channelId, ownerRef.current)
          }
        />
      </div>

      {/*
        Replica fingerprint comparison.

        Raised by `PairingCompleted` on both sides of a replica handshake rather
        than waiting to be found, and re-openable from the channel row or the
        side panel for as long as the channel is unconfirmed. `replicaProtocol`
        is a stable accessor that reads the instance at call time, so — unlike
        the panel this replaces — the control here can never be handed a `null`
        protocol captured during an early render and left disabled forever.
      */}
      {fingerprintReplica && (
        <AppMuiTheme>
          <ReplicaFingerprintDialog
            // A newly raised channel resets the dialog's own attempt state
            // rather than inheriting the previous channel's.
            key={fingerprintReplica.channelId ?? fingerprintReplica.id}
            open
            replica={fingerprintReplica}
            protocol={replicaProtocol}
            protocolTimeoutSecs={protocolTimeoutSecs}
            onConfirm={patch => handleReplicaConfirmed(fingerprintReplica.id, patch)}
            // Non-destructive by construction: nothing is written and nothing is
            // cancelled. The channel stays `Pending`, its row keeps a standing
            // prompt to reopen this, and the expiry keeps counting down.
            onClose={() => setFingerprintChannelId(null)}
          />
        </AppMuiTheme>
      )}

      {/*
        The same comparison for a *helper* channel paired with `NoKeys`. Kept
        page-level for the same reason as the replica dialog: the channel is
        unusable until it is resolved, whichever tab the user is on.
      */}
      {pendingFingerprintGate && (
        <AppMuiTheme>
          <ChannelFingerprintDialog
            key={pendingFingerprintGate.channelId}
            open
            peerName={pendingFingerprintGate.peerName}
            channelId={pendingFingerprintGate.channelId}
            peerActorId={pendingFingerprintGate.peerActorId}
            getFingerprint={channelId =>
              withProtocolLock(() => {
                const protocol = ownInstance()?.protocol
                if (!protocol) throw new Error('Protocol not initialised yet — try again in a moment.')
                return protocol.getFingerprint(channelId)
              })
            }
            verifyFingerprint={(channelId, fingerprint) =>
              withProtocolLock(() => {
                const protocol = ownInstance()?.protocol
                if (!protocol) throw new Error('Protocol not initialised yet — try again in a moment.')
                return protocol.verifyFingerprint(channelId, fingerprint)
              })
            }
            onConfirmed={channelId => {
              log({
                role: 'owner',
                flow: 'pairing',
                step: 'fingerprint_confirmed',
                description: `Confirmed the fingerprint for channel ${channelId}`,
                payload: { channelId },
              })
              // The library has just promoted the channel in its own store;
              // nothing else would tell React to look again.
              setChannelStatusNonce(n => n + 1)
            }}
            // Writes nothing: the channel stays `Pending` and is swept by the
            // tick if it is never confirmed.
            onClose={() => setPendingFingerprintGate(null)}
          />
        </AppMuiTheme>
      )}

      {/*
        A mirrored vault offered by a replica source. Page-level because it is an
        offer to erase this device, which must not depend on which tab is open.
      */}
      {pendingReplicaAdoption && (
        <AppMuiTheme>
          <Alert
            severity={adoptionFailure ? 'error' : 'warning'}
            sx={{ mx: 2, my: 1, textAlign: 'left' }}
            action={
              <Stack direction="row" spacing={1}>
                <Button color="inherit" size="small" onClick={() => setAdoptionOpen(true)}>
                  {adoptionFailure ? 'See what failed…' : 'Review…'}
                </Button>
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => setPendingReplicaAdoption(null)}
                >
                  Dismiss
                </Button>
              </Stack>
            }
          >
            {adoptionFailure ? (
              <>
                An earlier attempt to adopt {adoptionLabel}’s vault on this channel failed
                after this device’s own vault was erased, and will not be retried.{' '}
                {adoptionLabel} has since re-sent the copy (v{pendingReplicaAdoption.version}),
                but adopting it again is blocked until the device has been inspected.
              </>
            ) : (
              <>
                {adoptionLabel} sent this device a mirrored copy of their vault (v
                {pendingReplicaAdoption.version}, {pendingReplicaAdoption.shares.length} helper
                share{pendingReplicaAdoption.shares.length === 1 ? '' : 's'}). Adopting it
                erases everything this device holds. Nothing has been erased yet. Dismiss to
                discard the offer; the source's next sync will re-offer it.
              </>
            )}
          </Alert>

          {adoptionOpen && (
            <ReplicaAdoptionDialog
              // Keyed by the offered version so a newer offer arriving underneath
              // an open dialog resets its in-flight state rather than showing a
              // stale payload. `priorFailure` is what stops that reset from
              // re-arming a confirm whose previous attempt failed.
              key={`${pendingReplicaAdoption.channelId}:${pendingReplicaAdoption.version}`}
              open
              adoption={pendingReplicaAdoption}
              sourceLabel={adoptionLabel}
              onAdopt={handleAdoptReplicaSecret}
              priorFailure={adoptionFailure}
              onFailed={failure =>
                setAdoptionFailures(current => ({
                  ...current,
                  [pendingReplicaAdoption.channelId]: failure,
                }))
              }
              onAdopted={() => {
                setAdoptionOpen(false)
                setPendingReplicaAdoption(null)
                refreshReplicaRows()
              }}
              onCancel={() => {
                setAdoptionOpen(false)
                setPendingReplicaAdoption(null)
              }}
            />
          )}
        </AppMuiTheme>
      )}

      {/* Pairing confirmation modal — two views: decision and (User auth) link picker.
          A replica pairing takes the replica-specific dialog instead: it cannot be
          linked, and the destination side needs to be told what it is agreeing to.
          Both dialogs share the same accept/reject handlers. */}
      {pendingPairingConfirmation && (() => {
        const confirmation = pendingPairingConfirmation
        const replica = confirmation.replica
        if (replica) {
          return (
            <ReplicaPairingRequestDialog
              open
              peerName={confirmation.peerName}
              channelId={confirmation.channelId}
              localRole={replica.localRole}
              peerRole={replica.peerRole}
              onAccept={() => void handleAcceptPairing()}
              onReject={() => void handleRejectPairing()}
            />
          )
        }

        const userAuthMethod = owner.config?.authenticationMethod === 'user'
        // Linking declares two channels to belong to the same owner so shares
        // can be inherited. A replica channel holds no shares, so it is never a
        // candidate.
        const linkCandidates = owner.participants.filter(
          p =>
            p.connectionStatus === 'paired' &&
            p.channelId &&
            p.channelId !== confirmation.channelId &&
            !isReplicaChannel(p),
        )
        const linkAvailable = userAuthMethod && linkCandidates.length > 0

        return (
          <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="pairing-confirm-title">
            <div className="modal">
              <div className="modal-header">
                {pairingModalView === 'linking' && (
                  <button
                    type="button"
                    className="modal-back-btn"
                    onClick={() => {
                      setPairingModalView('decision')
                      setPairingLinkTarget(null)
                    }}
                    aria-label="Back to pairing decision"
                    disabled={pairingLinkSubmitting}
                  >
                    ‹ Back
                  </button>
                )}
                <h2 className="modal-title" id="pairing-confirm-title">
                  Incoming Pairing Request
                </h2>
              </div>

              <div className="modal-body">
                {pairingModalView === 'decision' ? (
                  <>
                    <p>
                      <strong>{confirmation.peerName}</strong>{' '}
                      wants to pair with you. Do you want to accept this pairing?
                    </p>
                    <div className="modal-actions">
                      <button className="secondary" onClick={handleRejectPairing}>
                        Reject
                      </button>
                      {linkAvailable && (
                        <button
                          className="secondary"
                          onClick={() => setPairingModalView('linking')}
                          title="Accept and link this channel to an existing one in a single step"
                        >
                          Link to existing
                        </button>
                      )}
                      <button className="primary" onClick={handleAcceptPairing}>
                        Accept
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p>
                      Pair with <strong>{confirmation.peerName}</strong> and link the new
                      channel to an existing one. Linked channels share their stored shares,
                      so a recovering owner can re-pair and inherit prior shares.
                    </p>

                    <div
                      className="link-channel-list"
                      role="listbox"
                      aria-label="Channels to link"
                    >
                      {linkCandidates.map(c => {
                        const isSelected = pairingLinkTarget === c.channelId
                        return (
                          <button
                            key={c.channelId}
                            type="button"
                            role="option"
                            aria-selected={isSelected}
                            className={`link-channel-option${isSelected ? ' link-channel-option--selected' : ''}`}
                            onClick={() => setPairingLinkTarget(c.channelId)}
                            disabled={pairingLinkSubmitting}
                          >
                            <span className="link-channel-option__name">
                              {c.name}
                              {c.peerRole && (
                                <span className={`role-tag role-tag--${c.peerRole}`}>
                                  {pairingRoleLabel(c.peerRole)}
                                </span>
                              )}
                            </span>
                            <span className="link-channel-option__meta">channel {c.channelId}</span>
                          </button>
                        )
                      })}
                    </div>

                    <div className="modal-actions">
                      <button
                        className="secondary"
                        onClick={() => {
                          setPairingModalView('decision')
                          setPairingLinkTarget(null)
                        }}
                        disabled={pairingLinkSubmitting}
                      >
                        Cancel
                      </button>
                      <button
                        className="primary"
                        onClick={() => pairingLinkTarget && handleAcceptAndLinkPairing(pairingLinkTarget)}
                        disabled={!pairingLinkTarget || pairingLinkSubmitting}
                      >
                        {pairingLinkSubmitting ? 'Pairing…' : 'Pair + Link'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )
      })()}

      {/* Store-share confirmation modal */}
      {pendingStoreShareConfirmation && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="storeshare-confirm-title">
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title" id="storeshare-confirm-title">Incoming Share Storage Request</h2>
            </div>
            <div className="modal-body">
              <p>
                <strong>{pendingStoreShareConfirmation.peerName}</strong> wants to store
                a secret share{pendingStoreShareConfirmation.description
                  ? ` ("${pendingStoreShareConfirmation.description}")`
                  : ''} — version {pendingStoreShareConfirmation.version}.
              </p>
              <p>Do you want to accept and store this share?</p>
              <div className="modal-actions">
                <button className="secondary" onClick={handleRejectStoreShare}>
                  Reject
                </button>
                <button className="primary" onClick={handleAcceptStoreShare}>
                  Accept
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Verify-share confirmation modal */}
      {pendingVerifyShareConfirmation && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="verifyshare-confirm-title">
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title" id="verifyshare-confirm-title">Incoming Verification Request</h2>
            </div>
            <div className="modal-body">
              <p>
                <strong>{pendingVerifyShareConfirmation.peerName}</strong> wants to verify
                that you still hold the secret share.
              </p>
              {pendingVerifyShareConfirmation.secretId && (
                <p className="verify-confirm-detail">
                  Secret ID: <code>{pendingVerifyShareConfirmation.secretId}</code>
                </p>
              )}
              <p className="verify-confirm-detail">
                Version: <strong>V{pendingVerifyShareConfirmation.version}</strong>
              </p>
              <p>Do you want to respond to this verification challenge?</p>
              <div className="modal-actions">
                <button className="secondary" onClick={handleRejectVerifyShare}>
                  Reject
                </button>
                <button className="primary" onClick={handleAcceptVerifyShare}>
                  Accept
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Unpair confirmation modal */}
      {pendingUnpairConfirmation && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="unpair-confirm-title">
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title" id="unpair-confirm-title">Incoming Unpair Request</h2>
            </div>
            <div className="modal-body">
              <p>
                <strong>{pendingUnpairConfirmation.peerName}</strong> wants to
                end the pairing on channel{' '}
                <code>{pendingUnpairConfirmation.channelId}</code>.
              </p>
              <p>
                Accepting drops the shared key, channel record, and any shares
                stored under this channel. The peer will be notified.
              </p>
              <div className="modal-actions">
                <button className="secondary" onClick={handleRejectUnpair}>
                  Reject
                </button>
                <button className="primary" onClick={handleAcceptUnpair}>
                  Accept
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Outgoing unpair confirmation modal (UnpairAck::Required path only) */}
      {outgoingUnpairConfirmation && (() => {
        const inFlight = unpairingChannelIds.has(outgoingUnpairConfirmation.channelId)
        return (
          <div
            className="modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="outgoing-unpair-confirm-title"
          >
            <div className="modal">
              <div className="modal-header">
                <h2 className="modal-title" id="outgoing-unpair-confirm-title">
                  {inFlight ? 'Unpairing channel…' : 'Unpair channel?'}
                </h2>
              </div>
              <div className="modal-body">
                {inFlight ? (
                  <p>
                    Waiting for{' '}
                    <strong>{outgoingUnpairConfirmation.peerName}</strong> to
                    acknowledge the unpair on channel{' '}
                    <code>{outgoingUnpairConfirmation.channelId}</code>.
                  </p>
                ) : (
                  <>
                    <p>
                      End the pairing with{' '}
                      <strong>{outgoingUnpairConfirmation.peerName}</strong> on
                      channel{' '}
                      <code>{outgoingUnpairConfirmation.channelId}</code>?
                    </p>
                    <p>
                      This drops the shared key, channel record, and any
                      shares stored under this channel on <em>both</em>{' '}
                      sides. The peer must acknowledge before the channel is
                      torn down locally.
                    </p>
                  </>
                )}
                <div className="modal-actions">
                  <button
                    className="secondary"
                    onClick={handleCancelOutgoingUnpair}
                    disabled={inFlight}
                  >
                    Cancel
                  </button>
                  <button
                    className="primary"
                    onClick={handleConfirmOutgoingUnpair}
                    disabled={inFlight}
                    aria-busy={inFlight || undefined}
                  >
                    {inFlight ? (
                      <>
                        <span className="modal-btn-spinner" aria-hidden="true" />
                        Unpairing…
                      </>
                    ) : (
                      'Unpair'
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Link channel modal */}
      {linkSourceChannelId && (() => {
        const sourceChannel = owner.participants.find(
          p => p.channelId === linkSourceChannelId,
        )
        if (!sourceChannel) return null
        const candidates = owner.participants.filter(
          p =>
            p.connectionStatus === 'paired' &&
            p.channelId &&
            p.channelId !== linkSourceChannelId,
        )
        return (
          <LinkChannelModal
            sourceChannel={sourceChannel}
            candidates={candidates}
            onConfirm={handleConfirmLink}
            onClose={() => setLinkSourceChannelId(null)}
          />
        )
      })()}
    </div>
    </ProtocolConfigProvider>
  )
}
