import { useState, useEffect, useRef } from 'react'
import './NewSessionWizard.css'
import type { OwnerSession } from './types'
import { apiCreateSession, apiGetSession, apiJoinSession } from './api'
import { useConsole } from './ConsoleContext'
import { loadLastSession, loadSessionById } from './sessionPersistence'
import {
  DEFAULT_AUTHENTICATION_METHOD,
  DEFAULT_AUTO_ACCEPT_UNPAIR_REQUESTS,
  DEFAULT_PROTOCOL_TIMEOUT_SECS,
  DEFAULT_UNPAIR_ACK,
  type AuthenticationMethod,
  type UnpairAck,
} from './config'
import { InfoTooltip } from './InfoTooltip'
import { faker } from '@faker-js/faker'

type Flow = 'create' | 'continue' | 'join' | 'joinRecovery'
type StepKey =
  | 'choice'
  | 'ownerName'
  | 'participantCount'
  | 'protocolSettings'
  | 'sessionId'
  | 'participantName'
  | 'joinPrePair'
  | 'claimActor'

/** Minimal view of an existing actor surfaced by the picker. Mirrors the
 *  fields the wizard renders; not a full BE DTO. */
interface ClaimableActor {
  id: string
  name: string
}

interface WizardData {
  ownerName: string
  participantCount: number
  prePairedCount: number
  minParticipants: number
  recommendedParticipants: number
  protocolTimeoutSecs: number
  authenticationMethod: AuthenticationMethod
  unpairAck: UnpairAck
  autoAcceptUnpairRequests: boolean
  sessionId: string
  participantName: string
  /** UUID of the existing owner actor to claim during recovery-join. */
  claimActorId: string
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
        <button
          className="secondary"
          onClick={() => onSelect('joinRecovery')}
          title="Join a session and start directly in recovery mode — empty state, ready to pair helpers and reconstruct."
        >
          Join in Recovery Mode
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

interface ToggleOption<T extends string> {
  value: T
  label: string
  /** Optional hint shown below the toggle when this option is the active one. */
  hint?: string
  /** When `true`, the option is rendered but cannot be selected (e.g. a
   *  feature that's not yet shipped). */
  disabled?: boolean
  /** Optional short tag (e.g. "Coming soon") rendered inline next to the
   *  label. Visually deemphasised. */
  badge?: string
  /** Native browser tooltip shown on hover — useful for disabled options
   *  where we want to explain *why* without burning UI space. */
  title?: string
}

/**
 * Compact segmented control for binary (or small N-way) string-valued
 * configuration. Renders as `[ optionA | optionB ]` with the selected option
 * highlighted. Exposed semantics mirror a native radiogroup so screen readers
 * announce it correctly.
 *
 * When the active option carries a `hint`, that hint is rendered as a single
 * line below the toggle — replacing the longer per-option descriptions that
 * the vertical radio layout used.
 */
function ToggleGroup<T extends string>({
  ariaLabel,
  value,
  options,
  onChange,
}: {
  ariaLabel: string
  value: T
  options: ReadonlyArray<ToggleOption<T>>
  onChange: (next: T) => void
}) {
  const activeHint = options.find(o => o.value === value)?.hint
  return (
    <>
      <div className="wizard-toggle-group" role="radiogroup" aria-label={ariaLabel}>
        {options.map(opt => {
          const selected = opt.value === value
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-disabled={opt.disabled || undefined}
              disabled={opt.disabled}
              title={opt.title}
              className="wizard-toggle-option"
              onClick={() => {
                if (selected || opt.disabled) return
                onChange(opt.value)
              }}
            >
              {opt.label}
              {opt.badge && (
                <span className="wizard-toggle-option__badge">{opt.badge}</span>
              )}
            </button>
          )
        })}
      </div>
      {activeHint && <p className="wizard-toggle-hint">{activeHint}</p>}
    </>
  )
}

function StepProtocolSettings({
  protocolTimeoutSecs,
  onChangeProtocolTimeoutSecs,
  authenticationMethod,
  onChangeAuthenticationMethod,
  unpairAck,
  onChangeUnpairAck,
  autoAcceptUnpairRequests,
  onChangeAutoAcceptUnpairRequests,
}: {
  protocolTimeoutSecs: number
  onChangeProtocolTimeoutSecs: (n: number) => void
  authenticationMethod: AuthenticationMethod
  onChangeAuthenticationMethod: (m: AuthenticationMethod) => void
  unpairAck: UnpairAck
  onChangeUnpairAck: (v: UnpairAck) => void
  autoAcceptUnpairRequests: boolean
  onChangeAutoAcceptUnpairRequests: (v: boolean) => void
}) {
  return (
    <div className="wizard-step">
      <h2>Session settings</h2>
      <p>Tune how this session behaves. Sensible defaults are pre-filled.</p>

      <div className="participant-count-section">
        <span className="participant-count-section-label">
          Protocol timeout (seconds)
          <InfoTooltip label="About protocol timeout">
            The single timeout used everywhere. The protocol uses it passively
            to ignore expired messages; the app uses it as the active deadline —
            if a peer doesn't respond within this window the operation fails and
            the UI recovers. Lower = snappier failures; higher = more tolerant
            of slow peers.
          </InfoTooltip>
        </span>
        <div className="participant-count-input">
          <button
            className="stepper"
            onClick={() => onChangeProtocolTimeoutSecs(Math.max(10, protocolTimeoutSecs - 30))}
            disabled={protocolTimeoutSecs <= 10}
            aria-label="Decrease protocol timeout"
          >
            −
          </button>
          <span className="count">{protocolTimeoutSecs}</span>
          <button
            className="stepper"
            onClick={() => onChangeProtocolTimeoutSecs(protocolTimeoutSecs + 30)}
            aria-label="Increase protocol timeout"
          >
            +
          </button>
        </div>
      </div>

      <div className="wizard-radio-section">
        <div className="wizard-row">
          <span className="wizard-row__label">Authentication method</span>
          <ToggleGroup<AuthenticationMethod>
            ariaLabel="Authentication method"
            value={authenticationMethod}
            onChange={onChangeAuthenticationMethod}
            options={[
              { value: 'user', label: 'User' },
              {
                value: 'application',
                label: 'Application',
                disabled: true,
                title: 'Coming soon',
              },
            ]}
          />
          <span className="wizard-row__spacer" />
          <InfoTooltip label="About authentication method">
            How the app decides that two pairing channels belong to the same
            user — an app-level concern, not part of the protocol.
            <ul>
              <li>
                <strong>User</strong> — the helper manually links channels when
                accepting a pairing request, so a recovering owner can re-pair
                and inherit its prior shares.
              </li>
              <li>
                <strong>Application</strong> <em>(not yet enabled)</em> — the
                app would supply identity automatically; reserved for a future
                release.
              </li>
            </ul>
          </InfoTooltip>
        </div>
      </div>

      <div
        className="wizard-section-group"
        role="group"
        aria-labelledby="unpair-flow-heading"
      >
        <h3 id="unpair-flow-heading" className="wizard-section-group__legend">
          Unpair flow
        </h3>

        <div className="wizard-row">
          <span className="wizard-row__label">Acknowledgement</span>
          <ToggleGroup<UnpairAck>
            ariaLabel="Unpair acknowledgement"
            value={unpairAck}
            onChange={onChangeUnpairAck}
            options={[
              { value: 'required', label: 'Required' },
              { value: 'not_required', label: 'Fire-and-forget' },
            ]}
          />
          <span className="wizard-row__spacer" />
          <InfoTooltip label="About unpair acknowledgement">
            Protocol-level: how the initiator of an unpair flow handles the
            peer's response. Echoed to every joiner so the whole session
            agrees.
            <ul>
              <li>
                <strong>Required</strong> — wait for the peer's acknowledgement
                before dropping local state (the initiator keeps state until
                ACK or until the protocol timeout fires).
              </li>
              <li>
                <strong>Fire-and-forget</strong> — drop local state
                immediately on <code>start(Unpair)</code>; ignore any later
                peer response.
              </li>
            </ul>
          </InfoTooltip>
        </div>

        <div className="wizard-row">
          <span className="wizard-row__label">Incoming requests</span>
          <ToggleGroup<'auto' | 'prompt'>
            ariaLabel="Incoming unpair requests"
            value={autoAcceptUnpairRequests ? 'auto' : 'prompt'}
            onChange={next => onChangeAutoAcceptUnpairRequests(next === 'auto')}
            options={[
              { value: 'auto', label: 'Auto-accept' },
              { value: 'prompt', label: 'Show modal' },
            ]}
          />
          <span className="wizard-row__spacer" />
          <InfoTooltip label="About incoming unpair handling">
            UI-only (not part of the protocol). Stored per session on this
            device only.
            <ul>
              <li>
                <strong>Auto-accept</strong> — quietly accept and let the
                channel disappear with a toast.
              </li>
              <li>
                <strong>Show modal</strong> — surface a confirmation dialog so
                the operator can accept or reject each request.
              </li>
            </ul>
          </InfoTooltip>
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

/**
 * Step where a recovering joiner picks an existing owner actor whose mailbox
 * the new tab will adopt. Two equivalent inputs are offered:
 *  - select from the loaded list of browser-based (`role === 'owner'`)
 *    actors in the session;
 *  - paste a UUID directly (matches the "in a real app, auth hands you the
 *    id" model and works when the picker doesn't surface the right entry).
 *
 * `selectedId` reflects whichever input was used last. Listing and paste
 * keep each other in sync — clicking a row fills the paste field, typing
 * a valid UUID highlights the matching row.
 */
function StepClaimActor({
  actors,
  selectedId,
  onChange,
  error,
}: {
  actors: ClaimableActor[]
  selectedId: string
  onChange: (id: string) => void
  error: string | null
}) {
  return (
    <div className="wizard-step">
      <h2>Recover as which owner?</h2>
      <p>
        Pick an existing owner from the session below, or paste their actor
        ID. After recovery your tab adopts that actor's mailbox so helpers'
        replies — verification, share retrieval, future protect rounds — keep
        flowing to the same transport URI they already know.
      </p>

      {actors.length === 0 ? (
        <p className="wizard-field-hint">
          No other owners found in this session. Paste an actor ID below if
          you have one.
        </p>
      ) : (
        <div
          className="link-channel-list"
          role="listbox"
          aria-label="Existing owners in this session"
        >
          {actors.map(a => {
            const isSelected = selectedId.trim() === a.id
            return (
              <button
                key={a.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`link-channel-option${isSelected ? ' link-channel-option--selected' : ''}`}
                onClick={() => onChange(a.id)}
              >
                <span className="link-channel-option__name">{a.name}</span>
                <span className="link-channel-option__meta">{a.id}</span>
              </button>
            )
          })}
        </div>
      )}

      <label className="wizard-field-label" style={{ marginTop: 16, display: 'block' }}>
        Or paste an actor ID
        <input
          className="full-input"
          type="text"
          placeholder="e.g. a1b2c3d4-…"
          value={selectedId}
          onChange={e => onChange(e.target.value)}
        />
      </label>

      {error && <p className="wizard-field-error">{error}</p>}
    </div>
  )
}

const FLOW_STEPS: Record<Flow, StepKey[]> = {
  create: ['ownerName', 'participantCount', 'protocolSettings'],
  continue: ['sessionId'],
  join: ['sessionId', 'participantName', 'joinPrePair'],
  // Recovery joiners pair helpers manually (one at a time, by linking against
  // their old channels), so the `joinPrePair` step doesn't apply here.
  // Instead they pick an existing owner actor to *claim* — that's whose
  // mailbox the new tab will adopt so helpers' replies arrive.
  joinRecovery: ['sessionId', 'claimActor'],
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
    protocolTimeoutSecs: DEFAULT_PROTOCOL_TIMEOUT_SECS,
    authenticationMethod: DEFAULT_AUTHENTICATION_METHOD,
    unpairAck: DEFAULT_UNPAIR_ACK,
    autoAcceptUnpairRequests: DEFAULT_AUTO_ACCEPT_UNPAIR_REQUESTS,
    sessionId: initialSessionId ?? '',
    participantName: `${faker.person.firstName()} ${faker.person.lastName()}`,
    claimActorId: '',
  })
  const [creating, setCreating] = useState(false)
  const [continueError, setContinueError] = useState<string | null>(null)
  const [joinParticipantCount, setJoinParticipantCount] = useState<number>(0)
  // Owner actors in the session, fetched when entering the recovery-join
  // flow. Empty if the lookup hasn't run yet or surfaced no owners — the
  // paste-UUID input is the fallback in either case.
  const [claimableActors, setClaimableActors] = useState<ClaimableActor[]>([])
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
        protocolTimeoutSecs: data.protocolTimeoutSecs,
        authenticationMethod: data.authenticationMethod,
        unpairAck: data.unpairAck,
        autoAcceptUnpairRequests: data.autoAcceptUnpairRequests,
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
        recoveryFailures: [],
        replicas: [],
        heldShares: [],
        mainChannels: [],
        config: {
          protocolTimeoutSecs: data.protocolTimeoutSecs,
          authenticationMethod: data.authenticationMethod,
          unpairAck: data.unpairAck,
          autoAcceptUnpairRequests: data.autoAcceptUnpairRequests,
        },
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
        recoveryFailures: [],
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
        mainChannels: [],
        config: {
          protocolTimeoutSecs: resp.protocol_timeout_secs,
          authenticationMethod: resp.authentication_method,
          unpairAck: resp.unpair_ack,
          autoAcceptUnpairRequests: resp.auto_accept_unpair_requests,
        },
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

  async function handleJoin(recovery: boolean = false) {
    setContinueError(null)
    const sessionId = data.sessionId.trim()
    const claimActorId = data.claimActorId.trim()
    // The claimed actor's display name is authoritative in recovery (the
    // user is *resuming* that identity, not creating a new one). For normal
    // join the wizard-entered name applies; `name` is sent to the backend
    // either way — it's ignored on the claim path.
    const name = recovery
      ? (claimableActors.find(a => a.id === claimActorId)?.name ?? 'recovering owner')
      : data.participantName.trim()

    if (!sessionId) return
    if (recovery) {
      if (!claimActorId) {
        setContinueError('Pick an actor to recover into, or paste an actor ID.')
        return
      }
    } else if (!name) {
      return
    }

    // Pre-pairing is meaningless in recovery — the helpers we want to pair
    // with are the *old* ones, and we'll pair manually with each to link
    // against pre-recovery channels.
    const prePairedCount = recovery
      ? undefined
      : (data.prePairedCount > 0 ? data.prePairedCount : undefined)

    setCreating(true)
    try {
      const resp = await apiJoinSession(
        sessionId,
        name,
        prePairedCount,
        recovery ? claimActorId : undefined,
      )

      const peerActors = resp.actors.filter(a => a.role === 'participant')
      const replicaActors = resp.actors.filter(a => a.role === 'replica')

      const session: OwnerSession = {
        sessionId: resp.session_id,
        ownerId: resp.actor.id,
        // In recovery (claim) mode the backend echoes the *existing* actor's
        // name regardless of what we sent — use it so the FE matches.
        ownerName: recovery ? resp.actor.name : name,
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
        prePairedCount,
        minParticipants: resp.min_participants,
        recommendedParticipants: resp.recommended_participants,
        recoveredSecrets: [],
        recoveryProgress: null,
        recoveryFailures: [],
        recoveryMode: recovery,
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
        mainChannels: [],
        config: {
          protocolTimeoutSecs: resp.protocol_timeout_secs,
          authenticationMethod: resp.authentication_method,
          unpairAck: resp.unpair_ack,
          autoAcceptUnpairRequests: resp.auto_accept_unpair_requests,
        },
      }

      log({
        role: 'owner',
        flow: 'session',
        step: recovery ? 'session_joined_recovery' : 'session_joined',
        description: recovery
          ? `Joined session ${sessionId} as "${name}" (recovery mode)`
          : `Joined session ${sessionId} as "${name}" (owner mode)`,
        payload: {
          sessionId,
          ownerId: resp.actor.id,
          participantCount: peerActors.length,
          recovery,
        },
      })

      onCreated(session)
    } catch (err) {
      setContinueError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  async function handleNext() {
    // The session-id lookahead matters for two flows:
    //  - regular `join`: needs the participant count to bound prePair.
    //  - `joinRecovery`: needs the existing owner actors for the claim picker.
    // Both call `apiGetSession`; we tease apart the data each one consumes.
    if (step === 'sessionId' && (flow === 'join' || flow === 'joinRecovery')) {
      const sessionId = data.sessionId.trim()
      if (!sessionId) return
      setContinueError(null)
      setCreating(true)
      try {
        const resp = await apiGetSession(sessionId)
        if (flow === 'join') {
          const count = resp.actors.filter(a => a.role === 'participant').length
          setJoinParticipantCount(count)
          if (data.prePairedCount > count) {
            setData(d => ({ ...d, prePairedCount: Math.min(d.prePairedCount, count) }))
          }
        } else {
          // joinRecovery: collect browser-based owners as claim candidates.
          const owners: ClaimableActor[] = resp.actors
            .filter(a => a.role === 'owner')
            .map(a => ({ id: a.id, name: a.name }))
          setClaimableActors(owners)
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
          : step === 'claimActor'
            ? data.claimActorId.trim().length > 0
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
        {step === 'protocolSettings' && (
          <StepProtocolSettings
            protocolTimeoutSecs={data.protocolTimeoutSecs}
            onChangeProtocolTimeoutSecs={n => setData(d => ({ ...d, protocolTimeoutSecs: n }))}
            authenticationMethod={data.authenticationMethod}
            onChangeAuthenticationMethod={m => setData(d => ({ ...d, authenticationMethod: m }))}
            unpairAck={data.unpairAck}
            onChangeUnpairAck={v => setData(d => ({ ...d, unpairAck: v }))}
            autoAcceptUnpairRequests={data.autoAcceptUnpairRequests}
            onChangeAutoAcceptUnpairRequests={v => setData(d => ({ ...d, autoAcceptUnpairRequests: v }))}
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
        {step === 'claimActor' && (
          <StepClaimActor
            actors={claimableActors}
            selectedId={data.claimActorId}
            onChange={v => { setData(d => ({ ...d, claimActorId: v })); setContinueError(null) }}
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
            ) : flow === 'join' ? (
              <button className="primary" onClick={() => handleJoin(false)} disabled={!canProceed || creating}>
                {creating ? 'Joining…' : 'Join'}
              </button>
            ) : flow === 'joinRecovery' ? (
              <button className="primary" onClick={() => handleJoin(true)} disabled={!canProceed || creating}>
                {creating ? 'Joining…' : 'Join (Recovery)'}
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
