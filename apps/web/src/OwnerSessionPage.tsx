import { useState, useEffect, useRef, useMemo } from 'react'
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
import './OwnerSessionPage.css'
import type { ChannelRole, ParticipantConnectionStatus, OwnerSession, PairedParticipant, PairedReplica, PendingPairing, BagVersion, SecretBag, UserSecret, RecoveredSecret, RecoveredSecretSnapshot, RecoveryFailure, ReplicaStatus, SecretShareRef, Transport, HeldShare } from './types'
import { useConsole } from './ConsoleContext'
import { reportError, reportInfo } from './toastBus'
import { protocolTimeoutMs, DEFAULT_PROTOCOL_TIMEOUT_SECS } from './config'
import { ProtocolConfigProvider, useProtocolTimeoutMs } from './ProtocolConfig'
import { sendMessage, pollMailbox, fromBase64Url, toBase64Url, type MailboxMessage } from './derecApi'
import { makeChannelStore, makeSecretStore, makeShareStore, makeStateStore, makeUserSecretStore, makeTransport, clearNamespace, loadRawShare } from './stores'
import { resolvePeerActor } from './peerIdentity'
import { type GetSessionResponse, type PairingRole, type ProvisionedChannel, apiListParticipantChannels, apiLinkParticipantChannels, apiAddParticipant, apiAddReplica, apiConfirmReplicaFingerprint, apiCreateActorContact, apiGetBrowserContact, apiGetReplicaFingerprint, apiGetSession, apiPostBrowserContact, apiStartActorPairing, apiToggleParticipantStatus, apiToggleReplicaStatus, type ContactMessageDto } from './api'
import { faker } from '@faker-js/faker'

/**
 * Whether a channel is a target for our own secret's shares.
 *
 * Only channels where *this* node is the Owner qualify. On a helper-role
 * channel the peer protects their own secret and we hold shares for them —
 * sending ours there would be backwards. Pairing is bi-directional, so the
 * same peer can appear on both kinds of channel at once.
 *
 * The library applies the same rule when it picks helpers for a round; this
 * mirrors it so the app's pending marks and bag roster agree with what the
 * protocol actually sent.
 */
function isShareTarget(h: PairedParticipant): boolean {
  return h.connectionStatus === 'paired' && !!h.channelId && h.peerRole !== 'owner'
}

/**
 * The **peer's** role on a channel, from `PairingCompleted.kind`.
 *
 * `kind` is the *local* party's role — the library sets it from what this side
 * declared when the handshake ran — so the peer's is its inverse. Storing the
 * peer's role mirrors `Channel.peer_role`: a row describes who is on the other
 * end. Replica kinds collapse to a 'helper' peer here because this app only
 * distinguishes owner/helper for participant channels; replicas are tracked
 * separately.
 */
function peerRoleFromKind(kind: number | undefined): ChannelRole {
  return kind === SenderKind.Helper ? 'owner' : 'helper'
}

// ── Protocol instance registry ───────────────────────────────────────────────
//
// A DeRecProtocol instance is bound to exactly one `secret_id`, and both ends
// of a relationship must bind to the same one. This node therefore runs
// several instances at once: one for the secret it owns, plus one per owner it
// acts as Helper for. They share a localStorage namespace because every store
// is internally partitioned by secret id.

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
  /** Stable per-device id; required to take part in replica-mode pairing. */
  replicaId?: bigint
}

function buildProtocolInstance(opts: BuildProtocolOptions): ProtocolInstance {
  const channelStore = makeChannelStore(opts.namespace)
  const shareStore = makeShareStore(opts.namespace)

  let builder = new DeRecProtocolBuilder(BigInt(opts.secretId))
    .withChannelStore(channelStore)
    .withShareStore(shareStore)
    .withSecretStore(makeSecretStore(opts.namespace))
    .withUserSecretStore(makeUserSecretStore(opts.namespace))
    .withStateStore(makeStateStore(opts.namespace))
    .withTransport(makeTransport(sendMessage))
    .withOwnTransport({ uri: opts.ownTransportUri, protocol: 'https' })
    .withThreshold(opts.threshold)
    .withKeepVersionsCount(opts.keepVersionsCount)
    .withTimeout(opts.timeoutSecs)
    .withCommunicationInfo(opts.communicationInfo)
    .withUnpairAck(opts.unpairAck)

  if (opts.replicaId !== undefined) {
    builder = builder.withReplicaId(opts.replicaId)
  }

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


// ── ContactMessage transport form ────────────────────────────────────────────
//
// The protocol type uses `bigint` for `channel_id`/`nonce` and a numeric
// `protocol` discriminant, none of which survive JSON. The app's wire form
// (QR payload and the backend signaling DTO) therefore carries `u64`s as
// decimal strings, the transport protocol as a label, and binary fields
// base64url-encoded.
//
// Key material is optional: it is inlined only under ContactMode.InlineKeys.
// HashedKeys carries a SHA-384 binding hash instead and NoKeys carries
// neither, with the real keys fetched later over the PrePair round-trip.

/** Numeric TransportProtocol discriminant for HTTPS. */
const TRANSPORT_PROTOCOL_HTTPS = 0

function transportToWire(t: ContactMessage['transport_protocol']): { uri: string; protocol: string } {
  return { uri: t?.uri ?? '', protocol: 'https' }
}

function transportFromWire(t: { uri: string; protocol: string }): { uri: string; protocol: number } {
  return { uri: t.uri, protocol: TRANSPORT_PROTOCOL_HTTPS }
}

function contactMessageToDto(c: ContactMessage): ContactMessageDto {
  return {
    channel_id: c.channel_id.toString(),
    nonce: c.nonce.toString(),
    transport_protocol: transportToWire(c.transport_protocol),
    contact_mode: c.contact_mode,
    mlkem_encapsulation_key: c.mlkem_encapsulation_key
      ? toBase64Url(c.mlkem_encapsulation_key)
      : undefined,
    ecies_public_key: c.ecies_public_key ? toBase64Url(c.ecies_public_key) : undefined,
    contact_binding_hash: c.contact_binding_hash
      ? toBase64Url(c.contact_binding_hash)
      : undefined,
  }
}

function dtoToContactMessage(dto: ContactMessageDto): ContactMessage {
  return {
    channel_id: BigInt(dto.channel_id),
    nonce: BigInt(dto.nonce),
    transport_protocol: transportFromWire(dto.transport_protocol),
    contact_mode: dto.contact_mode ?? ContactMode.InlineKeys,
    mlkem_encapsulation_key: dto.mlkem_encapsulation_key
      ? fromBase64Url(dto.mlkem_encapsulation_key)
      : undefined,
    ecies_public_key: dto.ecies_public_key ? fromBase64Url(dto.ecies_public_key) : undefined,
    contact_binding_hash: dto.contact_binding_hash
      ? fromBase64Url(dto.contact_binding_hash)
      : undefined,
  }
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
 * The version the library assigned to a `start(ProtectSecret)` round.
 *
 * Version progression is anchored to the library's own user-secret snapshot,
 * which also bumps on pair-completion auto-publish — so the app cannot derive
 * it from its own bag history without drifting out of step. Read it back from
 * the dispatch events instead.
 */
function protectVersionFrom(events: DeRecEvent[]): number | null {
  for (const e of events) {
    if (e.type === 'ProtectSecretStarted' || e.type === 'SharingComplete') return e.version
  }
  return null
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
          replicas: secret.replicas.replicas.map(r => ({
            channelId: r.channel_id,
            transportUri: r.transport_uri,
            communicationInfo: r.communication_info,
            replicaId: r.replica_id,
            senderKind: r.sender_kind,
          })),
          sharedKey: toBase64Url(asBytes(secret.replicas.shared_key)),
        }
      : undefined,
    ownerReplicaId: secret.owner_replica_id,
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
          replicas: snapshot.replicas.replicas.map(r => ({
            channel_id: r.channelId,
            transport_uri: r.transportUri,
            communication_info: r.communicationInfo,
            replica_id: r.replicaId,
            sender_kind: r.senderKind,
          })),
          shared_key: fromBase64Url(snapshot.replicas.sharedKey),
        }
      : undefined,
    owner_replica_id: snapshot.ownerReplicaId,
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

/** The role that complements `role` — what the other side of a channel takes. */
function complementRole(role: PairingRole): PairingRole {
  return role === 'owner' ? 'helper' : 'owner'
}

/** `SenderKind` for an app-level pairing role. */
function senderKindFor(role: PairingRole): SenderKind {
  return role === 'owner' ? SenderKind.Owner : SenderKind.Helper
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

function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <button className="secondary copy-field-btn" onClick={handleCopy}>
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
  onAddSecret: (name: string, data: string) => Promise<void>
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
      await onAddSecret(form.name.trim(), form.data.trim())
      const newVersion = secretBag ? secretBag.currentVersion.version + 1 : 1
      setStatus({ kind: 'confirming', participantIds: pairedParticipants.map(h => h.id), version: newVersion })
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
 * Owner / Helper picker for a pairing.
 *
 * Pairing is bi-directional: whichever side initiates declares its own role on
 * the wire and the responder takes the complement.
 */
function PairingRoleSelector({
  value,
  onChange,
  disabled,
  idPrefix,
  legend = 'Your role',
  ownerHint,
  helperHint,
}: {
  value: PairingRole
  onChange: (role: PairingRole) => void
  disabled?: boolean
  idPrefix: string
  legend?: string
  ownerHint: string
  helperHint: string
}) {
  const options: Array<{ role: PairingRole; label: string; hint: string }> = [
    { role: 'owner', label: 'Owner', hint: ownerHint },
    { role: 'helper', label: 'Helper', hint: helperHint },
  ]

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

function ShareContactModal({
  title,
  transport,
  createContact,
  onClose,
  onPairingCreated,
}: {
  title: string
  transport: Transport
  createContact: () => Promise<ContactMessage>
  onClose: () => void
  onPairingCreated?: (channelId: bigint) => void
}) {
  const { log } = useConsole()
  const [step, setStep] = useState<ShareContactStep>({ kind: 'loading' })
  const [contact, setContact] = useState<ContactMessage | null>(null)

  const didInit = useRef(false)
  useEffect(() => {
    if (didInit.current) return
    didInit.current = true

    createContact()
      .then(c => {
        setContact(c)
        onPairingCreated?.(BigInt(c.channel_id))
        log({
          role: 'owner',
          flow: 'pairing',
          step: 'create_contact',
          description: `Contact created for ${transport.uri}`,
          payload: { channelId: c.channel_id.toString(), transportUri: transport.uri },
        })
      })
      .catch((err: unknown) => {
        setStep({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
          <p className="modal-description">
            A contact carries no role. Whoever scans this chooses which side
            they take, and you become the other one.
          </p>

          {step.kind === 'loading' && (
            <p className="modal-description">Generating contact message…</p>
          )}

          {step.kind === 'error' && (
            <p className="field-error">{step.message}</p>
          )}

          {step.kind === 'ready' && (
            <>
              <div className="qr-wrapper">
                <QRCodeSVG value={step.qrPayload} size={200} />
              </div>

              <div className="modal-section">
                <h3 className="sub-heading">Copy</h3>
                <div className="copy-row">
                  <CopyButton label="QR Payload" text={step.qrPayload} />
                  <CopyButton label="Raw Bytes (hex)" text={step.rawHex} />
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

function PairInitiatorModal({
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
  fixedRole,
  defaultRole,
  initiatorLabel,
  ownerHint,
  helperHint,
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
  startPairing: (contact: ContactMessage, role: PairingRole) => Promise<bigint>
  /** Role the initiator takes. Fixed for flows that only make sense one way
   *  (replica provisioning); selectable otherwise. */
  fixedRole?: PairingRole
  /** Which role the selector starts on. */
  defaultRole?: PairingRole
  /** Who is doing the pairing, for the selector's labels. Defaults to us. */
  initiatorLabel?: string
  ownerHint?: string
  helperHint?: string
}) {
  const { log } = useConsole()
  const timeoutMs = useProtocolTimeoutMs()
  const [payload, setPayload] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<PairInitiatorStep>({ kind: 'input' })
  // A contact carries no role, so nothing here is inferred from the payload:
  // the initiator picks its own side and the responder gets the complement.
  const [role, setRole] = useState<PairingRole>(fixedRole ?? defaultRole ?? 'owner')

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
    setStep({ kind: 'sending' })
    try {
      const contact = deserializeContact(payload.trim())
      const channelId = await startPairing(contact, role)

      log({
        role: 'owner',
        flow: 'pairing',
        step: 'start_pairing',
        description: `Pairing request sent for channel ${channelId.toString()} as ${role}`,
        payload: { channelId: channelId.toString(), role },
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
            <p className="modal-description">
              {role === 'owner'
                ? 'Pairing completed successfully. The helper is now ready to receive shares.'
                : 'Pairing completed successfully. The owner can now distribute shares here.'}
            </p>
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
              <label className="form-label" htmlFor="qr-payload">{label}</label>
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
              {error && <p className="field-error">{error}</p>}
            </div>

            {!fixedRole && (
              <>
                <PairingRoleSelector
                  value={role}
                  onChange={setRole}
                  disabled={step.kind === 'sending'}
                  idPrefix="pair"
                  legend={initiatorLabel ? `${initiatorLabel} role` : 'Your role'}
                  ownerHint={
                    ownerHint ?? 'You protect the secret; the peer holds a share for you.'
                  }
                  helperHint={
                    helperHint ?? 'You hold a share; the peer protects their own secret.'
                  }
                />
                <p className="modal-description">
                  The other side becomes <strong>{complementRole(role)}</strong> on this channel.
                </p>
              </>
            )}

            <div className="modal-actions">
              <button type="button" className="secondary" onClick={handleClose} disabled={step.kind === 'sending'}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={payload.trim().length === 0 || step.kind === 'sending'}>
                {step.kind === 'sending' ? 'Sending…' : `Pair as ${role}`}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

//
// Tracks the replica through: Pairing → Confirmation → Fingerprint → Done
// The `replica` prop is live (refreshes from session state as events arrive).

function ReplicaProvisioningModal({
  replica,
  onPairingRequestSent,
  startPairing,
  onConfirm,
  onClose,
}: {
  replica: PairedReplica
  onPairingRequestSent: (channelId: bigint, replicaId: string) => void
  startPairing: (contact: ContactMessage, role: PairingRole) => Promise<bigint>
  onConfirm: (replicaId: string) => void
  onClose: () => void
}) {
  const { log } = useConsole()
  const [payload, setPayload] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<'input' | 'progress'>(
    replica.status === 'available' ? 'input' : 'progress',
  )
  const [sending, setSending] = useState(false)

  const pairingDone = replica.status === 'paired' || replica.status === 'confirmed'
  const isConfirmed = replica.status === 'confirmed'
  const hasFingerprint = !!replica.replicaFingerprint
  const isBlocking = phase === 'progress' && !pairingDone

  const [remainingMs, setRemainingMs] = useState<number | null>(null)
  useEffect(() => {
    if (!replica.confirmationStartedAt || isConfirmed) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRemainingMs(null)
      return
    }
    function tick() {
      const elapsed = Date.now() - replica.confirmationStartedAt!
      const remaining = Math.max(0, 5 * 60 * 1000 - elapsed)
      setRemainingMs(remaining)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [replica.confirmationStartedAt, isConfirmed])

  const timedOut = remainingMs !== null && remainingMs <= 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSending(true)
    try {
      const contact = deserializeContact(payload.trim())
      // Replica provisioning is owner-driven: this is the owner adding one of
      // its own devices, so there is no role to choose.
      const channelId = await startPairing(contact, 'owner')

      log({
        role: 'owner',
        flow: 'replica',
        step: 'start_pairing',
        description: `Replica pairing request sent for channel ${channelId.toString()}`,
        payload: { channelId: channelId.toString(), replicaId: replica.id },
      })

      onPairingRequestSent(channelId, replica.id)
      setPhase('progress')
    } catch (err) {

      setError(`Failed: ${err instanceof Error ? err.message : String(err)}`)
      setSending(false)
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="replica-prov-title">
      <div className="modal verify-modal--progress">
        <div className="modal-header">
          <h2 className="modal-title" id="replica-prov-title">Replica Provisioning</h2>
          {!isBlocking && <ModalCloseButton onClose={onClose} />}
        </div>

        {phase === 'progress' ? (
          <div className="modal-body">
            <p className="modal-description">
              Setting up {replica.name}. Protocol messages are being exchanged automatically.
            </p>

            <ul className="share-progress-list" role="list">
              {/* Step 1: Pairing */}
              <li className={`share-progress-item${pairingDone ? ' share-progress-item--confirmed' : ''}`}>
                <span className="verify-progress-icon">
                  {pairingDone
                    ? <span className="verify-progress-icon--done" aria-label="Done">&#10003;</span>
                    : <span className="verify-spinner" role="status" aria-label="In progress" />
                  }
                </span>
                <span className="share-progress-item-name">Pairing</span>
                <span className={`share-progress-item-status${pairingDone ? ' status--verified' : ''}`}>
                  {pairingDone ? 'Done' : 'Exchanging messages\u2026'}
                </span>
              </li>

              {/* Step 2: Fingerprint confirmation */}
              {pairingDone && (
                <li className={`share-progress-item${isConfirmed ? ' share-progress-item--confirmed' : ''}`}>
                  <span className="verify-progress-icon">
                    {isConfirmed
                      ? <span className="verify-progress-icon--done" aria-label="Done">&#10003;</span>
                      : hasFingerprint
                        ? <span className="verify-progress-icon--action" aria-label="Action required">!</span>
                        : <span className="verify-spinner" role="status" aria-label="Fetching fingerprint" />
                    }
                  </span>
                  <span className="share-progress-item-name">Fingerprint Confirmation</span>
                  <span className={`share-progress-item-status${isConfirmed ? ' status--verified' : ''}`}>
                    {isConfirmed ? 'Confirmed' : hasFingerprint ? 'Awaiting confirmation' : 'Fetching fingerprint\u2026'}
                  </span>
                </li>
              )}
            </ul>

            {/* Fingerprint display + confirm button */}
            {pairingDone && hasFingerprint && !isConfirmed && !timedOut && (
              <div className="replica-confirm-section">
                <p className="replica-confirm-hint">
                  Verify this fingerprint matches on the replica device:
                </p>
                <code className="replica-fingerprint-display">{replica.replicaFingerprint}</code>
                {remainingMs !== null && (
                  <p className="replica-confirm-timer">
                    Time remaining: {Math.floor(remainingMs / 60000)}:{String(Math.floor((remainingMs % 60000) / 1000)).padStart(2, '0')}
                  </p>
                )}
                <button className="primary" onClick={() => onConfirm(replica.id)}>
                  Confirm Fingerprint
                </button>
              </div>
            )}

            {timedOut && !isConfirmed && (
              <p className="replica-confirm-expired">
                Confirmation window expired. Remove and re-pair this replica.
              </p>
            )}

            <div className="modal-actions">
              <button
                type="button"
                className={(pairingDone && (isConfirmed || timedOut)) ? 'primary' : 'secondary'}
                onClick={onClose}
              >
                {isConfirmed ? 'Done' : 'Close'}
              </button>
            </div>
          </div>
        ) : (
          <form className="modal-body" onSubmit={handleSubmit}>
            <div className="form-field">
              <label className="form-label" htmlFor="replica-qr-payload">Owner Contact QR Payload</label>
              <textarea
                id="replica-qr-payload"
                className="full-input mono-textarea"
                rows={4}
                placeholder="Paste the JSON payload from the owner's Share Contact QR code"
                value={payload}
                onChange={e => setPayload(e.target.value)}
                disabled={sending}
                autoFocus
                spellCheck={false}
              />
              {error && <p className="field-error">{error}</p>}
            </div>

            <div className="modal-actions">
              <button type="button" className="secondary" onClick={onClose} disabled={sending}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={payload.trim().length === 0 || sending}>
                {sending ? 'Sending\u2026' : 'Pair'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

export function SessionIdBadge({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(id).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="session-id-badge">
      <span className="meta-label">Session ID</span>
      <code className="session-id-value" title={id}>{id.slice(0, 8)}…</code>
      <button className="secondary copy-btn" onClick={handleCopy} aria-label="Copy full session ID">
        {copied ? 'Copied!' : 'Copy'}
      </button>
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
// Progress updates automatically: `secret` is a prop that refreshes from session
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
    return <p className="tab-empty-state">No paired participants yet. Add and pair one from the side panel.</p>
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
                    {h.peerRole === 'owner' ? 'Owner' : 'Helper'}
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
                      {h.peerRole === 'owner' ? 'Owner' : 'Helper'}
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
                          {c.peerRole === 'owner' ? 'Owner' : 'Helper'}
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

  function toggle(id: string) {
    setRevealedSecrets(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleRestoreClick() {
    if (restoring) return
    const ok = window.confirm(
      'Recover from this bag?\n\n' +
      'This will replace all current channels, secrets and shares with what ' +
      'this bag holds, then exit recovery mode. The recovery-paired helpers ' +
      'will be unlinked from the app (they remain paired on their side).',
    )
    if (!ok) return
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
          onClick={handleRestoreClick}
          disabled={restoring}
          title="Restore channels, secret bag and shares from this recovered bag and exit recovery mode."
        >
          {restoring ? 'Restoring…' : 'Recover'}
        </button>
      </div>
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

function replicaStatusLabel(status: ReplicaStatus): string {
  switch (status) {
    case 'available':  return 'Available'
    case 'paired':     return 'Paired'
    case 'confirmed':  return 'Confirmed'
  }
}

function ReplicaCard({
  replica,
  onConfirm,
}: {
  replica: PairedReplica
  onConfirm?: (replicaId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)

  const isPaired = replica.status === 'paired'
  const isConfirmed = replica.status === 'confirmed'
  const awaitingConfirmation = isPaired && !isConfirmed && !!replica.replicaFingerprint

  const [remainingMs, setRemainingMs] = useState<number | null>(null)
  useEffect(() => {
    if (!replica.confirmationStartedAt || isConfirmed) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRemainingMs(null)
      return
    }
    function tick() {
      const elapsed = Date.now() - replica.confirmationStartedAt!
      const remaining = Math.max(0, 5 * 60 * 1000 - elapsed)
      setRemainingMs(remaining)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [replica.confirmationStartedAt, isConfirmed])

  const timedOut = remainingMs !== null && remainingMs <= 0

  return (
    <div className={`detail-card collapsible ${expanded ? 'expanded' : ''}`}>
      <button
        type="button"
        className="card-header card-toggle"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
      >
        <span className="card-title">
          <span
            className="participant-dot"
            style={{
              background:
                isConfirmed ? 'var(--clr-success, #22c55e)'
                : isPaired ? 'var(--clr-accent)'
                : 'var(--clr-muted)',
            }}
          />
          {replica.name}
        </span>
        <span className={`status-tag ${replica.status}`}>
          {replicaStatusLabel(replica.status)}
        </span>
        <span className="chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="card-body">
          <dl className="field-list">
            <div className="field-row">
              <dt>Protocol</dt>
              <dd><span className="protocol-badge">{replica.transport.protocol.toUpperCase()}</span></dd>
            </div>
            <div className="field-row">
              <dt>URI</dt>
              <dd><code className="uri-value">{replica.transport.uri}</code></dd>
            </div>
            {replica.channelId && (
              <div className="field-row">
                <dt>Channel ID</dt>
                <dd><code className="mono-value">{replica.channelId}</code></dd>
              </div>
            )}
            {replica.replicaFingerprint && (
              <div className="field-row">
                <dt>Fingerprint</dt>
                <dd><code className="mono-value">{replica.replicaFingerprint}</code></dd>
              </div>
            )}
          </dl>

          {awaitingConfirmation && !timedOut && onConfirm && (
            <div className="replica-confirm-section">
              <p className="replica-confirm-hint">
                Verify the fingerprint matches on both devices, then confirm.
              </p>
              {remainingMs !== null && (
                <p className="replica-confirm-timer">
                  Time remaining: {Math.floor(remainingMs / 60000)}:{String(Math.floor((remainingMs % 60000) / 1000)).padStart(2, '0')}
                </p>
              )}
              <button className="primary" onClick={() => onConfirm(replica.id)}>
                Confirm Fingerprint
              </button>
            </div>
          )}

          {timedOut && !isConfirmed && (
            <p className="replica-confirm-expired">
              Confirmation window expired. Remove and re-pair this replica.
            </p>
          )}
        </div>
      )}
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

function ReplicasList({
  replicas,
  onConfirm,
}: {
  replicas: PairedReplica[]
  onConfirm: (replicaId: string) => void
}) {
  const paired = replicas.filter(r => r.status !== 'available')
  if (paired.length === 0) {
    return (
      <p className="tab-empty-state">
        No replicas paired yet. Add and pair a replica from the side panel.
      </p>
    )
  }
  return (
    <div className="card-list">
      {paired.map(r => (
        <ReplicaCard
          key={r.id}
          replica={r}
          onConfirm={onConfirm}
        />
      ))}
    </div>
  )
}

function RecoveryPanel({
  session,
  onRequestDiscovery,
  onRecover,
  onRestoreFromBag,
}: {
  session: OwnerSession
  onRequestDiscovery: () => Promise<void>
  onRecover: (secretId: string, version: number, label: string, participantChannelIds: bigint[]) => Promise<void>
  onRestoreFromBag: (secret: RecoveredSecret) => Promise<void>
}) {
  // Every paired helper is a discovery candidate. There is no separate
  // "recovery pairing" any more: a re-paired owner looks like any other, and
  // whether a helper can answer depends on it having *linked* the channel to
  // an owner it already helps — which happens on the helper's side.
  const recoveryParticipants = session.participants.filter(
    h => h.connectionStatus === 'paired' && h.channelId,
  )
  const recoveredSecrets = session.recoveredSecrets ?? []
  const alreadyRecoveredKeys = new Set(recoveredSecrets.map(s => `${s.secretId}:${s.version}`))
  const recoveryProgress = session.recoveryProgress

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
                          session.recoveryFailures,
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
}: {
  participant: PairedParticipant
  onTogglePair: (id: string) => void
  onToggleStatus: (participantId: string) => Promise<void>
  onPairingRequestSent: (channelId: bigint, participantId: string) => void
  createParticipantContact: () => Promise<ContactMessage>
  /** List the channels this provisioned helper holds, for the link picker. */
  listChannels: (participantId: string) => Promise<ProvisionedChannel[]>
  /** Declare that two of its channels belong to the same owner. */
  linkChannels: (participantId: string, channelId: string, linkTo: string) => Promise<void>
  startParticipantPairing: (contact: ContactMessage, role: PairingRole) => Promise<bigint>
  /**
   * When defined, the Pair button opens a modal for the user to paste the peer's
   * contact JSON. The backend actor then initiates pairing using that contact,
   * taking the complement of the role chosen here.
   */
  startPairingAsInitiator?: (ownerContact: ContactMessage, role: PairingRole) => Promise<bigint>
  pairedChannelIds: Set<string>
  pairingRejectionCount: number
  pairingCompletedSignal: number
}) {
  const [expanded, setExpanded] = useState(false)
  const [shareContactOpen, setShareContactOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [pairAsInitiatorOpen, setPairAsInitiatorOpen] = useState(false)
  const [isPairing, setIsPairing] = useState(false)
  const [pairError, setPairError] = useState<string | null>(null)
  const [togglingStatus, setTogglingStatus] = useState(false)
  const isPaired = participant.connectionStatus === 'paired'
  const isOffline = !!participant.offline

  async function handlePair() {
    if (startPairingAsInitiator) {
      // Flow 1: open a modal so the user can paste the owner's contact JSON.
      // The backend actor will initiate pairing using that contact.
      setPairAsInitiatorOpen(true)
      return
    }
    // Flow 2: owner's WASM fetches the participant's contact and initiates pairing.
    setIsPairing(true)
    setPairError(null)
    try {
      const contact = await createParticipantContact()
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
            {isPaired ? (
              <button className="pair-action-btn unpair" onClick={() => onTogglePair(participant.id)}>
                Unpair
              </button>
            ) : !isOffline ? (
              <button
                className="pair-action-btn pair"
                disabled={isPairing}
                onClick={handlePair}
              >
                {isPairing ? 'Pairing…' : 'Pair'}
              </button>
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
          // we end up on the other side of the channel.
          defaultRole="helper"
          initiatorLabel={`${participant.name}'s`}
          ownerHint={`${participant.name} protects a secret; you hold a share for them.`}
          helperHint={`${participant.name} holds a share; you protect the secret.`}
        />
      )}
    </li>
  )
}

export function JoinQrModal({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, '')
  const joinUrl = `${window.location.origin}${basePath}/session/${sessionId}/join`

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Invite participant">
      <div className="modal" style={{ maxWidth: 400, textAlign: 'center' }}>
        <div className="modal-header">
          <h2 className="modal-title">Invite to Session</h2>
          <ModalCloseButton onClose={onClose} />
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
          <p className="modal-description">
            Scan this QR code or share the link to join as a participant from another device.
          </p>
          <QRCodeSVG
            value={joinUrl}
            size={200}
            bgColor="transparent"
            fgColor="currentColor"
          />
          <code style={{ fontSize: '0.85rem', wordBreak: 'break-all', userSelect: 'all' }}>{joinUrl}</code>
          <div className="modal-actions">
            <button className="primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
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

function SidePanelReplicaItem({
  replica,
  onToggleStatus,
  onPairingCreated,
  onPairStarted,
  createReplicaContact,
}: {
  replica: PairedReplica
  onToggleStatus: (replicaId: string) => Promise<void>
  onPairingCreated: (channelId: bigint, replicaId: string) => void
  onPairStarted: (replicaId: string) => void
  createReplicaContact: () => Promise<ContactMessage>
}) {
  const [expanded, setExpanded] = useState(false)
  const [shareContactOpen, setShareContactOpen] = useState(false)
  const [togglingStatus, setTogglingStatus] = useState(false)
  const [pairingInProgress, setPairingInProgress] = useState(false)
  const isPaired = replica.status !== 'available'
  const isOffline = !!replica.offline

  useEffect(() => {
    if (isPaired && pairingInProgress) setPairingInProgress(false)
  }, [isPaired, pairingInProgress])

  return (
    <li className="side-participant-item">
      <button
        type="button"
        className="side-participant-header"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
      >
        <span
          className="participant-dot"
          style={{
            background:
              isOffline ? 'var(--clr-muted)'
              : pairingInProgress ? 'var(--clr-warning, #f59e0b)'
              : replica.status === 'confirmed' ? 'var(--clr-success, #22c55e)'
              : replica.status === 'paired' ? 'var(--clr-accent)'
              : 'var(--clr-muted)',
          }}
        />
        <span className="side-participant-name">{replica.name}</span>
        {isOffline ? (
          <span className="status-tag offline">Offline</span>
        ) : pairingInProgress ? (
          <span className="status-tag confirming">Pairing…</span>
        ) : (
          <span className={`status-tag ${replica.status}`}>
            {replicaStatusLabel(replica.status)}
          </span>
        )}
        <ChevronIcon expanded={expanded} />
      </button>

      {expanded && (
        <div className="side-participant-details">
          {pairingInProgress && (
            <p className="side-detail-progress">
              Pairing in progress — waiting for protocol messages to be exchanged…
            </p>
          )}
          {replica.channelId && (
            <div className="side-detail-row">
              <span className="side-detail-label">Channel ID</span>
              <ClickToCopyCode value={replica.channelId} />
            </div>
          )}
          {!pairingInProgress && (
            <div className="side-detail-row">
              <span className="side-detail-label">Status</span>
              <span>{replicaStatusLabel(replica.status)}</span>
            </div>
          )}
          <div className="side-participant-actions">
            <button
              className="secondary side-action-btn"
              onClick={() => setShareContactOpen(true)}
            >
              Share Contact
            </button>
            <button
              className={`pair-action-btn ${isOffline ? 'pair' : 'unpair'}`}
              disabled={togglingStatus}
              onClick={async () => {
                setTogglingStatus(true)
                try { await onToggleStatus(replica.id) } finally { setTogglingStatus(false) }
              }}
            >
              {togglingStatus ? '…' : isOffline ? 'Go Online' : 'Go Offline'}
            </button>
            {!isPaired && !isOffline && !pairingInProgress && (
              <button className="pair-action-btn pair" onClick={() => onPairStarted(replica.id)}>
                Pair
              </button>
            )}
          </div>
        </div>
      )}

      {shareContactOpen && (
        <ShareContactModal
          title={`Share ${replica.name} Contact`}
          transport={replica.transport}
          createContact={createReplicaContact}
          onClose={() => setShareContactOpen(false)}
          onPairingCreated={channelId => {
            onPairingCreated(channelId, replica.id)
          }}
        />
      )}
    </li>
  )
}

function SessionParticipantPanel({
  participants,
  replicas,
  onTogglePair,
  onToggleParticipantStatus,
  onToggleReplicaStatus,
  onPairingCreated,
  onPairingRequestSent,
  listChannels,
  linkChannels,
  onAddParticipant,
  onAddReplica,
  onReplicaPairStarted,
  getParticipantFunctions,
  getReplicaFunctions,
  pairedChannelIds,
  pairingRejectionCount,
  pairingCompletedSignal,
}: {
  participants: PairedParticipant[]
  replicas: PairedReplica[]
  onTogglePair: (id: string) => void
  onToggleParticipantStatus: (participantId: string) => Promise<void>
  onToggleReplicaStatus: (replicaId: string) => Promise<void>
  onPairingCreated: (channelId: bigint, actorId: string) => void
  onPairingRequestSent: (channelId: bigint, actorId: string) => void
  onAddParticipant: (name: string, autoPair: boolean) => Promise<void>
  onAddReplica: (name: string) => Promise<void>
  onReplicaPairStarted: (replicaId: string) => void
  listChannels: (participantId: string) => Promise<ProvisionedChannel[]>
  linkChannels: (participantId: string, channelId: string, linkTo: string) => Promise<void>
  getParticipantFunctions: (participantId: string) => {
    createContact: () => Promise<ContactMessage>
    startPairing: (contact: ContactMessage, role: PairingRole) => Promise<bigint>
    startPairingAsInitiator?: (ownerContact: ContactMessage, role: PairingRole) => Promise<bigint>
  }
  getReplicaFunctions: (replicaId: string) => {
    createContact: () => Promise<ContactMessage>
    startPairing: (contact: ContactMessage, role: PairingRole) => Promise<bigint>
  }
  pairedChannelIds: Set<string>
  pairingRejectionCount: number
  pairingCompletedSignal: number
}) {
  const [addParticipantOpen, setAddParticipantOpen] = useState(false)
  const [addingReplica, setAddingReplica] = useState(false)

  return (
    <aside className="side-panel" aria-label="Session actors">
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
            title="Add a new participant to this session"
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
              />
            )
          })}
        </ul>
      </div>

      {/* ── Replicas section ────────────────────────────────────────── */}
      <div className="side-panel-section">
        <div className="panel-header-row">
          <div>
            <h3 className="panel-heading">Replicas</h3>
            <p className="panel-subtitle">{replicas.length} provisioned</p>
          </div>
          <button
            className="secondary small"
            disabled={addingReplica}
            onClick={async () => {
              setAddingReplica(true)
              try {
                await onAddReplica(`${faker.person.firstName()} ${faker.person.lastName()}`)
              } finally {
                setAddingReplica(false)
              }
            }}
            title="Add a new replica to this session"
          >
            {addingReplica ? '…' : '+ Add'}
          </button>
        </div>
        {replicas.length === 0 ? (
          <p className="panel-empty-hint">No replicas yet</p>
        ) : (
          <ul className="side-participant-list" role="list">
            {replicas.map(r => {
              const { createContact } = getReplicaFunctions(r.id)
              return (
                <SidePanelReplicaItem
                  key={r.id}
                  replica={r}
                  onToggleStatus={onToggleReplicaStatus}
                  onPairingCreated={onPairingCreated}
                  onPairStarted={onReplicaPairStarted}
                  createReplicaContact={createContact}
                />
              )
            })}
          </ul>
        )}
      </div>

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

type ActiveTab = 'participants' | 'secrets' | 'shares' | 'recovery' | 'replicas'

interface Props {
  session: OwnerSession
  onUpdate: (updated: OwnerSession) => void
}

export default function OwnerSessionPage({ session, onUpdate }: Props) {
  const { log } = useConsole()
  // Single per-session protocol timeout (ms) — drives the FE watchdog and all
  // app-level wall-clock timers; the same value (in seconds) is passed to the
  // WASM constructor for the library's passive process() expiry.
  const flowTimeoutMs = protocolTimeoutMs(session.config?.protocolTimeoutSecs)
  const [activeTab, setActiveTab] = useState<ActiveTab>(
    'participants',
  )
  const [shareOpen, setShareOpen] = useState(false)
  const [pairOpen, setPairOpen] = useState(false)
  const [provisioningReplicaId, setProvisioningReplicaId] = useState<string | null>(null)
  const [protectOpen, setProtectOpen] = useState(false)
  const [protocolBusy, setProtocolBusy] = useState(false)

  // Set of paired channel IDs watched by PairInitiatorModal to detect when pairing completes.
  const pairedChannelIds = useMemo(() => {
    const ids = new Set<string>()
    for (const p of session.participants) {
      if (p.connectionStatus === 'paired' && p.channelId) ids.add(p.channelId)
    }
    for (const r of session.replicas ?? []) {
      if (r.status === 'paired' && r.ownerChannelId) ids.add(r.ownerChannelId)
    }
    return ids
  }, [session.participants, session.replicas])

  // Polled by PairInitiatorModal — incremented on process() errors with "non-ok status".
  const [pairingRejectionCount, setPairingRejectionCount] = useState(0)

  // Fallback success signal for recovery pairings where protocol.start() returns a
  // different channel ID than PairingCompleted.channel_id (so pairedChannelIds won't match).
  const [pairingCompletedSignal, setPairingCompletedSignal] = useState(0)

  // Non-empty while participants are being auto-paired; shows a setup gate in the UI.
  const [autoPairingIds, setAutoPairingIds] = useState<string[]>([])

  interface PendingPairingConfirmation {
    peerName: string
    channelId: string
    /** Opaque action token from ActionRequired event — pass to accept() or reject(). */
    action: Uint8Array
  }

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

  // Use a stable session ref so polling closures always see the latest value without
  // being listed as a dependency (avoids tearing down intervals on every render).
  const sessionRef = useRef(session)
  useEffect(() => { sessionRef.current = session }, [session])
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
    const paired = session.participants.filter(
      p => p.connectionStatus === 'paired' && p.channelId,
    )

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

      const mains = session.mainChannels ?? []
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
     
  }, [session.participants, session.mainChannels, linkVersion])

  useEffect(() => {
    const { sessionId, ownerId, transport, participants } = session

    const ns = `owner:${ownerId}`

    // The secret this node owns, allocated by the backend and published on
    // its actor record so peers can bind a helper-role instance to it.
    // Recovery re-pairs into the same secret namespace: the whole point is to
    // reconstruct *this* secret, and helpers still hold shares keyed by it.
    const ownSecretId = session.ownSecretId
    ownSecretIdRef.current = ownSecretId

    const timeoutSecs = session.config?.protocolTimeoutSecs ?? DEFAULT_PROTOCOL_TIMEOUT_SECS
    const unpairAck = session.config?.unpairAck ?? 'required'

    instanceRef.current = buildProtocolInstance({
      namespace: ns,
      secretId: ownSecretId,
      ownTransportUri: transport.uri,
      communicationInfo: { name: session.ownerName },
      threshold: session.minParticipants,
      keepVersionsCount: 3,
      timeoutSecs,
      unpairAck,
    })

    log({
      role: 'owner',
      flow: 'session',
      step: 'protocol_init',
      description: `Protocol initialized for session ${sessionId}`,
      payload: { sessionId, ownerId, ownSecretId, participantCount: participants.length },
    })

    // In recovery mode Alice is not protecting secrets and doesn't need to be
    // discoverable by other owners, so skip the normal-mode setup below.
    {
      // The backend's disabled_participants set is in-memory and resets on restart;
      // re-apply any offline flags the FE has persisted.
      for (const h of participants) {
        if (h.offline) {
          apiToggleParticipantStatus(sessionId, h.id, true).catch(() => {})
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

          await apiPostBrowserContact(
            sessionId,
            ownerId,
            JSON.stringify(contactMessageToDto(contact)),
          )
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
  }, [session.sessionId])


  const didAutoPair = useRef(false)
  useEffect(() => {
    if (didAutoPair.current) return
    const count = session.prePairedCount ?? 0
    if (count === 0) return
    didAutoPair.current = true

    const participantsToAutoPair = session.participants.filter(h => h.connectionStatus === 'available' && !h.browserManaged).slice(0, count)
    if (participantsToAutoPair.length === 0) return

    setAutoPairingIds(participantsToAutoPair.map(h => h.id))

    async function autoPair() {
      const protocol = ownInstance()?.protocol ?? null
      if (!protocol) return

      const newPairings: Array<{ channelId: bigint; participantId: string }> = []

      for (const participant of participantsToAutoPair) {
        try {
          const dto = await apiCreateActorContact(session.sessionId, participant.id)
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
        const snapshot = sessionRef.current
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
  }, [session.sessionId])

  // Clear the auto-pair gate once all targeted participants have paired.
  useEffect(() => {
    if (autoPairingIds.length === 0) return
    const allPaired = autoPairingIds.every(id =>
      session.participants.some(h => h.id === id && h.connectionStatus === 'paired'),
    )
    if (allPaired) setAutoPairingIds([])
  }, [autoPairingIds, session.participants])

  /** Fold one protocol event into session state. */
  function applyOwnerEvent(current: OwnerSession, event: DeRecEvent): OwnerSession {
    if (event.type === 'PairingCompleted' && event.channel_id) {
      // The handshake atomically rotates to a long-term channel id at
      // completion. `pairing_channel_id` is the transient id that travelled on
      // the ContactMessage — the one pending pairings were recorded under —
      // so match on it, then key all persisted state on the new id.
      const channelId = event.channel_id
      const pairingChannelId = event.pairing_channel_id

      // Detect whether this pairing is for a replica. The pending pairing stores
      // the channel ID returned by ownerStartPairing, but PairingCompleted fires with
      // the owner-side channel ID — they match when Alice initiates. We also handle the
      // case where the backend status poll already moved the replica to 'paired' before
      // this event arrived (race condition), so check replicas without ownerChannelId too.
      const replicaIds = new Set(
        (current.replicas ?? [])
          .filter(r => r.status === 'available' || (r.status === 'paired' && !r.ownerChannelId))
          .map(r => r.id),
      )

      // Pending pairings are recorded under the transient id, so that is what
      // matches here — the long-term `channel_id` never appears in the pending
      // list. Falling back to the post-rekey id would leave every pairing
      // unmatched, orphaning replica bindings and participant placeholders.
      let pending = current.pendingPairings.find(
        p => p.channelId.toString() === pairingChannelId,
      )
      if (!pending) {
        pending = current.pendingPairings.find(p => p.participantId != null && replicaIds.has(p.participantId))
      }
      const actorId = pending?.participantId
      const isReplica = actorId != null && replicaIds.has(actorId)

      log({
        role: 'owner',
        flow: 'pairing',
        step: 'PairingCompleted',
        description: `Pairing complete for channel ${channelId}${isReplica ? ' (replica)' : ''}`,
        payload: { channelId, pairingChannelId, actorId, isReplica },
      })

      let updated: OwnerSession = {
        ...current,
        pendingPairings: pending
          ? current.pendingPairings.filter(p => p !== pending)
          : current.pendingPairings.filter(
              p => p.channelId.toString() !== pairingChannelId,
            ),
      }

      if (isReplica) {
        // Store the owner-side channel ID (from this event). The replica-side
        // channel ID is already in replica.channelId from backend polling.
        updated = {
          ...updated,
          replicas: (updated.replicas ?? []).map(r =>
            r.id === actorId
              ? { ...r, ownerChannelId: channelId, status: 'paired' as const }
              : r,
          ),
        }
      } else if (actorId && updated.participants.some(h => h.id === actorId && !h.channelId)) {
        // Fill in a pre-created participant placeholder (e.g. a provisioned
        // actor added via handleAddParticipant whose channelId is still empty).
        // Pairing is unidirectional and per-channel, so only an *unpaired*
        // placeholder is updated in place — never an already-paired entry.
        const peerRole = peerRoleFromKind(event.kind)
        updated = {
          ...updated,
          participants: updated.participants.map(h =>
            h.id === actorId && !h.channelId
              ? { ...h, channelId, connectionStatus: 'paired' as const, peerRole }
              : h,
          ),
        }
      } else if (updated.participants.some(h => h.channelId === channelId)) {
        // Idempotent: this channel already has a row (duplicate event
        // delivery). Just ensure it is marked paired with the correct role.
        const peerRole = peerRoleFromKind(event.kind)
        updated = {
          ...updated,
          participants: updated.participants.map(h =>
            h.channelId === channelId
              ? { ...h, connectionStatus: 'paired' as const, peerRole }
              : h,
          ),
        }
      } else {
        // New channel. A peer may be paired multiple times (same or different
        // role); each pairing is a distinct channel that gets its own row.
        // `actorId` is set when the peer was already identified by a previous
        // pairing — carry over its identity instead of treating it as unknown.
        const knownActor = actorId
          ? updated.participants.find(h => h.id === actorId)
          : undefined
        const peerName =
          event.peer_communication_info?.name || knownActor?.name || 'Peer'
        const peerRole = peerRoleFromKind(event.kind)

        // Channel-scoped id so repeated pairings with the same peer stay
        // distinct (channelId is unique per pairing).
        const tempId = `peer-${channelId}`
        updated = {
          ...updated,
          participants: [...updated.participants, {
            id: tempId,
            name: peerName,
            channelId,
            transport: knownActor?.transport ?? { protocol: 'https' as const, uri: '' },
            connectionStatus: 'paired' as const,
            peerRole,
            secretShares: [],
            browserManaged: knownActor?.browserManaged,
          }],
        }

        // Resolve identity from the backend only when the peer is genuinely
        // unknown. When it was already identified by a prior pairing, the
        // name/transport are carried over above.
        if (!actorId) {
          const sessionId = current.sessionId
          const ownerId = current.ownerId
          // The URI we paired against, when we were the initiator. Without it
          // (responder side) resolution falls back to inference, which only
          // commits when a single candidate exists — a session holding stale
          // owner actors from a device that reset and rejoined would otherwise
          // relabel this channel with the wrong peer's identity.
          const peerTransportUri = pending?.peerTransportUri
          apiGetSession(sessionId).then(resp => {
            const snapshot = sessionRef.current
            const peerActor = resolvePeerActor(resp.actors, {
              selfActorId: ownerId,
              knownActorIds: new Set(snapshot.participants.map(h => h.id)),
              peerTransportUri,
            })
            if (!peerActor) return
            // Replace the placeholder with real actor info.
            onUpdateRef.current({
              ...snapshot,
              participants: snapshot.participants.map(h =>
                h.id === tempId
                  ? { ...h, id: peerActor.id, name: peerActor.name, transport: { protocol: peerActor.transport.protocol, uri: peerActor.transport.uri }, browserManaged: peerActor.browser_managed ?? false }
                  : h
              ),
            })
          }).catch(() => {})
        }
      }

      // Discovery is NOT triggered here — the participant must first associate
      // the new channel with the old one. Session status polling detects when
      // pendingRecoveryChannelId clears and triggers discovery at that point.

      // Read the shared key from the local secret store for browser-managed peers.
      // Backend-managed participants get their shared key from the backend poll,
      // but for WASM-to-WASM pairing the key only exists locally.
      const localSharedKey = localStorage.getItem(
        `derec:owner:${current.ownerId}:secret:${channelId}:0`,
      )
      if (localSharedKey && !isReplica) {
        // Target the row by channelId — each paired entry owns a unique
        // channel, so this works whether a placeholder was filled in or a
        // new per-channel row was created.
        updated = {
          ...updated,
          participants: updated.participants.map(h =>
            h.channelId === channelId ? { ...h, sharedKey: localSharedKey } : h,
          ),
        }
      }

      return updated
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

      // Drop every local trace of the channel: participants, replicas (in
      // either role), held shares, pending pairings, and the secret bag
      // participant lists. The library already removed channel-store and
      // share-store entries via the trait callbacks during accept().
      const participantHit = current.participants.find(p => p.channelId === channelId)
      const replicaHit = (current.replicas ?? []).find(r =>
        r.channelId === channelId || r.ownerChannelId === channelId,
      )

      let updated: OwnerSession = {
        ...current,
        participants: current.participants.filter(p => p.channelId !== channelId),
        replicas: (current.replicas ?? []).filter(r =>
          r.channelId !== channelId && r.ownerChannelId !== channelId,
        ),
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

      const peerName = participantHit?.name ?? replicaHit?.name ?? 'Peer'
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

      // Update the pending bag (not yet committed to session state).
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

      // Track the failure in the pending bag (not yet committed to session state).
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

      const pending = pendingBagRef.current
      pendingBagRef.current = null

      // The share store now derives `latestVersion` from the versions it
      // actually holds — the owner persists its own committed shares — so
      // there is no separate counter to advance or roll back here.
      if (thresholdMet && pending && pending.version === version) {
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
          replicaCount: snapshot.replicas?.replicas.length ?? 0,
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

    // ── Replica lifecycle ────────────────────────────────────────────────
    // Replica pairing is now first-class: `ReplicaPaired` fires alongside
    // `PairingCompleted` and carries the peer's replica id, so the app no
    // longer has to infer replica-ness from pending-pairing bookkeeping.
    if (event.type === 'ReplicaPaired') {
      const channelId = event.channel_id
      log({
        role: 'owner',
        flow: 'replica',
        step: 'ReplicaPaired',
        description: `Replica pair handshake complete on channel ${channelId}`,
        payload: { channelId, peerReplicaId: event.peer_replica_id },
      })
      return {
        ...current,
        replicas: (current.replicas ?? []).map(r =>
          r.ownerChannelId === channelId || r.channelId === channelId
            ? { ...r, status: r.status === 'confirmed' ? r.status : ('paired' as const) }
            : r,
        ),
      }
    }

    if (event.type === 'ReplicaSecretReceived') {
      log({
        role: 'owner',
        flow: 'replica',
        step: 'ReplicaSecretReceived',
        description: `Replica sync received for v${event.version} (${event.shares.length} helper share(s))`,
        payload: {
          channelId: event.channel_id,
          fromReplicaId: event.from_replica_id,
          secretId: event.secret_id,
          version: event.version,
          shareCount: event.shares.length,
        },
      })
      return current
    }

    if (event.type === 'ReplicaSecretAcked') {
      const ok = event.status === 0
      log({
        role: 'owner',
        flow: 'replica',
        step: 'ReplicaSecretAcked',
        description: ok
          ? `Replica acknowledged v${event.version}`
          : `Replica rejected v${event.version}: ${event.memo}`,
        payload: {
          channelId: event.channel_id,
          version: event.version,
          status: event.status,
          memo: event.memo,
        },
      })
      if (!ok) {
        reportError(`A replica rejected the secret sync for v${event.version}`, event.memo)
      }
      return current
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

    return current
  }

  // Poll faster (500ms) during auto-pair so the setup gate clears quickly.

  const pollInterval = (autoPairingIds.length > 0 || protocolBusy) ? 500 : 5000

  useEffect(() => {
    let ownerPollRunning = false
    const id = setInterval(async () => {
      if (ownerPollRunning) return
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
        const { sessionId, ownerId } = sessionRef.current
        const protocol = ownInstance()?.protocol ?? null
        if (!protocol) return

        let messages
        try {
          messages = await pollMailbox(sessionId, 'owners', ownerId)
        } catch (err) {
          reportError('Mailbox poll failed', err, { sessionId, ownerId })
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
          const initial = sessionRef.current
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
                  const channelId = event.channel_id!
                  const peerName = event.peer_communication_info?.name || 'Unknown peer'
                  setPendingPairingConfirmation({
                    peerName,
                    channelId,
                    action: event.action,
                  })

                  log({
                    role: 'owner',
                    flow: 'pairing',
                    step: 'pairing_confirmation_pending',
                    description: `Pairing request from "${peerName}" — waiting for user confirmation`,
                    payload: { channelId },
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
                  // Peer-initiated unpair. The session-wide FE config (echoed
                  // by the backend on join) decides whether to auto-accept or
                  // surface a modal so the operator can visually verify the
                  // flow before letting it complete.
                  //
                  // The fallback when the value is missing is **show modal**
                  // (the safer side): we'd rather make the user click than
                  // silently tear down a channel because a persisted session
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
            sessionRef.current = updated
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
  }, [session.sessionId, pollInterval])

  async function handleAcceptPairing() {
    const confirmation = pendingPairingConfirmation
    if (!confirmation) return

    const instance = ownInstance()
    const protocol = instance?.protocol ?? null
    if (!protocol || !instance) return

    try {
      const events = await withProtocolLock(() => protocol.accept(confirmation.action))
      const eventArray = Array.from(events)

      let updated = sessionRef.current
      let pairingCompleted = false
      for (const event of eventArray) {
        try {
          updated = applyOwnerEvent(updated, event)
        } catch (err) {
          reportError(`Failed to handle a ${event.type} event`, err)
        }
        if (event.type === 'PairingCompleted') pairingCompleted = true
      }
      if (pairingCompleted) {
        // No discovery is fired here. A helper can only answer once it has
        // linked this channel to an owner it already helps, which happens on
        // its side and out of band — so discovery is driven explicitly from
        // the Recovery tab once that has happened.
        setPairingCompletedSignal(c => c + 1)
      }

      if (updated !== sessionRef.current) {
        sessionRef.current = updated
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

      let updated = sessionRef.current
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

      if (updated !== sessionRef.current) {
        sessionRef.current = updated
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
      let updated: OwnerSession = {
        ...sessionRef.current,
        heldShares: [...(sessionRef.current.heldShares ?? []), {
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

      if (updated !== sessionRef.current) {
        sessionRef.current = updated
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

      let updated = sessionRef.current
      for (const event of eventArray) {
        try {
          updated = applyOwnerEvent(updated, event)
        } catch (err) {
          reportError(`Failed to handle a ${event.type} event`, err)
        }
      }

      if (updated !== sessionRef.current) {
        sessionRef.current = updated
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

      let updated = sessionRef.current
      for (const event of eventArray) {
        try {
          updated = applyOwnerEvent(updated, event)
        } catch (err) {
          reportError(`Failed to handle a ${event.type} event`, err)
        }
      }

      if (updated !== sessionRef.current) {
        sessionRef.current = updated
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
      const { sessionId } = sessionRef.current
      try {
        const resp = await apiGetSession(sessionId)
        // Re-read after the async call so we see any updates from the owner
        // mailbox poll that completed while the API request was in flight.
        const current = sessionRef.current
        let updated = current
        let changed = false

        // Sync session-level config from the backend. The backend is the
        // source of truth for these settings — if localStorage was persisted
        // before a field existed (or with a stale value), reconcile here so
        // the polling-loop dispatch never reads an out-of-date value (e.g.
        // auto-accepting an Unpair request that the session was configured
        // to surface as a modal).
        if (
          current.config?.protocolTimeoutSecs !== resp.protocol_timeout_secs ||
          current.config?.authenticationMethod !== resp.authentication_method ||
          current.config?.unpairAck !== resp.unpair_ack ||
          current.config?.autoAcceptUnpairRequests !== resp.auto_accept_unpair_requests
        ) {
          changed = true
          updated = {
            ...updated,
            config: {
              ...(updated.config ?? {}),
              protocolTimeoutSecs: resp.protocol_timeout_secs,
              authenticationMethod: resp.authentication_method,
              unpairAck: resp.unpair_ack,
              autoAcceptUnpairRequests: resp.auto_accept_unpair_requests,
            },
          }
        }

        // Discover new participants. All participants are shared session resources.
        // New participants always start as 'available' — the backend's channel_id may
        // belong to another owner's pairing. This owner's pairing status is managed
        // exclusively via PairingCompleted events.
        for (const actor of resp.actors) {
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

        for (const actor of resp.actors) {
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

        // Sync replica state from backend.
        for (const actor of resp.actors) {
          if (actor.role !== 'replica') continue
          const replica = updated.replicas?.find(r => r.id === actor.id)
          if (!replica) continue

          let replicaUpdated = false
          let newStatus: ReplicaStatus = replica.status
          const newOffline = !!actor.disabled

          if (actor.channel_id && replica.status === 'available') {
            newStatus = 'paired'
            replicaUpdated = true
          }

          // Sync confirmation status from backend.
          if (actor.replica_confirmed && replica.status === 'paired') {
            newStatus = 'confirmed'
            replicaUpdated = true
          }

          // Sync offline status.
          if (newOffline !== !!replica.offline) {
            replicaUpdated = true
          }

          if (replicaUpdated) {
            changed = true
            updated = {
              ...updated,
              replicas: updated.replicas.map(r =>
                r.id === actor.id
                  ? {
                      ...r,
                      channelId: actor.channel_id ?? r.channelId,
                      status: newStatus,
                      offline: newOffline || undefined,
                    }
                  : r,
              ),
            }
          }

          // Auto-fetch fingerprint for newly paired replicas that don't have one yet.
          if (actor.channel_id && !replica.replicaFingerprint && replica.status !== 'confirmed') {
            apiGetReplicaFingerprint(sessionId, actor.id)
              .then(({ fingerprint }) => {
                const current = sessionRef.current
                onUpdateRef.current({
                  ...current,
                  replicas: current.replicas.map(r =>
                    r.id === actor.id
                      ? {
                          ...r,
                          replicaFingerprint: fingerprint,
                          confirmationStartedAt: r.confirmationStartedAt ?? Date.now(),
                        }
                      : r,
                  ),
                })
              })
              .catch(err => {
                reportError('Failed to fetch the replica fingerprint', err)
              })
          }
        }

        if (changed) {
          sessionRef.current = updated
          onUpdateRef.current(updated)
        }
      } catch {
        // Silently ignore — the owner mailbox poll will surface connectivity issues.
      }
    }, pollInterval)

    return () => clearInterval(id)
     
  }, [session.sessionId, pollInterval])

  async function createOwnerContact(): Promise<ContactMessage> {
    return withProtocolLock(async () => {
      const protocol = ownInstance()?.protocol ?? null
      if (!protocol) throw new Error('Protocol not initialized')
      return protocol.createContact(null, ContactMode.InlineKeys)
    })
  }

  function getParticipantFunctions(participantId: string) {
    const participant = session.participants.find(h => h.id === participantId)

    // Browser-managed participants (other owners) post their own contact via the
    // browser-contact endpoint. Pairing is always initiated by Alice's WASM.
    if (participant?.browserManaged) {
      return {
        createContact: async (): Promise<ContactMessage> => {
          const dto = await apiGetBrowserContact(session.sessionId, participantId)
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
      createContact: async (): Promise<ContactMessage> => {
        const dto = await apiCreateActorContact(session.sessionId, participantId)
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
        role: PairingRole,
      ): Promise<bigint> => {
        // The backend actor scans our contact and initiates, so `role` is
        // already that actor's own declaration — it goes through unchanged.
        // We become the complement when its request reaches us.
        const dto = contactMessageToDto(ownContact)
        const result = await apiStartActorPairing(session.sessionId, participantId, dto, role)
        return BigInt(result.channel_id)
      },
    }
  }

  /** Channels a provisioned helper holds, for the operator's link picker. */
  async function listParticipantChannels(participantId: string): Promise<ProvisionedChannel[]> {
    return apiListParticipantChannels(session.sessionId, participantId)
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
    await apiLinkParticipantChannels(session.sessionId, participantId, channelId, linkTo)
    log({
      role: 'owner',
      flow: 'pairing',
      step: 'operator_link',
      description: `Linked channel ${channelId} to ${linkTo} on a provisioned helper`,
      payload: { participantId, channelId, linkTo },
    })
    reportInfo('Channels linked — the helper can now answer discovery for this owner.')
  }

  function getReplicaFunctions(replicaId: string) {
    const replica = (session.replicas ?? []).find(r => r.id === replicaId)
    return {
      createContact: async (): Promise<ContactMessage> => {
        const dto = await apiCreateActorContact(session.sessionId, replicaId)
        return dtoToContactMessage(dto)
      },
      startPairing: (contact: ContactMessage, role: PairingRole): Promise<bigint> =>
        ownerStartPairing(contact, role, replica?.name),
    }
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
    const cur = sessionRef.current
    const reverted = {
      ...cur,
      participants: cur.participants.map(h => ({
        ...h,
        secretShares: h.secretShares.filter(s => s.version !== version),
      })),
    }
    sessionRef.current = reverted
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

  async function ownerAddSecret(name: string, data: string): Promise<void> {
    setProtocolBusy(true)
    const protocol = ownInstance()?.protocol ?? null
    if (!protocol) throw new Error('Protocol not initialized')

    const current = sessionRef.current
    const existingBag = current.secretBag

    // Build the full list of user secrets (existing + new).
    // Per-user-secret IDs are application-level random identifiers (hex-encoded).
    const newUserSecretIdBytes = crypto.getRandomValues(new Uint8Array(16))
    const newUserSecretId = Array.from(newUserSecretIdBytes).map(b => b.toString(16).padStart(2, '0')).join('')
    const newUserSecret: UserSecret = { id: newUserSecretId, name, data }

    const allUserSecrets = existingBag
      ? [...existingBag.currentVersion.secrets, newUserSecret]
      : [newUserSecret]

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
      return
    }

    const pairedParticipants = current.participants.filter(isShareTarget)

    // Register pending shares for correlation.
    const pendingShare: PendingShare = { version: newVersion }
    for (const h of pairedParticipants) {
      if (h.channelId) pendingSharesRef.current.set(h.channelId, pendingShare)
    }

    // Build the new bag version (not committed to session yet — waits for SharingComplete).
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
    // but do NOT commit the bag to session state yet. Clear any stale refs for
    // this version from a previous failed attempt.
    onUpdate({
      ...current,
      participants: current.participants.map(h =>
        pairedParticipants.some(ph => ph.id === h.id)
          ? { ...h, secretShares: [...h.secretShares.filter(s => s.version !== newVersion), { version: newVersion, status: 'pending' as const, verified: false }] }
          : h,
      ),
    })

    log({
      role: 'owner',
      flow: 'sharing',
      step: 'protect_secret',
      description: `Secret "${name}" added to bag (v${newVersion}), distributed to ${pairedParticipants.length} participant(s)`,
      payload: { version: newVersion, secretCount: allUserSecrets.length },
    })

    setActiveTab('secrets')
  }

  async function ownerVerifyShares(version: number): Promise<void> {
    setProtocolBusy(true)
    armFlowWatchdog()
    const protocol = ownInstance()?.protocol ?? null
    if (!protocol) throw new Error('Protocol not initialized')

    const current = sessionRef.current
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
    const current = sessionRef.current
    // Drop any prior failure for THIS (secretId, version) so its row drops
    // back to "Recovering…" instead of clinging to the previous "Incomplete".
    // Failures on OTHER versions are preserved.
    const updated = {
      ...current,
      recoveryProgress: { secretId, version, sharesReceived: 0, totalRequested: participantChannelIds.length, error: null },
      recoveryFailures: removeRecoveryFailure(current.recoveryFailures, secretId, version),
    }
    sessionRef.current = updated
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
          'and no share requests were sent. Rejoin the session in recovery mode and claim the original ' +
          'owner actor so this device binds to the secret being recovered.'

    clearFlowWatchdog()
    setProtocolBusy(false)
    const failed = sessionRef.current
    const withError = {
      ...failed,
      recoveryProgress: failed.recoveryProgress
        ? { ...failed.recoveryProgress, error: message }
        : failed.recoveryProgress,
      recoveryFailures: upsertRecoveryFailure(failed.recoveryFailures, secretId, version, message),
    }
    sessionRef.current = withError
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
   * 4. Rebuilds FE session state — participants, secret bag, threshold —
   *    so the UI matches the protocol's restored stores.
   * 5. Exits recovery mode; the protocol useEffect rebuilds the instance
   *    registry against the now-populated non-recovery namespace.
   *
   * The recovery-mode helpers stay paired on their side. They simply drop out
   * of this app's view.
   */
  async function handleRestoreFromBag(secret: RecoveredSecret): Promise<void> {
    try {
      const current = sessionRef.current
      const targetNs = `owner:${current.ownerId}`

      // 0. Retire the ephemeral recovery channels while their keys still
      //    exist. They served one purpose — carrying discovery and share
      //    retrieval — and the restored snapshot replaces them with the
      //    originals. Wiping the namespace without telling the peers leaves
      //    them paired to a channel this device can no longer decrypt: every
      //    message they send afterwards lands as an "unknown channel_id"
      //    error, indefinitely. Best-effort — a peer we cannot reach must not
      //    block the restore.
      const recoveryChannelIds = current.participants
        .filter(p => p.connectionStatus === 'paired' && p.channelId)
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
      })
      // `restore` returns the events from its own recovery-channel teardown
      // (one `Unpaired` per wiped channel, `UnpairFailed` for any the peer
      // never received). Drain them so the teardown is visible rather than
      // discarded.
      const restoreEvents = Array.from(
        await restoreInstance.protocol.restore(snapshotToPayload(secret.snapshot), secret.version),
      )
      // The session each fold returns is intentionally dropped: step 4 below
      // replaces participants wholesale from the snapshot, so only these
      // handlers' console output is wanted here.
      for (const event of restoreEvents) {
        try {
          applyOwnerEvent(sessionRef.current, event)
        } catch (err) {
          reportError(`Failed to handle a ${event.type} event from restore`, err)
        }
      }

      // 3. FE state derived from the snapshot. Helpers become paired
      //    participants; the secret bag is reconstructed with one version and
      //    no history.
      //
      //    Peers are re-identified against the session's actor list by
      //    transport URI, which is unique per actor. Snapshot records carry
      //    only what travelled on the wire, so without this the restored rows
      //    would be anonymous placeholders: backend polling reconciles
      //    participant and replica state by actor id, and would never match.
      let actorByUri = new Map<string, GetSessionResponse['actors'][number]>()
      try {
        const resp = await apiGetSession(current.sessionId)
        actorByUri = new Map(resp.actors.map(a => [a.transport.uri, a]))
      } catch (err) {
        // Non-fatal: fall back to snapshot-only identities.
        reportError('Could not re-identify restored peers against the session', err, {
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

      // Replicas are part of the protected state, so a restore that dropped
      // them would leave the device holding replica channels the UI cannot
      // see. `channelId` (replica-side) and the confirmation flag come from
      // the backend poll, which keys on the actor id resolved above.
      const replicas: PairedReplica[] = (secret.snapshot.replicas?.replicas ?? []).map(r => {
        const actor = actorByUri.get(r.transportUri)
        return {
          id: actor?.id ?? `replica-${r.channelId}`,
          name: actor?.name || r.communicationInfo['name'] || 'Replica',
          channelId: '',
          ownerChannelId: r.channelId,
          transport: { protocol: 'https' as const, uri: r.transportUri },
          status: 'paired' as const,
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
        // The threshold isn't carried in the bag; reuse the session's
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
          await restoreInstance.protocol.setOwnTransport(current.transport.uri, 'https')
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

      // 4. Commit the restored session. `ownSecretId` becomes the *recovered*
      //    secret: `restore` rebuilt state under that id, so the instance must
      //    be rebound to it or it would look at an empty namespace.
      setActiveTab('participants')
      onUpdate({
        ...current,
        participants,
        secretBag,
        pendingPairings: [],
        replicas,
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
        description: `Restored ${participants.length} helper(s), ${secret.snapshot.secrets.length} secret(s) and ${replicas.length} replica(s) from recovered bag`,
        payload: {
          secretId: secret.secretId,
          version: secret.version,
          helperCount: participants.length,
          secretCount: secret.snapshot.secrets.length,
          replicaCount: replicas.length,
        },
      })
    } catch (err) {
      reportError('Failed to restore from recovered bag', err, {
        secretId: secret.secretId,
        version: secret.version,
      })
    }
  }

  function addPendingPairing(
    channelId: bigint,
    participantId?: string,
    peerTransportUri?: string,
  ) {
    const pending: PendingPairing = { channelId, participantId, peerTransportUri }
    const current = sessionRef.current
    const updated = { ...current, pendingPairings: [...current.pendingPairings, pending] }
    sessionRef.current = updated
    onUpdateRef.current(updated)
  }

  async function handleAddParticipant(name: string, autoPair: boolean) {
    const resp = await apiAddParticipant(session.sessionId, name)
    const newParticipant: PairedParticipant = {
      id: resp.id,
      name: resp.name,
      channelId: '',
      transport: { protocol: resp.transport.protocol, uri: resp.transport.uri },
      connectionStatus: 'available',
      secretShares: [],
    }

    let updated = { ...session, participants: [...session.participants, newParticipant] }

    log({
      role: 'owner',
      flow: 'session',
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
        const dto = await apiCreateActorContact(session.sessionId, resp.id)
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
    const resp = await apiToggleParticipantStatus(session.sessionId, participantId)
    onUpdate({
      ...session,
      participants: session.participants.map(h =>
        h.id === participantId ? { ...h, offline: resp.disabled } : h,
      ),
    })

    log({
      role: 'owner',
      flow: 'session',
      step: 'participant_status_toggled',
      description: `${session.participants.find(h => h.id === participantId)?.name ?? participantId} is now ${resp.disabled ? 'offline' : 'online'}`,
      payload: { participantId, disabled: resp.disabled },
    })
  }

  async function handleToggleReplicaStatus(replicaId: string) {
    const resp = await apiToggleReplicaStatus(session.sessionId, replicaId)
    onUpdate({
      ...session,
      replicas: (session.replicas ?? []).map(r =>
        r.id === replicaId ? { ...r, offline: resp.disabled } : r,
      ),
    })

    log({
      role: 'owner',
      flow: 'replica',
      step: 'replica_status_toggled',
      description: `${(session.replicas ?? []).find(r => r.id === replicaId)?.name ?? replicaId} is now ${resp.disabled ? 'offline' : 'online'}`,
      payload: { replicaId, disabled: resp.disabled },
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
          unpairAck: session.config?.unpairAck ?? 'required',
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
   * Entry point for the Unpair button. Branches on the session's
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
   *     removed from the session.
   *
   * Placeholder rows for not-yet-paired actors carry no channel ID — they
   * have no protocol state to tear down, so we drop them locally.
   */
  function handleTogglePair(participantId: string) {
    const participant = session.participants.find(h => h.id === participantId)
    if (!participant) return

    if (participant.connectionStatus !== 'paired' || !participant.channelId) {
      onUpdate({
        ...session,
        participants: session.participants.filter(p => p.id !== participantId),
      })
      return
    }

    // An unpair request is already in flight for this channel — ignore the
    // click (the button is also disabled in the UI, but guard anyway).
    if (unpairingChannelIds.has(participant.channelId)) return

    const unpairAck = session.config?.unpairAck ?? 'required'
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
    const cur = sessionRef.current
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
    // record the single chosen main. Persist via session state.
    const mergedIds = new Set<string>([
      ...srcClosure,
      ...tgtClosure,
      sourceChannelId,
      targetChannelId,
    ])
    const nextMains = (cur.mainChannels ?? []).filter(id => !mergedIds.has(id))
    nextMains.push(newMain)
    const updated = { ...cur, mainChannels: nextMains }
    sessionRef.current = updated
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

  async function handleConfirmReplica(replicaId: string) {
    const replica = session.replicas.find(r => r.id === replicaId)
    if (!replica || !replica.replicaFingerprint || !replica.channelId) return

    try {
      await apiConfirmReplicaFingerprint(
        session.sessionId,
        replicaId,
        replica.channelId,
        replica.replicaFingerprint,
      )

      onUpdate({
        ...session,
        replicas: session.replicas.map(r =>
          r.id === replicaId ? { ...r, status: 'confirmed' as const } : r,
        ),
      })

      log({
        role: 'owner',
        flow: 'replica',
        step: 'fingerprint_confirmed',
        description: `Replica "${replica.name}" fingerprint confirmed`,
        payload: { replicaId, channelId: replica.channelId, fingerprint: replica.replicaFingerprint },
      })
    } catch (err) {
      reportError(`Failed to confirm the fingerprint for replica "${replica.name}"`, err, {
        replicaId,
      })
    }
  }

  async function handleAddReplica(name: string) {
    const resp = await apiAddReplica(session.sessionId, name)
    const newReplica: PairedReplica = {
      id: resp.id,
      name: resp.name,
      channelId: '',
      transport: { protocol: resp.transport.protocol, uri: resp.transport.uri },
      status: 'available',
    }

    const updated: OwnerSession = { ...session, replicas: [...(session.replicas ?? []), newReplica] }
    onUpdate(updated)

    log({
      role: 'owner',
      flow: 'replica',
      step: 'replica_added',
      description: `Replica "${name}" provisioned`,
      payload: { replicaId: resp.id, name },
    })
  }

  // Show a setup gate while auto-pairing is in progress.
  if (autoPairingIds.length > 0) {
    const pairedCount = autoPairingIds.filter(id =>
      session.participants.some(h => h.id === id && h.connectionStatus === 'paired'),
    ).length
    const total = autoPairingIds.length

    return (
      <div className="session-setup-gate">
        <h2 className="setup-gate-title">Setting up session</h2>
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
            const participant = session.participants.find(h => h.id === id)
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

  return (
    <ProtocolConfigProvider timeoutMs={flowTimeoutMs}>
    <div className="session-page">
      <div className="session-info-bar">
        <div className="owner-badge">
          <span className="meta-label">Owner</span>
          <span className="owner-name">{session.ownerName}</span>
        </div>

        <div className="header-transport">
          <span className="protocol-badge">{session.transport.protocol.toUpperCase()}</span>
          <code className="header-uri">{session.transport.uri}</code>
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
            const pairedCount = session.participants.filter(isShareTarget).length
            const belowMin = pairedCount < session.minParticipants
            return (
              <button
                className="primary"
                onClick={() => setProtectOpen(true)}
                disabled={belowMin}
                title={belowMin ? `Need at least ${session.minParticipants} paired participant${session.minParticipants !== 1 ? 's' : ''} (currently ${pairedCount})` : undefined}
              >
                {session.secretBag ? 'Add Secret' : 'Protect Secret'}
              </button>
            )
          })()}
        </div>
      </div>

      {shareOpen && (
        <ShareContactModal
          title="Share Contact"
          transport={session.transport}
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
            session.participants.find(p => p.transport.uri === contact.transport_protocol?.uri)?.id
          }
          startPairing={ownerStartPairing}
        />
      )}

      {provisioningReplicaId && (() => {
        const replica = (session.replicas ?? []).find(r => r.id === provisioningReplicaId)
        if (!replica) return null
        const { startPairing } = getReplicaFunctions(replica.id)
        return (
          <ReplicaProvisioningModal
            replica={replica}
            onPairingRequestSent={(channelId, replicaId) => addPendingPairing(channelId, replicaId)}
            startPairing={startPairing}
            onConfirm={handleConfirmReplica}
            onClose={() => setProvisioningReplicaId(null)}
          />
        )
      })()}

      {protectOpen && (
        <AddSecretModal
          participants={session.participants}
          secretBag={session.secretBag}
          threshold={session.minParticipants}
          onClose={() => { setProtectOpen(false); setProtocolBusy(false) }}
          onAddSecret={ownerAddSecret}
        />
      )}

      {(() => {
        const pairedCount = session.participants.filter(isShareTarget).length
        const belowMin = pairedCount < session.minParticipants
        const belowRecommended = !belowMin && pairedCount < session.recommendedParticipants
        if (belowMin) {
          return (
            <div className="session-banner session-banner--error" role="alert">
              Secret protection is disabled — {pairedCount} of {session.minParticipants} required participants paired.
            </div>
          )
        }
        if (belowRecommended) {
          return (
            <div className="session-banner session-banner--warning" role="status">
              Only {pairedCount} of {session.recommendedParticipants} recommended participants paired. Consider pairing more before protecting secrets.
            </div>
          )
        }
        return null
      })()}

      <div className="session-layout">
        <div className="session-content">
          <div className="tab-bar" role="tablist">
            <button
              role="tab"
              className={`tab-btn ${activeTab === 'participants' ? 'active' : ''}`}
              onClick={() => setActiveTab('participants')}
              aria-selected={activeTab === 'participants'}
            >
              Channels
              <span className="tab-count">{session.participants.filter(h => h.connectionStatus === 'paired').length}</span>
            </button>
            <button
              role="tab"
              className={`tab-btn ${activeTab === 'secrets' ? 'active' : ''}`}
              onClick={() => setActiveTab('secrets')}
              aria-selected={activeTab === 'secrets'}
            >
              Secret Bag
              <span className="tab-count">{session.secretBag?.currentVersion.secrets.length ?? 0}</span>
            </button>
            <button
              role="tab"
              className={`tab-btn ${activeTab === 'shares' ? 'active' : ''}`}
              onClick={() => setActiveTab('shares')}
              aria-selected={activeTab === 'shares'}
            >
              Shares
              <span className="tab-count">{(session.heldShares ?? []).length}</span>
            </button>
            <button
              role="tab"
              className={`tab-btn ${activeTab === 'replicas' ? 'active' : ''}`}
              onClick={() => setActiveTab('replicas')}
              aria-selected={activeTab === 'replicas'}
            >
              Replicas
              <span className="tab-count">{(session.replicas ?? []).filter(r => r.status !== 'available').length}</span>
            </button>
            {(
              <button
                role="tab"
                className={`tab-btn ${activeTab === 'recovery' ? 'active' : ''}`}
                onClick={() => setActiveTab('recovery')}
                aria-selected={activeTab === 'recovery'}
              >
                Recovery
                <span className="tab-count">{(session.recoveredSecrets ?? []).length}</span>
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
            {activeTab === 'secrets' && (
              <SecretBagPanel bag={session.secretBag} participants={session.participants} onVerify={ownerVerifyShares} onVerifyClose={() => setProtocolBusy(false)} onAddSecret={() => setProtectOpen(true)} />
            )}
            {activeTab === 'shares' && (
              <HeldSharesList
                shares={session.heldShares ?? []}
                participants={session.participants}
                ownerId={session.ownerId}
                ownSecretId={session.ownSecretId}
              />
            )}
            {activeTab === 'replicas' && (
              <ReplicasList
                replicas={session.replicas ?? []}
                onConfirm={handleConfirmReplica}
              />
            )}
            {activeTab === 'recovery' && (
              <RecoveryPanel
                session={session}
                onRequestDiscovery={ownerRequestDiscovery}
                onRecover={ownerRecoverSecret}
                onRestoreFromBag={handleRestoreFromBag}
              />
            )}
          </div>
        </div>

        <SessionParticipantPanel
          participants={session.participants.filter(p => !p.browserManaged)}
          replicas={session.replicas ?? []}
          listChannels={listParticipantChannels}
          linkChannels={linkParticipantChannels}
          onTogglePair={handleTogglePair}
          onToggleParticipantStatus={handleToggleStatus}
          onToggleReplicaStatus={handleToggleReplicaStatus}
          onPairingCreated={(channelId, actorId) => addPendingPairing(channelId, actorId)}
          onPairingRequestSent={(channelId, actorId) => addPendingPairing(channelId, actorId)}
          onAddParticipant={handleAddParticipant}
          onAddReplica={handleAddReplica}
          onReplicaPairStarted={setProvisioningReplicaId}
          getParticipantFunctions={getParticipantFunctions}
          getReplicaFunctions={getReplicaFunctions}
          pairedChannelIds={pairedChannelIds}
          pairingRejectionCount={pairingRejectionCount}
          pairingCompletedSignal={pairingCompletedSignal}
        />
      </div>

      {/* Pairing confirmation modal — two views: decision and (User auth) link picker. */}
      {pendingPairingConfirmation && (() => {
        const confirmation = pendingPairingConfirmation
        const userAuthMethod = session.config?.authenticationMethod === 'user'
        const linkCandidates = session.participants.filter(
          p =>
            p.connectionStatus === 'paired' &&
            p.channelId &&
            p.channelId !== confirmation.channelId,
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
                                  {c.peerRole === 'owner' ? 'Owner' : 'Helper'}
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
        const sourceChannel = session.participants.find(
          p => p.channelId === linkSourceChannelId,
        )
        if (!sourceChannel) return null
        const candidates = session.participants.filter(
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
