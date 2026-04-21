import { useState, useEffect, useRef } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { DeRecProtocol, SenderKind, type ContactMessage } from '@derec-alliance/web'
import './OwnerSessionPage.css'
import type { DiscoverableSecret, HelperConnectionStatus, OwnerSession, PairedHelper, PendingPairing, PreviousVersion, ProtectedSecret, RecoveredSecret, RecoveryProgress, SecretShareRef, Transport } from './types'
import { useConsole } from './ConsoleContext'
import { sendMessage, pollMailbox, fromBase64Url, toBase64Url } from './derecApi'
import { makeContactStore, makeSecretStore, makeShareStore, makeTransport } from './stores'
import { apiAssociateChannel, apiClearPendingAssociations, apiCreateHelperContact, apiGetSession, apiStartHelperPairing, type ContactMessageDto } from './api'

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

interface ProtectSecretFormState {
  label: string
  data: string
  threshold: number
  selectedHelperIds: Set<string>
}

type ProtectSecretStatus =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'confirming'; secretIdHex: string; selectedHelperIds: string[] }
  | { kind: 'error'; message: string }

function ProtectSecretModal({
  helpers,
  onClose,
  onProtect,
}: {
  helpers: PairedHelper[]
  onClose: () => void
  onProtect: (
    secretId: Uint8Array,
    secretData: Uint8Array,
    label: string,
    version: number,
    threshold: number,
    helperChannelIds: bigint[],
  ) => Promise<void>
}) {
  const pairedHelpers = helpers.filter(h => h.connectionStatus === 'paired')

  const [form, setForm] = useState<ProtectSecretFormState>({
    label: '',
    data: '',
    threshold: 2,
    selectedHelperIds: new Set(),
  })
  const [status, setStatus] = useState<ProtectSecretStatus>({ kind: 'idle' })

  const selectedPaired = pairedHelpers.filter(h => form.selectedHelperIds.has(h.id))
  const n = selectedPaired.length

  function toggleHelper(id: string) {
    setForm(prev => {
      const next = new Set(prev.selectedHelperIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      const newN = next.size
      return { ...prev, selectedHelperIds: next, threshold: Math.min(prev.threshold, Math.max(2, newN)) }
    })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.label.trim() || !form.data.trim() || n === 0 || form.threshold < 2 || form.threshold > n) return

    const secretId = crypto.getRandomValues(new Uint8Array(16))
    const secretIdHex = Array.from(secretId).map(b => b.toString(16).padStart(2, '0')).join('')
    const secretData = new TextEncoder().encode(form.data.trim())
    const helperChannelIds = selectedPaired.map(h => BigInt(h.channelId))

    setStatus({ kind: 'sending' })
    try {
      await onProtect(secretId, secretData, form.label.trim(), 1, form.threshold, helperChannelIds)
      setStatus({ kind: 'confirming', secretIdHex, selectedHelperIds: selectedPaired.map(h => h.id) })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  // Track confirmation progress from live helper data.
  const confirming = status.kind === 'confirming' ? status : null
  const confirmationProgress = confirming
    ? confirming.selectedHelperIds.map(id => {
        const helper = helpers.find(h => h.id === id)
        const confirmed = helper?.secretShares.some(
          s => s.secretId === confirming.secretIdHex && s.status === 'confirmed',
        ) ?? false
        return { id, name: helper?.name ?? id, confirmed }
      })
    : []
  const allConfirmed = confirming !== null && confirmationProgress.every(h => h.confirmed)

  const canSubmit = form.label.trim().length > 0
    && form.data.trim().length > 0
    && n >= 2
    && form.threshold >= 2
    && form.threshold <= n

  const isBlocking = status.kind === 'sending' || (status.kind === 'confirming' && !allConfirmed)

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Protect secret">
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">Protect Secret</h2>
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
            <div className="form-field">
              <label className="form-label" htmlFor="ps-label">Label</label>
              <input
                id="ps-label"
                className="full-input"
                type="text"
                placeholder="e.g. Metamask Wallet V1"
                value={form.label}
                onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
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
              <span className="form-label">Helper Set (N={n})</span>
              {pairedHelpers.length === 0 ? (
                <p className="empty-hint">No helpers paired yet.</p>
              ) : (
                <ul className="helper-check-list" role="list">
                  {pairedHelpers.map(h => (
                    <li key={h.id} className="helper-check-item">
                      <label className="helper-check-label">
                        <input
                          type="checkbox"
                          className="helper-checkbox"
                          checked={form.selectedHelperIds.has(h.id)}
                          onChange={() => toggleHelper(h.id)}
                          disabled={status.kind === 'sending'}
                        />
                        <span className={`helper-dot ${h.connectionStatus}`} aria-hidden="true" />
                        <span>{h.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="ps-threshold">
                Threshold (T)
                {n > 0 && <span className="form-label-hint"> — min shares to recover (2–{n})</span>}
              </label>
              <input
                id="ps-threshold"
                className="full-input"
                type="number"
                min={2}
                max={n || 2}
                value={form.threshold}
                onChange={e => setForm(f => ({ ...f, threshold: Math.max(2, Math.min(n || 2, Number(e.target.value))) }))}
                disabled={n === 0 || status.kind === 'sending'}
              />
            </div>

            {status.kind === 'error' && (
              <p className="field-error">{status.message}</p>
            )}

            <div className="modal-actions">
              <button type="button" className="secondary" onClick={onClose} disabled={status.kind === 'sending'}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={!canSubmit || status.kind === 'sending'}>
                {status.kind === 'sending' ? 'Sending…' : 'Protect'}
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
//   - Owner displays their own contact QR (helper scans it → owner-initiates flow)
//   - Helper displays their contact QR (owner scans it → helper-initiates flow)
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
  | { kind: 'result'; channelId: bigint }

function PairInitiatorModal({
  label,
  placeholder,
  helperId,
  onClose,
  onSuccess,
  onPairingRequestSent,
  startPairing,
}: {
  label: string
  placeholder: string
  /** Known helper to associate with this pairing attempt, if applicable. */
  helperId?: string
  onClose: () => void
  onSuccess: () => void
  onPairingRequestSent: (channelId: bigint, helperId?: string) => void
  startPairing: (contact: ContactMessage) => Promise<bigint>
}) {
  const { log } = useConsole()
  const [payload, setPayload] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<PairInitiatorStep>({ kind: 'input' })

  useEffect(() => {
    if (step.kind !== 'result') return
    onClose()
    onSuccess()
  }, [step, onClose, onSuccess])

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

      onPairingRequestSent(channelId, helperId)
      setStep({ kind: 'result', channelId })
    } catch (err) {
      console.error('[PairInitiatorModal] start_pairing failed:', err)
      setError(`Failed: ${err instanceof Error ? err.message : String(err)}`)
      setStep({ kind: 'input' })
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="pair-modal-title">
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title" id="pair-modal-title">Pair</h2>
          <ModalCloseButton onClose={onClose} />
        </div>

        {step.kind === 'result' ? (
          <div className="modal-body">
            <p className="modal-description">Pairing request sent. Waiting for confirmation…</p>
            <div className="modal-actions">
              <button className="secondary" onClick={onClose}>Close</button>
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
              <button type="button" className="secondary" onClick={onClose} disabled={step.kind === 'sending'}>
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

// ── Pairing success modal ─────────────────────────────────────────────────────

function PairingSuccessModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="success-title">
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title" id="success-title">Pairing Complete</h2>
          <ModalCloseButton onClose={onClose} />
        </div>
        <div className="modal-body">
          <p className="modal-description">
            Pairing completed successfully. The helper is now ready to receive shares.
          </p>
          <div className="modal-actions">
            <button className="primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Session ID badge ──────────────────────────────────────────────────────────

function SessionIdBadge({ id }: { id: string }) {
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
//   Step 1 — select helpers (checkbox list, all pre-selected)
//   Step 2 — progress (spinner → checkmark as ShareVerified events arrive)
//
// Progress updates automatically: `secret` is a prop that refreshes from session
// state whenever a ShareVerified event is applied, so no callbacks or refs needed.

type VerifyWizardStep =
  | { kind: 'select' }
  | { kind: 'progress'; selectedHelpers: PairedHelper[] }

function VerifySharesModal({
  secretId,
  version,
  verifiedHelperIds,
  confirmedHelpers,
  onClose,
  onVerify,
}: {
  secretId: string
  version: number
  /** Live-updated list of helper IDs that have passed verification for this version. */
  verifiedHelperIds: string[]
  confirmedHelpers: PairedHelper[]
  onClose: () => void
  onVerify: (secretId: string, version: number, selectedHelperIds: string[]) => Promise<void>
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(confirmedHelpers.map(h => h.id)),
  )
  const [step, setStep] = useState<VerifyWizardStep>({ kind: 'select' })
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggleHelper(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleSendChallenges() {
    const selectedHelpers = confirmedHelpers.filter(h => selected.has(h.id))
    if (selectedHelpers.length === 0) return
    setSending(true)
    setError(null)
    try {
      await onVerify(secretId, version, selectedHelpers.map(h => h.id))
      setStep({ kind: 'progress', selectedHelpers })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  // ── Step 1: Select helpers ────────────────────────────────────────────────

  if (step.kind === 'select') {
    return (
      <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="verify-modal-title">
        <div className="modal">
          <div className="modal-header">
            <h2 className="modal-title" id="verify-modal-title">
              Verify Shares {version > 0 && <span className="version-tag">v{version}</span>}
            </h2>
            <ModalCloseButton onClose={onClose} />
          </div>
          <div className="modal-body">
            <p className="modal-description">
              Select the helpers to challenge. Each will receive a verification request
              and must respond with proof of their stored share.
            </p>

            <ul className="helper-check-list" role="list">
              {confirmedHelpers.map(h => {
                const wasVerified = verifiedHelperIds.includes(h.id)
                return (
                  <li key={h.id} className="helper-check-item">
                    <label className="helper-check-label">
                      <input
                        type="checkbox"
                        className="helper-checkbox"
                        checked={selected.has(h.id)}
                        onChange={() => toggleHelper(h.id)}
                        disabled={sending}
                      />
                      <span className={`helper-dot ${h.connectionStatus}`} aria-hidden="true" />
                      <span>{h.name}</span>
                      {wasVerified && (
                        <span className="share-status-tag verified" title="Previously verified">
                          ✓ Verified
                        </span>
                      )}
                    </label>
                  </li>
                )
              })}
            </ul>

            {error && <p className="field-error">{error}</p>}

            <div className="modal-actions">
              <button type="button" className="secondary" onClick={onClose} disabled={sending}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={handleSendChallenges}
                disabled={selected.size === 0 || sending}
              >
                {sending ? 'Sending…' : `Send Challenges (${selected.size})`}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Step 2: Progress ──────────────────────────────────────────────────────

  const { selectedHelpers } = step
  const verifiedCount = selectedHelpers.filter(h => verifiedHelperIds.includes(h.id)).length
  const allDone = verifiedCount === selectedHelpers.length
  const pct = selectedHelpers.length > 0
    ? Math.round((verifiedCount / selectedHelpers.length) * 100)
    : 0

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="verify-progress-title">
      <div className="modal verify-modal--progress">
        <div className="modal-header">
          <h2 className="modal-title" id="verify-progress-title">Verifying Shares</h2>
          <ModalCloseButton onClose={onClose} />
        </div>
        <div className="modal-body">
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
              {verifiedCount} of {selectedHelpers.length} verified
            </p>
          </div>

          <ul className="share-progress-list" role="list">
            {selectedHelpers.map(h => {
              const isVerified = verifiedHelperIds.includes(h.id)
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

// ── Renew Secret modal ────────────────────────────────────────────────────────
//
// Two-step wizard:
//   Step 1 — configure: new data, helper selection, threshold, keepList
//   Step 2 — progress: wait for ShareConfirmed events per selected helper
//
// `secret` is a live prop: after the version increments in step 2, the parent
// re-renders with the new ProtectedSecret (same secretId key), so
// secret.helperIds fills in automatically as ShareConfirmed events arrive.

type RenewWizardStep =
  | { kind: 'configure' }
  | { kind: 'progress'; newVersion: number; selectedHelpers: PairedHelper[] }

interface RenewForm {
  newData: string
  threshold: number
  selectedHelperIds: Set<string>
  keepSet: Set<number>
}

function RenewSecretModal({
  secret,
  pairedHelpers,
  onClose,
  onRenew,
}: {
  secret: ProtectedSecret
  pairedHelpers: PairedHelper[]
  onClose: () => void
  onRenew: (
    secretIdHex: string,
    newSecretData: Uint8Array,
    keepList: number[],
    helperChannelIds: bigint[],
    threshold: number,
  ) => Promise<void>
}) {
  // All version numbers that existed before this renewal (available for keepList).
  // Captured once at mount — must not change when secret.version increments in step 2.
  const [previousVersionsAtOpen] = useState(() => [...secret.previousVersions.map(pv => pv.version), secret.version])
  const newVersion = secret.version + 1

  // Default helper selection: helpers that confirmed the current version.
  const [form, setForm] = useState<RenewForm>(() => {
    const defaultHelperIds = new Set(pairedHelpers.filter(h => secret.helperIds.includes(h.id)).map(h => h.id))
    return {
      newData: '',
      threshold: secret.threshold,
      selectedHelperIds: defaultHelperIds.size > 0 ? defaultHelperIds : new Set(pairedHelpers.map(h => h.id)),
      keepSet: new Set(previousVersionsAtOpen),
    }
  })

  const [step, setStep] = useState<RenewWizardStep>({ kind: 'configure' })
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const selectedPaired = pairedHelpers.filter(h => form.selectedHelperIds.has(h.id))
  const n = selectedPaired.length

  function toggleHelper(id: string) {
    setForm(prev => {
      const next = new Set(prev.selectedHelperIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      const newN = next.size
      return { ...prev, selectedHelperIds: next, threshold: Math.min(prev.threshold, Math.max(2, newN)) }
    })
  }

  function toggleVersion(v: number) {
    setForm(prev => {
      const next = new Set(prev.keepSet)
      if (next.has(v)) next.delete(v)
      else next.add(v)
      return { ...prev, keepSet: next }
    })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.newData.trim() || n === 0 || form.threshold < 2 || form.threshold > n) return

    const secretData = new TextEncoder().encode(form.newData.trim())
    const keepList = previousVersionsAtOpen.filter(v => form.keepSet.has(v))
    const helperChannelIds = selectedPaired.map(h => BigInt(h.channelId))

    setSending(true)
    setError(null)
    try {
      await onRenew(secret.secretId, secretData, keepList, helperChannelIds, form.threshold)
      setStep({ kind: 'progress', newVersion, selectedHelpers: selectedPaired })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  // ── Step 2: progress ──────────────────────────────────────────────────────

  if (step.kind === 'progress') {
    const { selectedHelpers } = step
    // secret.helperIds is updated live as ShareConfirmed events arrive.
    const confirmedCount = selectedHelpers.filter(h => secret.helperIds.includes(h.id)).length
    const allDone = confirmedCount === selectedHelpers.length
    const pct = selectedHelpers.length > 0
      ? Math.round((confirmedCount / selectedHelpers.length) * 100)
      : 0

    return (
      <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="renew-progress-title">
        <div className="modal verify-modal--progress">
          <div className="modal-header">
            <h2 className="modal-title" id="renew-progress-title">
              Sharing Version {step.newVersion}
            </h2>
            <ModalCloseButton onClose={onClose} />
          </div>
          <div className="modal-body">
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
                {confirmedCount} of {selectedHelpers.length} confirmed
              </p>
            </div>

            <ul className="share-progress-list" role="list">
              {selectedHelpers.map(h => {
                const isConfirmed = secret.helperIds.includes(h.id)
                return (
                  <li
                    key={h.id}
                    className={`share-progress-item ${isConfirmed ? 'share-progress-item--confirmed' : ''}`}
                  >
                    <span className="verify-progress-icon">
                      {isConfirmed
                        ? <span className="verify-progress-icon--done" aria-label="Confirmed">✓</span>
                        : <span className="verify-spinner" role="status" aria-label="Waiting for confirmation" />
                      }
                    </span>
                    <span className="share-progress-item-name">{h.name}</span>
                    <span className={`share-progress-item-status ${isConfirmed ? 'status--verified' : ''}`}>
                      {isConfirmed ? 'Confirmed' : 'Waiting…'}
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

  // ── Step 1: configure ─────────────────────────────────────────────────────

  const canSubmit = form.newData.trim().length > 0
    && n >= 2
    && form.threshold >= 2
    && form.threshold <= n

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Renew secret">
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">Renew Secret</h2>
          {!sending && <ModalCloseButton onClose={onClose} />}
        </div>

        <form className="modal-body" onSubmit={handleSubmit}>
          <div className="form-field">
            <span className="form-label">Secret</span>
            <p className="form-hint">
              {secret.label} — creating version {newVersion} ({secret.label}-{newVersion})
            </p>
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="rs-data">New Secret Data</label>
            <SecretDataField
              value={form.newData}
              onChange={newData => setForm(f => ({ ...f, newData }))}
              disabled={sending}
            />
          </div>

          <div className="form-field">
            <span className="form-label">Helpers (N={n})</span>
            {pairedHelpers.length === 0 ? (
              <p className="empty-hint">No paired helpers available.</p>
            ) : (
              <ul className="helper-check-list" role="list">
                {pairedHelpers.map(h => (
                  <li key={h.id} className="helper-check-item">
                    <label className="helper-check-label">
                      <input
                        type="checkbox"
                        className="helper-checkbox"
                        checked={form.selectedHelperIds.has(h.id)}
                        onChange={() => toggleHelper(h.id)}
                        disabled={sending}
                      />
                      <span className={`helper-dot ${h.connectionStatus}`} aria-hidden="true" />
                      <span>{h.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="rs-threshold">
              Threshold (T)
              {n > 0 && <span className="form-label-hint"> — min shares to recover (2–{n})</span>}
            </label>
            <input
              id="rs-threshold"
              className="full-input"
              type="number"
              min={2}
              max={n || 2}
              value={form.threshold}
              onChange={e => setForm(f => ({ ...f, threshold: Math.max(2, Math.min(n || 2, Number(e.target.value))) }))}
              disabled={n === 0 || sending}
            />
          </div>

          {previousVersionsAtOpen.length > 0 && (
            <div className="form-field">
              <span className="form-label">Previous Versions to Retain</span>
              <p className="form-hint">
                Checked versions remain stored by helpers and can be recovered if needed.
                Uncheck to instruct helpers to delete those shares.
              </p>
              <ul className="helper-check-list" role="list">
                {previousVersionsAtOpen.map(v => (
                  <li key={v} className="helper-check-item">
                    <label className="helper-check-label">
                      <input
                        type="checkbox"
                        className="helper-checkbox"
                        checked={form.keepSet.has(v)}
                        onChange={() => toggleVersion(v)}
                        disabled={sending}
                      />
                      <span>Version {v} — <code>{secret.label}-{v}</code></span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && <p className="field-error">{error}</p>}

          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose} disabled={sending}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={!canSubmit || sending}>
              {sending ? 'Sending…' : `Share as Version ${newVersion}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Paired helper card ────────────────────────────────────────────────────────

function PairedHelperCard({ helper, onUnpair }: { helper: PairedHelper; onUnpair: () => void }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className={`detail-card collapsible ${expanded ? 'expanded' : ''}`}>
      <button
        className="card-header card-toggle"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
      >
        <span className="card-title">{helper.name}</span>
        <ClickToCopyCode label="Channel ID" value={helper.channelId} />
        <span className={`status-tag ${helper.connectionStatus}`}>
          {connectionStatusLabel(helper.connectionStatus)}
        </span>
        <ChevronIcon expanded={expanded} />
      </button>

      {expanded && (
        <div className="card-body">
          <dl className="field-list">
            <div className="field-row">
              <dt>Protocol</dt>
              <dd><span className="protocol-badge">{helper.transport.protocol.toUpperCase()}</span></dd>
            </div>
            <div className="field-row">
              <dt>URI</dt>
              <dd><code className="uri-value">{helper.transport.uri}</code></dd>
            </div>
          </dl>

          <div className="card-sub-section">
            <h4 className="sub-heading">Secret Shares</h4>
            {helper.secretShares.length === 0 ? (
              <p className="empty-hint">No secret shares yet.</p>
            ) : (
              <ul className="share-list" role="list">
                {helper.secretShares.map(share => (
                  <li
                    key={`${share.secretId}-${share.version}`}
                    className={`share-item ${share.status === 'confirmed' ? 'share-item--confirmed' : 'share-item--pending'}`}
                  >
                    <span className="share-label">{share.label}</span>
                    <span className="version-tag">v{share.version}</span>
                    <span
                      className={`share-status-tag ${share.verified ? 'verified' : share.status}`}
                      title={share.verified ? 'Verified' : share.status === 'confirmed' ? 'Confirmed' : 'Awaiting confirmation'}
                    >
                      {share.verified ? '✓✓' : share.status === 'confirmed' ? '✓' : '⋯'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card-actions">
            <button className="primary unpair-card-btn" onClick={onUnpair}>
              Unpair
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Protected secret card ─────────────────────────────────────────────────────

function ProtectedSecretCard({
  secret,
  helpers,
  onVerify,
  onRenew,
}: {
  secret: ProtectedSecret
  helpers: PairedHelper[]
  onVerify: (secretId: string, version: number, selectedHelperIds: string[]) => Promise<void>
  onRenew: (secretIdHex: string, newSecretData: Uint8Array, keepList: number[], helperChannelIds: bigint[], threshold: number) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [secretVisible, setSecretVisible] = useState(false)
  // null = no verify modal open; a version number = that version's modal is open
  const [verifyingVersion, setVerifyingVersion] = useState<number | null>(null)
  const [renewOpen, setRenewOpen] = useState(false)
  const confirmedHelpers = helpers.filter(h => secret.helperIds.includes(h.id))
  const pairedHelpers = helpers.filter(h => h.connectionStatus === 'paired')
  const n = confirmedHelpers.length
  const verifiedCount = secret.verifiedHelperIds.length

  // Resolve props for whichever verify modal is open.
  const verifyingPreviousVersion = verifyingVersion !== null && verifyingVersion !== secret.version
    ? secret.previousVersions.find(pv => pv.version === verifyingVersion) ?? null
    : null
  const activeVerifiedHelperIds = verifyingVersion === secret.version
    ? secret.verifiedHelperIds
    : (verifyingPreviousVersion?.verifiedHelperIds ?? [])

  return (
    <>
      <div className={`detail-card collapsible ${expanded ? 'expanded' : ''}`}>
        <button
          className="card-header card-toggle"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
        >
          <span className="card-title">{secret.label}</span>
          <span className="version-tag">v{secret.version}</span>
          <ChevronIcon expanded={expanded} />
        </button>

        {expanded && (
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
                <dt>Current Value</dt>
                <dd>
                  <div className="shared-key-field">
                    <code className="key-input" style={{ fontFamily: 'inherit' }}>
                      {secretVisible ? secret.secretData : '•'.repeat(Math.min(secret.secretData.length, 24))}
                    </code>
                    <button
                      type="button"
                      className="secondary reveal-btn"
                      onClick={() => setSecretVisible(v => !v)}
                      aria-label={secretVisible ? 'Hide secret' : 'Reveal secret'}
                    >
                      {secretVisible ? <EyeOffIcon /> : <EyeIcon />}
                    </button>
                  </div>
                </dd>
              </div>

              <div className="field-row">
                <dt>Recovery threshold</dt>
                <dd>
                  <span className="threshold-value">
                    {secret.threshold} of {n > 0 ? n : '?'} helpers
                  </span>
                </dd>
              </div>
            </dl>

            <div className="card-sub-section">
              <div className="sub-heading-row">
                <h4 className="sub-heading">Helper Shares</h4>
                {n > 0 && (
                  <span className="verified-summary">
                    {verifiedCount}/{n} verified
                  </span>
                )}
              </div>
              {confirmedHelpers.length === 0 ? (
                <p className="empty-hint">Waiting for helpers to confirm…</p>
              ) : (
                <ul className="helper-tag-list" role="list">
                  {confirmedHelpers.map(h => {
                    const isVerified = secret.verifiedHelperIds.includes(h.id)
                    return (
                      <li key={h.id} className={`helper-tag ${isVerified ? 'helper-tag--verified' : ''}`}>
                        <span>{h.name}</span>
                        <span
                          className="helper-verification-icon"
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

            {secret.previousVersions.length > 0 && (
              <div className="card-sub-section">
                <h4 className="sub-heading">Previous Versions</h4>
                <ul className="version-history-list" role="list">
                  {secret.previousVersions.map(pv => {
                    const pvVerifiedCount = pv.verifiedHelperIds.length
                    return (
                      <li key={pv.version} className="version-history-item">
                        <span className="version-tag">v{pv.version}</span>
                        <span className="version-history-label">{secret.label}-{pv.version}</span>
                        {pvVerifiedCount > 0 && (
                          <span className="version-history-verified" title={`${pvVerifiedCount} helper(s) verified`}>
                            ✓ {pvVerifiedCount}
                          </span>
                        )}
                        <button
                          type="button"
                          className="secondary version-verify-btn"
                          onClick={() => setVerifyingVersion(pv.version)}
                        >
                          Verify
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}

            <div className="card-actions">
              {n > 0 && (
                <>
                  <button
                    type="button"
                    className="secondary verify-btn"
                    onClick={() => setVerifyingVersion(secret.version)}
                  >
                    Verify Shares
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => setRenewOpen(true)}
                  >
                    Renew Secret
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {verifyingVersion !== null && (
        <VerifySharesModal
          secretId={secret.secretId}
          version={verifyingVersion}
          verifiedHelperIds={activeVerifiedHelperIds}
          confirmedHelpers={confirmedHelpers}
          onClose={() => setVerifyingVersion(null)}
          onVerify={onVerify}
        />
      )}

      {renewOpen && (
        <RenewSecretModal
          secret={secret}
          pairedHelpers={pairedHelpers}
          onClose={() => setRenewOpen(false)}
          onRenew={onRenew}
        />
      )}
    </>
  )
}

// ── Tab panels ────────────────────────────────────────────────────────────────

function PairedHelpersList({ helpers, onTogglePair }: { helpers: PairedHelper[]; onTogglePair: (id: string) => void }) {
  const paired = helpers.filter(h => h.connectionStatus === 'paired')
  if (paired.length === 0) {
    return (
      <p className="tab-empty-state">
        No helpers paired yet. Share your Session ID with helpers so they can join.
      </p>
    )
  }
  return (
    <div className="card-list">
      {paired.map(h => (
        <PairedHelperCard key={h.id} helper={h} onUnpair={() => onTogglePair(h.id)} />
      ))}
    </div>
  )
}

function ProtectedSecretsList({
  secrets,
  helpers,
  onVerify,
  onRenew,
}: {
  secrets: ProtectedSecret[]
  helpers: PairedHelper[]
  onVerify: (secretId: string, version: number, selectedHelperIds: string[]) => Promise<void>
  onRenew: (secretIdHex: string, newSecretData: Uint8Array, keepList: number[], helperChannelIds: bigint[], threshold: number) => Promise<void>
}) {
  if (secrets.length === 0) {
    return (
      <p className="tab-empty-state">
        No protected secrets yet. Secrets will appear here once shared with helpers.
      </p>
    )
  }
  return (
    <div className="card-list">
      {secrets.map(s => (
        <ProtectedSecretCard
          key={s.secretId}
          secret={s}
          helpers={helpers}
          onVerify={onVerify}
          onRenew={onRenew}
        />
      ))}
    </div>
  )
}

// ── Recovery tab components ──────────────────────────────────────────────────

function RecoveryHelperCard({
  helper,
  onRequestDiscovery,
}: {
  helper: PairedHelper
  onRequestDiscovery: (channelId: bigint) => void
}) {
  return (
    <div className="detail-card">
      <div className="card-header">
        <span className={`helper-dot paired`} aria-hidden="true" />
        <span className="card-title">{helper.name}</span>
        <ClickToCopyCode label="Channel ID" value={helper.channelId} />
        <span className={`status-tag ${helper.discoveryComplete ? 'paired' : 'available'}`}>
          {helper.discoveryComplete ? 'Discovered' : 'Pending'}
        </span>
      </div>
      <div className="card-body">
        <div className="card-actions">
          <button
            className="primary"
            onClick={() => onRequestDiscovery(BigInt(helper.channelId))}
          >
            {helper.discoveryComplete ? 'Re-discover' : 'Discover'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Recover Secret modal ─────────────────────────────────────────────────────

type RecoverSecretStatus =
  | { kind: 'selecting' }
  | { kind: 'recovering'; selectedHelperIds: string[] }
  | { kind: 'recovered'; secretData: string }
  | { kind: 'error'; message: string }

function RecoverSecretModal({
  secret,
  version,
  helpers,
  recoveredSecrets,
  recoveryProgress,
  onRecover,
  onClose,
}: {
  secret: DiscoverableSecret
  version: number
  helpers: PairedHelper[]
  recoveredSecrets: RecoveredSecret[]
  recoveryProgress: RecoveryProgress | null
  onRecover: (secretId: string, version: number, label: string, helperChannelIds: bigint[]) => Promise<void>
  onClose: () => void
}) {
  const helperIds = secret.helperSharesByVersion[version] ?? []
  const availableHelpers = helperIds
    .map(id => helpers.find(h => h.id === id))
    .filter((h): h is PairedHelper => h !== undefined && h.channelId !== '')

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(availableHelpers.map(h => h.id)))
  const [status, setStatus] = useState<RecoverSecretStatus>({ kind: 'selecting' })

  // React to recoveredSecrets prop — transition to 'recovered' when our secret appears.
  const recovering = status.kind === 'recovering' ? status : null
  useEffect(() => {
    if (!recovering) return
    const match = recoveredSecrets.find(
      r => r.secretId === secret.secretId && r.version === version,
    )
    if (match) {
      setStatus({ kind: 'recovered', secretData: match.secretData })
    }
  }, [recovering, recoveredSecrets, secret.secretId, version])

  // React to recoveryProgress — when all responses arrived but reconstruction failed,
  // show an error with the reason from the library.
  useEffect(() => {
    if (!recovering || !recoveryProgress) return
    if (recoveryProgress.secretId !== secret.secretId || recoveryProgress.version !== version) return

    if (recoveryProgress.error) {
      setStatus({
        kind: 'error',
        message: `Recovery failed: ${recoveryProgress.error}. Try selecting different helpers.`,
      })
    } else if (recoveryProgress.sharesReceived >= recoveryProgress.totalRequested) {
      // All responses arrived but no SecretRecovered event — threshold not met.
      setStatus({
        kind: 'error',
        message: `All ${recoveryProgress.totalRequested} helper(s) responded, but the shares were insufficient to reconstruct the secret. The secret's threshold may require more helpers than were available.`,
      })
    }
  }, [recovering, recoveryProgress, secret.secretId, version])

  function toggleHelper(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleConfirm() {
    const selected = availableHelpers.filter(h => selectedIds.has(h.id))
    if (selected.length === 0) return

    const channelIds = selected.map(h => BigInt(h.channelId))
    setStatus({ kind: 'recovering', selectedHelperIds: selected.map(h => h.id) })
    try {
      await onRecover(secret.secretId, version, secret.label, channelIds)
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const selectedCount = availableHelpers.filter(h => selectedIds.has(h.id)).length
  const isBlocking = status.kind === 'recovering'

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Recover secret">
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">Recover Secret</h2>
          {!isBlocking && <ModalCloseButton onClose={onClose} />}
        </div>

        {status.kind === 'recovered' ? (
          <div className="modal-body">
            <p className="share-progress-summary">
              Secret <strong>{secret.label}</strong> v{version} recovered successfully.
            </p>

            <div className="form-field">
              <label className="form-label">Recovered Secret Data</label>
              <pre className="recovered-secret-plaintext">{status.secretData}</pre>
            </div>

            <div className="modal-actions">
              <button type="button" className="primary" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : status.kind === 'error' ? (
          <div className="modal-body">
            <p className="field-error" style={{ marginBottom: '1rem' }}>{status.message}</p>

            <div className="modal-actions">
              <button type="button" className="secondary" onClick={onClose}>Close</button>
              <button
                type="button"
                className="primary"
                onClick={() => setStatus({ kind: 'selecting' })}
              >
                Try Again
              </button>
            </div>
          </div>
        ) : status.kind === 'recovering' ? (
          <div className="modal-body">
            <p className="share-progress-summary" style={{ marginBottom: '0.75rem' }}>
              Recovering <strong>{secret.label}</strong> v{version} &mdash;
              {recoveryProgress
                ? ` ${recoveryProgress.sharesReceived} of ${recoveryProgress.totalRequested} share(s) received`
                : ' waiting for helper responses'}&hellip;
            </p>

            <div className="verify-progress-bar-section">
              <div className="share-progress-bar-track">
                <div
                  className="share-progress-bar-fill"
                  style={{ width: recoveryProgress ? `${Math.round((recoveryProgress.sharesReceived / recoveryProgress.totalRequested) * 100)}%` : '0%' }}
                  role="progressbar"
                  aria-valuenow={recoveryProgress?.sharesReceived ?? 0}
                  aria-valuemin={0}
                  aria-valuemax={recoveryProgress?.totalRequested ?? status.selectedHelperIds.length}
                />
              </div>
            </div>

            <ul className="share-progress-list" role="list">
              {status.selectedHelperIds.map(id => {
                const helper = helpers.find(h => h.id === id)
                return (
                  <li key={id} className="share-progress-item">
                    <span className="verify-progress-icon">
                      <span className="verify-spinner" role="status" aria-label="Waiting for response" />
                    </span>
                    <span className="share-progress-item-name">{helper?.name ?? id}</span>
                    <span className="share-progress-item-status">Waiting&hellip;</span>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : (
          <div className="modal-body">
            <dl className="field-list" style={{ marginBottom: '1rem' }}>
              <div className="field-row">
                <dt>Secret</dt>
                <dd><strong>{secret.label}</strong></dd>
              </div>
              <div className="field-row">
                <dt>Version</dt>
                <dd><span className="version-tag">v{version}</span></dd>
              </div>
              <div className="field-row">
                <dt>Secret ID</dt>
                <dd>
                  <code className="secret-id-value" title={secret.secretId}>
                    {secret.secretId.slice(0, 16)}…
                  </code>
                </dd>
              </div>
            </dl>

            <div className="form-field">
              <span className="form-label">Select helpers to recover from ({selectedCount} selected)</span>
              {availableHelpers.length === 0 ? (
                <p className="empty-hint">No helpers with shares available for this version.</p>
              ) : (
                <ul className="helper-check-list" role="list">
                  {availableHelpers.map(h => (
                    <li key={h.id} className="helper-check-item">
                      <label className="helper-check-label">
                        <input
                          type="checkbox"
                          className="helper-checkbox"
                          checked={selectedIds.has(h.id)}
                          onChange={() => toggleHelper(h.id)}
                        />
                        <span className={`helper-dot ${h.connectionStatus}`} aria-hidden="true" />
                        <span>{h.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="modal-actions">
              <button type="button" className="secondary" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="primary"
                onClick={handleConfirm}
                disabled={selectedCount === 0}
              >
                Recover
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function DiscoverableSecretCard({
  secret,
  helpers,
  recoveredSecrets,
  recoveryProgress,
  onRecover,
}: {
  secret: DiscoverableSecret
  helpers: PairedHelper[]
  recoveredSecrets: RecoveredSecret[]
  recoveryProgress: RecoveryProgress | null
  onRecover: (secretId: string, version: number, label: string, helperChannelIds: bigint[]) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(true)
  const [recoverModalVersion, setRecoverModalVersion] = useState<number | null>(null)

  return (
    <>
      <div className={`detail-card collapsible ${expanded ? 'expanded' : ''}`}>
        <button
          className="card-header card-toggle"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
        >
          <span className="card-title">{secret.label}</span>
          <code className="secret-id-value" title={secret.secretId}>
            {secret.secretId.slice(0, 12)}…
          </code>
          <ChevronIcon expanded={expanded} />
        </button>

        {expanded && (
          <div className="card-body">
            <div className="card-sub-section">
              <h4 className="sub-heading">Versions available for recovery</h4>
              <ul className="version-history-list" role="list">
                {secret.versions.map(v => {
                  const helperIds = secret.helperSharesByVersion[v.version] ?? []
                  const alreadyRecovered = recoveredSecrets.some(
                    r => r.secretId === secret.secretId && r.version === v.version,
                  )
                  return (
                    <li key={v.version} className="version-history-item">
                      <span className="version-tag">v{v.version}</span>
                      <span className="version-history-label">{v.description}</span>
                      <span className="version-history-verified" title={`${helperIds.length} helper(s) have shares`}>
                        {helperIds.length} helper{helperIds.length !== 1 ? 's' : ''}
                      </span>
                      {alreadyRecovered ? (
                        <span className="status-tag paired">Recovered</span>
                      ) : (
                        <button
                          type="button"
                          className="primary version-verify-btn"
                          onClick={() => setRecoverModalVersion(v.version)}
                          disabled={helperIds.length === 0}
                        >
                          Recover
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>

            <div className="card-sub-section">
              <h4 className="sub-heading">Helper availability</h4>
              <ul className="helper-tag-list" role="list">
                {Object.entries(secret.helperSharesByVersion).map(([ver, ids]) =>
                  ids.map(id => {
                    const h = helpers.find(h => h.id === id)
                    return (
                      <li key={`${ver}-${id}`} className="helper-tag">
                        <span>{h?.name ?? id}</span>
                        <span className="version-tag">v{ver}</span>
                      </li>
                    )
                  }),
                )}
              </ul>
            </div>
          </div>
        )}
      </div>

      {recoverModalVersion !== null && (
        <RecoverSecretModal
          secret={secret}
          version={recoverModalVersion}
          helpers={helpers}
          recoveredSecrets={recoveredSecrets}
          recoveryProgress={recoveryProgress}
          onRecover={onRecover}
          onClose={() => setRecoverModalVersion(null)}
        />
      )}
    </>
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

function RecoveryPanel({
  session,
  onRequestDiscovery,
  onRecover,
}: {
  session: OwnerSession
  onRequestDiscovery: (channelId: bigint) => void
  onRecover: (secretId: string, version: number, label: string, helperChannelIds: bigint[]) => Promise<void>
}) {
  const recoveryHelpers = session.helpers.filter(h => h.recoveryPaired && h.connectionStatus === 'paired')
  const discoverableSecrets = session.discoverableSecrets ?? []
  const recoveredSecrets = session.recoveredSecrets ?? []

  return (
    <div className="recovery-panel">
      <div className="recovery-section">
        <h3 className="sub-heading">Recovery-Paired Helpers</h3>
        {recoveryHelpers.length === 0 ? (
          <p className="tab-empty-state">
            No helpers paired in recovery mode yet. Use the "Pair" button while Recovery Mode is active.
          </p>
        ) : (
          <div className="card-list">
            {recoveryHelpers.map(h => (
              <RecoveryHelperCard
                key={h.id}
                helper={h}
                onRequestDiscovery={onRequestDiscovery}
              />
            ))}
          </div>
        )}
      </div>

      <div className="recovery-section">
        <h3 className="sub-heading">Discoverable Secrets</h3>
        {discoverableSecrets.length === 0 ? (
          <p className="tab-empty-state">
            No secrets discovered yet. Pair with helpers in recovery mode and associate their channels to discover available secrets.
          </p>
        ) : (
          <div className="card-list">
            {discoverableSecrets.map(s => (
              <DiscoverableSecretCard
                key={s.secretId}
                secret={s}
                helpers={session.helpers}
                recoveredSecrets={recoveredSecrets}
                recoveryProgress={session.recoveryProgress}
                onRecover={onRecover}
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

function connectionStatusLabel(status: HelperConnectionStatus): string {
  switch (status) {
    case 'paired':    return 'Paired'
    case 'available': return 'Available'
    case 'offline':   return 'Offline'
  }
}

function SidePanelHelperItem({
  helper,
  sessionId,
  ownerName,
  onTogglePair,
  onPairingCreated,
  onPairingRequestSent,
  onSuccess,
  createHelperContact,
  startHelperPairing,
}: {
  helper: PairedHelper
  sessionId: string
  ownerName: string
  onTogglePair: (id: string) => void
  onPairingCreated: (channelId: bigint, helperId: string) => void
  onPairingRequestSent: (channelId: bigint, helperId: string) => void
  onSuccess: () => void
  createHelperContact: () => Promise<ContactMessage>
  startHelperPairing: (contact: ContactMessage) => Promise<bigint>
}) {
  const [expanded, setExpanded] = useState(false)
  const [shareContactOpen, setShareContactOpen] = useState(false)
  const [pairWithOwnerOpen, setPairWithOwnerOpen] = useState(false)
  const [associating, setAssociating] = useState(false)
  const [assocError, setAssocError] = useState<string | null>(null)
  const isPaired = helper.connectionStatus === 'paired'
  const hasPendingRecovery = !!helper.pendingRecoveryChannelId

  async function handleAssociate() {
    if (!helper.pendingRecoveryChannelId || !helper.channelId) return
    setAssociating(true)
    setAssocError(null)
    try {
      await apiAssociateChannel(
        sessionId,
        helper.id,
        helper.channelId, // old channel
        helper.pendingRecoveryChannelId, // new recovery channel
      )
    } catch (err) {
      setAssocError(err instanceof Error ? err.message : String(err))
    } finally {
      setAssociating(false)
    }
  }

  return (
    <li className="side-helper-item">
      <button
        className="side-helper-header"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
      >
        <span className={`helper-dot ${hasPendingRecovery ? 'recovery-pending' : helper.connectionStatus}`} aria-hidden="true" />
        <span className="side-helper-name">{helper.name}</span>
        {hasPendingRecovery ? (
          <span className="status-tag recovery-pending">Recovery Pending</span>
        ) : (
          <span className={`status-tag ${helper.connectionStatus}`}>
            {connectionStatusLabel(helper.connectionStatus)}
          </span>
        )}
        <ChevronIcon expanded={expanded} />
      </button>

      {expanded && (
        <div className="side-helper-details">
          {hasPendingRecovery ? (
            <div className="recovery-association-prompt">
              <p className="recovery-assoc-description">
                A recovery pairing request was received. Associate the new channel with this helper's existing contact.
              </p>
              <div className="recovery-assoc-contact">
                <span className="recovery-assoc-name">{ownerName}</span>
                <ClickToCopyCode label="Old Channel" value={helper.channelId} />
                <ClickToCopyCode label="New Channel" value={helper.pendingRecoveryChannelId!} />
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
                <ClickToCopyCode value={helper.channelId} />
              </div>
              <div className="side-detail-row side-detail-shares">
                <span className="side-detail-label">Shares</span>
                {helper.secretShares.length === 0 ? (
                  <span className="empty-hint">None</span>
                ) : (
                  <ul className="side-share-list" role="list">
                    {helper.secretShares.map(s => (
                      <li key={`${s.secretId}-${s.version}`} className="side-share-item">
                        <span>{s.label}</span>
                        <span className="version-tag">v{s.version}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="side-helper-actions">
                <button
                  className="secondary side-action-btn"
                  onClick={() => setShareContactOpen(true)}
                >
                  Share Contact
                </button>
                {isPaired ? (
                  <button className="pair-action-btn unpair" onClick={() => onTogglePair(helper.id)}>
                    Unpair
                  </button>
                ) : (
                  <button className="pair-action-btn pair" onClick={() => setPairWithOwnerOpen(true)}>
                    Pair
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {shareContactOpen && (
        <ShareContactModal
          title={`Share ${helper.name} Contact`}
          transport={helper.transport}
          createContact={createHelperContact}
          onClose={() => setShareContactOpen(false)}
          onPairingCreated={channelId => {
            onPairingCreated(channelId, helper.id)
          }}
        />
      )}

      {pairWithOwnerOpen && (
        <PairInitiatorModal
          label="Owner Contact QR Payload"
          placeholder="Paste the JSON payload from the owner's Share Contact QR code"
          onClose={() => setPairWithOwnerOpen(false)}
          onSuccess={onSuccess}
          onPairingRequestSent={(channelId) => onPairingRequestSent(channelId, helper.id)}
          startPairing={startHelperPairing}
        />
      )}
    </li>
  )
}

function SessionHelperPanel({
  helpers,
  sessionId,
  ownerName,
  onTogglePair,
  onPairingCreated,
  onPairingRequestSent,
  onSuccess,
  getHelperFunctions,
}: {
  helpers: PairedHelper[]
  sessionId: string
  ownerName: string
  onTogglePair: (id: string) => void
  onPairingCreated: (channelId: bigint, helperId: string) => void
  onPairingRequestSent: (channelId: bigint, helperId: string) => void
  onSuccess: () => void
  getHelperFunctions: (helperId: string) => {
    createContact: () => Promise<ContactMessage>
    startPairing: (contact: ContactMessage) => Promise<bigint>
  }
}) {
  return (
    <aside className="side-panel" aria-label="Session helpers">
      <h3 className="panel-heading">Helpers</h3>
      <p className="panel-subtitle">{helpers.length} provisioned</p>
      <ul className="side-helper-list" role="list">
        {helpers.map(h => {
          const { createContact, startPairing } = getHelperFunctions(h.id)
          return (
            <SidePanelHelperItem
              key={h.id}
              helper={h}
              sessionId={sessionId}
              ownerName={ownerName}
              onTogglePair={onTogglePair}
              onPairingCreated={onPairingCreated}
              onPairingRequestSent={onPairingRequestSent}
              onSuccess={onSuccess}
              createHelperContact={createContact}
              startHelperPairing={startPairing}
            />
          )
        })}
      </ul>
    </aside>
  )
}

// ── Pending share tracking ────────────────────────────────────────────────────

interface PendingShare {
  secretId: string      // hex string for matching against ProtectedSecret
  secretIdBytes: Uint8Array
  label: string
  version: number
}

// ── Page ──────────────────────────────────────────────────────────────────────

type ActiveTab = 'helpers' | 'secrets' | 'recovery'

interface Props {
  session: OwnerSession
  onUpdate: (updated: OwnerSession) => void
  onLeave: () => void
}

export default function OwnerSessionPage({ session, onUpdate, onLeave }: Props) {
  const { log } = useConsole()
  const [activeTab, setActiveTab] = useState<ActiveTab>('helpers')
  const [shareOpen, setShareOpen] = useState(false)
  const [pairOpen, setPairOpen] = useState(false)
  const [pairSuccessOpen, setPairSuccessOpen] = useState(false)
  const [protectOpen, setProtectOpen] = useState(false)
  const [recoveryMode, setRecoveryMode] = useState(false)
  const recoveryModeRef = useRef(false)
  recoveryModeRef.current = recoveryMode
  // Snapshot of helper state before entering recovery — restored on exit.
  const preRecoveryHelpersRef = useRef<PairedHelper[] | null>(null)

  // IDs of helpers being auto-paired. Non-empty → show setup gate instead of full UI.
  const [autoPairingIds, setAutoPairingIds] = useState<string[]>([])

  // ── Protocol instances ────────────────────────────────────────────────────────

  const ownerProtocolRef = useRef<DeRecProtocol | null>(null)

  // Tracks pending shares so ShareConfirmed events can be correlated with secrets.
  // keyed by helper channelId (bigint as string)
  const pendingSharesRef = useRef<Map<string, PendingShare>>(new Map())

  // Tracks in-flight verification challenges keyed by helper channelId.
  const pendingVerificationsRef = useRef<Map<string, { secretIdHex: string; version: number }>>(new Map())

  // Tracks in-flight recovery requests so SecretRecovered events can be correlated.
  const pendingRecoveryRef = useRef<{ secretId: string; version: number; label: string } | null>(null)

  // Use a stable session ref so polling closures always see the latest value without
  // being listed as a dependency (avoids tearing down intervals on every render).
  const sessionRef = useRef(session)
  useEffect(() => { sessionRef.current = session }, [session])
  const onUpdateRef = useRef(onUpdate)
  useEffect(() => { onUpdateRef.current = onUpdate }, [onUpdate])

  useEffect(() => {
    const { sessionId, ownerId, transport, helpers } = session

    // Owner protocol (WASM). Helpers run on the backend — no FE protocol needed.
    const ownerProtocol = new DeRecProtocol(
      makeContactStore(`owner:${ownerId}`),
      makeShareStore(`owner:${ownerId}`),
      makeSecretStore(`owner:${ownerId}`),
      makeTransport(sendMessage),
      transport.uri,
      'https',
    )
    ownerProtocolRef.current = ownerProtocol

    log({
      role: 'owner',
      flow: 'session',
      step: 'protocol_init',
      description: `Owner protocol initialized for session ${sessionId}`,
      payload: { sessionId, ownerId, helperCount: helpers.length },
    })

    return () => {
      ownerProtocolRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId])

  // ── Auto-pair helpers on first load ───────────────────────────────────────────

  const didAutoPair = useRef(false)
  useEffect(() => {
    if (didAutoPair.current) return
    const count = session.prePairedCount ?? 0
    if (count === 0) return
    didAutoPair.current = true

    const helpersToAutoPair = session.helpers.filter(h => h.connectionStatus === 'available').slice(0, count)
    if (helpersToAutoPair.length === 0) return

    setAutoPairingIds(helpersToAutoPair.map(h => h.id))

    async function autoPair() {
      const protocol = ownerProtocolRef.current
      if (!protocol) return

      const newPairings: Array<{ channelId: bigint; helperId: string }> = []

      for (const helper of helpersToAutoPair) {
        try {
          const dto = await apiCreateHelperContact(session.sessionId, helper.id)
          const contact = dtoToContactMessage(dto)
          const channelId = await protocol.startPairing(SenderKind.OwnerNonRecovery, contact)

          newPairings.push({ channelId, helperId: helper.id })

          log({
            role: 'owner',
            flow: 'pairing',
            step: 'auto_pair_initiated',
            description: `Auto-pair initiated for ${helper.name}`,
            payload: { helperId: helper.id, channelId: channelId.toString() },
          })
        } catch (err) {
          console.error(`[auto-pair] failed for helper ${helper.id}:`, err)
        }
      }

      if (newPairings.length > 0) {
        const snapshot = sessionRef.current
        onUpdateRef.current({
          ...snapshot,
          prePairedCount: 0,
          pendingPairings: [
            ...snapshot.pendingPairings,
            ...newPairings.map(({ channelId, helperId }) => ({ channelId, helperId })),
          ],
        })
      }
    }

    autoPair()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId])

  // Clear the auto-pair gate once all targeted helpers have paired.
  useEffect(() => {
    if (autoPairingIds.length === 0) return
    const allPaired = autoPairingIds.every(id =>
      session.helpers.some(h => h.id === id && h.connectionStatus === 'paired'),
    )
    if (allPaired) setAutoPairingIds([])
  }, [autoPairingIds, session.helpers])

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
    },
  ): OwnerSession {
    if (event.type === 'PairingComplete' && event.channel_id) {
      const channelId = event.channel_id
      const isRecovery = event.kind === 1 // SenderKind.OwnerRecovery
      const pending = current.pendingPairings.find(p => p.channelId.toString() === channelId)
      const helperId = pending?.helperId

      log({
        role: 'owner',
        flow: 'pairing',
        step: 'PairingComplete',
        description: `Pairing complete for channel ${channelId}${isRecovery ? ' (recovery)' : ''}`,
        payload: { channelId, helperId, isRecovery },
      })

      const updated: OwnerSession = {
        ...current,
        pendingPairings: current.pendingPairings.filter(p => p.channelId.toString() !== channelId),
        helpers: current.helpers.map(h =>
          h.id === helperId
            ? { ...h, channelId, connectionStatus: 'paired' as const, recoveryPaired: isRecovery || undefined }
            : h,
        ),
      }

      // Discovery is NOT triggered here — the helper must first associate
      // the new channel with the old one. Session status polling detects when
      // pendingRecoveryChannelId clears and triggers discovery at that point.

      return updated
    }

    if (event.type === 'ShareConfirmed' && event.channel_id) {
      const channelId = event.channel_id
      const version = event.version ?? 1
      const pending = pendingSharesRef.current.get(channelId)

      log({
        role: 'owner',
        flow: 'sharing',
        step: 'ShareConfirmed',
        description: `Share confirmed by helper on channel ${channelId}`,
        payload: { channelId, version, secretId: pending?.secretId },
      })

      if (!pending) return current

      const helper = current.helpers.find(h => h.channelId === channelId)
      if (!helper) return current

      const shareRef: SecretShareRef = {
        secretId: pending.secretId,
        version,
        label: pending.label,
        status: 'confirmed',
        verified: false,
      }

      return {
        ...current,
        helpers: current.helpers.map(h =>
          h.id === helper.id
            ? { ...h, secretShares: [...h.secretShares.filter(s => !(s.secretId === pending.secretId && s.version === version)), shareRef] }
            : h,
        ),
        protectedSecrets: current.protectedSecrets.map(s =>
          s.secretId === pending.secretId && s.version === version && !s.helperIds.includes(helper.id)
            ? { ...s, helperIds: [...s.helperIds, helper.id] }
            : s,
        ),
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
        payload: { channelId, version, secretId: pending?.secretIdHex },
      })

      if (!pending) return current

      const helper = current.helpers.find(h => h.channelId === channelId)
      if (!helper) return current

      return {
        ...current,
        helpers: current.helpers.map(h =>
          h.id === helper.id
            ? {
                ...h,
                secretShares: h.secretShares.map(s =>
                  s.secretId === pending.secretIdHex && s.version === version
                    ? { ...s, verified: true }
                    : s,
                ),
              }
            : h,
        ),
        protectedSecrets: current.protectedSecrets.map(s => {
          if (s.secretId !== pending.secretIdHex) return s

          // Current version verified.
          if (s.version === version) {
            if (s.verifiedHelperIds.includes(helper.id)) return s
            return { ...s, verifiedHelperIds: [...s.verifiedHelperIds, helper.id] }
          }

          // Previous version verified.
          const pvIdx = s.previousVersions.findIndex(pv => pv.version === version)
          if (pvIdx === -1) return s
          if (s.previousVersions[pvIdx].verifiedHelperIds.includes(helper.id)) return s
          return {
            ...s,
            previousVersions: s.previousVersions.map((pv, i) =>
              i === pvIdx
                ? { ...pv, verifiedHelperIds: [...pv.verifiedHelperIds, helper.id] }
                : pv,
            ),
          }
        }),
      }
    }

    if (event.type === 'SecretsDiscovered' && event.channel_id && event.secrets) {
      const channelId = event.channel_id
      const helper = current.helpers.find(h => h.channelId === channelId)

      log({
        role: 'owner',
        flow: 'recovery',
        step: 'SecretsDiscovered',
        description: `Discovery complete for channel ${channelId}: ${event.secrets.length} secret(s)`,
        payload: { channelId, helperId: helper?.id, secretCount: event.secrets.length },
      })

      let discoverableSecrets = [...(current.discoverableSecrets ?? [])]

      for (const entry of event.secrets) {
        const secretIdHex = Array.from(entry.secret_id).map(b => b.toString(16).padStart(2, '0')).join('')
        // Parse label from description "{label}-{version}" — use the first version's description.
        const firstDesc = entry.versions[0]?.description ?? ''
        const lastDash = firstDesc.lastIndexOf('-')
        const label = lastDash > 0 ? firstDesc.slice(0, lastDash) : firstDesc

        const existing = discoverableSecrets.find(s => s.secretId === secretIdHex)
        if (existing) {
          // Merge: add helper to existing versions, add any new versions.
          const helperSharesByVersion = { ...existing.helperSharesByVersion }
          const existingVersionNums = new Set(existing.versions.map(v => v.version))
          const newVersions = [...existing.versions]

          for (const v of entry.versions) {
            if (!existingVersionNums.has(v.version)) {
              newVersions.push({ version: v.version, description: v.description })
            }
            const arr = helperSharesByVersion[v.version] ?? []
            if (helper && !arr.includes(helper.id)) {
              helperSharesByVersion[v.version] = [...arr, helper.id]
            }
          }

          discoverableSecrets = discoverableSecrets.map(s =>
            s.secretId === secretIdHex
              ? { ...s, versions: newVersions, helperSharesByVersion }
              : s,
          )
        } else {
          const helperSharesByVersion: Record<number, string[]> = {}
          for (const v of entry.versions) {
            helperSharesByVersion[v.version] = helper ? [helper.id] : []
          }
          discoverableSecrets.push({
            secretId: secretIdHex,
            label,
            versions: entry.versions.map(v => ({ version: v.version, description: v.description })),
            helperSharesByVersion,
          })
        }
      }

      return {
        ...current,
        discoverableSecrets,
        helpers: current.helpers.map(h =>
          h.channelId === channelId ? { ...h, discoveryComplete: true } : h,
        ),
      }
    }

    if (event.type === 'RecoveryShareReceived') {
      log({
        role: 'owner',
        flow: 'recovery',
        step: 'RecoveryShareReceived',
        description: `Share received from helper (${event.shares_received} total)`,
        payload: { channelId: event.channel_id, sharesReceived: event.shares_received },
      })

      const progress = current.recoveryProgress
      if (!progress) return current

      return {
        ...current,
        recoveryProgress: { ...progress, sharesReceived: event.shares_received },
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
        recoveryProgress: { ...progress, sharesReceived: event.shares_received, error: event.error },
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

  const pollInterval = (autoPairingIds.length > 0 || recoveryMode) ? 500 : 5000

  useEffect(() => {
    const id = setInterval(async () => {
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

      console.debug('[owner-poll] processing', messages.length, 'message(s)')

      const initial = sessionRef.current
      let updated = initial
      for (const { bytes } of messages) {
        let events: { type: string; channel_id?: string; version?: number; secret?: Uint8Array }[]
        try {
          events = Array.from(await protocol.process(bytes)) as typeof events
        } catch (err) {
          console.error('[owner-poll] process() failed:', err)
          continue
        }
        console.debug('[owner-poll] events:', events.map(e => e.type))
        for (const event of events) {
          try {
            updated = applyOwnerEvent(updated, event)
          } catch (err) {
            console.error('[owner-poll] applyOwnerEvent failed for', event.type, ':', err)
          }
        }
      }

      if (updated !== initial) {
        onUpdateRef.current(updated)
      }
    }, pollInterval)

    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId, pollInterval])

  // ── Backend session status polling ───────────────────────────────────────────
  // Syncs helper pairing status from the backend's helper_channels data.
  // This catches helper-initiated pairings that never produce an owner-side event.

  useEffect(() => {
    const id = setInterval(async () => {
      const current = sessionRef.current
      try {
        const resp = await apiGetSession(current.sessionId)
        let updated = current
        let changed = false

        for (const actor of resp.actors) {
          const helper = updated.helpers.find(h => h.id === actor.id)
          if (!helper) continue

          // Sync pairing status from helper_channels.
          // Skip in recovery mode — helpers are intentionally reset to 'available'
          // and should only become 'paired' through recovery pairing events.
          if (!recoveryModeRef.current && actor.channel_id && helper.connectionStatus !== 'paired') {
            changed = true
            updated = {
              ...updated,
              helpers: updated.helpers.map(h =>
                h.id === actor.id
                  ? { ...h, channelId: actor.channel_id!, connectionStatus: 'paired' as const }
                  : h,
              ),
            }
          }

          // Sync pending recovery association status — only while in recovery mode.
          if (!recoveryModeRef.current) continue
          const currentPending = helper.pendingRecoveryChannelId ?? null
          const newPending = actor.pending_recovery_channel_id ?? null
          if (currentPending !== newPending) {
            changed = true

            // Association just completed: pending cleared and helper now has a channel.
            // Update the helper's channelId to the new recovery channel and trigger discovery.
            const associationJustCompleted = currentPending && !newPending && actor.channel_id
            if (associationJustCompleted) {
              const recoveryChannelId = actor.channel_id!

              updated = {
                ...updated,
                helpers: updated.helpers.map(h =>
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
                protocol.requestDiscovery(BigInt(recoveryChannelId)).catch((err: unknown) => {
                  console.error('[recovery] requestDiscovery after association failed:', err)
                })
                log({
                  role: 'owner',
                  flow: 'recovery',
                  step: 'discovery_triggered',
                  description: `Channel association complete for helper ${actor.id} — requesting discovery on channel ${recoveryChannelId}`,
                  payload: { helperId: actor.id, channelId: recoveryChannelId },
                })
              }
            } else {
              updated = {
                ...updated,
                helpers: updated.helpers.map(h =>
                  h.id === actor.id
                    ? { ...h, pendingRecoveryChannelId: newPending ?? undefined }
                    : h,
                ),
              }
            }
          }
        }

        if (changed) {
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
    const protocol = ownerProtocolRef.current
    if (!protocol) throw new Error('Protocol not initialized')
    return protocol.createContact(null)
  }

  function getHelperFunctions(helperId: string) {
    return {
      createContact: async (): Promise<ContactMessage> => {
        const dto = await apiCreateHelperContact(session.sessionId, helperId)
        return dtoToContactMessage(dto)
      },
      startPairing: async (contact: ContactMessage): Promise<bigint> => {
        const dto = contactMessageToDto(contact)
        const resp = await apiStartHelperPairing(session.sessionId, helperId, dto)
        return BigInt(resp.channel_id)
      },
    }
  }

  async function ownerStartPairing(contact: ContactMessage): Promise<bigint> {
    const protocol = ownerProtocolRef.current
    if (!protocol) throw new Error('Protocol not initialized')
    return protocol.startPairing(SenderKind.OwnerNonRecovery, contact)
  }

  async function ownerProtectSecret(
    secretId: Uint8Array,
    secretData: Uint8Array,
    label: string,
    version: number,
    threshold: number,
    helperChannelIds: bigint[],
  ): Promise<void> {
    const protocol = ownerProtocolRef.current
    if (!protocol) throw new Error('Protocol not initialized')

    // Description follows the protocol convention: "{label}-{version}"
    const description = `${label}-${version}`
    await protocol.protectSecret(secretId, secretData, description, version, threshold, helperChannelIds, [])

    // Register pending shares so ShareConfirmed events can be correlated.
    const secretIdHex = Array.from(secretId).map(b => b.toString(16).padStart(2, '0')).join('')
    const share: PendingShare = { secretId: secretIdHex, secretIdBytes: secretId, label, version }
    for (const cid of helperChannelIds) {
      pendingSharesRef.current.set(cid.toString(), share)
    }

    // Add the protected secret to session state immediately (helperIds fills in as events arrive).
    const secretDataStr = new TextDecoder().decode(secretData)
    const selectedHelpers = session.helpers.filter(h => helperChannelIds.includes(BigInt(h.channelId)))
    onUpdate({
      ...session,
      protectedSecrets: [
        ...session.protectedSecrets,
        { secretId: secretIdHex, version, label, secretData: secretDataStr, helperIds: [], verifiedHelperIds: [], threshold, previousVersions: [] },
      ],
      helpers: session.helpers.map(h =>
        selectedHelpers.some(sh => sh.id === h.id)
          ? { ...h, secretShares: [...h.secretShares, { secretId: secretIdHex, version, label, status: 'pending' as const, verified: false }] }
          : h,
      ),
    })

    log({
      role: 'owner',
      flow: 'sharing',
      step: 'protect_secret',
      description: `Shares sent for "${label}" to ${helperChannelIds.length} helper(s)`,
      payload: {
        secretId: secretIdHex,
        version,
        threshold,
        channels: helperChannelIds.map(c => c.toString()),
      },
    })

    setActiveTab('secrets')
  }

  async function ownerVerifyShares(
    secretIdHex: string,
    version: number,
    selectedHelperIds: string[],
  ): Promise<void> {
    const protocol = ownerProtocolRef.current
    if (!protocol) throw new Error('Protocol not initialized')

    const current = sessionRef.current
    // Find by secretId only — version may refer to a previous version, not current.
    const secret = current.protectedSecrets.find(s => s.secretId === secretIdHex)
    if (!secret) throw new Error('Secret not found')

    // Only register pending verification entries for the selected helpers so that
    // ShareVerified events from helpers not chosen in this wizard run are ignored.
    // Note: protocol.verifyShares() broadcasts to all confirmed helpers (WASM API
    // limitation — per-helper targeting is not yet supported).
    const selectedHelpers = current.helpers.filter(
      h => secret.helperIds.includes(h.id) && h.channelId && selectedHelperIds.includes(h.id),
    )
    for (const helper of selectedHelpers) {
      pendingVerificationsRef.current.set(helper.channelId, { secretIdHex, version })
    }

    const secretIdBytes = Uint8Array.from(secretIdHex.match(/.{2}/g)!.map(b => parseInt(b, 16)))
    await protocol.verifyShares(secretIdBytes, version)

    log({
      role: 'owner',
      flow: 'verification',
      step: 'verify_shares',
      description: `Verification challenges sent for "${secret.label}" to ${selectedHelpers.length} helper(s)`,
      payload: { secretId: secretIdHex, version, helperCount: selectedHelpers.length, selectedHelperIds },
    })
  }

  async function ownerRenewSecret(
    secretIdHex: string,
    newSecretData: Uint8Array,
    keepList: number[],
    helperChannelIds: bigint[],
    threshold: number,
  ): Promise<void> {
    const protocol = ownerProtocolRef.current
    if (!protocol) throw new Error('Protocol not initialized')

    const current = sessionRef.current
    const existing = current.protectedSecrets.find(s => s.secretId === secretIdHex)
    if (!existing) throw new Error('Secret not found')

    const newVersion = existing.version + 1
    const description = `${existing.label}-${newVersion}`
    const secretIdBytes = Uint8Array.from(secretIdHex.match(/.{2}/g)!.map(b => parseInt(b, 16)))

    await protocol.protectSecret(secretIdBytes, newSecretData, description, newVersion, threshold, helperChannelIds, keepList)

    // Register pending shares for correlation with ShareConfirmed events.
    const pendingShare: PendingShare = { secretId: secretIdHex, secretIdBytes, label: existing.label, version: newVersion }
    for (const cid of helperChannelIds) {
      pendingSharesRef.current.set(cid.toString(), pendingShare)
    }

    // Build the new state: replace the ProtectedSecret entry with the new version.
    // The old secret data is intentionally dropped — only the latest value is kept locally.
    // Merge existing previous versions with the outgoing current version, then filter to
    // those still in the new keepList. Preserve verifiedHelperIds so past verification
    // results survive the renewal.
    const allPreviousVersions: PreviousVersion[] = [
      ...existing.previousVersions,
      { version: existing.version, verifiedHelperIds: existing.verifiedHelperIds },
    ]
    const retainedVersions = allPreviousVersions.filter(pv => keepList.includes(pv.version))

    const newEntry: ProtectedSecret = {
      secretId: secretIdHex,
      version: newVersion,
      label: existing.label,
      secretData: new TextDecoder().decode(newSecretData),
      helperIds: [],
      verifiedHelperIds: [],
      threshold,
      previousVersions: retainedVersions,
    }

    // Resolve the selected helpers from channel IDs for share ref updates.
    // Read a fresh snapshot after the async protectSecret call to avoid overwriting
    // state changes that arrived from polling during the await.
    const snapshot = sessionRef.current
    const selectedHelpers = snapshot.helpers.filter(
      h => h.channelId && helperChannelIds.includes(BigInt(h.channelId)),
    )

    onUpdate({
      ...snapshot,
      protectedSecrets: snapshot.protectedSecrets.map(s =>
        s.secretId === secretIdHex ? newEntry : s,
      ),
      helpers: snapshot.helpers.map(h =>
        selectedHelpers.some(sh => sh.id === h.id)
          ? {
              ...h,
              secretShares: [
                ...h.secretShares,
                { secretId: secretIdHex, version: newVersion, label: existing.label, status: 'pending' as const, verified: false },
              ],
            }
          : h,
      ),
    })

    log({
      role: 'owner',
      flow: 'sharing',
      step: 'renew_secret',
      description: `"${existing.label}" renewed from v${existing.version} to v${newVersion}`,
      payload: { secretId: secretIdHex, newVersion, keepList, retainedVersions: retainedVersions.map(pv => pv.version), channels: helperChannelIds.map(c => c.toString()) },
    })

    setActiveTab('secrets')
  }

  // ── Recovery protocol actions ────────────────────────────────────────────────

  async function ownerStartRecoveryPairing(contact: ContactMessage): Promise<bigint> {
    const protocol = ownerProtocolRef.current
    if (!protocol) throw new Error('Protocol not initialized')
    return protocol.startPairing(SenderKind.OwnerRecovery, contact)
  }

  async function ownerRequestDiscovery(channelId: bigint): Promise<void> {
    const protocol = ownerProtocolRef.current
    if (!protocol) throw new Error('Protocol not initialized')
    await protocol.requestDiscovery(channelId)

    log({
      role: 'owner',
      flow: 'recovery',
      step: 'request_discovery',
      description: `Discovery requested for channel ${channelId}`,
      payload: { channelId: channelId.toString() },
    })
  }

  async function ownerRecoverSecret(
    secretId: string,
    version: number,
    label: string,
    helperChannelIds: bigint[],
  ): Promise<void> {
    const protocol = ownerProtocolRef.current
    if (!protocol) throw new Error('Protocol not initialized')

    const secretIdBytes = Uint8Array.from(secretId.match(/.{2}/g)!.map(b => parseInt(b, 16)))
    pendingRecoveryRef.current = { secretId, version, label }
    onUpdate({
      ...session,
      recoveryProgress: { secretId, version, sharesReceived: 0, totalRequested: helperChannelIds.length, error: null },
    })
    await protocol.recoverSecret(secretIdBytes, version, helperChannelIds)

    log({
      role: 'owner',
      flow: 'recovery',
      step: 'recover_secret',
      description: `Recovery requested for "${label}" v${version} from ${helperChannelIds.length} helper(s)`,
      payload: { secretId, version, channels: helperChannelIds.map(c => c.toString()) },
    })
  }

  // ── Session mutation helpers ──────────────────────────────────────────────────

  function addPendingPairing(channelId: bigint, helperId?: string) {
    const pending: PendingPairing = { channelId, helperId }
    onUpdate({ ...session, pendingPairings: [...session.pendingPairings, pending] })
  }

  function handleTogglePair(helperId: string) {
    const helper = session.helpers.find(h => h.id === helperId)
    if (!helper) return
    const unpairing = helper.connectionStatus === 'paired'
    const updatedHelpers = session.helpers.map(h =>
      h.id !== helperId ? h : {
        ...h,
        connectionStatus: unpairing ? 'available' as const : 'paired' as const,
        secretShares: unpairing ? [] : h.secretShares,
      }
    )
    const updatedSecrets = unpairing
      ? session.protectedSecrets.map(s => ({ ...s, helperIds: s.helperIds.filter(id => id !== helperId) }))
      : session.protectedSecrets
    onUpdate({ ...session, helpers: updatedHelpers, protectedSecrets: updatedSecrets })
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  // Show a setup gate while auto-pairing is in progress.
  if (autoPairingIds.length > 0) {
    const pairedCount = autoPairingIds.filter(id =>
      session.helpers.some(h => h.id === id && h.connectionStatus === 'paired'),
    ).length
    const total = autoPairingIds.length

    return (
      <div className="session-setup-gate">
        <h2 className="setup-gate-title">Setting up session</h2>
        <p className="setup-gate-description">
          Pairing {total} helper{total > 1 ? 's' : ''}…
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
            const helper = session.helpers.find(h => h.id === id)
            const isPaired = helper?.connectionStatus === 'paired'
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
                <span className="share-progress-item-name">{helper?.name ?? id}</span>
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
        <SessionIdBadge id={session.sessionId} />

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
          {!recoveryMode && (
            <button className="primary" onClick={() => setProtectOpen(true)}>
              Protect Secret
            </button>
          )}
          <button
            className={`secondary ${recoveryMode ? 'recovery-active' : ''}`}
            onClick={() => {
              if (recoveryMode) {
                // Exiting recovery: restore pre-recovery helper state and clear recovery data.
                setRecoveryMode(false)
                setActiveTab('helpers')
                onUpdate({
                  ...session,
                  helpers: preRecoveryHelpersRef.current ?? session.helpers,
                  discoverableSecrets: [],
                  recoveredSecrets: [],
                  recoveryProgress: null,
                })
                preRecoveryHelpersRef.current = null
                // Clear backend pending associations so re-entering recovery starts fresh.
                apiClearPendingAssociations(session.sessionId).catch(() => {})
              } else {
                // Entering recovery: snapshot current helpers, then reset them to unpaired.
                preRecoveryHelpersRef.current = session.helpers
                setRecoveryMode(true)
                setActiveTab('recovery')
                onUpdate({
                  ...session,
                  helpers: session.helpers.map(h => ({
                    ...h,
                    connectionStatus: 'available' as const,
                    secretShares: [],
                    recoveryPaired: undefined,
                    discoveryComplete: undefined,
                  })),
                  discoverableSecrets: [],
                  recoveredSecrets: [],
                  recoveryProgress: null,
                })
              }
            }}
            title={recoveryMode ? 'Exit recovery mode' : 'Enter recovery mode'}
          >
            {recoveryMode ? 'Exit Recovery' : 'Recovery Mode'}
          </button>
          <button className="secondary leave-btn" onClick={onLeave} title="Return to session list">
            Leave
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
          label="Helper Contact QR Payload"
          placeholder="Paste the JSON payload from the helper's Share Contact QR code"
          onClose={() => setPairOpen(false)}
          onSuccess={() => setPairSuccessOpen(true)}
          onPairingRequestSent={(channelId, helperId) => addPendingPairing(channelId, helperId)}
          startPairing={recoveryMode ? ownerStartRecoveryPairing : ownerStartPairing}
        />
      )}

      {pairSuccessOpen && (
        <PairingSuccessModal onClose={() => setPairSuccessOpen(false)} />
      )}

      {protectOpen && (
        <ProtectSecretModal
          helpers={session.helpers}
          onClose={() => setProtectOpen(false)}
          onProtect={ownerProtectSecret}
        />
      )}

      <div className="session-layout">
        <div className="session-content">
          <div className="tab-bar" role="tablist">
            <button
              role="tab"
              className={`tab-btn ${activeTab === 'helpers' ? 'active' : ''}`}
              onClick={() => setActiveTab('helpers')}
              aria-selected={activeTab === 'helpers'}
            >
              Paired Helpers
              <span className="tab-count">{session.helpers.filter(h => h.connectionStatus === 'paired').length}</span>
            </button>
            <button
              role="tab"
              className={`tab-btn ${activeTab === 'secrets' ? 'active' : ''}`}
              onClick={() => setActiveTab('secrets')}
              aria-selected={activeTab === 'secrets'}
            >
              Protected Secrets
              <span className="tab-count">{session.protectedSecrets.length}</span>
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
            {activeTab === 'helpers' && (
              <PairedHelpersList helpers={session.helpers} onTogglePair={handleTogglePair} />
            )}
            {activeTab === 'secrets' && (
              <ProtectedSecretsList secrets={session.protectedSecrets} helpers={session.helpers} onVerify={ownerVerifyShares} onRenew={ownerRenewSecret} />
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

        <SessionHelperPanel
          helpers={session.helpers}
          sessionId={session.sessionId}
          ownerName={session.ownerName}
          onTogglePair={handleTogglePair}
          onPairingCreated={(channelId, helperId) => addPendingPairing(channelId, helperId)}
          onPairingRequestSent={(channelId, helperId) => addPendingPairing(channelId, helperId)}
          onSuccess={() => setPairSuccessOpen(true)}
          getHelperFunctions={getHelperFunctions}
        />
      </div>
    </div>
  )
}
