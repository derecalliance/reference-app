import { useState } from 'react'
import './NewSessionWizard.css'
import type { OwnerSession, PairedHelper, ProtectedSecret } from './types'

// ── Types ────────────────────────────────────────────────────────────────────

type Flow = 'create' | 'continue'
type Role = 'owner' | 'helper'
type StepKey = 'choice' | 'role' | 'ownerName' | 'helperCount' | 'sessionId'

interface WizardData {
  role: Role
  ownerName: string
  helperCount: number
  sessionId: string
}

// ── Mock API ─────────────────────────────────────────────────────────────────

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

async function mockCreateSession(ownerName: string, helperCount: number): Promise<OwnerSession> {
  await new Promise<void>(resolve => setTimeout(resolve, 500))

  const seedSecretId = crypto.randomUUID()

  // All provisioned helpers are auto-paired. Seed the first one with a secret share.
  const helpers: PairedHelper[] = Array.from({ length: helperCount }, (_, i) => ({
    id: crypto.randomUUID(),
    name: i === 0 ? 'Demo Helper' : `Helper ${i + 1}`,
    channelId: randomHex(8),
    transport: {
      protocol: 'https' as const,
      uri: `https://helper-${i + 1}.example.com/derec`,
    },
    sharedKey: randomHex(16),
    connectionStatus: 'paired' as const,
    secretShares: i === 0
      ? [{ secretId: seedSecretId, version: 1, label: 'Metamask Wallet V1' }]
      : [],
  }))

  const protectedSecrets: ProtectedSecret[] = [
    {
      secretId: seedSecretId,
      version: 1,
      label: 'Metamask Wallet V1',
      helperNames: ['Demo Helper'],
    },
  ]

  return {
    sessionId: crypto.randomUUID(),
    ownerName,
    transport: {
      protocol: 'https' as const,
      uri: 'https://owner.example.com/derec',
    },
    helpers,
    protectedSecrets,
  }
}

// ── Step components ──────────────────────────────────────────────────────────

function StepChoice({ onSelect }: { onSelect: (flow: Flow) => void }) {
  return (
    <div className="wizard-step">
      <h2>Get started</h2>
      <p>Choose an option to continue.</p>
      <div className="choice-buttons">
        <button className="primary" onClick={() => onSelect('create')}>
          Create Session
        </button>
        <button className="secondary" onClick={() => onSelect('continue')}>
          Continue Session
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
  value,
  onChange,
  role,
}: {
  value: number
  onChange: (n: number) => void
  role: Role
}) {
  return (
    <div className="wizard-step">
      <h2>{role === 'helper' ? 'How many additional helpers?' : 'How many helpers?'}</h2>
      <p>
        Helpers store encrypted shares of your secret. More helpers increases
        resilience.
      </p>
      <div className="helper-count-input">
        <button
          className="stepper"
          onClick={() => onChange(Math.max(1, value - 1))}
          aria-label="Decrease"
        >
          −
        </button>
        <span className="count">{value}</span>
        <button
          className="stepper"
          onClick={() => onChange(value + 1)}
          aria-label="Increase"
        >
          +
        </button>
      </div>
    </div>
  )
}

function StepSessionId({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="wizard-step">
      <h2>Enter session ID</h2>
      <p>Paste the session ID you received to resume your session.</p>
      <input
        className="full-input"
        type="text"
        placeholder="Session ID"
        value={value}
        onChange={e => onChange(e.target.value)}
        autoFocus
      />
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
}

export default function NewSessionWizard({ onCreated }: Props) {
  const [flow, setFlow] = useState<Flow | null>(null)
  const [stepIndex, setStepIndex] = useState(0)
  const [data, setData] = useState<WizardData>({
    role: 'owner',
    ownerName: '',
    helperCount: 3,
    sessionId: '',
  })
  const [creating, setCreating] = useState(false)

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
      const session = await mockCreateSession(data.ownerName, data.helperCount)
      onCreated(session)
    } catch {
      setCreating(false)
    }
  }

  function handleContinue() {
    // TODO: implement session resume
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
        {step === 'choice' && <StepChoice onSelect={handleSelectFlow} />}
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
            value={data.helperCount}
            onChange={n => setData(d => ({ ...d, helperCount: n }))}
            role={data.role}
          />
        )}
        {step === 'sessionId' && (
          <StepSessionId
            value={data.sessionId}
            onChange={v => setData(d => ({ ...d, sessionId: v }))}
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
              <button className="primary" onClick={handleContinue} disabled={!canProceed}>
                Continue
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
