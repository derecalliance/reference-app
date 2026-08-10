import { useState } from 'react'
import './ConsolePanel.css'
import { useConsole, type ConsoleEntry, type ConsoleFlow, type ConsoleRole } from './ConsoleContext'

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour12: false })
}

// ── Badges ────────────────────────────────────────────────────────────────────

const ROLE_LABEL: Record<ConsoleRole, string> = {
  owner: 'Owner',
  participant: 'Participant',
}

const FLOW_LABEL: Record<ConsoleFlow, string> = {
  session: 'Session',
  pairing: 'Pairing',
  unpairing: 'Unpairing',
  sharing: 'Sharing',
  verification: 'Verification',
  discovery: 'Discovery',
  recovery: 'Recovery',
  replica: 'Replica',
  protocol: 'Protocol',
}

function RoleBadge({ role }: { role: ConsoleRole }) {
  return <span className={`cbadge role-${role}`}>{ROLE_LABEL[role]}</span>
}

function FlowBadge({ flow }: { flow: ConsoleFlow }) {
  return <span className={`cbadge flow-${flow}`}>{FLOW_LABEL[flow]}</span>
}

// ── Chevron ───────────────────────────────────────────────────────────────────

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`console-chevron ${expanded ? 'expanded' : ''}`}
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

// ── Log detail modal ──────────────────────────────────────────────────────────

function DetailSection({ title, data }: { title: string; data: unknown }) {
  const [copied, setCopied] = useState(false)
  const text = JSON.stringify(data, null, 2)

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="cmodal-section">
      <div className="cmodal-section-header">
        <span className="cmodal-section-title">{title}</span>
        <button
          className="console-icon-btn"
          onClick={handleCopy}
          aria-label={`Copy ${title}`}
          title={`Copy ${title}`}
        >
          {copied ? '✓' : '⎘'}
        </button>
      </div>
      <pre className="cmodal-section-content">{text}</pre>
    </div>
  )
}

function LogDetailModal({ entry, onClose }: { entry: ConsoleEntry; onClose: () => void }) {
  const hasContent = entry.payload !== undefined || entry.response !== undefined

  return (
    <div
      className="cmodal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cmodal-title"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="cmodal">
        <div className="cmodal-header">
          <div className="cmodal-header-meta">
            <RoleBadge role={entry.role} />
            <FlowBadge flow={entry.flow} />
            <code className="cmodal-step" id="cmodal-title">{entry.step}</code>
          </div>
          <button
            className="console-icon-btn cmodal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="cmodal-body">
          {!hasContent && (
            <p className="console-empty">No payload or response recorded.</p>
          )}
          {entry.payload !== undefined && (
            <DetailSection title="Payload" data={entry.payload} />
          )}
          {entry.response !== undefined && (
            <DetailSection title="Response" data={entry.response} />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Entry row ─────────────────────────────────────────────────────────────────

function EntryRow({ entry }: { entry: ConsoleEntry }) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const hasDetails = entry.payload !== undefined || entry.response !== undefined

  function handleCopy() {
    const text = JSON.stringify(
      {
        timestamp: entry.timestamp.toISOString(),
        role: entry.role,
        flow: entry.flow,
        step: entry.step,
        description: entry.description,
        ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
        ...(entry.response !== undefined ? { response: entry.response } : {}),
      },
      null,
      2,
    )
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="console-entry">
      <div className="console-row">
        <RoleBadge role={entry.role} />
        <FlowBadge flow={entry.flow} />
        <code className="console-step">{entry.step}</code>
        <span className="console-desc">{entry.description}</span>
        <span className="console-time">{formatTime(entry.timestamp)}</span>
        <div className="console-row-actions">
          <button
            className="console-icon-btn"
            onClick={handleCopy}
            aria-label="Copy log entry to clipboard"
            title="Copy entry"
          >
            {copied ? '✓' : '⎘'}
          </button>
          {hasDetails && (
            <button
              className="console-icon-btn"
              onClick={() => setDetailsOpen(true)}
              aria-label="View details"
              title="View details"
            >
              ↗
            </button>
          )}
        </div>
      </div>

      {detailsOpen && (
        <LogDetailModal entry={entry} onClose={() => setDetailsOpen(false)} />
      )}
    </div>
  )
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export default function ConsolePanel() {
  const { entries, clear } = useConsole()
  const [expanded, setExpanded] = useState(false)

  return (
    <div className={`console-panel ${expanded ? 'expanded' : 'collapsed'}`}>
      <div className="console-header">
        <button
          className="console-toggle"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse console' : 'Expand console'}
        >
          <Chevron expanded={expanded} />
          <span className="console-title">Console</span>
          {entries.length > 0 && (
            <span className="console-count">{entries.length}</span>
          )}
        </button>

        <div className="console-header-actions">
          <button
            className="console-clear-btn"
            onClick={clear}
            disabled={entries.length === 0}
            aria-label="Clear console"
          >
            Clear
          </button>
        </div>
      </div>

      {expanded && (
        <div className="console-body">
          {entries.length === 0 ? (
            <p className="console-empty">No logs yet.</p>
          ) : (
            <div className="console-list" role="log" aria-live="polite">
              {entries.map(entry => (
                <EntryRow key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
