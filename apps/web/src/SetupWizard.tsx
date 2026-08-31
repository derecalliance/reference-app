import { useState, useEffect } from 'react'
import './SetupWizard.css'
import type { Owner, PairedParticipant } from './types'
import {
  apiEnsureParticipants,
  apiGetActors,
  apiGetServerDefaults,
  apiRegisterOwner,
  type ProvisioningSettings,
} from './api'
import { useConsole } from './ConsoleContext'
import { listOwners, loadOwnerById, type OwnerSummary } from './ownerPersistence'
import { heldOwnerIds } from './ownerLock'
import {
  FALLBACK_SERVER_DEFAULTS,
  type AuthenticationMethod,
  type ServerDefaults,
  type UnpairAck,
} from './config'
import { InfoTooltip } from './InfoTooltip'
import { faker } from '@faker-js/faker'

type Flow = 'setup' | 'claim'
type StepKey = 'choice' | 'ownerName' | 'participantCount' | 'protocolSettings' | 'claimActor'

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
  /** UUID of the existing owner actor to adopt in the claim flow. */
  claimActorId: string
}

function initialData(defaults: ServerDefaults): WizardData {
  return {
    ownerName: '',
    participantCount: defaults.participantCount,
    prePairedCount: defaults.prePairedCount,
    minParticipants: defaults.minParticipants,
    recommendedParticipants: defaults.recommendedParticipants,
    protocolTimeoutSecs: defaults.protocolTimeoutSecs,
    authenticationMethod: defaults.authenticationMethod,
    unpairAck: defaults.unpairAck,
    autoAcceptUnpairRequests: defaults.autoAcceptUnpairRequests,
    claimActorId: '',
  }
}

/** One row of the saved-owner picker. */
function OwnerRow({
  owner,
  busy,
  onOpen,
}: {
  owner: OwnerSummary
  busy: boolean
  onOpen: () => void
}) {
  return (
    <tr className={`owner-table__row${busy ? ' owner-table__row--busy' : ''}`}>
      <td className="owner-table__name">{owner.ownerName}</td>
      <td>
        <code className="owner-table__id">{owner.ownerId.slice(0, 8)}…</code>
      </td>
      <td className="owner-table__paired">{owner.pairedCount}</td>
      <td className="owner-table__action">
        {busy ? (
          // Text, not just the dimmed row: state must not be carried by colour
          // alone. The note under the table explains why it cannot be opened.
          <span className="owner-table__status">In use</span>
        ) : (
          <button className="secondary" onClick={onOpen}>
            Open
          </button>
        )}
      </td>
    </tr>
  )
}

/**
 * Shown when the backend could not be reached at mount.
 *
 * Nothing here is disabled: the server may come up at any moment, and blocking
 * the wizard would be a worse answer than warning about it. The point is that
 * the user learns now rather than after filling in three steps.
 */
function ServerUnreachableNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="wizard-offline-notice" role="alert">
      <p className="wizard-offline-notice__title">Can’t reach the DeRec server</p>
      <p className="wizard-offline-notice__body">
        Setting up needs the backend running. Start it with{' '}
        <code>cargo run</code> in <code>apps/backend</code>, then retry.
      </p>
      <button className="secondary" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}

function StepChoice({
  onSelect,
  onOpenOwner,
  owners,
  busyOwnerIds,
  serverReachable,
  onRetryServer,
  error,
}: {
  onSelect: (flow: Flow) => void
  onOpenOwner: (ownerId: string) => void
  owners: OwnerSummary[]
  busyOwnerIds: ReadonlySet<string>
  serverReachable: boolean | null
  onRetryServer: () => void
  error: string | null
}) {
  const anyBusy = owners.some(o => busyOwnerIds.has(o.ownerId))

  return (
    <div className="wizard-step">
      <h2>Get started</h2>

      {serverReachable === false && <ServerUnreachableNotice onRetry={onRetryServer} />}
      <p>
        {owners.length === 0
          ? 'Set up an owner on this device to begin.'
          : 'Open one of the owners saved in this browser, or set up a new one.'}
      </p>

      {owners.length > 0 && (
        <>
          <div className="owner-table-scroll">
            <table className="owner-table">
              <caption className="visually-hidden">Owners saved in this browser</caption>
              <thead>
                <tr>
                  <th className="owner-table__th">Owner</th>
                  <th className="owner-table__th">ID</th>
                  <th className="owner-table__th owner-table__th--paired" scope="col">
                    Paired
                  </th>
                  <th className="owner-table__th owner-table__th--action" />
                </tr>
              </thead>
              <tbody>
                {owners.map(o => (
                  <OwnerRow
                    key={o.ownerId}
                    owner={o}
                    busy={busyOwnerIds.has(o.ownerId)}
                    onOpen={() => onOpenOwner(o.ownerId)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {anyBusy && (
            <p className="wizard-field-hint">
              An owner marked <strong>in use</strong> is open in another tab.
              Two tabs cannot drive one owner — they would share a mailbox and
              only the newer would keep receiving. Close the other tab to free it.
            </p>
          )}
        </>
      )}

      {error && <p className="wizard-field-error">{error}</p>}

      <div className="choice-buttons">
        <button className="primary" onClick={() => onSelect('setup')}>
          Set up a new owner
        </button>
        <button
          className="secondary"
          onClick={() => onSelect('claim')}
          title="Testing shortcut: adopt an existing owner actor's mailbox instead of registering a new one. Recovery itself does not need this — a recovering owner sets up normally and re-pairs."
        >
          Claim an existing actor
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
      <p>Enter the name you'd like to use as the owner on this device.</p>
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

/**
 * Explains what the requested total will actually do to the shared pool.
 *
 * The number is a target, not an order to create — so the honest thing to show
 * is how it lands against what other owners have already provisioned.
 */
function PoolEffect({ existing, wanted }: { existing: number | null; wanted: number }) {
  if (existing === null) return null

  const shortfall = Math.max(0, wanted - existing)
  const reused = Math.min(existing, wanted)

  if (existing === 0) {
    return (
      <p className="wizard-field-hint">
        No participants on this server yet — all {wanted} will be created.
      </p>
    )
  }
  if (shortfall === 0) {
    return (
      <p className="wizard-field-hint">
        {existing} already on this server, so you’ll pair with {reused} of them and
        none will be created.
      </p>
    )
  }
  return (
    <p className="wizard-field-hint">
      {existing} already on this server — {shortfall} more will be created.
    </p>
  )
}

function StepParticipantCount({
  participantCount,
  prePairedCount,
  minParticipants,
  recommendedParticipants,
  existingParticipants,
  onChangeParticipantCount,
  onChangePrePairedCount,
  onChangeMinParticipants,
  onChangeRecommendedParticipants,
}: {
  participantCount: number
  prePairedCount: number
  minParticipants: number
  recommendedParticipants: number
  /** Participants already on the server, or `null` while unknown. */
  existingParticipants: number | null
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
        resilience. They are shared by everyone on this server, so this is how many
        should exist — not how many to add.
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

      <PoolEffect existing={existingParticipants} wanted={participantCount} />

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
            aria-label="Increase pre-paired participants"
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
      <h2>Protocol settings</h2>
      <p>Tune how this device behaves. Defaults come from the server's configuration.</p>

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
            peer's response. Sent to the backend with each participant and
            replica this device provisions, so they agree.
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
            UI-only (not part of the protocol). Stored on this device only.
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

/**
 * Step where a recovering user picks an existing owner actor whose mailbox this
 * tab will adopt. Two equivalent inputs are offered:
 *  - select from the loaded list of `role === 'owner'` actors on the server;
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
  loading,
  error,
}: {
  actors: ClaimableActor[]
  selectedId: string
  onChange: (id: string) => void
  loading: boolean
  error: string | null
}) {
  return (
    <div className="wizard-step">
      <h2>Recover as which owner?</h2>
      <p>
        Pick an existing owner from the server below, or paste their actor ID.
        After recovery your tab adopts that actor's mailbox so helpers'
        replies — verification, share retrieval, future protect rounds — keep
        flowing to the same transport URI they already know.
      </p>

      {loading ? (
        <p className="wizard-field-hint">Loading owners…</p>
      ) : actors.length === 0 ? (
        <p className="wizard-field-hint">
          No other owners found on this server. Paste an actor ID below if you
          have one.
        </p>
      ) : (
        <div
          className="link-channel-list"
          role="listbox"
          aria-label="Existing owners on this server"
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
  setup: ['ownerName', 'participantCount', 'protocolSettings'],
  // A recovering owner pairs helpers manually, one at a time, by linking
  // against their old channels — so there is nothing to configure here beyond
  // which existing owner actor's mailbox this tab adopts.
  claim: ['claimActor'],
}

interface Props {
  /** Hand an owner to the app. Returns false if another tab took it first. */
  onReady: (owner: Owner) => Promise<boolean>
}

/** Wire an actor DTO into the participant shape the owner state carries. */
function toParticipant(
  actor: { id: string; name: string; transport: { protocol: 'https'; uri: string } },
  channelId: string,
): PairedParticipant {
  return {
    id: actor.id,
    name: actor.name,
    channelId,
    transport: { protocol: actor.transport.protocol, uri: actor.transport.uri },
    connectionStatus: channelId ? 'paired' : 'available',
    secretShares: [],
  }
}

export default function SetupWizard({ onReady }: Props) {
  const [flow, setFlow] = useState<Flow | null>(null)
  const [stepIndex, setStepIndex] = useState(0)
  const [data, setData] = useState<WizardData>(() => initialData(FALLBACK_SERVER_DEFAULTS))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [claimableActors, setClaimableActors] = useState<ClaimableActor[]>([])
  const [loadingClaimable, setLoadingClaimable] = useState(false)
  const { log } = useConsole()

  // `null` until the first probe lands, so the banner does not flash "offline"
  // on a perfectly healthy load.
  const [serverReachable, setServerReachable] = useState<boolean | null>(null)
  const [probeNonce, setProbeNonce] = useState(0)
  // Participants already on the server, so the count step can say what the
  // requested total will actually do. `null` until the probe lands.
  const [existingParticipants, setExistingParticipants] = useState<number | null>(null)

  const [owners, setOwners] = useState<OwnerSummary[]>(() => listOwners())
  const [busyOwnerIds, setBusyOwnerIds] = useState<ReadonlySet<string>>(() => new Set())

  // Which saved owners another tab currently holds.
  //
  // Polled rather than subscribed: a tab closing frees its owner with no event
  // to listen for, and a row left reading "open in another tab" after that
  // would be a dead end. Only while the list is actually on screen — once the
  // user is inside a flow there is nothing to label.
  const showingOwnerList = flow === null && owners.length > 0
  useEffect(() => {
    if (!showingOwnerList) return
    let cancelled = false
    const refresh = () => {
      void heldOwnerIds().then(ids => {
        if (!cancelled) setBusyOwnerIds(ids)
      })
    }
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [showingOwnerList])

  /** Open a saved owner, unless another tab claimed it in the meantime. */
  async function handleOpenOwner(ownerId: string) {
    setError(null)
    const stored = loadOwnerById(ownerId)
    if (!stored) {
      // Storage changed under us — drop the stale row rather than leaving a
      // button that does nothing.
      setOwners(listOwners())
      setError('That owner is no longer saved in this browser.')
      return
    }

    if (!(await onReady(stored))) {
      setBusyOwnerIds(await heldOwnerIds())
      setError(`"${stored.ownerName}" was just opened in another tab.`)
    }
  }

  // First contact with the backend, doing two jobs.
  //
  // It prefills the wizard from the operator-supplied defaults, so a developer
  // running the Docker image with a mounted config doesn't retype the same
  // values each run — applied only while the user is still on the choice
  // screen, since overwriting fields they have already touched would be worse
  // than a stale default.
  //
  // It also records whether the server answered at all. This is the earliest
  // point at which "the backend is down" can be said out loud, and saying it
  // here is what stops the user filling in three steps before finding out.
  useEffect(() => {
    let cancelled = false
    void probeServer()
    return () => {
      cancelled = true
    }

    async function probeServer() {
      const { defaults, reachable } = await apiGetServerDefaults()
      if (cancelled) return
      setServerReachable(reachable)
      setData(current => (current.ownerName ? current : initialData(defaults)))
      if (!reachable) {
        setExistingParticipants(null)
        return
      }
      try {
        const actors = await apiGetActors()
        if (!cancelled) {
          setExistingParticipants(actors.filter(a => a.role === 'participant').length)
        }
      } catch {
        // Only drives an explanatory line; leave it unknown rather than wrong.
        if (!cancelled) setExistingParticipants(null)
      }
    }
  }, [probeNonce])

  const steps: StepKey[] = flow ? FLOW_STEPS[flow] : []
  const isFinal = flow !== null && stepIndex === steps.length - 1
  const step: StepKey = flow === null ? 'choice' : steps[stepIndex]

  function handleSelectFlow(selected: Flow) {
    setFlow(selected)
    setStepIndex(0)
    setError(null)
    if (selected === 'claim') void loadClaimableActors()
  }

  /** Owners already registered on this server, as claim candidates. */
  async function loadClaimableActors() {
    setLoadingClaimable(true)
    try {
      const actors = await apiGetActors()
      setClaimableActors(
        actors.filter(a => a.role === 'owner').map(a => ({ id: a.id, name: a.name })),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingClaimable(false)
    }
  }

  function handleBack() {
    if (stepIndex > 0) {
      setStepIndex(i => i - 1)
    } else {
      setFlow(null)
    }
    setError(null)
  }

  function configFrom(d: WizardData) {
    return {
      protocolTimeoutSecs: d.protocolTimeoutSecs,
      authenticationMethod: d.authenticationMethod,
      unpairAck: d.unpairAck,
      autoAcceptUnpairRequests: d.autoAcceptUnpairRequests,
    }
  }

  /**
   * Register this browser context as an owner and make sure the shared
   * participant pool is big enough.
   *
   * The pool belongs to the server, not to this owner: a second owner asking
   * for seven when seven already exist pairs with those, and only a shortfall
   * is created. Names are offered as candidates — the server takes as many as
   * it ends up needing — so name generation stays with the rest of the app's
   * fixture data instead of being duplicated in the backend.
   */
  async function handleSetup() {
    setBusy(true)
    setError(null)
    const settings: ProvisioningSettings = {
      protocolTimeoutSecs: data.protocolTimeoutSecs,
      unpairAck: data.unpairAck,
    }

    try {
      const ownerActor = await apiRegisterOwner(data.ownerName)

      const candidateNames = Array.from(
        { length: data.participantCount },
        () => `${faker.person.firstName()} ${faker.person.lastName()}`,
      )
      const { participants: provisioned, created } = await apiEnsureParticipants(
        data.participantCount,
        candidateNames,
        settings,
      )

      const owner: Owner = {
        ownerId: ownerActor.id,
        ownerName: data.ownerName,
        ownSecretId: ownerActor.secret_id,
        transport: {
          protocol: ownerActor.transport.protocol,
          uri: ownerActor.transport.uri,
        },
        participants: provisioned.map(a => toParticipant(a, '')),
        secretBag: null,
        pendingPairings: [],
        prePairedCount: data.prePairedCount > 0 ? data.prePairedCount : undefined,
        minParticipants: data.minParticipants,
        recommendedParticipants: data.recommendedParticipants,
        recoveredSecrets: [],
        recoveryProgress: null,
        recoveryFailures: [],
        heldShares: [],
        mainChannels: [],
        config: configFrom(data),
      }

      log({
        role: 'owner',
        flow: 'setup',
        step: 'owner_registered',
        description:
          `Set up with ${owner.participants.length} participant(s) ` +
          `(${created} newly provisioned), ${data.prePairedCount} to auto-pair`,
        payload: {
          ownerId: owner.ownerId,
          ownerName: owner.ownerName,
          transport: owner.transport,
          participants: owner.participants.map(h => ({
            id: h.id,
            name: h.name,
            transport: h.transport,
          })),
        },
      })

      await onReady(owner)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  /**
   * Adopt an existing owner actor's mailbox instead of registering a new one.
   *
   * Pre-pairing is meaningless here — the helpers we want are the *old* ones,
   * and we pair with each manually to link against pre-recovery channels — so
   * the roster is seeded from whatever the server already has.
   */
  async function handleClaim() {
    const claimActorId = data.claimActorId.trim()
    if (!claimActorId) {
      setError('Pick an actor to recover into, or paste an actor ID.')
      return
    }

    setBusy(true)
    setError(null)
    try {
      // The claimed actor's display name is authoritative: the user is
      // *resuming* that identity, not creating one. `name` is sent anyway
      // because the request requires it, and is ignored on the claim path.
      const claimedName = claimableActors.find(a => a.id === claimActorId)?.name
      const ownerActor = await apiRegisterOwner(claimedName ?? 'recovering owner', claimActorId)

      const actors = await apiGetActors()
      const peers = actors.filter(a => a.role === 'participant')

      const owner: Owner = {
        ownerId: ownerActor.id,
        ownerName: ownerActor.name,
        ownSecretId: ownerActor.secret_id,
        transport: {
          protocol: ownerActor.transport.protocol,
          uri: ownerActor.transport.uri,
        },
        participants: peers.map(a => toParticipant(a, '')),
        secretBag: null,
        pendingPairings: [],
        minParticipants: data.minParticipants,
        recommendedParticipants: data.recommendedParticipants,
        recoveredSecrets: [],
        recoveryProgress: null,
        recoveryFailures: [],
        heldShares: [],
        mainChannels: [],
        config: configFrom(data),
      }

      log({
        role: 'owner',
        flow: 'setup',
        step: 'owner_claimed',
        description: `Claimed owner actor "${owner.ownerName}" (recovery mode)`,
        payload: {
          ownerId: owner.ownerId,
          participantCount: peers.length,
        },
      })

      if (!(await onReady(owner))) {
        // The claimed actor is already driven by another tab in this browser.
        setError(`"${owner.ownerName}" is already open in another tab.`)
        setBusy(false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const canProceed =
    step === 'ownerName'
      ? data.ownerName.trim().length > 0
      : step === 'claimActor'
        ? data.claimActorId.trim().length > 0
        : true

  return (
    <div className="wizard">
      {flow !== null && (
        <div className="wizard-header">
          <button className="back-link" onClick={handleBack} disabled={busy}>
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
            onOpenOwner={handleOpenOwner}
            owners={owners}
            busyOwnerIds={busyOwnerIds}
            serverReachable={serverReachable}
            onRetryServer={() => setProbeNonce(n => n + 1)}
            error={error}
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
            existingParticipants={existingParticipants}
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
        {step === 'claimActor' && (
          <StepClaimActor
            actors={claimableActors}
            selectedId={data.claimActorId}
            onChange={v => { setData(d => ({ ...d, claimActorId: v })); setError(null) }}
            loading={loadingClaimable}
            error={error}
          />
        )}
      </div>

      {flow !== null && (
        <div className="wizard-actions">
          {isFinal ? (
            flow === 'setup' ? (
              <button className="primary" onClick={handleSetup} disabled={!canProceed || busy}>
                {busy ? 'Setting up…' : 'Set up'}
              </button>
            ) : (
              <button className="primary" onClick={handleClaim} disabled={!canProceed || busy}>
                {busy ? 'Claiming…' : 'Claim'}
              </button>
            )
          ) : (
            <button
              className="primary"
              onClick={() => setStepIndex(i => i + 1)}
              disabled={!canProceed || busy}
            >
              Next →
            </button>
          )}
        </div>
      )}

      {error && step !== 'claimActor' && <p className="wizard-field-error">{error}</p>}
    </div>
  )
}
