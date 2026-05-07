import { useState, useEffect, useRef, useMemo } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { DeRecProtocol, SenderKind, FlowKind, type ContactMessage } from '@derec-alliance/web'
import './OwnerSessionPage.css'
import type { ParticipantConnectionStatus, OwnerSession, PairedParticipant, PairedReplica, PendingPairing, BagVersion, SecretBag, UserSecret, RecoveredSecret, ReplicaStatus, SecretShareRef, Transport, HeldShare } from './types'
import { useConsole } from './ConsoleContext'
import { sendMessage, pollMailbox, fromBase64Url, toBase64Url } from './derecApi'
import { makeChannelStore, makeSecretStore, makeShareStore, makeTransport } from './stores'
import { apiAddParticipant, apiAddReplica, apiAssociateChannel, apiClearPendingAssociations, apiConfirmReplicaFingerprint, apiCreateParticipantContact, apiCreateReplicaContact, apiGetBrowserContact, apiGetReplicaFingerprint, apiGetSession, apiPostBrowserContact, apiStartParticipantPairing, apiStartReplicaPairing, apiToggleParticipantStatus, apiToggleReplicaStatus, type ContactMessageDto } from './api'
import { faker } from '@faker-js/faker'

// ── Contact serialization ─────────────────────────────────────────────────────
//
// QR / clipboard encoding is app-level. We use JSON with binary fields
// base64url-encoded so the payload is text-safe and human-readable.

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

// ── Backend DTO ↔ FE ContactMessage conversion ───────────────────────────────

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

// ── Shared SVG eye icons ──────────────────────────────────────────────────────

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

// ── Copy button ───────────────────────────────────────────────────────────────

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

// ── Shared key row (participant details) ─────────────────────────────────────

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

// ── Shared modal close button ─────────────────────────────────────────────────

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

// ── Protect Secret modal ──────────────────────────────────────────────────────

type AddSecretStatus =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'confirming'; participantIds: string[]; version: number }
  | { kind: 'error'; message: string }

function AddSecretModal({
  participants,
  secretBag,
  onClose,
  onAddSecret,
}: {
  participants: PairedParticipant[]
  secretBag: SecretBag | null
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

  // Track confirmation progress from the bag's current version participantIds.
  const confirming = status.kind === 'confirming' ? status : null
  const confirmationProgress = confirming
    ? confirming.participantIds.map(id => {
        const participant = participants.find(h => h.id === id)
        const confirmed = participant?.secretShares.some(s => s.version === confirming.version && s.status === 'confirmed') ?? false
        return { id, name: participant?.name ?? id, confirmed }
      })
    : []
  const allConfirmed = confirming !== null && confirmationProgress.every(h => h.confirmed)

  const canSubmit = form.name.trim().length > 0 && form.data.trim().length > 0
  const isBlocking = status.kind === 'sending' || (status.kind === 'confirming' && !allConfirmed)
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
                  style={{ width: `${confirmationProgress.length > 0 ? Math.round((confirmationProgress.filter(h => h.confirmed).length / confirmationProgress.length) * 100) : 0}%` }}
                  role="progressbar"
                  aria-valuenow={confirmationProgress.filter(h => h.confirmed).length}
                  aria-valuemin={0}
                  aria-valuemax={confirmationProgress.length}
                />
              </div>
              <p className="share-progress-summary">
                {confirmationProgress.filter(h => h.confirmed).length} of {confirmationProgress.length} confirmed
              </p>
            </div>

            <ul className="share-progress-list" role="list">
              {confirmationProgress.map(h => (
                <li
                  key={h.id}
                  className={`share-progress-item ${h.confirmed ? 'share-progress-item--confirmed' : ''}`}
                >
                  <span className="verify-progress-icon">
                    {h.confirmed
                      ? <span className="verify-progress-icon--done" aria-label="Confirmed">&#10003;</span>
                      : <span className="verify-spinner" role="status" aria-label="Waiting for confirmation" />
                    }
                  </span>
                  <span className="share-progress-item-name">{h.name}</span>
                  <span className={`share-progress-item-status ${h.confirmed ? 'status--verified' : ''}`}>
                    {h.confirmed ? 'Confirmed' : 'Waiting\u2026'}
                  </span>
                </li>
              ))}
            </ul>

            <div className="modal-actions">
              <button
                type="button"
                className={allConfirmed ? 'primary' : 'secondary'}
                onClick={onClose}
              >
                {allConfirmed ? 'Done' : 'Close'}
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

// ── Share Contact modal ───────────────────────────────────────────────────────
//
// Used for both flows:
//   - Owner displays their own contact QR (participant scans it → owner-initiates flow)
//   - Participant displays their contact QR (owner scans it → participant-initiates flow)
//
// `createContact` abstracts the protocol instance so this component stays generic.


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
  onPairingCreated: (channelId: bigint) => void
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
        onPairingCreated(channelId)
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

// ── Transport display ─────────────────────────────────────────────────────────

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

// ── Pair Initiator modal ──────────────────────────────────────────────────────
//
// The user pastes/scans a peer's contact QR payload (base64url protobuf bytes).
// `startPairing` abstracts which protocol instance handles it.

type PairInitiatorStep =
  | { kind: 'input' }
  | { kind: 'sending' }
  | { kind: 'waiting'; channelId: bigint }
  | { kind: 'success'; channelId: bigint }
  | { kind: 'failed'; reason: string }

const PAIRING_TIMEOUT_MS = 60_000

function PairInitiatorModal({
  label,
  placeholder,
  participantId,
  pairedChannelIds,
  pairingRejectionCount,
  onClose,
  onSuccess,
  onPairingRequestSent,
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
  onClose: () => void
  onSuccess: () => void
  onPairingRequestSent: (channelId: bigint, participantId?: string) => void
  startPairing: (contact: ContactMessage) => Promise<bigint>
}) {
  const { log } = useConsole()
  const [payload, setPayload] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<PairInitiatorStep>({ kind: 'input' })

  // Snapshot the rejection count when we enter the waiting state so we only
  // react to rejections that arrive *after* the request was sent.
  const rejectionCountAtWaitRef = useRef(pairingRejectionCount)

  // Detect pairing completion by watching pairedChannelIds
  useEffect(() => {
    if (step.kind !== 'waiting') return
    if (pairedChannelIds.has(step.channelId.toString())) {
      setStep({ kind: 'success', channelId: step.channelId })
    }
  }, [step, pairedChannelIds])

  // Detect pairing rejection from the polling loop
  useEffect(() => {
    if (step.kind !== 'waiting') return
    if (pairingRejectionCount > rejectionCountAtWaitRef.current) {
      setStep({ kind: 'failed', reason: 'The peer rejected the pairing request.' })
    }
  }, [step.kind, pairingRejectionCount])

  // Timeout: if still waiting after PAIRING_TIMEOUT_MS, show failure
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

      onPairingRequestSent(channelId, participantId)
      rejectionCountAtWaitRef.current = pairingRejectionCount
      setStep({ kind: 'waiting', channelId })
    } catch (err) {
      console.error('[PairInitiatorModal] start_pairing failed:', err)
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

// ── Replica provisioning modal ────────────────────────────────────────────────
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

  // 5-minute countdown for fingerprint confirmation
  const [remainingMs, setRemainingMs] = useState<number | null>(null)
  useEffect(() => {
    if (!replica.confirmationStartedAt || isConfirmed) {
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
      console.error('[ReplicaProvisioningModal] start_pairing failed:', err)
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

// ── Session ID badge ──────────────────────────────────────────────────────────

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

// ── Secret data field ─────────────────────────────────────────────────────────

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

// ── Verify Shares wizard ──────────────────────────────────────────────────────
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

  // Send verification to all on mount.
  useEffect(() => {
    if (sent) return
    setSent(true)
    onVerify(version).catch(err => {
      setError(err instanceof Error ? err.message : String(err))
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const totalCount = confirmedParticipants.length
  const verifiedCount = confirmedParticipants.filter(
    h => verifiedParticipantIds.includes(h.id),
  ).length
  const allDone = totalCount > 0 && verifiedCount === totalCount
  const pct = totalCount > 0
    ? Math.round((verifiedCount / totalCount) * 100)
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
            </p>
          </div>

          <ul className="share-progress-list" role="list">
            {confirmedParticipants.map(h => {
              const isVerified = verifiedParticipantIds.includes(h.id)
              return (
                <li
                  key={h.id}
                  className={`share-progress-item ${isVerified ? 'share-progress-item--confirmed' : ''}`}
                >
                  <span className="verify-progress-icon">
                    {isVerified
                      ? <span className="verify-progress-icon--done" aria-label="Verified">✓</span>
                      : <span className="verify-spinner" role="status" aria-label="Waiting for response" />
                    }
                  </span>
                  <span className="share-progress-item-name">{h.name}</span>
                  <span className={`share-progress-item-status ${isVerified ? 'status--verified' : ''}`}>
                    {isVerified ? 'Verified' : 'Waiting…'}
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

// ── Secret Bag Panel ────────────────────────────────────────────────────────

// ── SecretBagPanel ─────────────────────────────────────────────────────────

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

// ── Tab panels ────────────────────────────────────────────────────────────────

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
            <span className="channel-row-name">{h.name}</span>
            <span className="channel-id-inline">{h.channelId}</span>
            {h.offline && (
              <span className="status-tag offline">Offline</span>
            )}
            <button className="channel-unpair-btn" onClick={() => onTogglePair(h.id)}>
              Unpair
            </button>
          </div>
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
        </div>
      ))}
    </div>
  )
}

// ── Recovery tab components ──────────────────────────────────────────────────

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

// ── Replica components ───────────────────────────────────────────────────────

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

  // 5-minute countdown
  const [remainingMs, setRemainingMs] = useState<number | null>(null)
  useEffect(() => {
    if (!replica.confirmationStartedAt || isConfirmed) {
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

function HeldSharesList({
  shares,
  participants,
}: {
  shares: HeldShare[]
  participants: PairedParticipant[]
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
    <div className="card-list">
      {shares.map((share, i) => (
        <div key={`${share.channelId}-${share.version}-${i}`} className="detail-card">
          <div className="detail-card-header">
            <strong>{peerName(share.channelId)}</strong>
            <span className="detail-card-badge">v{share.version}</span>
          </div>
          <div className="detail-card-meta">
            {share.description && <span>{share.description}</span>}
            {share.secretId && <span className="channel-id">Secret {share.secretId}</span>}
            <span className="channel-id">Channel {share.channelId}</span>
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
  const recoveryParticipants = session.participants.filter(h => h.recoveryPaired && (h.connectionStatus === 'paired'))
  const recoveredSecrets = session.recoveredSecrets ?? []
  const allDiscovered = recoveryParticipants.length > 0 && recoveryParticipants.every(h => h.discoveryComplete)

  return (
    <div className="recovery-panel">
      <div className="recovery-section">
        <div className="section-header-row">
          <h3 className="sub-heading">Recovery-Paired Participants</h3>
          {recoveryParticipants.length > 0 && (
            <button
              className="primary"
              onClick={() => { onRequestDiscovery() }}
            >
              {allDiscovered ? 'Re-discover All' : 'Discover All'}
            </button>
          )}
        </div>
        {recoveryParticipants.length === 0 ? (
          <p className="tab-empty-state">
            No participants paired in recovery mode yet. Use the "Pair" button while Recovery Mode is active.
          </p>
        ) : (
          <div className="card-list">
            {recoveryParticipants.map(h => (
              <RecoveryParticipantCard
                key={h.id}
                participant={h}
              />
            ))}
          </div>
        )}
      </div>

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

// ── Side panel ────────────────────────────────────────────────────────────────

function connectionStatusLabel(status: ParticipantConnectionStatus): string {
  switch (status) {
    case 'paired':    return 'Paired'
    case 'available': return 'Available'
  }
}

function SidePanelParticipantItem({
  participant,
  sessionId,
  ownerName,
  pairedChannelIds,
  pairingRejectionCount,
  onTogglePair,
  onToggleStatus,
  onPairingCreated,
  onPairingRequestSent,
  onSuccess,
  createParticipantContact,
  startParticipantPairing,
}: {
  participant: PairedParticipant
  sessionId: string
  ownerName: string
  pairedChannelIds: Set<string>
  pairingRejectionCount: number
  onTogglePair: (id: string) => void
  onToggleStatus: (participantId: string) => Promise<void>
  onPairingCreated: (channelId: bigint, participantId: string) => void
  onPairingRequestSent: (channelId: bigint, participantId: string) => void
  onSuccess: () => void
  createParticipantContact: () => Promise<ContactMessage>
  startParticipantPairing: (contact: ContactMessage) => Promise<bigint>
}) {
  const [expanded, setExpanded] = useState(false)
  const [shareContactOpen, setShareContactOpen] = useState(false)
  const [pairWithOwnerOpen, setPairWithOwnerOpen] = useState(false)
  const [associating, setAssociating] = useState(false)
  const [assocError, setAssocError] = useState<string | null>(null)
  const [togglingStatus, setTogglingStatus] = useState(false)
  const isPaired = participant.connectionStatus === 'paired'
  const isOffline = !!participant.offline
  const hasPendingRecovery = !!participant.pendingRecoveryChannelId

  async function handleAssociate() {
    if (!participant.pendingRecoveryChannelId || !participant.channelId) return
    setAssociating(true)
    setAssocError(null)
    try {
      await apiAssociateChannel(
        sessionId,
        participant.id,
        participant.channelId, // old channel
        participant.pendingRecoveryChannelId, // new recovery channel
      )
    } catch (err) {
      setAssocError(err instanceof Error ? err.message : String(err))
    } finally {
      setAssociating(false)
    }
  }

  return (
    <li className="side-participant-item">
      <button
        className="side-participant-header"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
      >
        <span className={`participant-dot ${hasPendingRecovery ? 'recovery-pending' : isOffline ? 'offline' : participant.connectionStatus}`} aria-hidden="true" />
        <span className="side-participant-name">{participant.name}</span>
        {hasPendingRecovery ? (
          <span className="status-tag recovery-pending">Recovery Pending</span>
        ) : isOffline ? (
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
          {hasPendingRecovery ? (
            <div className="recovery-association-prompt">
              <p className="recovery-assoc-description">
                A recovery pairing request was received. Associate the new channel with this participant's existing contact.
              </p>
              <div className="recovery-assoc-contact">
                <span className="recovery-assoc-name">{ownerName}</span>
                <ClickToCopyCode label="Old Channel" value={participant.channelId} />
                <ClickToCopyCode label="New Channel" value={participant.pendingRecoveryChannelId!} />
              </div>
              {assocError && <p className="field-error">{assocError}</p>}
              <button
                className="primary"
                onClick={handleAssociate}
                disabled={associating}
              >
                {associating ? 'Associating…' : `Associate with ${ownerName}`}
              </button>
            </div>
          ) : (
            <>
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
                    try { await onToggleStatus(participant.id) } finally { setTogglingStatus(false) }
                  }}
                >
                  {togglingStatus ? '…' : isOffline ? 'Go Online' : 'Go Offline'}
                </button>
                {isPaired ? (
                  <button className="pair-action-btn unpair" onClick={() => onTogglePair(participant.id)}>
                    Unpair
                  </button>
                ) : !isOffline ? (
                  <button className="pair-action-btn pair" onClick={() => setPairWithOwnerOpen(true)}>
                    Pair
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>
      )}

      {shareContactOpen && (
        <ShareContactModal
          title={`Share ${participant.name} Contact`}
          transport={participant.transport}
          createContact={createParticipantContact}
          onClose={() => setShareContactOpen(false)}
          onPairingCreated={channelId => {
            onPairingCreated(channelId, participant.id)
          }}
        />
      )}

      {pairWithOwnerOpen && (
        <PairInitiatorModal
          label="Owner Contact QR Payload"
          placeholder="Paste the JSON payload from the owner's Share Contact QR code"
          pairedChannelIds={pairedChannelIds}
          pairingRejectionCount={pairingRejectionCount}
          onClose={() => setPairWithOwnerOpen(false)}
          onSuccess={onSuccess}
          onPairingRequestSent={(channelId) => onPairingRequestSent(channelId, participant.id)}
          startPairing={startParticipantPairing}
        />
      )}
    </li>
  )
}

// ── Join QR modal ─────────────────────────────────────────────────────────────

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

// ── Add Participant modal ────────────────────────────────────────────────────────

function AddParticipantModal({
  existingCount,
  onAdd,
  onClose,
}: {
  existingCount: number
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

  // Clear pairingInProgress when the replica actually becomes paired.
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
  pairedChannelIds,
  pairingRejectionCount,
  onTogglePair,
  onToggleParticipantStatus,
  onToggleReplicaStatus,
  onPairingCreated,
  onPairingRequestSent,
  onSuccess,
  onAddParticipant,
  onAddReplica,
  onReplicaPairStarted,
  getParticipantFunctions,
  getReplicaFunctions,
}: {
  participants: PairedParticipant[]
  replicas: PairedReplica[]
  sessionId: string
  ownerName: string
  pairedChannelIds: Set<string>
  pairingRejectionCount: number
  onTogglePair: (id: string) => void
  onToggleParticipantStatus: (participantId: string) => Promise<void>
  onToggleReplicaStatus: (replicaId: string) => Promise<void>
  onPairingCreated: (channelId: bigint, actorId: string) => void
  onPairingRequestSent: (channelId: bigint, actorId: string) => void
  onSuccess: () => void
  onAddParticipant: (name: string, autoPair: boolean) => Promise<void>
  onAddReplica: (name: string) => Promise<void>
  onReplicaPairStarted: (replicaId: string) => void
  getParticipantFunctions: (participantId: string) => {
    createContact: () => Promise<ContactMessage>
    startPairing: (contact: ContactMessage) => Promise<bigint>
  }
  getReplicaFunctions: (replicaId: string) => {
    createContact: () => Promise<ContactMessage>
    startPairing: (contact: ContactMessage) => Promise<bigint>
  }
}) {
  const [addParticipantOpen, setAddParticipantOpen] = useState(false)
  const [addingReplica, setAddingReplica] = useState(false)

  return (
    <aside className="side-panel" aria-label="Session actors">
      {/* ── Participants section ─────────────────────────────────────────── */}
      <div className="side-panel-section">
        <div className="panel-header-row">
          <div>
            <h3 className="panel-heading">Participants</h3>
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
            const { createContact, startPairing } = getParticipantFunctions(h.id)
            return (
              <SidePanelParticipantItem
                key={h.id}
                participant={h}
                sessionId={sessionId}
                ownerName={ownerName}
                pairedChannelIds={pairedChannelIds}
                pairingRejectionCount={pairingRejectionCount}
                onTogglePair={onTogglePair}
                onToggleStatus={onToggleParticipantStatus}
                onPairingCreated={onPairingCreated}
                onPairingRequestSent={onPairingRequestSent}
                onSuccess={onSuccess}
                createParticipantContact={createContact}
                startParticipantPairing={startPairing}
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
          existingCount={participants.length}
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

// ── Bag state helpers ────────────────────────────────────────────────────────

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

// ── Pending share tracking ────────────────────────────────────────────────────

interface PendingShare {
  version: number
}

// ── Page ──────────────────────────────────────────────────────────────────────

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
  // Snapshot of participant state before entering recovery — restored on exit.
  const preRecoveryParticipantsRef = useRef<PairedParticipant[] | null>(null)

  // Derived: set of channel IDs (decimal strings) for all paired participants + replicas.
  // Used by PairInitiatorModal to detect pairing completion.
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

  // Incremented when the polling loop detects a pairing rejection (process() error with
  // "non-ok status"). PairInitiatorModal watches this to exit the waiting state.
  const [pairingRejectionCount, setPairingRejectionCount] = useState(0)

  // IDs of participants being auto-paired. Non-empty → show setup gate instead of full UI.
  const [autoPairingIds, setAutoPairingIds] = useState<string[]>([])

  // ── Pending pairing confirmation ────────────────────────────────────────────
  interface PendingPairingConfirmation {
    peerName: string
    channelId: string
    /** Opaque action token from ActionRequired event — pass to accept() or reject(). */
    action: Uint8Array
  }

  const [pendingPairingConfirmation, setPendingPairingConfirmation] = useState<PendingPairingConfirmation | null>(null)
  const pendingPairingConfirmationRef = useRef<PendingPairingConfirmation | null>(null)
  useEffect(() => { pendingPairingConfirmationRef.current = pendingPairingConfirmation }, [pendingPairingConfirmation])

  // ── Pending store-share confirmation ───────────────────────────────────────────
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

  // ── Protocol instances ────────────────────────────────────────────────────────

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

  // Tracks pending shares so ShareConfirmed events can be correlated with secrets.
  // keyed by participant channelId (bigint as string)
  const pendingSharesRef = useRef<Map<string, PendingShare>>(new Map())

  // Tracks in-flight verification challenges keyed by participant channelId.
  const pendingVerificationsRef = useRef<Map<string, { secretIdHex: string; version: number }>>(new Map())

  // Tracks in-flight recovery requests so SecretRecovered events can be correlated.
  const pendingRecoveryRef = useRef<{ secretId: string; version: number; label: string } | null>(null)

  // The channel ID from the owner's contact posted for peer discovery.
  // Tracks which channel is waiting for an incoming pairing request.
  const ownerContactChannelRef = useRef<string | null>(null)

  // Use a stable session ref so polling closures always see the latest value without
  // being listed as a dependency (avoids tearing down intervals on every render).
  const sessionRef = useRef(session)
  useEffect(() => { sessionRef.current = session }, [session])
  const onUpdateRef = useRef(onUpdate)
  useEffect(() => { onUpdateRef.current = onUpdate }, [onUpdate])

  useEffect(() => {
    const { sessionId, ownerId, transport, participants } = session

    // Derive secretId bytes: reuse existing bag's ID, or generate a fresh one.
    const secretIdHex = session.secretBag?.secretId
    const secretId = secretIdHex
      ? Uint8Array.from(secretIdHex.match(/.{2}/g)!.map(b => parseInt(b, 16)))
      : crypto.getRandomValues(new Uint8Array(16))

    const shareStore = makeShareStore(`owner:${ownerId}`)
    const ownerProtocol = new DeRecProtocol(
      makeChannelStore(`owner:${ownerId}`),
      shareStore,
      makeSecretStore(`owner:${ownerId}`),
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
    if (session.secretBag) {
      shareStore.setOwnerVersion(session.secretBag.currentVersion.version)
    }

    log({
      role: 'owner',
      flow: 'session',
      step: 'protocol_init',
      description: `Owner protocol initialized for session ${sessionId}`,
      payload: { sessionId, ownerId, participantCount: participants.length },
    })

    // Re-sync offline participants to the backend (its disabled_participants set is in-memory
    // and resets on restart, but the FE persists the offline flag).
    for (const h of participants) {
      if (h.offline) {
        apiToggleParticipantStatus(sessionId, h.id, true).catch(() => {})
      }
    }

    // Post this owner's contact to the browser-contact endpoint so other owners
    // can discover it and initiate pairing.
    async function postOwnerContact() {
      try {
        const contact = await withProtocolLock(() => ownerProtocol.createContact(null))
        ownerContactChannelRef.current = contact.channel_id
        console.warn('[owner] contact created for peer discovery, channelId:', contact.channel_id, 'transport:', contact.transport_protocol?.uri)
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
        console.error('[owner] failed to post browser contact:', err)
      }
    }
    postOwnerContact()

    return () => {
      ownerProtocolRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId])

  // ── Auto-pair participants on first load ───────────────────────────────────────────

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
          const dto = await apiCreateParticipantContact(session.sessionId, participant.id)
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
          console.error(`[auto-pair] failed for participant ${participant.id}:`, err)
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

  // ── Event handlers ────────────────────────────────────────────────────────────

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
      peer_communication_info?: Record<string, string>
    },
  ): OwnerSession {
    if (event.type === 'PairingCompleted' && event.channel_id) {
      const channelId = event.channel_id
      const isRecovery = event.kind === 1 // SenderKind.OwnerRecovery

      // Detect whether this pairing is for a replica. The pending pairing stores
      // the replica-side channel ID (from apiStartReplicaPairing), but PairingCompleted
      // fires with the owner-side channel ID — they differ. We also need to handle the
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
        // Unknown peer or pending pairing without a participantId (e.g. owner-to-
        // owner pairing via the header "Pair" button). Add as a new paired peer.
        // The session poll will reconcile with actual actor info.
        const tempId = `peer-${channelId}`
        updated = {
          ...updated,
          participants: [...updated.participants, {
            id: tempId,
            name: event.peer_communication_info?.name || 'Peer',
            channelId,
            transport: { protocol: 'https' as const, uri: '' },
            connectionStatus: 'paired' as const,
            secretShares: [],
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
                ? { ...h, id: peerActor.id, name: peerActor.name, transport: { protocol: peerActor.transport.protocol, uri: peerActor.transport.uri } }
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

      // Update the bag version's participantIds
      const bag = current.secretBag
      const updatedBag = bag ? updateBagParticipant(bag, version, participant.id) : null

      return {
        ...current,
        participants: current.participants.map(h =>
          h.id === participant.id
            ? { ...h, secretShares: [...h.secretShares.filter(s => s.version !== version), shareRef] }
            : h,
        ),
        secretBag: updatedBag,
      }
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

    if (event.type === 'RecoveryShareReceived') {
      log({
        role: 'owner',
        flow: 'recovery',
        step: 'RecoveryShareReceived',
        description: `Share received from participant (${event.shares_received} total)`,
        payload: { channelId: event.channel_id, sharesReceived: event.shares_received },
      })

      const progress = current.recoveryProgress
      if (!progress) return current

      return {
        ...current,
        recoveryProgress: { ...progress, sharesReceived: event.shares_received ?? progress.sharesReceived },
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

  // ── Owner mailbox polling ─────────────────────────────────────────────────────
  // Poll faster (500ms) during auto-pair so the setup gate clears quickly.

  const pollInterval = (autoPairingIds.length > 0 || recoveryMode || protocolBusy) ? 500 : 5000

  useEffect(() => {
    let ownerPollRunning = false
    const id = setInterval(async () => {
      if (ownerPollRunning) return
      // Skip processing while a pairing confirmation modal is open.
      if (pendingPairingConfirmationRef.current || pendingStoreShareConfirmationRef.current) return
      ownerPollRunning = true
      try {
        const { sessionId, ownerId } = sessionRef.current
        const protocol = ownerProtocolRef.current
        if (!protocol) return

        let messages
        try {
          messages = await pollMailbox(sessionId, 'owners', ownerId)
        } catch (err) {
          console.error('[owner-poll] failed to fetch messages:', err)
          return
        }

        if (messages.length === 0) return

        console.warn(`[owner-poll] received ${messages.length} message(s), sizes: ${messages.map(m => m.bytes.length).join(', ')}`)

        await withProtocolLock(async () => {
          const initial = sessionRef.current
          let updated = initial
          let shouldBreak = false

          for (const { bytes } of messages!) {
            if (shouldBreak) break

            let events: { type: string; channel_id?: string; kind?: number; version?: number; secret?: Uint8Array; shares_received?: number; error?: string; action?: Uint8Array; action_kind?: string; peer_communication_info?: Record<string, string>; share_version?: number; share_description?: string; share_secret_id?: number[] }[]
            try {
              events = Array.from(await protocol.process(bytes)) as typeof events
            } catch (err) {
              console.error('[owner-poll] process() FAILED for message:', err)
              // Detect pairing rejection: the library returns a DEREC_ERROR with
              // "non-ok status" when the responder rejects the pairing request.
              const errMsg = err instanceof Error ? err.message : typeof err === 'object' && err !== null ? JSON.stringify(err) : String(err)
              if (errMsg.includes('non-ok status')) {
                setPairingRejectionCount(c => c + 1)
              }
              continue
            }



            for (const event of events) {
              // Handle ActionRequired events: pairing needs user confirmation,
              // all other action kinds are auto-accepted for now.
              if (event.type === 'ActionRequired' && event.action) {
                if (event.action_kind === 'Pairing') {
                  // Check if this is a known pairing we initiated (backend participant or replica).
                  // Those should be auto-accepted — only unknown peers need user confirmation.
                  //
                  // We check if we have ANY pending pairings with non-browser-managed actors —
                  // those are backend participants/replicas whose PairRequest we orchestrated
                  // via the backend API.
                  const channelId = event.channel_id!
                  const hasPendingBackendPairings = updated.pendingPairings.some(p => {
                    if (!p.participantId) return false
                    const participant = updated.participants.find(h => h.id === p.participantId)
                    if (participant && !participant.browserManaged) return true
                    const replica = (updated.replicas ?? []).find(r => r.id === p.participantId)
                    if (replica) return true
                    return false
                  })

                  if (hasPendingBackendPairings) {
                    // Remap the pending pairing's channelId to the owner-side channel
                    // from this event. When the participant initiates pairing (via the
                    // "Pair" button / apiStartParticipantPairing), the pending pairing
                    // stores the participant-side channel ID, but PairingCompleted will
                    // fire with the owner-side channel ID. Without this fixup the
                    // PairingCompleted handler can't match the pending pairing and falls
                    // into the "Unknown peer" branch.
                    const pendingIdx = updated.pendingPairings.findIndex(p => {
                      if (!p.participantId) return false
                      const participant = updated.participants.find(h => h.id === p.participantId)
                      if (participant && !participant.browserManaged) return true
                      const replica = (updated.replicas ?? []).find(r => r.id === p.participantId)
                      if (replica) return true
                      return false
                    })
                    if (pendingIdx >= 0) {
                      updated = {
                        ...updated,
                        pendingPairings: updated.pendingPairings.map((p, i) =>
                          i === pendingIdx ? { ...p, channelId: BigInt(channelId) } : p,
                        ),
                      }
                    }

                    try {
                      const acceptEvents = Array.from(await protocol.accept(event.action)) as typeof events
                      for (const e of acceptEvents) {
                        updated = applyOwnerEvent(updated, e)
                      }
                    } catch (err) {
                      console.error('[owner-poll] auto-accept known pairing failed:', err)
                    }
                  } else {
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

                    // Skip remaining messages; they'll be picked up on next poll.
                    shouldBreak = true
                    break
                  }
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
                } else {
                  // Auto-accept remaining requests (VerifyShare, Discovery, GetShare).
                  try {
                    const acceptEvents = Array.from(await protocol.accept(event.action)) as typeof events
                    for (const e of acceptEvents) {
                      updated = applyOwnerEvent(updated, e)
                    }
                  } catch (err) {
                    console.error(`[owner-poll] auto-accept ${event.action_kind} failed:`, err)
                  }
                }
                continue
              }

              console.log(`[owner-poll] applying ${event.type}`, { channelId: event.channel_id, kind: event.kind })
              try {
                updated = applyOwnerEvent(updated, event)
              } catch (err) {
                console.error('[owner-poll] applyOwnerEvent failed for', event.type, ':', err)
              }
            }
          }

          if (updated !== initial) {
            sessionRef.current = updated
            onUpdateRef.current(updated)
          }
        })
      } catch (err) {
        console.error('[owner-poll] poll failed:', err)
      } finally {
        ownerPollRunning = false
      }
    }, pollInterval)

    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId, pollInterval])

  // ── Pairing confirmation accept/reject ──────────────────────────────────────

  async function handleAcceptPairing() {
    const confirmation = pendingPairingConfirmation
    if (!confirmation) return

    const protocol = ownerProtocolRef.current
    if (!protocol) return

    try {
      const events = await withProtocolLock(() => protocol.accept(confirmation.action))
      const eventArray = Array.from(events) as Array<{ type: string; channel_id?: string; kind?: number; version?: number; secret?: Uint8Array; shares_received?: number; error?: string }>

      let updated = sessionRef.current
      for (const event of eventArray) {
        try {
          updated = applyOwnerEvent(updated, event)
        } catch (err) {
          console.error('[pairing-confirm] applyOwnerEvent failed:', err)
        }
      }
      if (updated !== sessionRef.current) {
        sessionRef.current = updated
        onUpdateRef.current(updated)
      }
    } catch (err) {
      console.error('[pairing-confirm] accept failed:', err)
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

    const protocol = ownerProtocolRef.current
    if (!protocol) return

    try {
      await withProtocolLock(() => protocol.reject(confirmation.action, 'Pairing request rejected by user'))

      log({
        role: 'owner',
        flow: 'pairing',
        step: 'pairing_rejected',
        description: `Rejected pairing request from "${confirmation.peerName}"`,
        payload: { channelId: confirmation.channelId },
      })
    } catch (err) {
      console.error('[pairing-reject] reject failed:', err)
    }

    setPendingPairingConfirmation(null)
  }

  // ── Store-share confirmation accept/reject ─────────────────────────────────

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
          console.error('[storeshare-confirm] applyOwnerEvent failed:', err)
        }
      }

      if (updated !== sessionRef.current) {
        sessionRef.current = updated
        onUpdateRef.current(updated)
      }
    } catch (err) {
      console.error('[storeshare-confirm] accept failed:', err)
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
      await withProtocolLock(() => protocol.reject(confirmation.action, 'Share storage rejected by user'))

      log({
        role: 'owner',
        flow: 'sharing',
        step: 'store_share_rejected',
        description: `Rejected share storage from "${confirmation.peerName}" (version ${confirmation.version})`,
        payload: { channelId: confirmation.channelId, version: confirmation.version },
      })
    } catch (err) {
      console.error('[storeshare-reject] reject failed:', err)
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

  // ── Backend session status polling ───────────────────────────────────────────
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

          // Sync pending recovery association status — only while in recovery mode.
          if (!recoveryModeRef.current) continue
          const currentPending = participant.pendingRecoveryChannelId ?? null
          const newPending = actor.pending_recovery_channel_id ?? null
          if (currentPending !== newPending) {
            changed = true

            // Association just completed: pending cleared and participant now has a channel.
            // Update the participant's channelId to the new recovery channel and trigger discovery.
            const associationJustCompleted = currentPending && !newPending && actor.channel_id
            if (associationJustCompleted) {
              const recoveryChannelId = actor.channel_id!

              updated = {
                ...updated,
                participants: updated.participants.map(h =>
                  h.id === actor.id
                    ? {
                        ...h,
                        channelId: recoveryChannelId,
                        connectionStatus: 'paired' as const,
                        pendingRecoveryChannelId: undefined,
                        recoveryPaired: true,
                      }
                    : h,
                ),
              }

              const protocol = ownerProtocolRef.current
              if (protocol) {
                withProtocolLock(() => protocol.start(FlowKind.Discovery, {})).catch((err: unknown) => {
                  console.error('[recovery] requestDiscovery after association failed:', err)
                })
                log({
                  role: 'owner',
                  flow: 'recovery',
                  step: 'discovery_triggered',
                  description: `Channel association complete for participant ${actor.id} — requesting discovery on all helpers`,
                  payload: { participantId: actor.id },
                })
              }
            } else {
              updated = {
                ...updated,
                participants: updated.participants.map(h =>
                  h.id === actor.id
                    ? { ...h, pendingRecoveryChannelId: newPending ?? undefined }
                    : h,
                ),
              }
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

          // Sync pairing status.
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
                console.error(`[session-poll] failed to fetch fingerprint for replica ${actor.id}:`, err)
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

  // ── Protocol action callbacks ─────────────────────────────────────────────────

  async function createOwnerContact(): Promise<ContactMessage> {
    return withProtocolLock(async () => {
      const protocol = ownerProtocolRef.current
      if (!protocol) throw new Error('Protocol not initialized')
      return protocol.createContact(null)
    })
  }

  function getParticipantFunctions(participantId: string) {
    const participant = session.participants.find(h => h.id === participantId)

    // Browser-managed participants (other owners) use the browser-contact
    // endpoint for contact exchange and the owner's own WASM for pairing.
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
            return protocol.start(FlowKind.Pairing, { kind: SenderKind.OwnerNonRecovery, contact }) as Promise<bigint>
          })
        },
      }
    }

    // Backend-managed participants use the backend's protocol instance.
    return {
      createContact: async (): Promise<ContactMessage> => {
        const dto = await apiCreateParticipantContact(session.sessionId, participantId)
        return dtoToContactMessage(dto)
      },
      startPairing: async (contact: ContactMessage): Promise<bigint> => {
        const dto = contactMessageToDto(contact)
        const resp = await apiStartParticipantPairing(session.sessionId, participantId, dto)
        return BigInt(resp.channel_id)
      },
    }
  }

  function getReplicaFunctions(replicaId: string) {
    return {
      createContact: async (): Promise<ContactMessage> => {
        const dto = await apiCreateReplicaContact(session.sessionId, replicaId)
        return dtoToContactMessage(dto)
      },
      startPairing: async (contact: ContactMessage): Promise<bigint> => {
        const dto = contactMessageToDto(contact)
        const resp = await apiStartReplicaPairing(session.sessionId, replicaId, dto)
        return BigInt(resp.channel_id)
      },
    }
  }

  async function ownerStartPairing(contact: ContactMessage): Promise<bigint> {
    console.warn('[owner] startPairing called, contact channelId:', contact.channel_id, 'transport:', contact.transport_protocol?.uri)
    return withProtocolLock(async () => {
      const protocol = ownerProtocolRef.current
      if (!protocol) throw new Error('Protocol not initialized')
      const channelId = await (protocol.start(FlowKind.Pairing, { kind: SenderKind.OwnerNonRecovery, contact }) as Promise<bigint>)
      console.warn('[owner] startPairing succeeded, channelId:', channelId.toString())
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

    // Compute the new version and update the share store's owner version counter
    // so that latestVersion() only tracks this owner's distributed versions — not
    // held shares from other owners.
    const newVersion = existingBag ? existingBag.currentVersion.version + 1 : 1
    ownerShareStoreRef.current?.setOwnerVersion(newVersion)
    const pairedParticipants = current.participants.filter(h => h.connectionStatus === 'paired')

    // Register pending shares for correlation.
    const pendingShare: PendingShare = { version: newVersion }
    for (const h of pairedParticipants) {
      if (h.channelId) pendingSharesRef.current.set(h.channelId, pendingShare)
    }

    // Build the new bag version
    const newBagVersion: BagVersion = {
      version: newVersion,
      participantIds: [],
      verifiedParticipantIds: [],
      secrets: allUserSecrets,
      rawBytes: '',
      helpers: pairedParticipants.map(h => ({ id: h.id, name: h.name, channelId: h.channelId })),
    }

    // Build the updated secret bag
    const updatedBag: SecretBag = existingBag
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

    onUpdate({
      ...current,
      secretBag: updatedBag,
      participants: current.participants.map(h =>
        pairedParticipants.some(ph => ph.id === h.id)
          ? { ...h, secretShares: [...h.secretShares, { version: newVersion, status: 'pending' as const, verified: false }] }
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

    // Register pending verifications for all confirmed participants.
    const confirmedParticipants = current.participants.filter(
      h => bagVersion.participantIds.includes(h.id) && h.channelId,
    )
    for (const participant of confirmedParticipants) {
      pendingVerificationsRef.current.set(participant.channelId, { secretIdHex: bag.secretId, version })
    }

    await withProtocolLock(() => protocol.start(FlowKind.VerifyShares, { version }))

    log({
      role: 'owner',
      flow: 'verification',
      step: 'verify_shares',
      description: `Verification challenges sent for bag v${version} to ${confirmedParticipants.length} participant(s)`,
      payload: { version, participantCount: confirmedParticipants.length },
    })
  }

  // ── Recovery protocol actions ────────────────────────────────────────────────

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
    onUpdate({
      ...session,
      recoveryProgress: { secretId, version, sharesReceived: 0, totalRequested: participantChannelIds.length, error: null },
    })
    await withProtocolLock(() => protocol.start(FlowKind.RecoverSecret, { secretId: secretIdBytes, version }))

    log({
      role: 'owner',
      flow: 'recovery',
      step: 'recover_secret',
      description: `Recovery requested for "${label}" v${version} from ${participantChannelIds.length} participant(s)`,
      payload: { secretId, version, channels: participantChannelIds.map(c => c.toString()) },
    })
  }

  // ── Session mutation participants ──────────────────────────────────────────────────

  function addPendingPairing(channelId: bigint, participantId?: string) {
    const pending: PendingPairing = { channelId, participantId }
    onUpdate({ ...session, pendingPairings: [...session.pendingPairings, pending] })
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
        const dto = await apiCreateParticipantContact(session.sessionId, resp.id)
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
        console.error(`[add-participant] auto-pair failed for ${resp.id}:`, err)
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

  // ── Replica action callbacks ──────────────────────────────────────────────────

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
      console.error('[handleConfirmReplica] failed:', err)
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


  // ── Render ────────────────────────────────────────────────────────────────────

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
                // Exiting recovery: restore pre-recovery participant state and clear recovery data.
                setRecoveryMode(false)
                setActiveTab('participants')
                onUpdate({
                  ...session,
                  participants: preRecoveryParticipantsRef.current ?? session.participants,
                  recoveredSecrets: [],
                  recoveryProgress: null,
                })
                preRecoveryParticipantsRef.current = null
                // Clear backend pending associations so re-entering recovery starts fresh.
                apiClearPendingAssociations(session.sessionId).catch(() => {})
              } else {
                // Entering recovery: snapshot current participants, then reset them to unpaired.
                preRecoveryParticipantsRef.current = session.participants
                setRecoveryMode(true)
                setActiveTab('recovery')
                onUpdate({
                  ...session,
                  participants: session.participants.map(h => ({
                    ...h,
                    connectionStatus: 'available' as const,
                    secretShares: [],
                    recoveryPaired: undefined,
                    discoveryComplete: undefined,
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
          onPairingCreated={channelId => {
            addPendingPairing(channelId)
          }}
        />
      )}

      {pairOpen && (
        <PairInitiatorModal
          label="Participant Contact QR Payload"
          placeholder="Paste the JSON payload from the participant's Share Contact QR code"
          pairedChannelIds={pairedChannelIds}
          pairingRejectionCount={pairingRejectionCount}
          onClose={() => setPairOpen(false)}
          onSuccess={() => {}}
          onPairingRequestSent={(channelId, participantId) => addPendingPairing(channelId, participantId)}
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
              <HeldSharesList shares={session.heldShares ?? []} participants={session.participants} />
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
          pairedChannelIds={pairedChannelIds}
          pairingRejectionCount={pairingRejectionCount}
          onTogglePair={handleTogglePair}
          onToggleParticipantStatus={handleToggleStatus}
          onToggleReplicaStatus={handleToggleReplicaStatus}
          onPairingCreated={(channelId, actorId) => addPendingPairing(channelId, actorId)}
          onPairingRequestSent={(channelId, actorId) => addPendingPairing(channelId, actorId)}
          onSuccess={() => {}}
          onAddParticipant={handleAddParticipant}
          onAddReplica={handleAddReplica}
          onReplicaPairStarted={setProvisioningReplicaId}
          getParticipantFunctions={getParticipantFunctions}
          getReplicaFunctions={getReplicaFunctions}
        />
      </div>

      {/* Pairing confirmation modal */}
      {pendingPairingConfirmation && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="pairing-confirm-title">
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title" id="pairing-confirm-title">Incoming Pairing Request</h2>
            </div>
            <div className="modal-body">
              <p>
                <strong>{pendingPairingConfirmation.peerName}</strong> wants to pair with you.
                Do you want to accept this pairing?
              </p>
              <div className="modal-actions">
                <button className="secondary" onClick={handleRejectPairing}>
                  Reject
                </button>
                <button className="primary" onClick={handleAcceptPairing}>
                  Accept
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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
    </div>
  )
}
