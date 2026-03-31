import { useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import './OwnerSessionPage.css'
import type { HelperConnectionStatus, OwnerSession, PairedHelper, ProtectedSecret, Transport } from './types'

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

// ── Small shared icons ────────────────────────────────────────────────────────

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
  selectedHelperIds: Set<string>
}

function ProtectSecretModal({
  helpers,
  onClose,
  onSubmit,
}: {
  helpers: PairedHelper[]
  onClose: () => void
  onSubmit: (secret: ProtectedSecret) => void
}) {
  const [form, setForm] = useState<ProtectSecretFormState>({
    label: '',
    data: '',
    selectedHelperIds: new Set(),
  })

  function toggleHelper(id: string) {
    setForm(prev => {
      const next = new Set(prev.selectedHelperIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { ...prev, selectedHelperIds: next }
    })
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.label.trim() || !form.data.trim()) return

    onSubmit({
      secretId: crypto.randomUUID(),
      version: 1,
      label: form.label.trim(),
      helperNames: helpers
        .filter(h => form.selectedHelperIds.has(h.id))
        .map(h => h.name),
    })
  }

  const canSubmit = form.label.trim().length > 0 && form.data.trim().length > 0

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Protect secret">
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">Protect Secret</h2>
          <ModalCloseButton onClose={onClose} />
        </div>

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
              autoFocus
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="ps-version">Version</label>
            <input
              id="ps-version"
              className="full-input"
              type="text"
              value="V1"
              disabled
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="ps-data">Secret Data</label>
            <SecretDataField
              value={form.data}
              onChange={data => setForm(f => ({ ...f, data }))}
            />
          </div>

          <div className="form-field">
            <span className="form-label">Helpers</span>
            {helpers.length === 0 ? (
              <p className="empty-hint">No helpers paired yet.</p>
            ) : (
              <ul className="helper-check-list" role="list">
                {helpers.map(h => (
                  <li key={h.id} className="helper-check-item">
                    <label className="helper-check-label">
                      <input
                        type="checkbox"
                        className="helper-checkbox"
                        checked={form.selectedHelperIds.has(h.id)}
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
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={!canSubmit}>
              Protect
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Share Contact modal ───────────────────────────────────────────────────────

function buildContactPayload(session: OwnerSession): string {
  const data = {
    sessionId: session.sessionId,
    ownerName: session.ownerName,
    transport: session.transport,
  }
  // Base64url-encode the JSON so the QR content is a compact, URL-safe string
  return btoa(JSON.stringify(data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
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

function ShareContactModal({ session, onClose }: { session: OwnerSession; onClose: () => void }) {
  const payload = buildContactPayload(session)

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Share contact">
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">Share Contact</h2>
          <ModalCloseButton onClose={onClose} />
        </div>

        <div className="modal-body">
          <div className="qr-wrapper">
            <QRCodeSVG value={payload} size={200} />
          </div>

          <div className="modal-section">
            <h3 className="sub-heading">Transport</h3>
            <TransportBlock transport={session.transport} />
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

// ── Shared key field ──────────────────────────────────────────────────────────

function SharedKeyField({ value }: { value: string }) {
  const [visible, setVisible] = useState(false)

  return (
    <div className="shared-key-field">
      <input
        className="key-input"
        type={visible ? 'text' : 'password'}
        value={value}
        readOnly
        aria-label="Shared key"
        spellCheck={false}
        autoComplete="off"
      />
      <button
        className="secondary reveal-btn"
        onClick={() => setVisible(v => !v)}
        aria-label={visible ? 'Hide shared key' : 'Reveal shared key'}
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  )
}

// Editable variant used in the Protect Secret form
function SecretDataField({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
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

// ── Verify button ────────────────────────────────────────────────────────────

type VerifyState = 'idle' | 'verifying' | 'success' | 'failed'

function VerifyButton() {
  const [state, setState] = useState<VerifyState>('idle')

  async function handleClick() {
    setState('verifying')
    // Mock verification — replace with real protocol call
    await new Promise<void>(resolve => setTimeout(resolve, 900))
    setState('success')
    setTimeout(() => setState('idle'), 2500)
  }

  return (
    <button
      className={`primary verify-btn verify-${state}`}
      onClick={handleClick}
      disabled={state === 'verifying'}
    >
      {state === 'idle'      && 'Verify'}
      {state === 'verifying' && 'Verifying…'}
      {state === 'success'   && '✓ Verified'}
      {state === 'failed'    && '✗ Failed'}
    </button>
  )
}

// ── Paired helper card (main tab) ─────────────────────────────────────────────

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
        <code className="channel-id" title={helper.channelId}>{helper.channelId}</code>
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
            <div className="field-row">
              <dt>Shared Key</dt>
              <dd><SharedKeyField value={helper.sharedKey} /></dd>
            </div>
          </dl>

          <div className="card-sub-section">
            <h4 className="sub-heading">Secret Shares</h4>
            {helper.secretShares.length === 0 ? (
              <p className="empty-hint">No secret shares yet.</p>
            ) : (
              <ul className="share-list" role="list">
                {helper.secretShares.map(share => (
                  <li key={`${share.secretId}-${share.version}`} className="share-item">
                    <span className="share-label">{share.label}</span>
                    <span className="version-tag">v{share.version}</span>
                    <VerifyButton />
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

// ── Protected secret card (main tab) ─────────────────────────────────────────

function ProtectedSecretCard({ secret }: { secret: ProtectedSecret }) {
  const [expanded, setExpanded] = useState(false)

  return (
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
          <div className="secret-id-row">
            <span className="meta-label">Secret ID</span>
            <code className="secret-id-value" title={secret.secretId}>
              {secret.secretId.slice(0, 12)}…
            </code>
          </div>

          <div className="card-sub-section">
            <h4 className="sub-heading">Helper Shares</h4>
            {secret.helperNames.length === 0 ? (
              <p className="empty-hint">No helpers hold a share yet.</p>
            ) : (
              <ul className="helper-tag-list" role="list">
                {secret.helperNames.map(name => (
                  <li key={name} className="helper-tag">{name}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="card-actions">
            <VerifyButton />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tab panels ────────────────────────────────────────────────────────────────

function PairedHelpersList({ helpers, onTogglePair }: { helpers: PairedHelper[]; onTogglePair: (id: string) => void }) {
  helpers = helpers.filter(h => h.connectionStatus === 'paired')
  if (helpers.length === 0) {
    return (
      <p className="tab-empty-state">
        No helpers paired yet. Share your Session ID with helpers so they can join.
      </p>
    )
  }
  return (
    <div className="card-list">
      {helpers.map(h => (
        <PairedHelperCard key={h.id} helper={h} onUnpair={() => onTogglePair(h.id)} />
      ))}
    </div>
  )
}

function ProtectedSecretsList({ secrets }: { secrets: ProtectedSecret[] }) {
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
        <ProtectedSecretCard key={`${s.secretId}-${s.version}`} secret={s} />
      ))}
    </div>
  )
}

// ── Side panel — expandable helper list ───────────────────────────────────────

function connectionStatusLabel(status: HelperConnectionStatus): string {
  switch (status) {
    case 'paired':    return 'Paired'
    case 'available': return 'Available'
    case 'offline':   return 'Offline'
  }
}

function SidePanelHelperItem({
  helper,
  onTogglePair,
}: {
  helper: PairedHelper
  onTogglePair: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const isPaired = helper.connectionStatus === 'paired'

  return (
    <li className="side-helper-item">
      <button
        className="side-helper-header"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
      >
        <span className={`helper-dot ${helper.connectionStatus}`} aria-hidden="true" />
        <span className="side-helper-name">{helper.name}</span>
        <span className={`status-tag ${helper.connectionStatus}`}>
          {connectionStatusLabel(helper.connectionStatus)}
        </span>
        <ChevronIcon expanded={expanded} />
      </button>

      {expanded && (
        <div className="side-helper-details">
          <div className="side-detail-row">
            <span className="side-detail-label">Channel</span>
            <code className="side-detail-code">{helper.channelId}</code>
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
          <button
            className={`pair-action-btn ${isPaired ? 'unpair' : 'pair'}`}
            onClick={() => onTogglePair(helper.id)}
          >
            {isPaired ? 'Unpair' : 'Pair'}
          </button>
        </div>
      )}
    </li>
  )
}

function SessionHelperPanel({
  helpers,
  onTogglePair,
}: {
  helpers: PairedHelper[]
  onTogglePair: (id: string) => void
}) {
  return (
    <aside className="side-panel" aria-label="Session helpers">
      <h3 className="panel-heading">Helpers</h3>
      <p className="panel-subtitle">
        {helpers.length} provisioned
      </p>
      <ul className="side-helper-list" role="list">
        {helpers.map(h => (
          <SidePanelHelperItem key={h.id} helper={h} onTogglePair={onTogglePair} />
        ))}
      </ul>
    </aside>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

type ActiveTab = 'helpers' | 'secrets'

interface Props {
  session: OwnerSession
  onUpdate: (updated: OwnerSession) => void
}

export default function OwnerSessionPage({ session, onUpdate }: Props) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('helpers')
  const [shareOpen, setShareOpen] = useState(false)
  const [protectOpen, setProtectOpen] = useState(false)

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
      ? session.protectedSecrets.map(s => ({
          ...s,
          helperNames: s.helperNames.filter(name => name !== helper.name),
        }))
      : session.protectedSecrets

    onUpdate({ ...session, helpers: updatedHelpers, protectedSecrets: updatedSecrets })
  }

  function handleProtectSubmit(secret: ProtectedSecret) {
    const shareRef = { secretId: secret.secretId, version: secret.version, label: secret.label }
    const updatedHelpers = session.helpers.map(h =>
      secret.helperNames.includes(h.name)
        ? { ...h, secretShares: [...h.secretShares, shareRef] }
        : h
    )
    onUpdate({
      ...session,
      helpers: updatedHelpers,
      protectedSecrets: [...session.protectedSecrets, secret],
    })
    setProtectOpen(false)
    setActiveTab('secrets')
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
          <button className="primary" onClick={() => setProtectOpen(true)}>
            Protect Secret
          </button>
        </div>
      </div>

      {shareOpen && (
        <ShareContactModal session={session} onClose={() => setShareOpen(false)} />
      )}
      {protectOpen && (
        <ProtectSecretModal
          helpers={session.helpers}
          onClose={() => setProtectOpen(false)}
          onSubmit={handleProtectSubmit}
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
          </div>

          <div className="tab-panel" role="tabpanel">
            {activeTab === 'helpers' && (
              <PairedHelpersList helpers={session.helpers} onTogglePair={handleTogglePair} />
            )}
            {activeTab === 'secrets' && (
              <ProtectedSecretsList secrets={session.protectedSecrets} />
            )}
          </div>
        </div>

        <SessionHelperPanel helpers={session.helpers} onTogglePair={handleTogglePair} />
      </div>
    </div>
  )
}
