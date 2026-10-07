// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState, useEffect } from 'react'
import { errorText } from './errorText'
import './SetupWizard.css'
import type { Vault, PairedParticipant, TransportProtocol } from './types'
import {
  apiGetActors,
  apiGetServerDefaults,
  apiRegisterOwner,
  type BEActorWithStatus,
} from './api'
import { effectiveDefaults } from './protocolDefaults'
import { useConsole } from './ConsoleContext'
import { FALLBACK_SERVER_DEFAULTS, type ServerDefaults } from './config'
import { StepVaultSettings, type NodeCheck } from './wizard/StepVaultSettings'
import { StepClaimActor, type ClaimableActor } from './wizard/StepClaimActor'
import {
  actorAppearsActive,
  isActorId,
  normalizeVaultName,
  ownerSettings,
  overridesFromEdits,
  prePairTarget,
  vaultNameError,
  type OwnerEdits,
} from './wizard/wizardForm'
import { parseWholeNumber, thresholdError } from './admin/defaultsValidation'
import { isDuplicateVaultName } from './vaultLabels'

type Flow = 'setup' | 'claim'
type StepKey = 'vaultName' | 'vaultSettings' | 'claimActor'

/**
 * The node as the wizard last found it: its own defaults, whether it answered,
 * and how many participants are online — or `checking` while the probe runs.
 */
type NodeProbe =
  | { status: 'checking' }
  | { status: 'done'; reachable: boolean; defaults: ServerDefaults; online: number | null }

/**
 * Shown when the backend could not be reached at mount.
 *
 * Nothing here is disabled: the server may come up at any moment, and blocking
 * the wizard would be a worse answer than warning about it. The point is that
 * the user learns now rather than after filling in three steps. Worded for
 * either way of running the node — from source or from the Docker image.
 */
function ServerUnreachableNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="wizard-offline-notice" role="alert">
      <p className="wizard-offline-notice__title">Can’t reach the DeRec server</p>
      <p className="wizard-offline-notice__body">
        Setting up needs the backend running. Start it (<code>cargo run</code> in{' '}
        <code>apps/backend</code>, or the Docker container), then retry.
      </p>
      <button className="secondary" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}

function StepVaultName({
  value,
  onChange,
  onSubmit,
  existingNames,
}: {
  value: string
  onChange: (v: string) => void
  /** Advance past this step — what Enter in the field does. */
  onSubmit: () => void
  /** Names of the vaults this browser already holds, to warn on a repeat. */
  existingNames: readonly string[]
}) {
  // Nothing is said about an empty field: the disabled Next says it, and an
  // error before anything was typed reads as a scolding.
  const error = value === '' ? null : vaultNameError(value)
  const duplicate = error === null && isDuplicateVaultName(value, existingNames)
  // A form, so Enter in the field submits the step the way it does in every
  // other form; the wizard's own Next button stays the visible control.
  return (
    <form
      className="wizard-step"
      onSubmit={e => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <h2>Your name</h2>
      <p>Enter the name you'd like to use as the owner on this device.</p>
      <input
        className="full-input"
        type="text"
        placeholder="e.g. Alice"
        value={value}
        onChange={e => onChange(e.target.value)}
        aria-label="Your name"
        aria-invalid={error !== null}
        aria-describedby={error || duplicate ? 'wizard-name-hint' : undefined}
        autoFocus
      />
      {error && (
        <p id="wizard-name-hint" className="wizard-field-error" role="alert">
          {error}
        </p>
      )}
      {duplicate && (
        <p id="wizard-name-hint" className="wizard-field-hint" role="status">
          A vault in this browser already has this name. It will work, but the vault
          list will tell them apart only by the start of their ids.
        </p>
      )}
    </form>
  )
}

/**
 * The node's owner actors as claim candidates, and when this browser read them.
 *
 * `readAt` is what "recently polled" is measured against: the list is only as
 * fresh as that read, and sampling the clock here — rather than during render —
 * keeps rendering pure.
 */
interface ClaimableSnapshot {
  actors: ClaimableActor[]
  readAt: number
}

const NO_CLAIMABLE: ClaimableSnapshot = { actors: [], readAt: 0 }

/** Owner actors on the node, as claim candidates, stamped with the read time. */
function claimableFrom(actors: readonly BEActorWithStatus[]): ClaimableSnapshot {
  return {
    actors: actors
      .filter(a => a.role === 'owner')
      .map(a => ({ id: a.id, name: a.name, lastPolledAt: a.last_polled_at ?? null })),
    readAt: Date.now(),
  }
}

const FLOW_STEPS: Record<Flow, StepKey[]> = {
  // Pool size, transport mix and protocol policy are the node's, not this
  // owner's: they are set in Settings and read from the effective defaults when
  // this wizard provisions. What is left is what an owner actually chooses.
  setup: ['vaultName', 'vaultSettings'],
  // A recovering owner pairs helpers manually, one at a time, by linking
  // against their old channels — so there is nothing to configure here beyond
  // which existing owner actor's mailbox this tab adopts.
  claim: ['claimActor'],
}

interface Props {
  /** Which flow this wizard runs — chosen on the vault list. */
  initialFlow: Flow
  /** Hand the new vault to the app. Returns false if another tab took it first. */
  onReady: (vault: Vault) => Promise<boolean>
  /** Back out of the first step, to the vault list. */
  onCancel: () => void
  /** Names of the vaults this browser already holds — a repeat is warned about. */
  existingVaultNames?: readonly string[]
}

/** Shown where the threshold a vault would be created with is unusable. */
function invalidThresholdMessage(threshold: number, reason: string): string {
  return (
    `The minimum in Settings (${Number.isNaN(threshold) ? 'empty' : threshold}) cannot ` +
    `protect a secret: ${reason.toLowerCase()}. Fix it under Settings first.`
  )
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

/**
 * Set up one new vault, or claim an existing owner actor as one.
 *
 * The list of saved vaults lives on the home screen now; this does one job.
 */
export default function SetupWizard({
  initialFlow,
  onReady,
  onCancel,
  existingVaultNames = [],
}: Props) {
  const flow = initialFlow
  const [stepIndex, setStepIndex] = useState(0)
  const [vaultName, setVaultName] = useState('')
  const [claimActorId, setClaimActorId] = useState('')
  // Only what the user changed — see `OwnerEdits` for why this is not a form
  // object seeded from the defaults.
  const [edits, setEdits] = useState<OwnerEdits>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [claimable, setClaimable] = useState<ClaimableSnapshot>(NO_CLAIMABLE)
  // Acknowledged that the chosen actor looks live elsewhere. Reset whenever
  // the choice changes: the acknowledgement was for that actor.
  const [confirmedActive, setConfirmedActive] = useState(false)
  const [loadingClaimable, setLoadingClaimable] = useState(flow === 'claim')
  // The threshold a claimed vault runs with, as typed — `null` until edited,
  // when the node's default stands in. The node does not record a vault's
  // threshold, so the person recovering has to confirm it.
  const [claimThresholdText, setClaimThresholdText] = useState<string | null>(null)
  const { log } = useConsole()

  const [probe, setProbe] = useState<NodeProbe>({ status: 'checking' })
  const [probeNonce, setProbeNonce] = useState(0)

  // First contact with the backend, doing three jobs.
  //
  // It fetches the node's defaults, which — with this browser's Settings
  // overrides on top — are what every value on the settings step starts from.
  // A developer running the Docker image with a mounted config should not
  // retype the same values each run.
  //
  // It records whether the server answered at all. This is the earliest point
  // at which "the backend is down" can be said out loud, and saying it here is
  // what stops the user filling in three steps before finding out.
  //
  // And it counts the participants online, the ceiling on pre-pairing. The
  // wizard no longer creates any, so this is a limit it must respect rather
  // than a number it can satisfy by provisioning more.
  useEffect(() => {
    let cancelled = false
    void probeServer()
    return () => {
      cancelled = true
    }

    async function probeServer() {
      const { defaults, reachable } = await apiGetServerDefaults()
      if (cancelled) return
      let online: number | null = null
      if (reachable) {
        try {
          online = onlineOf(await listPoolParticipants()).length
        } catch {
          // Unknown rather than wrong: pre-pairing is turned off rather than
          // offered against a ceiling that may not hold.
          online = null
        }
      }
      if (!cancelled) setProbe({ status: 'done', reachable, defaults, online })
    }
  }, [probeNonce])

  function retryProbe() {
    setProbe({ status: 'checking' })
    setProbeNonce(n => n + 1)
  }

  // The node's values with any Settings overrides on top, so the wizard and the
  // Settings pane cannot disagree about what a default is. The fallback stands
  // in only while the probe runs, and nothing on screen is editable meanwhile.
  const defaults = effectiveDefaults(
    probe.status === 'done' ? probe.defaults : FALLBACK_SERVER_DEFAULTS,
  )
  const settings = ownerSettings(defaults, edits)
  // A minimum saved in Settings before it was validated — or a node configured
  // with 1 — would create a vault the library refuses to start.
  const defaultThresholdError = thresholdError(defaults.minParticipants)
  const claimThreshold =
    claimThresholdText === null ? defaults.minParticipants : parseWholeNumber(claimThresholdText)
  const claimThresholdError = thresholdError(claimThreshold)
  const nodeCheck: NodeCheck =
    probe.status === 'done' ? { status: 'ready', online: probe.online } : { status: 'checking' }

  const steps: StepKey[] = FLOW_STEPS[flow]
  const isFinal = stepIndex === steps.length - 1
  const step: StepKey = steps[stepIndex]

  // Owners already registered on this server, as claim candidates.
  useEffect(() => {
    if (flow !== 'claim') return
    let cancelled = false
    apiGetActors()
      .then(actors => {
        if (cancelled) return
        setClaimable(claimableFrom(actors))
      })
      .catch(err => {
        if (!cancelled) setError(errorText(err))
      })
      .finally(() => {
        if (!cancelled) setLoadingClaimable(false)
      })
    return () => {
      cancelled = true
    }
  }, [flow])

  function handleBack() {
    setError(null)
    if (stepIndex > 0) setStepIndex(i => i - 1)
    else onCancel()
  }

  /**
   * Register this browser context as an owner against the pool the node
   * already runs.
   *
   * The pool belongs to the server, not to this owner: setting up reads it and
   * provisions nothing — growing it is an operator action under Participants.
   */
  async function handleSetup() {
    if (probe.status !== 'done') return
    // Shown on the step, which also holds the button disabled.
    if (defaultThresholdError) return
    const name = normalizeVaultName(vaultName)
    setBusy(true)
    setError(null)

    try {
      const ownerActor = await apiRegisterOwner(name)

      // Setting up an owner does not grow the pool. The pool belongs to the
      // node, and an owner asking for seven where an operator deliberately left
      // four would quietly undo that decision — which is what used to happen:
      // deleting three participants and creating an owner put them straight
      // back. This reads the pool; provisioning is an operator action, under
      // Participants.
      const provisioned = await listPoolParticipants()

      // What the stepper showed, then clamped against the pool as it is *now*:
      // an operator can delete or switch off a participant while the wizard is
      // open, and auto-pairing against one that is gone leaves the setup gate
      // waiting on a peer that will never answer. Clamping can only lower it.
      const shown = prePairTarget(settings.prePairedCount, probe.online ?? 0)
      const prePaired = prePairTarget(shown, onlineOf(provisioned).length)

      const vault: Vault = {
        id: ownerActor.id,
        name,
        secretId: ownerActor.secret_id,
        transport: {
          protocol: ownerActor.transport.protocol,
          uri: ownerActor.transport.uri,
        },
        participants: provisioned.map(a => toParticipant(a, '')),
        secretBag: null,
        pendingPairings: [],
        prePairedCount: prePaired > 0 ? prePaired : undefined,
        minParticipants: defaults.minParticipants,
        recommendedParticipants: defaults.recommendedParticipants,
        recoveredSecrets: [],
        recoveryProgress: null,
        recoveryFailures: [],
        heldShares: [],
        mainChannels: [],
        configOverrides: overridesFromEdits(edits, defaults),
      }

      log({
        role: 'owner',
        flow: 'setup',
        step: 'vault_created',
        description:
          `Set up against ${vault.participants.length} participant(s) already ` +
          `on this node, ${prePaired} to auto-pair` +
          (prePaired < shown ? ` (${shown} chosen; the rest went offline meanwhile)` : ''),
        payload: {
          vaultId: vault.id,
          vaultName: vault.name,
          transport: vault.transport,
          minParticipants: vault.minParticipants,
          configOverrides: vault.configOverrides,
          participants: vault.participants.map(h => ({
            id: h.id,
            name: h.name,
            transport: h.transport,
          })),
        },
      })

      if (!(await onReady(vault))) {
        // Only possible if another tab took the new owner's lock first; the
        // wizard must not sit on "Setting up…" for a vault that never opened.
        setError(`"${vault.name}" could not be opened — it is already open in another tab.`)
        setBusy(false)
      }
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
    const actorId = claimActorId.trim()
    if (!actorId) {
      setError('Pick an actor to recover into, or paste an actor ID.')
      return
    }
    if (!isActorId(actorId)) return
    if (claimThresholdError) return

    setBusy(true)
    setError(null)
    try {
      // Re-read just before claiming: the list may be minutes old, and the
      // question is whether another browser is draining this mailbox *now*.
      const fresh = claimableFrom(await apiGetActors())
      setClaimable(fresh)
      const target = fresh.actors.find(a => a.id === actorId)
      if (actorAppearsActive(target?.lastPolledAt, fresh.readAt) && !confirmedActive) {
        setError('This owner looks active in another browser. Confirm above to claim it anyway.')
        setBusy(false)
        return
      }

      // The claimed actor's display name is authoritative: the user is
      // *resuming* that identity, not creating one. `name` is sent anyway
      // because the request requires it, and is ignored on the claim path.
      const claimedName = target?.name
      const ownerActor = await apiRegisterOwner(claimedName ?? 'recovering owner', actorId)

      const actors = await apiGetActors()
      const peers = actors.filter(a => a.role === 'helper')

      const vault: Vault = {
        id: ownerActor.id,
        name: ownerActor.name,
        secretId: ownerActor.secret_id,
        transport: {
          protocol: ownerActor.transport.protocol,
          uri: ownerActor.transport.uri,
        },
        participants: peers.map(a => toParticipant(a, '')),
        secretBag: null,
        pendingPairings: [],
        // What the person confirmed, not the node's default: a vault set up
        // with 2 and claimed against a node defaulting to 3 read "0 of 3
        // required" for a secret two helpers could already rebuild.
        minParticipants: claimThreshold,
        recommendedParticipants: Math.max(defaults.recommendedParticipants, claimThreshold),
        recoveredSecrets: [],
        recoveryProgress: null,
        recoveryFailures: [],
        heldShares: [],
        mainChannels: [],
        // The claim flow has no settings step, so nothing was chosen to override.
        configOverrides: {},
      }

      log({
        role: 'owner',
        flow: 'setup',
        step: 'owner_claimed',
        description: `Claimed owner actor "${vault.name}" (recovery mode)`,
        payload: {
          vaultId: vault.id,
          participantCount: peers.length,
          minParticipants: vault.minParticipants,
        },
      })

      if (!(await onReady(vault))) {
        // The claimed actor is already driven by another tab in this browser.
        setError(`"${vault.name}" is already open in another tab.`)
        setBusy(false)
      }
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  const selectedClaimable = claimable.actors.find(a => a.id === claimActorId.trim())
  const claimActiveElsewhere = actorAppearsActive(selectedClaimable?.lastPolledAt, claimable.readAt)

  const canProceed =
    step === 'vaultName'
      ? vaultNameError(vaultName) === null
      : step === 'claimActor'
        ? isActorId(claimActorId) &&
          (!claimActiveElsewhere || confirmedActive) &&
          claimThresholdError === null
        : // Setup waits for the node's answer: until then neither the defaults
          // nor the pre-pair ceiling are known, and what it would use is not
          // what the step shows.
          probe.status === 'done' && defaultThresholdError === null

  return (
    <div className="wizard">
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

      <div className="wizard-body">
        {probe.status === 'done' && !probe.reachable && (
          <ServerUnreachableNotice onRetry={retryProbe} />
        )}
        {step === 'vaultName' && (
          <StepVaultName
            value={vaultName}
            onChange={setVaultName}
            onSubmit={() => {
              if (canProceed && !busy) setStepIndex(i => i + 1)
            }}
            existingNames={existingVaultNames}
          />
        )}
        {step === 'vaultSettings' && (
          <StepVaultSettings
            settings={settings}
            node={nodeCheck}
            onChangeProtocolTimeoutSecs={n => setEdits(e => ({ ...e, protocolTimeoutSecs: n }))}
            onChangePrePairedCount={n => setEdits(e => ({ ...e, prePairedCount: n }))}
          />
        )}
        {step === 'vaultSettings' && probe.status === 'done' && defaultThresholdError && (
          <p className="wizard-field-error" role="alert">
            {invalidThresholdMessage(defaults.minParticipants, defaultThresholdError)}
          </p>
        )}
        {step === 'claimActor' && (
          <StepClaimActor
            actors={claimable.actors}
            selectedId={claimActorId}
            onChange={v => {
              setClaimActorId(v)
              setConfirmedActive(false)
              setError(null)
            }}
            loading={loadingClaimable}
            error={error}
            activeElsewhere={claimActiveElsewhere}
            confirmedActive={confirmedActive}
            onConfirmActiveChange={setConfirmedActive}
            threshold={claimThresholdText ?? String(defaults.minParticipants)}
            thresholdError={claimThresholdError}
            onThresholdChange={setClaimThresholdText}
          />
        )}
      </div>

      <div className="wizard-actions">
        {isFinal ? (
          flow === 'setup' ? (
            <button className="primary" onClick={handleSetup} disabled={!canProceed || busy}>
              {busy ? 'Setting up…' : probe.status === 'checking' ? 'Checking the node…' : 'Set up'}
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

      {error && step !== 'claimActor' && <p className="wizard-field-error">{error}</p>}
    </div>
  )
}
