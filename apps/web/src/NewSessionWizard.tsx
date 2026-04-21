import { useState, useEffect, useRef } from 'react'
import './NewSessionWizard.css'
import type { OwnerSession } from './types'
import { apiCreateSession, apiGetSession } from './api'
import { useConsole } from './ConsoleContext'
import { loadLastSession, loadSessionById } from './sessionPersistence'

// ── Types ────────────────────────────────────────────────────────────────────

type Flow = 'create' | 'continue'
type Role = 'owner' | 'helper'
type StepKey = 'choice' | 'role' | 'ownerName' | 'helperCount' | 'sessionId'

interface WizardData {
  role: Role
  ownerName: string
  helperCount: number
  prePairedCount: number
  sessionId: string
}

// ── Step components ──────────────────────────────────────────────────────────

function StepChoice({
  onSelect,
  onResumeLast,
  lastSession,
}: {
  onSelect: (flow: Flow) => void
  onResumeLast: () => void
  lastSession: OwnerSession | null
}) {
  return (
    <div className="wizard-step">
      <h2>Get started</h2>
      <p>Choose an option to continue.</p>

      {lastSession && (
        <div className="resume-card">
          <div className="resume-card-info">
            <span className="resume-card-label">Last session</span>
            <span className="resume-card-name">{lastSession.ownerName}</span>
            <code className="resume-card-id">{lastSession.sessionId.slice(0, 8)}…</code>
          </div>
          <button className="primary" onClick={onResumeLast}>
            Resume
          </button>
        </div>
      )}

      <div className="choice-buttons">
        <button className="primary" onClick={() => onSelect('create')}>
          Create Session
        </button>
        <button className="secondary" onClick={() => onSelect('continue')}>
          Continue by ID
        </button>
      </div>
    </div>
  )
}

function StepRole({
  value,
  onChange,
}: {
  value: Role
  onChange: (r: Role) => void
}) {
  return (
    <div className="wizard-step">
      <h2>What is your role?</h2>
      <p>Choose how you will participate in this session.</p>
      <div className="role-cards">
        <button
          className={`role-card ${value === 'owner' ? 'selected' : ''}`}
          onClick={() => onChange('owner')}
        >
          <span className="role-title">Owner</span>
          <span className="role-desc">You are protecting your own secret.</span>
        </button>
        <button
          className={`role-card ${value === 'helper' ? 'selected' : ''}`}
          onClick={() => onChange('helper')}
        >
          <span className="role-title">Helper</span>
          <span className="role-desc">You are helping someone else recover their secret.</span>
        </button>
      </div>
    </div>
  )
}

function StepOwnerName({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="wizard-step">
      <h2>Your name</h2>
      <p>Enter the name you'd like to use as the owner of this session.</p>
      <input
        className="full-input"
        type="text"
        placeholder="e.g. Alice"
        value={value}
        onChange={e => onChange(e.target.value)}
        autoFocus
      />
    </div>
  )
}

function StepHelperCount({
  helperCount,
  prePairedCount,
  onChangeHelperCount,
  onChangePrePairedCount,
  role,
}: {
  helperCount: number
  prePairedCount: number
  onChangeHelperCount: (n: number) => void
  onChangePrePairedCount: (n: number) => void
  role: Role
}) {
  return (
    <div className="wizard-step">
      <h2>{role === 'helper' ? 'How many additional helpers?' : 'How many helpers?'}</h2>
      <p>
        Helpers store encrypted shares of your secret. More helpers increases
        resilience.
      </p>

      <div className="helper-count-section">
        <span className="helper-count-section-label">Total helpers</span>
        <div className="helper-count-input">
          <button
            className="stepper"
            onClick={() => {
              const next = Math.max(1, helperCount - 1)
              onChangeHelperCount(next)
              if (prePairedCount > next) onChangePrePairedCount(next)
            }}
            disabled={helperCount <= 1}
            aria-label="Decrease total helpers"
          >
            −
          </button>
          <span className="count">{helperCount}</span>
          <button
            className="stepper"
            onClick={() => onChangeHelperCount(helperCount + 1)}
            aria-label="Increase total helpers"
          >
            +
          </button>
        </div>
      </div>

      {role === 'owner' && (
        <div className="helper-count-section">
          <span className="helper-count-section-label">
            Pre-pair locally{' '}
            <span className="helper-count-section-hint">(testing only — skips QR exchange)</span>
          </span>
          <div className="helper-count-input">
            <button
              className="stepper"
              onClick={() => onChangePrePairedCount(Math.max(0, prePairedCount - 1))}
              disabled={prePairedCount <= 0}
              aria-label="Decrease pre-paired helpers"
            >
              −
            </button>
            <span className="count">{prePairedCount}</span>
            <button
              className="stepper"
              onClick={() => onChangePrePairedCount(Math.min(helperCount, prePairedCount + 1))}
              disabled={prePairedCount >= helperCount}
              aria-label="Increase pre-paired helpers"
            >
              +
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function StepSessionId({
  value,
  onChange,
  error,
}: {
  value: string
  onChange: (v: string) => void
  error: string | null
}) {
  return (
    <div className="wizard-step">
      <h2>Enter session ID</h2>
      <p>Paste the full session ID to resume a previously saved session.</p>
      <input
        className="full-input"
        type="text"
        placeholder="Session ID"
        value={value}
        onChange={e => onChange(e.target.value)}
        autoFocus
      />
      {error && <p className="wizard-field-error">{error}</p>}
    </div>
  )
}

// ── Flow / steps config ──────────────────────────────────────────────────────

const FLOW_STEPS: Record<Flow, StepKey[]> = {
  create: ['role', 'ownerName', 'helperCount'],
  continue: ['sessionId'],
}

// ── Main wizard ──────────────────────────────────────────────────────────────

interface Props {
  onCreated: (session: OwnerSession) => void
  /** Pre-filled session ID from the URL — auto-triggers the "Continue by ID" flow. */
  initialSessionId?: string | null
}

export default function NewSessionWizard({ onCreated, initialSessionId }: Props) {
  const [flow, setFlow] = useState<Flow | null>(initialSessionId ? 'continue' : null)
  const [stepIndex, setStepIndex] = useState(0)
  const [data, setData] = useState<WizardData>({
    role: 'owner',
    ownerName: '',
    helperCount: 3,
    prePairedCount: 0,
    sessionId: initialSessionId ?? '',
  })
  const [creating, setCreating] = useState(false)
  const [continueError, setContinueError] = useState<string | null>(null)
  const { log } = useConsole()

  // Loaded once at mount — used to show the "Resume" shortcut on the choice screen.
  const [lastSession] = useState<OwnerSession | null>(() => loadLastSession())

  // When opened with a session ID from the URL, auto-submit.
  const didAutoSubmit = useRef(false)
  useEffect(() => {
    if (!initialSessionId || didAutoSubmit.current) return
    didAutoSubmit.current = true
    handleContinue()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const steps: StepKey[] = flow ? FLOW_STEPS[flow] : []
  const isFinal = flow !== null && stepIndex === steps.length - 1
  const step: StepKey = flow === null ? 'choice' : steps[stepIndex]

  function handleSelectFlow(selected: Flow) {
    setFlow(selected)
    setStepIndex(0)
  }

  function handleBack() {
    if (stepIndex > 0) {
      setStepIndex(i => i - 1)
    } else {
      setFlow(null)
    }
  }

  async function handleCreate() {
    setCreating(true)
    try {
      const resp = await apiCreateSession({
        ownerName: data.ownerName,
        additionalHelpers: data.helperCount,
      })

      const ownerActor = resp.actors.find(a => a.role === 'owner')!
      const ownerTransport = { protocol: ownerActor.transport.protocol, uri: ownerActor.transport.uri }
      const helperActors = resp.actors.filter(a => a.role === 'helper')

      const session: OwnerSession = {
        sessionId: resp.session_id,
        ownerId: ownerActor.id,
        ownerName: data.ownerName,
        transport: ownerTransport,
        helpers: helperActors.map(a => ({
          id: a.id,
          name: a.name,
          channelId: '',
          transport: { protocol: a.transport.protocol, uri: a.transport.uri },
          connectionStatus: 'available' as const,
          secretShares: [],
        })),
        protectedSecrets: [],
        pendingPairings: [],
        prePairedCount: data.prePairedCount > 0 ? data.prePairedCount : undefined,
        discoverableSecrets: [],
        recoveredSecrets: [],
        recoveryProgress: null,
      }

      log({
        role: 'owner',
        flow: 'session',
        step: 'session_created',
        description: `Session created with ${session.helpers.length} helper(s), ${data.prePairedCount} to auto-pair`,
        payload: {
          sessionId: session.sessionId,
          ownerName: session.ownerName,
          transport: session.transport,
          helpers: session.helpers.map(h => ({ id: h.id, name: h.name, transport: h.transport })),
        },
      })

      onCreated(session)
    } catch {
      setCreating(false)
    }
  }

  async function handleContinue() {
    setContinueError(null)
    const sessionId = data.sessionId.trim()

    // Try localStorage first — it preserves full FE state (paired helpers, secrets, etc.)
    const localSession = loadSessionById(sessionId)
    if (localSession) {
      onCreated(localSession)
      return
    }

    // Fall back to the BE — works cross-browser/device but starts with fresh FE state.
    setCreating(true)
    try {
      const resp = await apiGetSession(sessionId)
      const ownerActor = resp.actors.find(a => a.role === 'owner')
      if (!ownerActor) {
        setContinueError('Session has no owner actor.')
        return
      }

      const helperActors = resp.actors.filter(a => a.role === 'helper')
      const session: OwnerSession = {
        sessionId: resp.session_id,
        ownerId: ownerActor.id,
        ownerName: ownerActor.name,
        transport: { protocol: ownerActor.transport.protocol, uri: ownerActor.transport.uri },
        helpers: helperActors.map(a => ({
          id: a.id,
          name: a.name,
          channelId: a.channel_id ?? '',
          transport: { protocol: a.transport.protocol, uri: a.transport.uri },
          connectionStatus: a.channel_id ? 'paired' as const : 'available' as const,
          secretShares: [],
          pendingRecoveryChannelId: a.pending_recovery_channel_id,
        })),
        protectedSecrets: [],
        pendingPairings: [],
        discoverableSecrets: [],
        recoveredSecrets: [],
        recoveryProgress: null,
      }

      log({
        role: 'owner',
        flow: 'session',
        step: 'session_resumed',
        description: `Session resumed from server: ${sessionId}`,
        payload: { sessionId, helperCount: helperActors.length },
      })

      onCreated(session)
    } catch (err) {
      setContinueError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  const canProceed =
    step === 'sessionId'
      ? data.sessionId.trim().length > 0
      : step === 'ownerName'
        ? data.ownerName.trim().length > 0
        : true

  return (
    <div className="wizard">
      {flow !== null && (
        <div className="wizard-header">
          <button className="back-link" onClick={handleBack} disabled={creating}>
            ← Back
          </button>
          <div className="wizard-progress">
            {steps.map((_, i) => (
              <div
                key={i}
                className={`pip ${i === stepIndex ? 'active' : i < stepIndex ? 'done' : ''}`}
              />
            ))}
          </div>
          <span className="wizard-step-label">
            Step {stepIndex + 1} of {steps.length}
          </span>
        </div>
      )}

      <div className="wizard-body">
        {step === 'choice' && (
          <StepChoice
            onSelect={handleSelectFlow}
            onResumeLast={() => lastSession && onCreated(lastSession)}
            lastSession={lastSession}
          />
        )}
        {step === 'role' && (
          <StepRole
            value={data.role}
            onChange={r => setData(d => ({ ...d, role: r }))}
          />
        )}
        {step === 'ownerName' && (
          <StepOwnerName
            value={data.ownerName}
            onChange={v => setData(d => ({ ...d, ownerName: v }))}
          />
        )}
        {step === 'helperCount' && (
          <StepHelperCount
            helperCount={data.helperCount}
            prePairedCount={data.prePairedCount}
            onChangeHelperCount={n => setData(d => ({ ...d, helperCount: n }))}
            onChangePrePairedCount={n => setData(d => ({ ...d, prePairedCount: n }))}
            role={data.role}
          />
        )}
        {step === 'sessionId' && (
          <StepSessionId
            value={data.sessionId}
            onChange={v => { setData(d => ({ ...d, sessionId: v })); setContinueError(null) }}
            error={continueError}
          />
        )}
      </div>

      {flow !== null && (
        <div className="wizard-actions">
          {isFinal ? (
            flow === 'create' ? (
              <button className="primary" onClick={handleCreate} disabled={creating}>
                {creating ? 'Creating…' : 'Create'}
              </button>
            ) : (
              <button className="primary" onClick={handleContinue} disabled={!canProceed || creating}>
                {creating ? 'Loading…' : 'Continue'}
              </button>
            )
          ) : (
            <button
              className="primary"
              onClick={() => setStepIndex(i => i + 1)}
              disabled={!canProceed}
            >
              Next →
            </button>
          )}
        </div>
      )}
    </div>
  )
}
