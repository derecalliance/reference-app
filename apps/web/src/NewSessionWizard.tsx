import { useState, useEffect, useRef } from 'react'
import './NewSessionWizard.css'
import type { OwnerSession } from './types'
import { apiCreateSession, apiGetSession, apiJoinSession } from './api'
import { useConsole } from './ConsoleContext'
import { loadLastSession, loadSessionById } from './sessionPersistence'
import { faker } from '@faker-js/faker'

type Flow = 'create' | 'continue' | 'join'
type StepKey = 'choice' | 'ownerName' | 'participantCount' | 'sessionId' | 'participantName' | 'joinPrePair'

interface WizardData {
  ownerName: string
  participantCount: number
  prePairedCount: number
  minParticipants: number
  recommendedParticipants: number
  sessionId: string
  participantName: string
}

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
        <button className="secondary" onClick={() => onSelect('join')}>
          Join Session
        </button>
        <button className="secondary" onClick={() => onSelect('continue')}>
          Continue by ID
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

function StepParticipantCount({
  participantCount,
  prePairedCount,
  minParticipants,
  recommendedParticipants,
  onChangeParticipantCount,
  onChangePrePairedCount,
  onChangeMinParticipants,
  onChangeRecommendedParticipants,
}: {
  participantCount: number
  prePairedCount: number
  minParticipants: number
  recommendedParticipants: number
  onChangeParticipantCount: (n: number) => void
  onChangePrePairedCount: (n: number) => void
  onChangeMinParticipants: (n: number) => void
  onChangeRecommendedParticipants: (n: number) => void
}) {
  return (
    <div className="wizard-step">
      <h2>How many participants?</h2>
      <p>
        Participants store encrypted shares of your secret. More participants increases
        resilience.
      </p>

      <div className="participant-count-section">
        <span className="participant-count-section-label">Total participants</span>
        <div className="participant-count-input">
          <button
            className="stepper"
            onClick={() => {
              const next = Math.max(1, participantCount - 1)
              onChangeParticipantCount(next)
              if (prePairedCount > next) onChangePrePairedCount(next)
              if (minParticipants > next) onChangeMinParticipants(next)
              if (recommendedParticipants > next) onChangeRecommendedParticipants(next)
            }}
            disabled={participantCount <= 1}
            aria-label="Decrease total participants"
          >
            −
          </button>
          <span className="count">{participantCount}</span>
          <button
            className="stepper"
            onClick={() => onChangeParticipantCount(participantCount + 1)}
            aria-label="Increase total participants"
          >
            +
          </button>
        </div>
      </div>

      <div className="participant-count-section">
        <span className="participant-count-section-label">
          Minimum paired to protect
          <span className="participant-count-section-hint">Secret protection disabled below this</span>
        </span>
        <div className="participant-count-input">
          <button
            className="stepper"
            onClick={() => {
              const next = Math.max(1, minParticipants - 1)
              onChangeMinParticipants(next)
            }}
            disabled={minParticipants <= 1}
            aria-label="Decrease minimum participants"
          >
            −
          </button>
          <span className="count">{minParticipants}</span>
          <button
            className="stepper"
            onClick={() => {
              const next = minParticipants + 1
              onChangeMinParticipants(next)
              if (recommendedParticipants < next) onChangeRecommendedParticipants(next)
            }}
            disabled={minParticipants >= participantCount}
            aria-label="Increase minimum participants"
          >
            +
          </button>
        </div>
      </div>

      <div className="participant-count-section">
        <span className="participant-count-section-label">
          Recommended paired
          <span className="participant-count-section-hint">Warning shown below this count</span>
        </span>
        <div className="participant-count-input">
          <button
            className="stepper"
            onClick={() => onChangeRecommendedParticipants(Math.max(minParticipants, recommendedParticipants - 1))}
            disabled={recommendedParticipants <= minParticipants}
            aria-label="Decrease recommended participants"
          >
            −
          </button>
          <span className="count">{recommendedParticipants}</span>
          <button
            className="stepper"
            onClick={() => onChangeRecommendedParticipants(recommendedParticipants + 1)}
            disabled={recommendedParticipants >= participantCount}
            aria-label="Increase recommended participants"
          >
            +
          </button>
        </div>
      </div>

      <div className="participant-count-section">
        <span className="participant-count-section-label">
          Pre-pair locally
          <span className="participant-count-section-hint">Testing only — skips QR exchange</span>
        </span>
        <div className="participant-count-input">
          <button
            className="stepper"
            onClick={() => onChangePrePairedCount(Math.max(0, prePairedCount - 1))}
            disabled={prePairedCount <= 0}
            aria-label="Decrease pre-paired participants"
          >
            −
          </button>
          <span className="count">{prePairedCount}</span>
          <button
            className="stepper"
            onClick={() => onChangePrePairedCount(Math.min(participantCount, prePairedCount + 1))}
            disabled={prePairedCount >= participantCount}
          >
            +
          </button>
        </div>
      </div>
    </div>
  )
}

function StepParticipantName({
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
      <h2>Your name</h2>
      <p>Enter the name other participants will see when you join.</p>
      <input
        className="full-input"
        type="text"
        placeholder="e.g. Bob"
        value={value}
        onChange={e => onChange(e.target.value)}
        autoFocus
      />
      {error && <p className="wizard-field-error">{error}</p>}
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

function StepJoinPrePair({
  prePairedCount,
  maxParticipants,
  onChangePrePairedCount,
}: {
  prePairedCount: number
  maxParticipants: number
  onChangePrePairedCount: (n: number) => void
}) {
  return (
    <div className="wizard-step">
      <h2>Pre-pair participants</h2>
      <p>
        The session has <strong>{maxParticipants}</strong> provisioned participant{maxParticipants !== 1 ? 's' : ''}.
        Choose how many to automatically pair with (testing shortcut — skips QR exchange).
      </p>

      <div className="participant-count-section">
        <span className="participant-count-section-label">
          Pre-pair locally
          <span className="participant-count-section-hint">Randomly selected from available participants</span>
        </span>
        <div className="participant-count-input">
          <button
            className="stepper"
            onClick={() => onChangePrePairedCount(Math.max(0, prePairedCount - 1))}
            disabled={prePairedCount <= 0}
            aria-label="Decrease pre-paired participants"
          >
            −
          </button>
          <span className="count">{prePairedCount}</span>
          <button
            className="stepper"
            onClick={() => onChangePrePairedCount(Math.min(maxParticipants, prePairedCount + 1))}
            disabled={prePairedCount >= maxParticipants}
            aria-label="Increase pre-paired participants"
          >
            +
          </button>
        </div>
      </div>
    </div>
  )
}

const FLOW_STEPS: Record<Flow, StepKey[]> = {
  create: ['ownerName', 'participantCount'],
  continue: ['sessionId'],
  join: ['sessionId', 'participantName', 'joinPrePair'],
}

interface Props {
  onCreated: (session: OwnerSession) => void
  initialSessionId?: string | null
  initialIntent?: 'continue' | 'join'
}

export default function NewSessionWizard({ onCreated, initialSessionId, initialIntent }: Props) {
  const [flow, setFlow] = useState<Flow | null>(() => {
    if (!initialSessionId) return null
    if (initialIntent === 'join') return 'join'
    return 'continue'
  })
  const [stepIndex, setStepIndex] = useState(() => {
    if (initialSessionId && initialIntent === 'join') return 1
    return 0
  })
  const [data, setData] = useState<WizardData>({
    ownerName: '',
    participantCount: 7,
    prePairedCount: 3,
    minParticipants: 3,
    recommendedParticipants: 5,
    sessionId: initialSessionId ?? '',
    participantName: `${faker.person.firstName()} ${faker.person.lastName()}`,
  })
  const [creating, setCreating] = useState(false)
  const [continueError, setContinueError] = useState<string | null>(null)
  const [joinParticipantCount, setJoinParticipantCount] = useState<number>(0)
  const { log } = useConsole()

  const [lastSession] = useState<OwnerSession | null>(() => loadLastSession())

  const didAutoSubmit = useRef(false)
  useEffect(() => {
    if (!initialSessionId || didAutoSubmit.current) return
    if (initialIntent !== 'continue') return
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
        additionalParticipants: data.participantCount,
        minParticipants: data.minParticipants,
        recommendedParticipants: data.recommendedParticipants,
      })

      const ownerActor = resp.actors.find(a => a.role === 'owner')!
      const ownerTransport = { protocol: ownerActor.transport.protocol, uri: ownerActor.transport.uri }
      const participantActors = resp.actors.filter(a => a.role === 'participant')

      const session: OwnerSession = {
        sessionId: resp.session_id,
        ownerId: ownerActor.id,
        ownerName: data.ownerName,
        transport: ownerTransport,
        participants: participantActors.map(a => ({
          id: a.id,
          name: a.name,
          channelId: '',
          transport: { protocol: a.transport.protocol, uri: a.transport.uri },
          connectionStatus: 'available' as const,
          secretShares: [],
        })),
        secretBag: null,
        pendingPairings: [],
        prePairedCount: data.prePairedCount > 0 ? data.prePairedCount : undefined,
        minParticipants: data.minParticipants,
        recommendedParticipants: data.recommendedParticipants,

        recoveredSecrets: [],
        recoveryProgress: null,
        replicas: [],
        heldShares: [],
        recoveryChannelLinks: [],
      }

      log({
        role: 'owner',
        flow: 'session',
        step: 'session_created',
        description: `Session created with ${session.participants.length} participant(s), ${data.prePairedCount} to auto-pair`,
        payload: {
          sessionId: session.sessionId,
          ownerName: session.ownerName,
          transport: session.transport,
          participants: session.participants.map(h => ({ id: h.id, name: h.name, transport: h.transport })),
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

    // localStorage preserves full FE state (paired participants, secrets, etc.);
    // falling back to the BE works cross-browser but starts with a fresh FE state.
    const localSession = loadSessionById(sessionId)
    if (localSession) {
      onCreated(localSession)
      return
    }

    setCreating(true)
    try {
      const resp = await apiGetSession(sessionId)
      const ownerActor = resp.actors.find(a => a.role === 'owner')
      if (!ownerActor) {
        setContinueError('Session has no owner actor.')
        return
      }

      const participantActors = resp.actors.filter(a => a.role === 'participant')
      const replicaActors = resp.actors.filter(a => a.role === 'replica')
      const session: OwnerSession = {
        sessionId: resp.session_id,
        ownerId: ownerActor.id,
        ownerName: ownerActor.name,
        transport: { protocol: ownerActor.transport.protocol, uri: ownerActor.transport.uri },
        participants: participantActors.map(a => ({
          id: a.id,
          name: a.name,
          channelId: a.channel_id ?? '',
          transport: { protocol: a.transport.protocol, uri: a.transport.uri },
          connectionStatus: a.channel_id ? 'paired' as const : 'available' as const,
          secretShares: [],
        })),
        secretBag: null,
        pendingPairings: [],
        minParticipants: resp.min_participants,
        recommendedParticipants: resp.recommended_participants,

        recoveredSecrets: [],
        recoveryProgress: null,
        replicas: replicaActors.map(a => ({
          id: a.id,
          name: a.name,
          channelId: a.channel_id ?? '',
          transport: { protocol: a.transport.protocol, uri: a.transport.uri },
          status: a.replica_confirmed ? 'confirmed' as const
            : a.channel_id ? 'paired' as const
            : 'available' as const,
          offline: a.disabled || undefined,
        })),
        heldShares: [],
        recoveryChannelLinks: [],
      }

      log({
        role: 'owner',
        flow: 'session',
        step: 'session_resumed',
        description: `Session resumed from server: ${sessionId}`,
        payload: { sessionId, participantCount: participantActors.length },
      })

      onCreated(session)
    } catch (err) {
      setContinueError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  async function handleJoin() {
    setContinueError(null)
    const sessionId = data.sessionId.trim()
    const name = data.participantName.trim()
    if (!sessionId || !name) return

    setCreating(true)
    try {
      const resp = await apiJoinSession(sessionId, name, data.prePairedCount > 0 ? data.prePairedCount : undefined)

      const peerActors = resp.actors.filter(a => a.role === 'participant')
      const replicaActors = resp.actors.filter(a => a.role === 'replica')

      const session: OwnerSession = {
        sessionId: resp.session_id,
        ownerId: resp.actor.id,
        ownerName: name,
        transport: { protocol: resp.actor.transport.protocol, uri: resp.actor.transport.uri },
        participants: peerActors.map(a => ({
          id: a.id,
          name: a.name,
          channelId: '',
          transport: { protocol: a.transport.protocol, uri: a.transport.uri },
          connectionStatus: 'available' as const,
          secretShares: [],
        })),
        secretBag: null,
        pendingPairings: [],
        prePairedCount: data.prePairedCount > 0 ? data.prePairedCount : undefined,
        minParticipants: resp.min_participants,
        recommendedParticipants: resp.recommended_participants,
        recoveredSecrets: [],
        recoveryProgress: null,
        replicas: replicaActors.map(a => ({
          id: a.id,
          name: a.name,
          channelId: a.channel_id ?? '',
          transport: { protocol: a.transport.protocol, uri: a.transport.uri },
          status: a.replica_confirmed ? 'confirmed' as const
            : a.channel_id ? 'paired' as const
            : 'available' as const,
          offline: a.disabled || undefined,
        })),
        heldShares: [],
        recoveryChannelLinks: [],
      }

      log({
        role: 'owner',
        flow: 'session',
        step: 'session_joined',
        description: `Joined session ${sessionId} as "${name}" (owner mode)`,
        payload: { sessionId, ownerId: resp.actor.id, participantCount: peerActors.length },
      })

      onCreated(session)
    } catch (err) {
      setContinueError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  async function handleNext() {
    if (flow === 'join' && step === 'sessionId') {
      const sessionId = data.sessionId.trim()
      if (!sessionId) return
      setContinueError(null)
      setCreating(true)
      try {
        const resp = await apiGetSession(sessionId)
        const count = resp.actors.filter(a => a.role === 'participant').length
        setJoinParticipantCount(count)
        if (data.prePairedCount > count) {
          setData(d => ({ ...d, prePairedCount: Math.min(d.prePairedCount, count) }))
        }
        setStepIndex(i => i + 1)
      } catch (err) {
        setContinueError(err instanceof Error ? err.message : String(err))
      } finally {
        setCreating(false)
      }
      return
    }
    setStepIndex(i => i + 1)
  }

  const canProceed =
    step === 'sessionId'
      ? data.sessionId.trim().length > 0
      : step === 'ownerName'
        ? data.ownerName.trim().length > 0
        : step === 'participantName'
          ? data.participantName.trim().length > 0
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
        {step === 'ownerName' && (
          <StepOwnerName
            value={data.ownerName}
            onChange={v => setData(d => ({ ...d, ownerName: v }))}
          />
        )}
        {step === 'participantCount' && (
          <StepParticipantCount
            participantCount={data.participantCount}
            prePairedCount={data.prePairedCount}
            minParticipants={data.minParticipants}
            recommendedParticipants={data.recommendedParticipants}
            onChangeParticipantCount={n => setData(d => ({ ...d, participantCount: n }))}
            onChangePrePairedCount={n => setData(d => ({ ...d, prePairedCount: n }))}
            onChangeMinParticipants={n => setData(d => ({ ...d, minParticipants: n }))}
            onChangeRecommendedParticipants={n => setData(d => ({ ...d, recommendedParticipants: n }))}
          />
        )}
        {step === 'sessionId' && (
          <StepSessionId
            value={data.sessionId}
            onChange={v => { setData(d => ({ ...d, sessionId: v })); setContinueError(null) }}
            error={continueError}
          />
        )}
        {step === 'participantName' && (
          <StepParticipantName
            value={data.participantName}
            onChange={v => { setData(d => ({ ...d, participantName: v })); setContinueError(null) }}
            error={continueError}
          />
        )}
        {step === 'joinPrePair' && (
          <StepJoinPrePair
            prePairedCount={data.prePairedCount}
            maxParticipants={joinParticipantCount}
            onChangePrePairedCount={n => setData(d => ({ ...d, prePairedCount: n }))}
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
            ) : flow === 'join' ? (
              <button className="primary" onClick={handleJoin} disabled={!canProceed || creating}>
                {creating ? 'Joining…' : 'Join'}
              </button>
            ) : (
              <button className="primary" onClick={handleContinue} disabled={!canProceed || creating}>
                {creating ? 'Loading…' : 'Continue'}
              </button>
            )
          ) : (
            <button
              className="primary"
              onClick={handleNext}
              disabled={!canProceed || creating}
            >
              {creating ? 'Validating…' : 'Next →'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
