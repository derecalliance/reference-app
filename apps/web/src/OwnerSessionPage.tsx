import { useState, useEffect, useRef, useMemo } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { DeRecProtocol, SenderKind, FlowKind, type ContactMessage } from '@derec-alliance/web'
import './OwnerSessionPage.css'
import type { ParticipantConnectionStatus, OwnerSession, PairedParticipant, PairedReplica, PendingPairing, BagVersion, SecretBag, UserSecret, RecoveredSecret, ReplicaStatus, SecretShareRef, Transport, HeldShare, RecoveryChannelLink } from './types'
import { useConsole } from './ConsoleContext'
import { sendMessage, pollMailbox, fromBase64Url, toBase64Url } from './derecApi'
import { makeChannelStore, makeSecretStore, makeShareStore, makeTransport, clearNamespace } from './stores'
import { apiAddParticipant, apiAddReplica, apiConfirmReplicaFingerprint, apiCreateActorContact, apiGetBrowserContact, apiGetReplicaFingerprint, apiGetSession, apiPostBrowserContact, apiStartActorPairing, apiToggleParticipantStatus, apiToggleReplicaStatus, type ContactMessageDto } from './api'
import { faker } from '@faker-js/faker'

// QR/clipboard payload: binary fields base64url-encoded, so the string is text-safe.
function serializeContact(contact: ContactMessage): string {
  return JSON.stringify({
    channel_id: contact.channel_id,
    nonce: contact.nonce,
    transport_protocol: contact.transport_protocol,
    mlkem_encapsulation_key: toBase64Url(contact.mlkem_encapsulation_key),
    ecies_public_key: toBase64Url(contact.ecies_public_key),
  })
}

function deserializeContact(payload: string): ContactMessage {
  const raw = JSON.parse(payload) as {
    channel_id: string
    nonce: string
    transport_protocol: { uri: string; protocol: string }
    mlkem_encapsulation_key: string
    ecies_public_key: string
  }
  return {
    channel_id: raw.channel_id,
    nonce: raw.nonce,
    transport_protocol: raw.transport_protocol,
    mlkem_encapsulation_key: fromBase64Url(raw.mlkem_encapsulation_key),
    ecies_public_key: fromBase64Url(raw.ecies_public_key),
  }
}

function dtoToContactMessage(dto: ContactMessageDto): ContactMessage {
  return {
    channel_id: dto.channel_id,
    nonce: dto.nonce,
    transport_protocol: dto.transport_protocol,
    mlkem_encapsulation_key: fromBase64Url(dto.mlkem_encapsulation_key),
    ecies_public_key: fromBase64Url(dto.ecies_public_key),
  }
}

function contactMessageToDto(c: ContactMessage): ContactMessageDto {
  return {
    channel_id: c.channel_id,
    nonce: c.nonce,
    transport_protocol: c.transport_protocol,
    mlkem_encapsulation_key: toBase64Url(c.mlkem_encapsulation_key),
    ecies_public_key: toBase64Url(c.ecies_public_key),
  }
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
  const pairedParticipants = participants.filter(h => h.connectionStatus === 'paired')

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

  const didInit = useRef(false)
  useEffect(() => {
    if (didInit.current) return
    didInit.current = true

    createContact()
      .then(contact => {
        const channelId = BigInt(contact.channel_id)
        // Serialize the ContactMessage to JSON for QR display.
        // Binary fields are base64url-encoded so the payload is text-safe.
        const qrPayload = serializeContact(contact)
        setStep({ kind: 'ready', channelId, qrPayload, rawHex: contact.channel_id })
        onPairingCreated?.(channelId)
        log({
          role: 'owner',
          flow: 'pairing',
          step: 'create_contact',
          description: `Contact created for ${transport.uri}`,
          payload: { channelId: channelId.toString(), transportUri: transport.uri },
        })
      })
      .catch((err: unknown) => {
        setStep({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="share-contact-title">
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title" id="share-contact-title">{title}</h2>
          <ModalCloseButton onClose={onClose} />
        </div>

        <div className="modal-body">
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

const PAIRING_TIMEOUT_MS = 60_000

interface NonOkStatus {
  status: number
  memo: string
  channelId?: string
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
  onPairingRequestSent: (channelId: bigint, participantId?: string) => void
  /**
   * Optional: given a contact, resolve which participant ID it belongs to.
   * Used to associate a PairingCompleted event with the correct provisioned
   * participant when the caller doesn't already know the participant ID.
   * Resolved by matching contact.transport_protocol.uri against participant.transport.uri.
   */
  resolveParticipantId?: (contact: ContactMessage) => string | undefined
  startPairing: (contact: ContactMessage) => Promise<bigint>
}) {
  const { log } = useConsole()
  const [payload, setPayload] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<PairInitiatorStep>({ kind: 'input' })

  // Snapshotted when entering the waiting state so we only react to events after the request.
  const rejectionCountAtWaitRef = useRef(pairingRejectionCount)
  const completedSignalAtWaitRef = useRef(pairingCompletedSignal)

  // For non-recovery pairings: pairedChannelIds contains the new channel ID once
  // PairingCompleted fires, so we can detect success here.
  // For recovery pairings the new channel goes into participant.recoveryChannelId
  // instead, so this check won't fire — the signal fallback below handles that case.
  useEffect(() => {
    if (step.kind !== 'waiting') return
    const channelIdStr = step.channelId.toString()
    const found = pairedChannelIds.has(channelIdStr)

    if (found) {

      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStep({ kind: 'success', channelId: step.channelId })
    }
  }, [step, pairedChannelIds])

  // Fallback for recovery pairings (see comment above).
  useEffect(() => {
    if (step.kind !== 'waiting') return
    if (pairingCompletedSignal > completedSignalAtWaitRef.current) {

      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStep({ kind: 'success', channelId: step.channelId })
    }
  }, [step.kind, step.channelId, pairingCompletedSignal])

  useEffect(() => {
    if (step.kind !== 'waiting') return
    if (pairingRejectionCount > rejectionCountAtWaitRef.current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStep({ kind: 'failed', reason: 'The peer rejected the pairing request.' })
    }
  }, [step.kind, pairingRejectionCount])

  useEffect(() => {
    if (step.kind !== 'waiting') return
    const timer = setTimeout(() => {
      setStep({ kind: 'failed', reason: 'Pairing request timed out. The peer may not have responded.' })
    }, PAIRING_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [step.kind])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setStep({ kind: 'sending' })
    try {
      const contact = deserializeContact(payload.trim())
      const channelId = await startPairing(contact)

      log({
        role: 'owner',
        flow: 'pairing',
        step: 'start_pairing',
        description: `Pairing request sent for channel ${channelId.toString()}`,
        payload: { channelId: channelId.toString() },
      })

      // Resolve participant ID from the contact's transport URI when it wasn't
      // provided statically. This handles the case where a provisioned participant's
      // contact JSON is pasted into the generic Pair modal.
      const resolvedParticipantId = participantId ?? resolveParticipantId?.(contact)
      onPairingRequestSent(channelId, resolvedParticipantId)
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
              Pairing completed successfully. The helper is now ready to receive shares.
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

            <div className="modal-actions">
              <button type="button" className="secondary" onClick={handleClose} disabled={step.kind === 'sending'}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={payload.trim().length === 0 || step.kind === 'sending'}>
                {step.kind === 'sending' ? 'Sending…' : 'Pair'}
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
  startPairing: (contact: ContactMessage) => Promise<bigint>
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
      const channelId = await startPairing(contact)

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
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [timedOut, setTimedOut] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (sent) return
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
    }, PAIRING_TIMEOUT_MS)
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
              <dd><code className="secret-id-value" title={bag.secretId}>{bag.secretId.slice(0, 12)}…</code></dd>
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

function PairedParticipantsList({
  participants,
  onTogglePair,
}: {
  participants: PairedParticipant[]
  onTogglePair: (id: string) => void
}) {
  const paired = participants.filter(h => h.connectionStatus === 'paired')

  if (paired.length === 0) {
    return <p className="tab-empty-state">No paired participants yet. Add and pair one from the side panel.</p>
  }

  return (
    <div className="channel-table">
      {paired.map(h => (
        <div key={h.id} className="channel-row">
          <div className="channel-row-top">
            <span className={`participant-dot ${h.offline ? 'offline' : 'paired'}`} aria-hidden="true" />
            <span className="channel-row-name" style={{ flex: 'none' }}>{h.name}</span>
            <span className="channel-id-inline">{h.channelId}</span>
            <span style={{ flex: 1 }} />
            {h.recoveryChannelId && (
              <span className="status-tag recovery-channel" title={`Recovery channel: ${h.recoveryChannelId}`}>
                Recovery
              </span>
            )}
            {h.offline && (
              <span className="status-tag offline">Offline</span>
            )}
            <button className="channel-unpair-btn" onClick={() => onTogglePair(h.id)}>
              Unpair
            </button>
          </div>
          <div className="channel-row-bottom">
            {h.recoveryChannelId && (
              <div className="channel-prop">
                <span className="channel-prop-label">Recovery Ch.</span>
                <code className="channel-id-inline">{h.recoveryChannelId}</code>
              </div>
            )}
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
        </div>
      ))}
    </div>
  )
}

function RecoveryParticipantCard({
  participant,
}: {
  participant: PairedParticipant
}) {
  return (
    <div className="detail-card">
      <div className="card-header">
        <span className={`participant-dot paired`} aria-hidden="true" />
        <span className="card-title">{participant.name}</span>
        <ClickToCopyCode label="Channel ID" value={participant.channelId} />
        <span className={`status-tag ${participant.discoveryComplete ? 'paired' : 'available'}`}>
          {participant.discoveryComplete ? 'Discovered' : 'Pending'}
        </span>
      </div>
    </div>
  )
}

function RecoveredSecretCard({ secret }: { secret: RecoveredSecret }) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="detail-card">
      <div className="card-header">
        <span className="card-title">{secret.label}</span>
        <span className="version-tag">v{secret.version}</span>
        <span className="status-tag paired">Recovered</span>
      </div>
      <div className="card-body">
        <dl className="field-list">
          <div className="field-row">
            <dt>Secret ID</dt>
            <dd>
              <code className="secret-id-value" title={secret.secretId}>
                {secret.secretId.slice(0, 12)}…
              </code>
            </dd>
          </div>
          <div className="field-row">
            <dt>Recovered Value</dt>
            <dd>
              <div className="shared-key-field">
                <code className="key-input" style={{ fontFamily: 'inherit' }}>
                  {visible ? secret.secretData : '•'.repeat(Math.min(secret.secretData.length, 24))}
                </code>
                <button
                  type="button"
                  className="secondary reveal-btn"
                  onClick={() => setVisible(v => !v)}
                  aria-label={visible ? 'Hide secret' : 'Reveal secret'}
                >
                  {visible ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </dd>
          </div>
        </dl>
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

function ShareDataRow({ channelId, version, ownerId }: { channelId: string; version: number; ownerId: string }) {
  const [format, setFormat] = useState<ShareFormat>('base64')

  const raw = localStorage.getItem(`derec:owner:${ownerId}:share:${channelId}:${version}`)
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
}: {
  shares: HeldShare[]
  participants: PairedParticipant[]
  ownerId: string
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
              <ShareDataRow channelId={share.channelId} version={share.version} ownerId={ownerId} />
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
}: {
  session: OwnerSession
  onRequestDiscovery: () => Promise<void>
  onRecover: (secretId: string, version: number, label: string, participantChannelIds: bigint[]) => Promise<void>
}) {
  const recoveryParticipants = session.participants.filter(
    h => h.recoveryPaired && h.connectionStatus === 'paired',
  )
  const recoveredSecrets = session.recoveredSecrets ?? []
  const alreadyRecoveredKeys = new Set(recoveredSecrets.map(s => `${s.secretId}:${s.version}`))
  const recoveryProgress = session.recoveryProgress

  // Aggregate discovered versions from all recovery-paired helpers.
  // Each entry carries which helpers have that (secretId, version) so we can
  // check whether the threshold is met before enabling the Recover button.
  type AggregatedEntry = {
    secretId: string
    version: number
    description: string
    helperChannelIds: bigint[]
    helperNames: string[]
  }
  const entryMap = new Map<string, AggregatedEntry>()
  for (const h of recoveryParticipants) {
    for (const v of h.discoveredVersions ?? []) {
      const key = `${v.secretId}:${v.version}`
      const existing = entryMap.get(key)
      if (existing) {
        existing.helperChannelIds.push(BigInt(h.channelId))
        existing.helperNames.push(h.name)
      } else {
        entryMap.set(key, {
          secretId: v.secretId,
          version: v.version,
          description: v.description,
          helperChannelIds: [BigInt(h.channelId)],
          helperNames: [h.name],
        })
      }
    }
  }
  const availableSecrets = Array.from(entryMap.values()).sort((a, b) => a.version - b.version)

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
            No helpers paired in recovery mode yet. Use the "Pair" button while Recovery Mode is active.
          </p>
        ) : (
          <div className="card-list">
            {recoveryParticipants.map(h => (
              <RecoveryParticipantCard key={h.id} participant={h} />
            ))}
          </div>
        )}
      </div>

      {/* Available secrets discovered from helpers */}
      {availableSecrets.length > 0 && (
        <div className="recovery-section">
          <h3 className="sub-heading">Available Secrets</h3>
          <div className="card-list">
            {availableSecrets.map(entry => {
              const key = `${entry.secretId}:${entry.version}`
              const alreadyRecovered = alreadyRecoveredKeys.has(key)
              const helperCount = entry.helperChannelIds.length
              const isInProgress = recoveryProgress?.secretId === entry.secretId &&
                recoveryProgress?.version === entry.version &&
                !recoveryProgress?.error
              const entryError = recoveryProgress?.secretId === entry.secretId &&
                recoveryProgress?.version === entry.version
                  ? recoveryProgress.error
                  : null
              const insufficientShares = entryError != null
              return (
                <div key={key} className="detail-card">
                  <div className="card-header">
                    <span className="card-title">{entry.description || 'Untitled secret'}</span>
                    <span className="mono-tag">{entry.secretId.slice(0, 8)}…</span>
                    <span className="version-tag">v{entry.version}</span>
                    <span className={`status-tag ${alreadyRecovered ? 'paired' : isInProgress ? 'available' : entryError ? 'offline' : 'available'}`}>
                      {alreadyRecovered ? 'Recovered' : isInProgress ? 'Recovering…' : entryError ? 'Incomplete' : 'Ready'}
                    </span>
                  </div>
                  <div className="card-body">
                    <dl className="field-list">
                      <div className="field-row">
                        <dt>Helpers</dt>
                        <dd className="recovery-helper-count">
                          {helperCount} helper{helperCount !== 1 ? 's' : ''} available
                          {entry.helperNames.length > 0 && (
                            <span className="recovery-helper-names"> ({entry.helperNames.join(', ')})</span>
                          )}
                        </dd>
                      </div>
                      {isInProgress && (
                        <div className="field-row">
                          <dt>Progress</dt>
                          <dd>{recoveryProgress!.sharesReceived} share{recoveryProgress!.sharesReceived !== 1 ? 's' : ''} received…</dd>
                        </div>
                      )}
                    </dl>
                    {insufficientShares && (
                      <p className="recovery-insufficient-notice">
                        Not enough shares — pair with more helpers and try again.
                      </p>
                    )}
                    {!alreadyRecovered && (
                      <div className="recovery-action-row">
                        <button
                          className="primary"
                          disabled={isInProgress}
                          onClick={() => onRecover(entry.secretId, entry.version, entry.description || 'secret', entry.helperChannelIds)}
                        >
                          {entryError ? 'Try Again' : 'Recover'}
                        </button>
                      </div>
                    )}
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
              <RecoveredSecretCard key={`${s.secretId}-${s.version}`} secret={s} />
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
  startParticipantPairing: (contact: ContactMessage) => Promise<bigint>
  /**
   * When defined, the Pair button opens a modal for the user to paste the owner's
   * contact JSON. The backend actor then initiates pairing using that contact.
   */
  startPairingAsInitiator?: (ownerContact: ContactMessage) => Promise<bigint>
  pairedChannelIds: Set<string>
  pairingRejectionCount: number
  pairingCompletedSignal: number
}) {
  const [expanded, setExpanded] = useState(false)
  const [shareContactOpen, setShareContactOpen] = useState(false)
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
      const channelId = await startParticipantPairing(contact)
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
          label="Owner Contact (QR Payload)"
          placeholder="Paste the JSON payload from the owner's Share Contact QR code"
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
  sessionId,
  ownerName,
  onTogglePair,
  onToggleParticipantStatus,
  onToggleReplicaStatus,
  onPairingCreated,
  onPairingRequestSent,
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
  sessionId: string
  ownerName: string
  onTogglePair: (id: string) => void
  onToggleParticipantStatus: (participantId: string) => Promise<void>
  onToggleReplicaStatus: (replicaId: string) => Promise<void>
  onPairingCreated: (channelId: bigint, actorId: string) => void
  onPairingRequestSent: (channelId: bigint, actorId: string) => void
  onAddParticipant: (name: string, autoPair: boolean) => Promise<void>
  onAddReplica: (name: string) => Promise<void>
  onReplicaPairStarted: (replicaId: string) => void
  getParticipantFunctions: (participantId: string) => {
    createContact: () => Promise<ContactMessage>
    startPairing: (contact: ContactMessage) => Promise<bigint>
    startPairingAsInitiator?: (ownerContact: ContactMessage) => Promise<bigint>
  }
  getReplicaFunctions: (replicaId: string) => {
    createContact: () => Promise<ContactMessage>
    startPairing: (contact: ContactMessage) => Promise<bigint>
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
  const [activeTab, setActiveTab] = useState<ActiveTab>('participants')
  const [shareOpen, setShareOpen] = useState(false)
  const [pairOpen, setPairOpen] = useState(false)
  const [provisioningReplicaId, setProvisioningReplicaId] = useState<string | null>(null)
  const [protectOpen, setProtectOpen] = useState(false)
  const [protocolBusy, setProtocolBusy] = useState(false)
  const [recoveryMode, setRecoveryMode] = useState(false)
  const recoveryModeRef = useRef(false)
  recoveryModeRef.current = recoveryMode
  // Preserved on recovery entry so we can restore them when the user exits recovery mode.
  const preRecoveryParticipantsRef = useRef<PairedParticipant[] | null>(null)
  const preRecoverySecretBagRef = useRef<import('./types').SecretBag | null>(null)
  const preRecoveryHeldSharesRef = useRef<HeldShare[] | null>(null)

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
    /** True when the peer initiated pairing in recovery mode (SenderKind.OwnerRecovery). */
    isRecovery: boolean
    /**
     * For recovery pairings only — drives the two-step modal:
     * - 'confirm': show recovery notice, user clicks "Continue"
     * - 'link': user selects the old contact to link; "Link & Accept" sends the response
     */
    step: 'confirm' | 'link'
    /** The old channel ID chosen by Alice in the 'link' step. null until chosen. */
    selectedOldChannelId: string | null
    /** Opaque action token from ActionRequired event — pass to accept() or reject(). */
    action: Uint8Array
  }

  const [pendingPairingConfirmation, setPendingPairingConfirmation] = useState<PendingPairingConfirmation | null>(null)
  const pendingPairingConfirmationRef = useRef<PendingPairingConfirmation | null>(null)
  useEffect(() => { pendingPairingConfirmationRef.current = pendingPairingConfirmation }, [pendingPairingConfirmation])

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

  const ownerProtocolRef = useRef<DeRecProtocol | null>(null)
  const ownerShareStoreRef = useRef<ReturnType<typeof makeShareStore> | null>(null)

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
  const pendingBagRef = useRef<{ bag: SecretBag; version: number; secretIdHex: string } | null>(null)

  // Tracks in-flight verification challenges keyed by participant channelId.
  const pendingVerificationsRef = useRef<Map<string, { secretIdHex: string; version: number }>>(new Map())

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

  useEffect(() => {
    const { sessionId, ownerId, transport, participants } = session

    // Recovery mode uses a separate namespace so the protocol starts with no
    // pre-existing channels. This mirrors real lost-device recovery: only
    // helpers explicitly re-paired in recovery mode are available to
    // RecoverSecret, so the library properly fails with RecoveryShareError
    // when fewer than `threshold` shares are collected.
    const ns = recoveryMode ? `owner:${ownerId}:recovery` : `owner:${ownerId}`

    // In recovery mode there is no existing bag to reuse; generate a fresh ID.
    const secretIdHex = recoveryMode ? null : session.secretBag?.secretId
    const secretId = secretIdHex
      ? Uint8Array.from(secretIdHex.match(/.{2}/g)!.map(b => parseInt(b, 16)))
      : crypto.getRandomValues(new Uint8Array(16))

    const shareStore = makeShareStore(ns)
    const ownerProtocol = new DeRecProtocol(
      makeChannelStore(ns),
      shareStore,
      makeSecretStore(ns),
      makeTransport(sendMessage),
      transport.uri,
      'https',
      session.minParticipants,  // threshold
      3,                         // keep_versions_count
      secretId,
      { name: session.ownerName },  // communication_info
    )
    ownerProtocolRef.current = ownerProtocol
    ownerShareStoreRef.current = shareStore

    // Seed the owner version counter from the existing secret bag so that
    // latestVersion() returns the correct value on session reload.
    // Not applicable in recovery mode (no bag exists yet on this namespace).
    if (!recoveryMode && session.secretBag) {
      shareStore.setOwnerVersion(session.secretBag.currentVersion.version)
    }

    log({
      role: 'owner',
      flow: 'session',
      step: 'protocol_init',
      description: `Owner protocol initialized for session ${sessionId} (${recoveryMode ? 'recovery' : 'normal'} mode)`,
      payload: { sessionId, ownerId, participantCount: participants.length, recoveryMode },
    })

    // In recovery mode Alice is not protecting secrets and doesn't need to be
    // discoverable by other owners, so skip the normal-mode setup below.
    if (!recoveryMode) {
      // The backend's disabled_participants set is in-memory and resets on restart;
      // re-apply any offline flags the FE has persisted.
      for (const h of participants) {
        if (h.offline) {
          apiToggleParticipantStatus(sessionId, h.id, true).catch(() => {})
        }
      }

      async function postOwnerContact() {
        try {
          const contact = await withProtocolLock(() => ownerProtocol.createContact(null))
          ownerContactChannelRef.current = contact.channel_id

          const dto = contactMessageToDto(contact)
          await apiPostBrowserContact(sessionId, ownerId, JSON.stringify(dto))
          log({
            role: 'owner',
            flow: 'pairing',
            step: 'owner_contact_posted',
            description: 'Owner contact posted for peer discovery',
            payload: { ownerId, contactChannelId: contact.channel_id },
          })
        } catch (err) {

        }
      }
      postOwnerContact()
    }

    return () => {
      ownerProtocolRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId, recoveryMode])

  // Throttle for retrying discovery when a recovery-paired helper returned empty secrets.
  const lastDiscoveryRetryRef = useRef(0)

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
      const protocol = ownerProtocolRef.current
      if (!protocol) return

      const newPairings: Array<{ channelId: bigint; participantId: string }> = []

      for (const participant of participantsToAutoPair) {
        try {
          const dto = await apiCreateActorContact(session.sessionId, participant.id)
          const contact = dtoToContactMessage(dto)
          const channelId = await withProtocolLock(() => protocol.start(FlowKind.Pairing, { kind: SenderKind.OwnerNonRecovery, contact }) as Promise<bigint>)

          newPairings.push({ channelId, participantId: participant.id })

          log({
            role: 'owner',
            flow: 'pairing',
            step: 'auto_pair_initiated',
            description: `Auto-pair initiated for ${participant.name}`,
            payload: { participantId: participant.id, channelId: channelId.toString() },
          })
        } catch (err) {

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

  function applyOwnerEvent(
    current: OwnerSession,
    event: {
      type: string
      channel_id?: string
      version?: number
      kind?: number
      secrets?: Array<{ secret_id: Uint8Array; versions: Array<{ version: number; description: string }> }>
      secret?: Uint8Array
      shares_received?: number
      error?: string
      reason?: string
      peer_communication_info?: Record<string, string>
      status?: number
      memo?: string
      confirmed_count?: number
      failed_count?: number
      threshold_met?: boolean
    },
  ): OwnerSession {
    if (event.type === 'PairingCompleted' && event.channel_id) {
      const channelId = event.channel_id
      // isRecovery when: the peer announced OwnerRecovery (Alice is someone else's helper),
      // OR Alice herself is in recovery mode (any pairing she completes is a recovery pairing,
      // regardless of the peer's sender kind — provisioned participants may use a different kind).
      const isRecovery = event.kind === SenderKind.OwnerRecovery || recoveryModeRef.current

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

      // Try matching by channel ID first (works for participants). For replicas, fall back
      // to finding a pending pairing whose participantId is a replica.
      let pending = current.pendingPairings.find(p => p.channelId.toString() === channelId)
      if (!pending) {
        pending = current.pendingPairings.find(p => p.participantId != null && replicaIds.has(p.participantId))
      }
      const actorId = pending?.participantId
      const isReplica = actorId != null && replicaIds.has(actorId)

      log({
        role: 'owner',
        flow: 'pairing',
        step: 'PairingCompleted',
        description: `Pairing complete for channel ${channelId}${isRecovery ? ' (recovery)' : isReplica ? ' (replica)' : ''}`,
        payload: { channelId, actorId, isRecovery, isReplica },
      })

      let updated: OwnerSession = {
        ...current,
        pendingPairings: pending
          ? current.pendingPairings.filter(p => p !== pending)
          : current.pendingPairings.filter(p => p.channelId.toString() !== channelId),
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
      } else if (actorId && updated.participants.some(h => h.id === actorId)) {
        // Update the existing participant's status and channelId.
        updated = {
          ...updated,
          participants: updated.participants.map(h =>
            h.id === actorId
              ? { ...h, channelId, connectionStatus: 'paired' as const, recoveryPaired: isRecovery || undefined }
              : h,
          ),
        }
      } else {
        // Unknown peer — no pending pairing with a participant ID.
        // This is the normal path for browser-to-browser owner pairings
        // (e.g. Bob initiating with Alice, or Alice using the "Pair" modal
        // without resolveParticipantId matching a known actor).
        const peerName = event.peer_communication_info?.name || 'Peer'

        const tempId = `peer-${channelId}`
        updated = {
          ...updated,
          participants: [...updated.participants, {
            id: tempId,
            name: peerName,
            channelId,
            transport: { protocol: 'https' as const, uri: '' },
            connectionStatus: 'paired' as const,
            secretShares: [],
            recoveryPaired: isRecovery || undefined,
          }],
        }

        // Try to resolve peer identity from the backend session.
        const sessionId = current.sessionId
        const ownerId = current.ownerId
        apiGetSession(sessionId).then(resp => {
          const snapshot = sessionRef.current
          // Find owner actors that aren't us and aren't already in our list.
          const knownIds = new Set(snapshot.participants.map(h => h.id))
          const peerActor = resp.actors.find(a =>
            a.role === 'owner' && a.id !== ownerId && !knownIds.has(a.id)
          )
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

      // Discovery is NOT triggered here — the participant must first associate
      // the new channel with the old one. Session status polling detects when
      // pendingRecoveryChannelId clears and triggers discovery at that point.

      // Read the shared key from the local secret store for browser-managed peers.
      // Backend-managed participants get their shared key from the backend poll,
      // but for WASM-to-WASM pairing the key only exists locally.
      const localSharedKey = localStorage.getItem(
        `derec:owner:${current.ownerId}:secret:${channelId}:0`,
      )
      if (localSharedKey) {
        const targetId = isReplica ? undefined : (actorId ?? `peer-${channelId}`)
        if (targetId) {
          updated = {
            ...updated,
            participants: updated.participants.map(h =>
              h.id === targetId ? { ...h, sharedKey: localSharedKey } : h,
            ),
          }
        }
      }

      return updated
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

      if (thresholdMet && pending && pending.version === version) {
        // Threshold met — commit the pending bag and advance the owner version
        // counter so the next ProtectSecret starts at version + 1.
        ownerShareStoreRef.current?.setOwnerVersion(version)
        return {
          ...current,
          secretBag: pending.bag,
        }
      }

      if (!thresholdMet) {
        // Threshold not met — discard the pending bag and reset the owner version
        // counter so the next attempt reuses the same version number.
        const previousVersion = current.secretBag?.currentVersion.version ?? null
        if (previousVersion !== null) {
          ownerShareStoreRef.current?.setOwnerVersion(previousVersion)
        } else {
          ownerShareStoreRef.current?.clearOwnerVersion()
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
        h => h.channelId === channelId || h.recoveryChannelId === channelId
      )
      if (!participant) return current

      // serde-wasm-bindgen serialises Vec<u8> as Array<number>, not Uint8Array.
      const discoveredVersions = event.secrets.flatMap(s => {
        const secretIdHex = Array.from(s.secret_id as number[])
          .map(b => b.toString(16).padStart(2, '0')).join('')
        return s.versions.map(v => ({
          secretId: secretIdHex,
          version: v.version,
          description: v.description,
        }))
      })

      // If the response is empty it is likely a race condition: the helper
      // processed our discovery request before processing our acceptance (the
      // backend adds a random 500–3000 ms delay per message, so ordering is
      // not guaranteed). Don't mark as discovered; the polling loop will retry.
      if (discoveredVersions.length === 0) {
        log({
          role: 'owner',
          flow: 'recovery',
          step: 'SecretsDiscovered',
          description: `Discovery returned 0 secrets from ${participant.name} — will retry`,
          payload: { channelId },
        })
        return current
      }

      log({
        role: 'owner',
        flow: 'recovery',
        step: 'SecretsDiscovered',
        description: `Discovered ${discoveredVersions.length} version(s) from ${participant.name}`,
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

      return {
        ...current,
        recoveryProgress: { ...progress, sharesReceived, error },
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

      return {
        ...current,
        recoveryProgress: {
          ...progress,
          sharesReceived: event.shares_received ?? progress.sharesReceived,
          error: event.error ?? 'Unknown recovery error',
        },
      }
    }

    if (event.type === 'SecretRecovered' && event.secret) {
      const pending = pendingRecoveryRef.current
      // serde-wasm-bindgen serializes Vec<u8> as a plain JS Array<number>, not Uint8Array.
      // TextDecoder.decode() requires a BufferSource, so convert first.
      const secretBytes = event.secret instanceof Uint8Array
        ? event.secret
        : new Uint8Array(event.secret)
      const secretData = new TextDecoder().decode(secretBytes)

      log({
        role: 'owner',
        flow: 'recovery',
        step: 'SecretRecovered',
        description: `Secret recovered: ${pending?.label ?? 'unknown'}`,
        payload: { secretId: pending?.secretId, version: pending?.version, dataLength: event.secret.length },
      })

      if (!pending) return current

      pendingRecoveryRef.current = null

      return {
        ...current,
        recoveryProgress: null,
        recoveredSecrets: [
          ...(current.recoveredSecrets ?? []),
          {
            secretId: pending.secretId,
            version: pending.version,
            label: pending.label,
            secretData,
          },
        ],
      }
    }

    return current
  }

  // Poll faster (500ms) during auto-pair so the setup gate clears quickly.

  const pollInterval = (autoPairingIds.length > 0 || recoveryMode || protocolBusy) ? 500 : 5000

  useEffect(() => {
    let ownerPollRunning = false
    const id = setInterval(async () => {
      if (ownerPollRunning) return
      // Skip processing while a pairing confirmation modal is open.
      if (pendingPairingConfirmationRef.current || pendingStoreShareConfirmationRef.current || pendingVerifyShareConfirmationRef.current) return
      ownerPollRunning = true
      try {
        const { sessionId, ownerId } = sessionRef.current
        const protocol = ownerProtocolRef.current
        if (!protocol) return

        let messages
        try {
          messages = await pollMailbox(sessionId, 'owners', ownerId)
        } catch (err) {

          return
        }

        if (messages.length === 0) return

        await withProtocolLock(async () => {
          const initial = sessionRef.current
          let updated = initial
          let shouldBreak = false

          for (const { bytes } of messages!) {
            if (shouldBreak) break

            let events: { type: string; channel_id?: string; kind?: number; version?: number; secret?: Uint8Array; shares_received?: number; error?: string; reason?: string; action?: Uint8Array; action_kind?: string; peer_communication_info?: Record<string, string>; share_version?: number; share_description?: string; share_secret_id?: number[]; status?: number; memo?: string; confirmed_count?: number; failed_count?: number; threshold_met?: boolean }[]
            try {
              events = Array.from(await protocol.process(bytes)) as typeof events
            } catch (err) {
              const nonOk = asNonOkStatus(err)
              if (nonOk) {
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
              } else {
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
                  const isRecovery = event.sender_kind === SenderKind.OwnerRecovery
                  setPendingPairingConfirmation({
                    peerName,
                    channelId,
                    isRecovery,
                    step: 'confirm',
                    selectedOldChannelId: null,
                    action: event.action,
                  })

                  log({
                    role: 'owner',
                    flow: 'pairing',
                    step: 'pairing_confirmation_pending',
                    description: `Pairing request from "${peerName}" — waiting for user confirmation`,
                    payload: { channelId },
                  })

                  // Skip remaining messages; they'll be picked up on next poll.
                  shouldBreak = true
                  break
                } else if (event.action_kind === 'StoreShare') {
                  // Browser-based user must confirm before storing a share.
                  const channelId = event.channel_id!
                  const peer = updated.participants.find(h => h.channelId === channelId)
                  const peerName = peer?.name || 'Unknown peer'

                  const secretIdHex = Array.from(event.share_secret_id ?? [])
                    .map(b => b.toString(16).padStart(2, '0')).join('')

                  setPendingStoreShareConfirmation({
                    peerName,
                    channelId,
                    secretId: secretIdHex,
                    version: event.share_version ?? 0,
                    description: event.share_description || '',
                    action: event.action,
                  })

                  log({
                    role: 'owner',
                    flow: 'sharing',
                    step: 'store_share_confirmation_pending',
                    description: `Share storage request from "${peerName}" — waiting for confirmation`,
                    payload: { channelId, version: event.share_version },
                  })

                  shouldBreak = true
                  break
                } else if (event.action_kind === 'VerifyShare') {
                  // Browser-based user must confirm before responding to verification.
                  const channelId = event.channel_id!
                  const peer = updated.participants.find(h => h.channelId === channelId)
                  const peerName = peer?.name || 'Unknown peer'

                  const secretIdHex = Array.from(event.share_secret_id ?? [])
                    .map(b => b.toString(16).padStart(2, '0')).join('')

                  setPendingVerifyShareConfirmation({
                    peerName,
                    channelId,
                    version: event.share_version ?? 0,
                    secretId: secretIdHex,
                    action: event.action,
                  })

                  log({
                    role: 'owner',
                    flow: 'verification',
                    step: 'verify_share_confirmation_pending',
                    description: `Verification request from "${peerName}" — waiting for confirmation`,
                    payload: { channelId, version: event.share_version },
                  })

                  shouldBreak = true
                  break
                } else {
                  // Auto-accept remaining requests (Discovery, GetShare).
                  try {
                    const acceptEvents = Array.from(await protocol.accept(event.action)) as typeof events
                    for (const e of acceptEvents) {
                      updated = applyOwnerEvent(updated, e)
                    }
                  } catch (err) {

                  }
                }
                continue
              }

              try {
                updated = applyOwnerEvent(updated, event)
              } catch (err) {

              }

              // Signal any waiting PairInitiatorModal that a pairing completed.
              // This is the fallback path for recovery pairings where protocol.start()
              // returns a different channel ID than PairingCompleted.channel_id.
              if (event.type === 'PairingCompleted') {
                setPairingCompletedSignal(c => c + 1)
              }

              // After a recovery pairing completes, immediately send a Discovery request
              // so the owner learns which shares the new helper holds.
              if (event.type === 'PairingCompleted' && (event.kind === SenderKind.OwnerRecovery || recoveryModeRef.current) && event.channel_id) {
                try {
                  await protocol.start(FlowKind.Discovery, { target: BigInt(event.channel_id) })
                  log({
                    role: 'owner',
                    flow: 'recovery',
                    step: 'discovery_sent',
                    description: `Discovery sent to recovery helper on channel ${event.channel_id}`,
                    payload: { channelId: event.channel_id },
                  })
                } catch (err) {

                }
              }
            }
          }

          if (updated !== initial) {
            sessionRef.current = updated
            onUpdateRef.current(updated)
          }

          // Retry discovery for recovery-paired helpers that returned empty secrets.
          // This handles the race where the helper processes the discovery request
          // before processing the acceptance (due to random backend message delays),
          // causing it to respond with no shares. We retry at most once every 3 s.
          if (recoveryModeRef.current) {
            const hasUndiscovered = updated.participants.some(
              h => h.recoveryPaired && h.connectionStatus === 'paired' && !h.discoveryComplete && h.channelId,
            )
            if (hasUndiscovered) {
              const now = Date.now()
              if (now - lastDiscoveryRetryRef.current >= 3000) {
                lastDiscoveryRetryRef.current = now
                try {
                  await protocol.start(FlowKind.Discovery, {})
                  log({
                    role: 'owner',
                    flow: 'recovery',
                    step: 'discovery_retry',
                    description: 'Retrying discovery for undiscovered recovery helpers',
                    payload: {},
                  })
                } catch (err) {

                }
              }
            }
          }
        })
      } catch (err) {

      } finally {
        ownerPollRunning = false
      }
    }, pollInterval)

    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId, pollInterval])

  /** For recovery pairings: advance from 'confirm' to the 'link' step. */
  function handleContinueToLinkStep() {
    setPendingPairingConfirmation(prev => prev ? { ...prev, step: 'link' } : null)
  }

  async function handleAcceptPairing() {
    const confirmation = pendingPairingConfirmation
    if (!confirmation) return

    const protocol = ownerProtocolRef.current
    if (!protocol) return

    // For recovery pairings the user must have selected an old contact.
    if (confirmation.isRecovery && !confirmation.selectedOldChannelId) return

    try {
      const events = await withProtocolLock(() => protocol.accept(confirmation.action))
      const eventArray = Array.from(events) as Array<{ type: string; channel_id?: string; kind?: number; version?: number; secret?: Uint8Array; shares_received?: number; error?: string }>

      let updated = sessionRef.current
      let pairingCompleted = false
      let pairingCompletedChannelId: string | undefined
      for (const event of eventArray) {
        try {
          updated = applyOwnerEvent(updated, event)
        } catch (err) {

        }
        if (event.type === 'PairingCompleted') {
          pairingCompleted = true
          pairingCompletedChannelId = event.channel_id
        }
      }
      if (pairingCompleted) {
        setPairingCompletedSignal(c => c + 1)
        // In recovery mode, auto-discover shares from the newly confirmed helper.
        if (recoveryModeRef.current && pairingCompletedChannelId) {
          try {
            await withProtocolLock(() => protocol.start(FlowKind.Discovery, { target: BigInt(pairingCompletedChannelId!) }))
            log({
              role: 'owner',
              flow: 'recovery',
              step: 'discovery_sent',
              description: `Discovery sent to recovery helper on channel ${pairingCompletedChannelId} (manual accept)`,
              payload: { channelId: pairingCompletedChannelId },
            })
          } catch (err) {

          }
        }
      }

      // For recovery pairings: the library emits PairingCompleted with kind=Helper on
      // the acceptor side, so applyOwnerEvent cannot detect the recovery context and falls
      // back to creating a new participant entry. Merge the new channel into the existing
      // participant (identified by selectedOldChannelId) and remove the duplicate.
      if (confirmation.isRecovery && confirmation.selectedOldChannelId) {
        const oldChannelId = confirmation.selectedOldChannelId
        const newChannelId = confirmation.channelId
        updated = {
          ...updated,
          participants: updated.participants
            .filter(p => p.channelId !== newChannelId)  // remove duplicate entry for new channel
            .map(p =>
              p.channelId === oldChannelId
                ? { ...p, recoveryChannelId: newChannelId, recoveryPaired: true }
                : p,
            ),
        }
      }

      // For recovery pairings: mirror shares from the old channel to the new one so
      // that the library can serve Discovery and GetShare requests on the new channel.
      if (confirmation.isRecovery && confirmation.selectedOldChannelId) {
        const shareStore = ownerShareStoreRef.current
        if (shareStore) {
          await shareStore.copyShares(confirmation.selectedOldChannelId, confirmation.channelId)
        }

        const link: RecoveryChannelLink = {
          newChannelId: confirmation.channelId,
          oldChannelId: confirmation.selectedOldChannelId,
        }
        updated = {
          ...updated,
          recoveryChannelLinks: [...(updated.recoveryChannelLinks ?? []), link],
        }

        log({
          role: 'owner',
          flow: 'pairing',
          step: 'recovery_channel_linked',
          description: `Linked new channel ${confirmation.channelId} → old channel ${confirmation.selectedOldChannelId} for recovery`,
          payload: { newChannelId: confirmation.channelId, oldChannelId: confirmation.selectedOldChannelId },
        })
      }

      if (updated !== sessionRef.current) {
        sessionRef.current = updated
        onUpdateRef.current(updated)
      }
    } catch (err) {

    }

    log({
      role: 'owner',
      flow: 'pairing',
      step: 'pairing_confirmed',
      description: `Accepted pairing request from "${confirmation.peerName}"${confirmation.isRecovery ? ' (recovery)' : ''}`,
      payload: { channelId: confirmation.channelId },
    })

    setPendingPairingConfirmation(null)
  }

  async function handleRejectPairing() {
    const confirmation = pendingPairingConfirmation
    if (!confirmation) return

    const protocol = ownerProtocolRef.current
    if (!protocol) return

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

    }

    setPendingPairingConfirmation(null)
  }

  async function handleAcceptStoreShare() {
    const confirmation = pendingStoreShareConfirmation
    if (!confirmation) return

    const protocol = ownerProtocolRef.current
    if (!protocol) return

    try {
      const events = await withProtocolLock(() => protocol.accept(confirmation.action))
      const eventArray = Array.from(events) as Array<{ type: string; channel_id?: string; kind?: number; version?: number; secret?: Uint8Array; shares_received?: number; error?: string }>

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

        }
      }

      if (updated !== sessionRef.current) {
        sessionRef.current = updated
        onUpdateRef.current(updated)
      }
    } catch (err) {

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

    const protocol = ownerProtocolRef.current
    if (!protocol) return

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

    }

    setPendingStoreShareConfirmation(null)
  }

  // Auto-reject store-share requests after timeout.
  useEffect(() => {
    if (!pendingStoreShareConfirmation) return
    const timer = setTimeout(() => {
      handleRejectStoreShare()
    }, PAIRING_TIMEOUT_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingStoreShareConfirmation])

  async function handleAcceptVerifyShare() {
    const confirmation = pendingVerifyShareConfirmation
    if (!confirmation) return

    const protocol = ownerProtocolRef.current
    if (!protocol) return

    try {
      const events = await withProtocolLock(() => protocol.accept(confirmation.action))
      const eventArray = Array.from(events) as Array<{ type: string; channel_id?: string; kind?: number; version?: number }>

      let updated = sessionRef.current
      for (const event of eventArray) {
        try {
          updated = applyOwnerEvent(updated, event)
        } catch (err) {

        }
      }

      if (updated !== sessionRef.current) {
        sessionRef.current = updated
        onUpdateRef.current(updated)
      }
    } catch (err) {

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

    const protocol = ownerProtocolRef.current
    if (!protocol) return

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

    }

    setPendingVerifyShareConfirmation(null)
  }

  // Auto-reject verify-share requests after timeout.
  useEffect(() => {
    if (!pendingVerifyShareConfirmation) return
    const timer = setTimeout(() => {
      handleRejectVerifyShare()
    }, PAIRING_TIMEOUT_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingVerifyShareConfirmation])

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId, pollInterval])

  async function createOwnerContact(): Promise<ContactMessage> {
    return withProtocolLock(async () => {
      const protocol = ownerProtocolRef.current
      if (!protocol) throw new Error('Protocol not initialized')
      return protocol.createContact(null)
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
        startPairing: async (contact: ContactMessage): Promise<bigint> => {
          return withProtocolLock(async () => {
            const protocol = ownerProtocolRef.current
            if (!protocol) throw new Error('Protocol not initialized')
            return (recoveryMode
              ? protocol.start(FlowKind.Pairing, { kind: SenderKind.OwnerRecovery, contact })
              : protocol.start(FlowKind.Pairing, { kind: SenderKind.OwnerNonRecovery, contact })) as Promise<bigint>
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
      startPairing: async (contact: ContactMessage): Promise<bigint> => {
        return withProtocolLock(async () => {
          const protocol = ownerProtocolRef.current
          if (!protocol) throw new Error('Protocol not initialized')
          return (recoveryMode
            ? protocol.start(FlowKind.Pairing, { kind: SenderKind.OwnerRecovery, contact })
            : protocol.start(FlowKind.Pairing, { kind: SenderKind.OwnerNonRecovery, contact })) as Promise<bigint>
        })
      },
      startPairingAsInitiator: async (ownerContact: ContactMessage): Promise<bigint> => {
        // The user provides the owner's contact (pasted from QR).
        // The backend actor calls protocol.start with it, initiating pairing.
        const dto = contactMessageToDto(ownerContact)
        const result = await apiStartActorPairing(session.sessionId, participantId, dto)
        return BigInt(result.channel_id)
      },
    }
  }

  function getReplicaFunctions(replicaId: string) {
    return {
      createContact: async (): Promise<ContactMessage> => {
        const dto = await apiCreateActorContact(session.sessionId, replicaId)
        return dtoToContactMessage(dto)
      },
      startPairing: (contact: ContactMessage): Promise<bigint> => ownerStartPairing(contact),
    }
  }

  async function ownerStartPairing(contact: ContactMessage): Promise<bigint> {

    return withProtocolLock(async () => {
      const protocol = ownerProtocolRef.current
      if (!protocol) throw new Error('Protocol not initialized')
      const channelId = await (protocol.start(FlowKind.Pairing, { kind: SenderKind.OwnerNonRecovery, contact }) as Promise<bigint>)
      return channelId
    })
  }

  async function ownerAddSecret(name: string, data: string): Promise<void> {
    setProtocolBusy(true)
    const protocol = ownerProtocolRef.current
    if (!protocol) throw new Error('Protocol not initialized')

    const current = sessionRef.current
    const existingBag = current.secretBag

    // Build the full list of user secrets (existing + new).
    const newSecretId = crypto.getRandomValues(new Uint8Array(16))
    const newSecretIdHex = Array.from(newSecretId).map(b => b.toString(16).padStart(2, '0')).join('')
    const newUserSecret: UserSecret = { id: newSecretIdHex, name, data }

    const allUserSecrets = existingBag
      ? [...existingBag.currentVersion.secrets, newUserSecret]
      : [newUserSecret]

    // Build the JS array the WASM binding expects: Array<{ id: Uint8Array, name: string, data: Uint8Array }>
    const wasmSecrets = allUserSecrets.map(s => ({
      id: Uint8Array.from(s.id.match(/.{2}/g)!.map(b => parseInt(b, 16))),
      name: s.name,
      data: new TextEncoder().encode(s.data),
    }))

    await withProtocolLock(() => protocol.start(FlowKind.ProtectSecret, { secrets: wasmSecrets, description: 'DeRec Vault' }))

    // Compute the new version. The share store's owner version counter is NOT
    // updated here — it is deferred to the SharingComplete handler so that a
    // failed round doesn't advance the version.
    const newVersion = existingBag ? existingBag.currentVersion.version + 1 : 1
    const pairedParticipants = current.participants.filter(h => h.connectionStatus === 'paired')

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
          secretId: newSecretIdHex,
          currentVersion: newBagVersion,
          previousVersions: [],
          threshold: current.minParticipants,
        }
    pendingBagRef.current = { bag: pendingBag, version: newVersion, secretIdHex: newSecretIdHex }

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
    const protocol = ownerProtocolRef.current
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
      pendingVerificationsRef.current.set(participant.channelId, { secretIdHex: bag.secretId, version })
    }

    await withProtocolLock(() => protocol.start(FlowKind.VerifyShares, { version, target: targetChannelIds }))

    log({
      role: 'owner',
      flow: 'verification',
      step: 'verify_shares',
      description: `Verification challenges sent for bag v${version} to ${confirmedParticipants.length} participant(s)`,
      payload: { version, participantCount: confirmedParticipants.length },
    })
  }

  async function ownerStartRecoveryPairing(contact: ContactMessage): Promise<bigint> {
    return withProtocolLock(async () => {
      const protocol = ownerProtocolRef.current
      if (!protocol) throw new Error('Protocol not initialized')
      return protocol.start(FlowKind.Pairing, { kind: SenderKind.OwnerRecovery, contact }) as Promise<bigint>
    })
  }

  async function ownerRequestDiscovery(): Promise<void> {
    const protocol = ownerProtocolRef.current
    if (!protocol) throw new Error('Protocol not initialized')
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
    const protocol = ownerProtocolRef.current
    if (!protocol) throw new Error('Protocol not initialized')

    const secretIdBytes = Uint8Array.from(secretId.match(/.{2}/g)!.map(b => parseInt(b, 16)))
    pendingRecoveryRef.current = { secretId, version, label }
    const current = sessionRef.current
    const updated = { ...current, recoveryProgress: { secretId, version, sharesReceived: 0, totalRequested: participantChannelIds.length, error: null } }
    sessionRef.current = updated
    onUpdateRef.current(updated)
    await withProtocolLock(() => protocol.start(FlowKind.RecoverSecret, { secretId: secretIdBytes, version }))

    log({
      role: 'owner',
      flow: 'recovery',
      step: 'recover_secret',
      description: `Recovery requested for "${label}" v${version} from ${participantChannelIds.length} participant(s)`,
      payload: { secretId, version, channels: participantChannelIds.map(c => c.toString()) },
    })
  }

  function addPendingPairing(channelId: bigint, participantId?: string) {
    const pending: PendingPairing = { channelId, participantId }
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
      const protocol = ownerProtocolRef.current
      if (!protocol) {
        onUpdate(updated)
        return
      }
      try {
        const dto = await apiCreateActorContact(session.sessionId, resp.id)
        const contact = dtoToContactMessage(dto)
        const channelId = await withProtocolLock(() => protocol.start(FlowKind.Pairing, { kind: SenderKind.OwnerNonRecovery, contact }) as Promise<bigint>)
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

  function handleTogglePair(participantId: string) {
    const participant = session.participants.find(h => h.id === participantId)
    if (!participant) return
    const unpairing = participant.connectionStatus === 'paired'
    const updatedParticipants = session.participants.map(h =>
      h.id !== participantId ? h : {
        ...h,
        connectionStatus: unpairing ? 'available' as const : 'paired' as const,
        secretShares: unpairing ? [] : h.secretShares,
      }
    )
    // When unpairing, remove the participant from the bag's participant lists.
    const updatedBag = unpairing && session.secretBag
      ? updateBagVersion(session.secretBag, session.secretBag.currentVersion.version, v => ({
          ...v,
          participantIds: v.participantIds.filter(id => id !== participantId),
        }))
      : session.secretBag
    onUpdate({ ...session, participants: updatedParticipants, secretBag: updatedBag })
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
            Pair{recoveryMode ? ' (Recovery)' : ''}
          </button>
          {!recoveryMode && (() => {
            const pairedCount = session.participants.filter(p => p.connectionStatus === 'paired').length
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
          <button
            className={`secondary ${recoveryMode ? 'recovery-active' : ''}`}
            onClick={() => {
              if (recoveryMode) {
                // Exiting recovery: restore pre-recovery state and clear recovery data.
                setRecoveryMode(false)
                setActiveTab('participants')
                onUpdate({
                  ...session,
                  participants: preRecoveryParticipantsRef.current ?? session.participants,
                  secretBag: preRecoverySecretBagRef.current,
                  heldShares: preRecoveryHeldSharesRef.current ?? session.heldShares,
                  recoveredSecrets: [],
                  recoveryProgress: null,
                })
                preRecoveryParticipantsRef.current = null
                preRecoverySecretBagRef.current = null
                preRecoveryHeldSharesRef.current = null
              } else {
                // Entering recovery: snapshot current state, then reset to a clean slate.
                // Bob has lost his device — he has no secrets yet until recovery completes.
                preRecoveryParticipantsRef.current = session.participants
                preRecoverySecretBagRef.current = session.secretBag
                preRecoveryHeldSharesRef.current = session.heldShares ?? []
                // Clear the recovery namespace so every recovery entry starts
                // with empty stores, matching real lost-device behaviour.
                clearNamespace(`owner:${session.ownerId}:recovery`)
                setRecoveryMode(true)
                setActiveTab('recovery')
                onUpdate({
                  ...session,
                  secretBag: null,
                  heldShares: [],
                  participants: session.participants.map(h => ({
                    ...h,
                    connectionStatus: 'available' as const,
                    secretShares: [],
                    recoveryPaired: undefined,
                    discoveryComplete: undefined,
                    discoveredVersions: undefined,
                  })),
                  recoveredSecrets: [],
                  recoveryProgress: null,
                })
              }
            }}
            title={recoveryMode ? 'Exit recovery mode' : 'Enter recovery mode'}
          >
            {recoveryMode ? 'Exit Recovery' : 'Recovery Mode'}
          </button>
        </div>
      </div>

      {shareOpen && (
        <ShareContactModal
          title="Share Owner Contact"
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
          onPairingRequestSent={(channelId, participantId) => addPendingPairing(channelId, participantId)}
          resolveParticipantId={contact =>
            session.participants.find(p => p.transport.uri === contact.transport_protocol?.uri)?.id
          }
          startPairing={recoveryMode ? ownerStartRecoveryPairing : ownerStartPairing}
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
        const pairedCount = session.participants.filter(p => p.connectionStatus === 'paired').length
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
            {recoveryMode && (
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
              <PairedParticipantsList participants={session.participants} onTogglePair={handleTogglePair} />
            )}
            {activeTab === 'secrets' && (
              <SecretBagPanel bag={session.secretBag} participants={session.participants} onVerify={ownerVerifyShares} onVerifyClose={() => setProtocolBusy(false)} onAddSecret={() => setProtectOpen(true)} />
            )}
            {activeTab === 'shares' && (
              <HeldSharesList shares={session.heldShares ?? []} participants={session.participants} ownerId={session.ownerId} />
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
              />
            )}
          </div>
        </div>

        <SessionParticipantPanel
          participants={session.participants.filter(p => !p.browserManaged)}
          replicas={session.replicas ?? []}
          sessionId={session.sessionId}
          ownerName={session.ownerName}
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

      {/* Pairing confirmation modal */}
      {pendingPairingConfirmation && (() => {
        const conf = pendingPairingConfirmation

        if (!conf.isRecovery || conf.step === 'confirm') {
          return (
            <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="pairing-confirm-title">
              <div className="modal">
                <div className="modal-header">
                  <h2 className="modal-title" id="pairing-confirm-title">
                    {conf.isRecovery ? 'Incoming Recovery Pairing Request' : 'Incoming Pairing Request'}
                  </h2>
                </div>
                <div className="modal-body">
                  {conf.isRecovery && (
                    <div className="recovery-pairing-notice" role="status">
                      <span className="recovery-pairing-notice__icon" aria-hidden="true">⚠</span>
                      <span>
                        This peer is requesting to pair in <strong>recovery mode</strong>. They may have
                        lost access to their original device and need to retrieve their secrets.
                        Only proceed if you can verify their identity out-of-band.
                      </span>
                    </div>
                  )}
                  <p>
                    <strong>{conf.peerName}</strong>{' '}
                    {conf.isRecovery
                      ? 'needs your help to recover their secrets. In the next step you will link their new identity to their previous contact so you can serve them the shares you hold.'
                      : 'wants to pair with you. Do you want to accept this pairing?'}
                  </p>
                  <div className="modal-actions">
                    <button className="secondary" onClick={handleRejectPairing}>Reject</button>
                    {conf.isRecovery
                      ? <button className="primary" onClick={handleContinueToLinkStep}>Continue</button>
                      : <button className="primary" onClick={handleAcceptPairing}>Accept</button>
                    }
                  </div>
                </div>
              </div>
            </div>
          )
        }

        // Build list of linkable contacts from session.participants (for names) cross-
        // referenced with heldShares (to know which participants we actually hold shares for).
        // If no heldShares data exists yet (old sessions), fall back to all paired participants.
        const alreadyLinkedOld = new Set((session.recoveryChannelLinks ?? []).map(l => l.oldChannelId))

        // Show all paired participants — the user decides who the recovering peer is.
        // No filtering by heldShares: in a real deployment participants are not pre-labelled.
        const linkableContacts = session.participants.filter(p =>
          p.channelId && !alreadyLinkedOld.has(p.channelId),
        )

        return (
          <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="pairing-link-title">
            <div className="modal">
              <div className="modal-header">
                <h2 className="modal-title" id="pairing-link-title">Link to Previous Contact</h2>
              </div>
              <div className="modal-body">
                <p>
                  Select the original contact that <strong>{conf.peerName}</strong> corresponds to.
                  Their shares will be made available to the new pairing once you confirm.
                </p>
                {linkableContacts.length === 0 ? (
                  <p className="recovery-pairing-notice" role="status">
                    <span className="recovery-pairing-notice__icon" aria-hidden="true">⚠</span>
                    <span>No paired contacts found. Make sure this node has accepted pairing and shares from an owner before they can recover.</span>
                  </p>
                ) : (
                  <div className="recovery-link-list" role="listbox" aria-label="Original contacts">
                    {linkableContacts.map(p => {
                      const isSelected = conf.selectedOldChannelId === p.channelId
                      const heldShare = (session.heldShares ?? []).find(hs => hs.channelId === p.channelId)
                      return (
                        <button
                          key={p.id}
                          role="option"
                          aria-selected={isSelected}
                          className={`recovery-link-option${isSelected ? ' recovery-link-option--selected' : ''}`}
                          onClick={() => setPendingPairingConfirmation(prev => prev ? { ...prev, selectedOldChannelId: p.channelId } : null)}
                        >
                          <span className="recovery-link-option__name">{p.name}</span>
                          <span className="recovery-link-option__meta">
                            {heldShare ? `${heldShare.description} · ` : ''}channel {p.channelId.slice(0, 8)}…
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
                <div className="modal-actions">
                  <button className="secondary" onClick={() => setPendingPairingConfirmation(prev => prev ? { ...prev, step: 'confirm' } : null)}>
                    Back
                  </button>
                  <button
                    className="primary"
                    onClick={handleAcceptPairing}
                    disabled={!conf.selectedOldChannelId}
                  >
                    Link &amp; Accept
                  </button>
                </div>
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
                that you still hold version {pendingVerifyShareConfirmation.version} of
                their secret share.
              </p>
              {pendingVerifyShareConfirmation.secretId && (
                <p className="verify-confirm-detail">
                  Secret ID: <code>{pendingVerifyShareConfirmation.secretId}</code>
                </p>
              )}
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
    </div>
  )
}
