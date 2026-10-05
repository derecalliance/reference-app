// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { copyText } from './clipboard'
import { useState } from 'react'
import { ModalFrame } from './ModalFrame'
import { reportError, reportInfo } from './toastBus'
import './ConsolePanel.css'
import { useConsole, type ConsoleEntry, type ConsoleFlow, type ConsoleRole } from './ConsoleContext'

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour12: false })
}

// ── Vault filter ──────────────────────────────────────────────────────────────

/**
 * Which entries the panel shows: every one, only those about one vault, or only
 * those about no vault — the node-wide `server` entries.
 *
 * Encoded as the `<select>` value. A vault is prefixed so no vault id can ever
 * collide with the two fixed choices.
 */
type VaultFilter = 'all' | 'node' | `vault:${string}`

function matchesVaultFilter(entry: ConsoleEntry, filter: VaultFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'node') return entry.vaultId === undefined
  return entry.vaultId === filter.slice('vault:'.length)
}

/** Every vault that has written to the log, in order of first appearance. */
function vaultIdsIn(entries: ConsoleEntry[]): string[] {
  const ids = new Set<string>()
  // Entries are newest-first; walk oldest-first so the list does not reorder
  // every time a vault logs.
  for (let i = entries.length - 1; i >= 0; i--) {
    const id = entries[i].vaultId
    if (id !== undefined) ids.add(id)
  }
  return [...ids]
}

/** Vault ids are opaque; a prefix is enough to tell a handful apart. */
function shortVaultId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

/**
 * How a vault is named in the filter: by the name the owner gave it, as the
 * vault list and switcher do. Its id is the fallback for a vault no longer in
 * this browser — its entries outlive it.
 */
function vaultOptionLabel(id: string, names: ReadonlyMap<string, string>): string {
  return names.get(id) ?? `Vault ${shortVaultId(id)}`
}

// ── Badges ────────────────────────────────────────────────────────────────────

const ROLE_LABEL: Record<ConsoleRole, string> = {
  owner: 'Owner',
  participant: 'Participant',
  server: 'Server',
}

const FLOW_LABEL: Record<ConsoleFlow, string> = {
  setup: 'Setup',
  pairing: 'Pairing',
  unpairing: 'Unpairing',
  sharing: 'Sharing',
  verification: 'Verification',
  discovery: 'Discovery',
  recovery: 'Recovery',
  protocol: 'Protocol',
  transport: 'Transport',
}

/**
 * The whole log as JSON, oldest first.
 *
 * Reversed because the panel shows newest-first for reading, but a log you
 * paste into a bug report or hand to an agent wants chronological order.
 */
function serializeLog(entries: ConsoleEntry[]): string {
  return JSON.stringify(
    [...entries].reverse().map(entry => ({
      timestamp: entry.timestamp.toISOString(),
      role: entry.role,
      flow: entry.flow,
      step: entry.step,
      description: entry.description,
      ...(entry.vaultId !== undefined ? { vaultId: entry.vaultId } : {}),
      ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
      ...(entry.response !== undefined ? { response: entry.response } : {}),
    })),
    null,
    2,
  )
}

/**
 * Copy `entries` and say whether it worked. A copy gives no visible sign of its
 * own, and on a LAN origin the clipboard API is missing altogether — so a
 * button that silently did nothing read as one that had worked.
 */
async function copyEntries(entries: ConsoleEntry[]): Promise<void> {
  const noun = entries.length === 1 ? 'entry' : 'entries'
  if (await copyText(serializeLog(entries))) {
    reportInfo(`Copied ${entries.length} log ${noun} as JSON`)
  } else {
    reportError(
      'Could not copy the log — this browser blocked clipboard access here. Use Download instead.',
    )
  }
}

function downloadEntries(entries: ConsoleEntry[]): void {
  const blob = new Blob([serializeLog(entries)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `derec-console-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  link.click()
  // The object URL pins the blob in memory until it is revoked, and a debug
  // session can produce a lot of these.
  URL.revokeObjectURL(url)
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
    void copyText(text).then(ok => {
      if (!ok) return
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
    <ModalFrame
      overlayClassName="cmodal-overlay"
      className="cmodal"
      labelledBy="cmodal-title"
      onEscape={onClose}
      onScrimClick={onClose}
    >
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
    </ModalFrame>
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
        ...(entry.vaultId !== undefined ? { vaultId: entry.vaultId } : {}),
        ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
        ...(entry.response !== undefined ? { response: entry.response } : {}),
      },
      null,
      2,
    )
    void copyText(text).then(ok => {
      if (!ok) return
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

export interface ConsolePanelProps {
  /** Vaults this browser holds, so the filter can name them. */
  vaults: ReadonlyArray<{ id: string; name: string }>
}

export default function ConsolePanel({ vaults }: ConsolePanelProps) {
  const { entries, clear } = useConsole()
  const [expanded, setExpanded] = useState(false)
  const [vaultFilter, setVaultFilter] = useState<VaultFilter>('all')

  const vaultIds = vaultIdsIn(entries)
  const vaultNames = new Map(vaults.map(v => [v.id, v.name]))
  const visible =
    vaultFilter === 'all' ? entries : entries.filter(e => matchesVaultFilter(e, vaultFilter))
  // Copy and Download take what the filter shows: narrowing to one vault and
  // then exporting it is the reason to filter. The labels say so whenever that
  // is not the whole log, so nobody files a partial log thinking it complete.
  const filtered = visible.length !== entries.length
  const exportScope = filtered ? `shown (${visible.length})` : 'all'

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
            <span className="console-count">
              {visible.length === entries.length ? entries.length : `${visible.length}/${entries.length}`}
            </span>
          )}
        </button>

        <div className="console-header-actions">
          {vaultIds.length > 0 && (
            <select
              className="console-filter"
              value={vaultFilter}
              onChange={e => setVaultFilter(e.target.value as VaultFilter)}
              aria-label="Show entries for"
              title="Show entries for"
            >
              <option value="all">All vaults</option>
              {vaultIds.map(id => (
                <option key={id} value={`vault:${id}`} title={id}>
                  {vaultOptionLabel(id, vaultNames)}
                </option>
              ))}
              <option value="node">Node only</option>
            </select>
          )}
          <button
            className="console-clear-btn"
            onClick={() => void copyEntries(visible)}
            disabled={visible.length === 0}
            aria-label={filtered ? `Copy the ${visible.length} entries shown as JSON` : 'Copy the whole log as JSON'}
            title={filtered ? 'Copy the entries the filter shows, as JSON' : 'Copy the whole log as JSON'}
          >
            Copy {exportScope}
          </button>
          <button
            className="console-clear-btn"
            onClick={() => downloadEntries(visible)}
            disabled={visible.length === 0}
            aria-label={filtered ? `Download the ${visible.length} entries shown as JSON` : 'Download the whole log as JSON'}
            title={filtered ? 'Download the entries the filter shows, as JSON' : 'Download the whole log as JSON'}
          >
            {filtered ? `Download ${exportScope}` : 'Download'}
          </button>
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
          {visible.length === 0 ? (
            <p className="console-empty">
              {entries.length === 0 ? 'No logs yet.' : 'No logs match this filter.'}
            </p>
          ) : (
            <div className="console-list" role="log" aria-live="polite">
              {visible.map(entry => (
                <EntryRow key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
