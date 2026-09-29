import { useState, useEffect } from 'react'
import { errorText } from './errorText'
import './SetupWizard.css'
import type { Owner, PairedParticipant, TransportProtocol } from './types'
import {
  apiGetActors,
  apiGetServerDefaults,
  apiRegisterOwner,
  type BEActorWithStatus,
} from './api'
import { effectiveDefaults } from './protocolDefaults'
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
import type { TransportMix } from './transportMix'

type Flow = 'setup' | 'claim'
type StepKey = 'choice' | 'ownerName' | 'ownerSettings' | 'claimActor'

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
  /** Target composition of the shared helper pool by transport. */
  transports: TransportMix
  /** Whether the backend runs the gRPC ingress listener — gates the gRPC and
   *  Both counters rather than being sent anywhere itself. */
  grpcEnabled: boolean
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
    transports: defaults.grpcEnabled
      ? defaults.helperTransports
      : { http: defaults.participantCount, grpc: 0, both: 0 },
    grpcEnabled: defaults.grpcEnabled,
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
 * The settings that belong to this owner rather than to the node.
 *
 * Pool size, transport mix and protocol policy moved to Settings: an operator
 * decides those once for the node, and a real app would not put them in front
 * of someone creating an account. What is left is what genuinely varies per
 * owner — a timeout a service might enforce or a self-custody app might let the
 * user pick, and how many participants to pre-pair.
 *
 * Both start from the node's defaults, with any Settings override on top, and
 * can be changed here — so two owners on the same node can differ, which is the
 * point: one set up with two pre-paired participants and another with three.
 */
function StepOwnerSettings({
  protocolTimeoutSecs,
  onChangeProtocolTimeoutSecs,
  prePairedCount,
  onChangePrePairedCount,
  onlineParticipants,
}: {
  protocolTimeoutSecs: number
  onChangeProtocolTimeoutSecs: (n: number) => void
  prePairedCount: number
  onChangePrePairedCount: (n: number) => void
  /**
   * Participants on this node that are switched on, or `null` while unknown.
   *
   * The hard ceiling on pre-pairing. Setup no longer provisions, so asking for
   * more than this would mean auto-pairing against peers that do not exist or
   * cannot answer — the owner would sit at "0 of N paired" with nothing able to
   * resolve it.
   */
  onlineParticipants: number | null
}) {
  const ceiling = onlineParticipants ?? 0
  return (
    <div className="wizard-step">
      <h2>Your settings</h2>
      <p>
        These belong to this owner. Pool size and protocol policy are set for
        the whole node, under Settings.
      </p>

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

      <div className="participant-count-section">
        <span className="participant-count-section-label">
          Pre-pair locally
          <span className="participant-count-section-hint">
            {onlineParticipants === null
              ? 'Testing only — skips QR exchange. Checking the node…'
              : ceiling === 0
                ? 'No participants are online on this node — provision some under Participants.'
                : `Testing only — skips QR exchange. Up to ${ceiling} online.`}
          </span>
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
          <span className="count">{Math.min(prePairedCount, ceiling)}</span>
          <button
            className="stepper"
            // Capped at what is online. Setting up an owner provisions nothing,
            // so anything above this would auto-pair against peers that either
            // do not exist or are switched off, and the setup gate would never
            // clear.
            onClick={() => onChangePrePairedCount(Math.min(ceiling, prePairedCount + 1))}
            disabled={prePairedCount >= ceiling}
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
  // Pool size, transport mix and protocol policy are the node's, not this
  // owner's: they are set in Settings and read from the effective defaults when
  // this wizard provisions. What is left is what an owner actually chooses.
  setup: ['ownerName', 'ownerSettings'],
  // A recovering owner pairs helpers manually, one at a time, by linking
  // against their old channels — so there is nothing to configure here beyond
  // which existing owner actor's mailbox this tab adopts.
  claim: ['claimActor'],
}

interface Props {
  /** Hand an owner to the app. Returns false if another tab took it first. */
  onReady: (owner: Owner) => Promise<boolean>
}

/**
 * The participants this node runs, newest last.
 *
 * Browser-managed actors run their protocol in a page and are nobody's to pair
 * with from here, so the pool is the backend-run helpers — the same definition
 * the Participants pane uses.
 */
async function listPoolParticipants(): Promise<BEActorWithStatus[]> {
  const actors = await apiGetActors()
  return actors.filter(a => a.role === 'helper' && !a.browser_managed)
}

/** Those a new owner could actually reach: switched off is unreachable. */
function onlineOf(pool: readonly BEActorWithStatus[]): BEActorWithStatus[] {
  return pool.filter(a => !a.disabled)
}

/** Wire an actor DTO into the participant shape the owner state carries. */
function toParticipant(
  actor: {
    id: string
    name: string
    transport: { protocol: TransportProtocol; uri: string }
    transports?: { protocol: TransportProtocol; uri: string }[]
    disabled?: boolean
  },
  channelId: string,
): PairedParticipant {
  return {
    id: actor.id,
    name: actor.name,
    channelId,
    transport: { protocol: actor.transport.protocol, uri: actor.transport.uri },
    transports: actor.transports,
    connectionStatus: channelId ? 'paired' : 'available',
    // Carried through so auto-pairing skips it: the node drops messages for a
    // switched-off participant, so a handshake with one never completes.
    offline: actor.disabled ?? false,
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
  // Participants on this node that are switched on, or `null` until the probe
  // lands. The pre-pair ceiling; the wizard provisions nothing itself.
  const [onlineParticipants, setOnlineParticipants] = useState<number | null>(null)

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
      // The node's values with any Settings overrides on top, so the wizard and
      // the Settings pane cannot disagree about what a default is.
      setData(current =>
        current.ownerName ? current : initialData(effectiveDefaults(defaults)),
      )
      if (!reachable) return

      // How many participants a new owner could actually pre-pair with. The
      // wizard no longer creates any, so this is a ceiling it must respect
      // rather than a number it can satisfy by provisioning more.
      try {
        const pool = await listPoolParticipants()
        if (!cancelled) setOnlineParticipants(onlineOf(pool).length)
      } catch {
        // Unknown rather than wrong: leaving it null disables pre-pairing
        // instead of offering a ceiling that may not hold.
        if (!cancelled) setOnlineParticipants(null)
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
      setError(errorText(err))
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

    try {
      const ownerActor = await apiRegisterOwner(data.ownerName)

      // Setting up an owner does not grow the pool. The pool belongs to the
      // node, and an owner asking for seven where an operator deliberately left
      // four would quietly undo that decision — which is what used to happen:
      // deleting three participants and creating an owner put them straight
      // back. This reads the pool; provisioning is an operator action, under
      // Participants.
      const provisioned = await listPoolParticipants()

      // Clamped against the pool as it is *now*, not as the probe found it: an
      // operator can delete or switch off a participant while the wizard is
      // open, and auto-pairing against one that is gone leaves the setup gate
      // waiting on a peer that will never answer.
      const prePaired = Math.min(data.prePairedCount, onlineOf(provisioned).length)

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
        prePairedCount: prePaired > 0 ? prePaired : undefined,
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
          `Set up against ${owner.participants.length} participant(s) already ` +
          `on this node, ${prePaired} to auto-pair`,
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
      setError(errorText(err))
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
      const peers = actors.filter(a => a.role === 'helper')

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
      setError(errorText(err))
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
        {step === 'ownerSettings' && (
          <StepOwnerSettings
            protocolTimeoutSecs={data.protocolTimeoutSecs}
            onChangeProtocolTimeoutSecs={n => setData(d => ({ ...d, protocolTimeoutSecs: n }))}
            prePairedCount={data.prePairedCount}
            onChangePrePairedCount={n => setData(d => ({ ...d, prePairedCount: n }))}
            onlineParticipants={onlineParticipants}
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
