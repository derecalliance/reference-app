// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import {
  ContactMode,
  FlowKind,
  type ContactMessage,
  type DeRecEvent,
  type DeRecProtocol,
} from '@derec-alliance/web'

import {
  apiCreateActorContact,
  apiGetActors,
  apiGetServerDefaults,
  apiPostBrowserContact,
  apiRenameOwner,
  apiToggleParticipantStatus,
  type BEActorWithStatus,
} from '../api'
import { selectAutoPairTargets } from '../autoPairSelection'
import { contactMessageToDto, dtoToContactMessage } from '../contactDto'
import { errorText } from '../errorText'
import {
  DEFAULT_CONTACT_MODE,
  humanNonce,
  toContactMode,
  type ContactModeKey,
} from '../contactModes'
import { NodeUnreachableError, fromBase64Url, pollMailbox, type MailboxMessage } from '../derecApi'
import type { PendingPairingConfirmation } from '../inboundPairing'
import { bagVersionOf, replicaGroupFromStore, updateBagVersion } from '../owner/bag'
import {
  asNonOkStatus,
  eventsOfFailedProcess,
  isUnknownChannelError,
  unknownChannelId,
} from '../owner/channelErrors'
import {
  buildProtocolInstance,
  PENDING_CHANNEL_TTL_SECS,
  PROTECT_ROUND_BACKSTOP_MS,
  TICK_INTERVAL_MS,
  pairingChannelIdFrom,
  protectVersionFrom,
  type ProtocolInstance,
} from '../owner/protocol'
import { removeRecoveryFailure, upsertRecoveryFailure } from '../owner/recoveryFailures'
import {
  describeVerifyFailure,
  restoredVersionReason,
  type VerifyDispatch,
} from '../owner/verification'
import { isShareTarget } from '../ownerPairing'
import { bagBytes, bagSizeProblem } from '../owner/secretLimits'
import { senderKindFor, type PairingRole } from '../pairingRoles'
import { resolveVaultConfig } from '../protocolDefaults'
import { loadReplicaAdoptionBlock, saveReplicaAdoptionBlock } from '../replicaAdoptionBlock'
import {
  automaticSyncNeedsAttention,
  createReplicaFirstSyncTrigger,
  forgetReplicaMember,
  hasAdoptionConsent,
  isReplicaChannelConfirmedLocally,
  loadReplicaState,
  markReplicaFirstSyncStarted,
  mergeReplicaSecretReceipt,
  removeReplicaMember,
  replicaSyncTargets,
  replicaViews,
  startReplicaDiscovery,
  type ManualReplicaSyncOutcome,
  type PendingReplicaAdoption,
  type ReplicaProtocol,
  type ReplicaSyncReason,
  type ReplicaSyncRoundResult,
  type ReplicaSyncTarget,
  type RestoreFailure,
  type UnresolvedAutomaticSync,
} from '../replicaFlows'
import { randomId } from '../randomId'
import {
  clearPendingReplicaOffer,
  loadPendingReplicaOffer,
  savePendingReplicaOffer,
} from '../replicaOfferStore'
import {
  STORAGE_FULL_MESSAGE,
  describeStorageFailure,
  explainDeliveryFailure,
  forgetHelperChannel,
  hasStorageHeadroom,
  listHelperChannels,
  listReplicaMembers,
  loadRawShare,
  readHelperChannelInfo,
  readHelperChannelStatus,
  takeStorageQuotaFailure,
  type KeepListSource,
} from '../stores'
import { getOrCreateReplicaId } from '../replicaIdentity'
import type {
  BagVersion,
  CorruptShareReport,
  PendingPairing,
  RecoveredSecret,
  SecretBag,
  UserSecret,
  Vault,
} from '../types'
import { foldEvent, type FoldContext } from './fold'
import { withoutChannel } from './fold/pairing'
import {
  endpointProblem,
  hasOutstandingPeers,
  identityUpdateFrom,
  undeliveredChannelIds,
  vaultNameProblem,
  withChannelOutcome,
  withExpiredWaits,
  withIdentityResend,
} from './identity'
import { adoptMirroredVault } from './commands/adoption'
import type { CommandContext } from './commands/context'
import { restoreVault } from './commands/restore'
import { routeActionRequired, type InboundContext } from './inbound'
import { keepListFor } from './keepList'
import { replicaConflictBlockReason } from './replicaConflict'
import { ReplicaCatchUp } from './replicaSync'
import { RoundTracker, settleUnansweredShares } from './rounds'
import type {
  Attention,
  AttentionKind,
  IdentityUpdate,
  ProtectRoundResult,
  StoreShareRequest,
  UnpairDispatch,
  UnpairRequest,
  VaultLogInput,
  VerifyShareRequest,
  VaultRuntimeDeps,
  VaultRuntimeIo,
  VaultRuntimeState,
  VaultStatus,
  VaultViewEffects,
} from './types'

/**
 * One vault's protocol engine, with no view attached.
 *
 * Owns the `DeRecProtocol` instance and the lock that serialises access to it.
 * Deliberately React-free: a runtime has to keep polling and processing while
 * its vault is off screen, so nothing here may depend on being rendered — and
 * being free of React is also what makes any of this unit-testable.
 *
 * The rule for what belongs here: **if it needs no DOM, it belongs to the
 * runtime.** Modal rendering, tabs, panels and dialog open/close stay in the
 * view.
 */
/** Poll cadence while a flow is in flight or auto-pairing. */
const POLL_FAST_MS = 500
/** Poll cadence while idle. */
const POLL_IDLE_MS = 5000

/** The status a person's refusal is reported to the counterparty with. */
const REJECTED_STATUS = 10

/** How each rejectable request is refused, logged and reported. */
const REJECTIONS: Record<
  Exclude<AttentionKind, 'replica-adoption'>,
  { memo: string; flow: VaultLogInput['flow']; step: string; verb: string; failure: string }
> = {
  pairing: {
    memo: 'Pairing request rejected by user',
    flow: 'pairing',
    step: 'pairing_rejected',
    verb: 'Rejected pairing request',
    failure: 'Failed to reject pairing request',
  },
  'store-share': {
    memo: 'Share storage rejected by user',
    flow: 'sharing',
    step: 'store_share_rejected',
    verb: 'Rejected share storage',
    failure: 'Failed to reject share-storage request',
  },
  'verify-share': {
    memo: 'Helper rejected the verification request',
    flow: 'verification',
    step: 'verify_share_rejected',
    verb: 'Rejected verification',
    failure: 'Failed to reject verification request',
  },
  unpair: {
    memo: 'Vault rejected the unpair request',
    flow: 'unpairing',
    step: 'unpair_request_rejected',
    verb: 'Rejected unpair',
    failure: 'Failed to reject unpair request',
  },
}

export class VaultRuntime {
  readonly vaultId: string

  private vault: Vault
  private readonly deps: VaultRuntimeDeps
  /** The view showing this vault, if any — see `attachView`. */
  private view: Partial<VaultViewEffects>
  private protocolInstance: ProtocolInstance | null = null
  private status: VaultStatus = 'idle'
  private failure: string | null = null
  private busy = false
  private readonly listeners = new Set<(state: VaultRuntimeState) => void>()

  /**
   * Tail of the queue of calls holding the protocol lock.
   *
   * Settled-or-rejected either way, so one failing call cannot wedge the queue.
   */
  private lock: Promise<unknown> = Promise.resolve()

  /**
   * Which dispatched requests are still awaiting their answer — shared by the
   * commands that start a round and the event handlers that resolve it.
   */
  private readonly rounds = new RoundTracker()

  /** What event handlers may reach. Built once; every member reads live state. */
  private readonly foldContext: FoldContext
  /** What inbound-request routing may reach. Built once, like `foldContext`. */
  private readonly inboundContext: InboundContext
  /** What the extracted multi-step commands may reach. Built once, like `foldContext`. */
  private readonly commandContext: CommandContext
  /** A replica destination fetching its source's copy until it lands. */
  private readonly catchUp: ReplicaCatchUp
  /** `catchUp` has a channel in flight — polls at the fast cadence meanwhile. */
  private catchingUp = false
  /** The own address being adopted, or last refused — see `followOwnAddress`. */
  private movingOwnAddressTo: string | null = null
  /** The HTTPS address the node last listed for this vault, for "follow the node". */
  private nodeAdvertisedUri: string | null = null
  /** Whether any roster has been read — until then a null address means "not asked yet". */
  private ownListingRead = false
  /** The latest identity update this vault sent, and each peer's answer. */
  private identityUpdate: IdentityUpdate | null = null
  /**
   * An identity change — from Edit identity or from following the node — is
   * between its first `await` and its commit. Both paths read the record before
   * announcing and write it after, so letting a second one start in between is
   * how an address was announced twice and then reverted.
   */
  private identityInFlight = false
  /** Marks peers still silent past the protocol timeout as `no-answer`. */
  private identityExpiryTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Resends of the node-follow update to peers it did not reach, so far, and
   * when the last one went. Bounded — see `retryNodeFollowUpdate`.
   */
  private nodeFollowRetries = { count: 0, lastAt: 0 }

  /**
   * The last automatic replica sync that sent nothing — never retried, so it is
   * held until a round that does dispatch, or the user dismisses it, and the
   * view shows it durably rather than as a toast that scrolls away.
   */
  private autoSyncOutcome: UnresolvedAutomaticSync | null = null

  /**
   * Owns both replica sync paths: the automatic round the first time a
   * destination becomes eligible, and the explicit "Sync now". Here rather than
   * in the view so a vault off screen still mirrors to a destination confirmed
   * while nobody was looking. One per runtime: its "already dispatched for"
   * bookkeeping and its single in-flight flag must not reset.
   */
  private readonly replicaTrigger = createReplicaFirstSyncTrigger({
    // A round stages a pending bag and arms the watchdog, so it must not land on
    // top of another flow. Deferring is free: the destination stays due and the
    // next roster tries again.
    canProtect: () => this.protocolInstance !== null && !this.blockedBy && !this.busy,
    markStarted: replicaIds => markReplicaFirstSyncStarted(this.vault.id, replicaIds),
    runProtectRound: reason => this.syncReplicas(reason),
    onOutcome: outcome => {
      if (outcome.kind === 'failed') {
        this.deps.notify.error('Could not mirror this vault to a newly confirmed replica', outcome.error)
      }
      this.autoSyncOutcome = automaticSyncNeedsAttention(outcome) ? outcome : null
      this.emit()
    },
  })

  /**
   * Wall-clock watchdog for any in-flight owner-initiated flow.
   *
   * Armed when a flow starts, refreshed by inbound progress, cleared on
   * completion. If it fires, the flow made no progress within the protocol
   * timeout and the UI has to recover rather than sit on a dead round.
   */
  private flowTimeout: ReturnType<typeof setTimeout> | null = null

  // ── Loop state ─────────────────────────────────────────────────────────────

  /**
   * Messages drained from the (destructive) backend mailbox but not yet
   * processed, because a confirmation opened partway through a batch. Replayed
   * ahead of the next poll's messages, so draining never loses one.
   */
  private pendingInbound: MailboxMessage[] = []
  /** Set when browser storage refused a write while a batch was processed. */
  private batchStorageFailure: string | null = null
  /** Named reasons the drain must not run, beyond open attention items. */
  private readonly pauseReasons = new Set<string>()
  /**
   * The failed replica adoption that erased the stores this instance reads.
   * Seeded from storage and sticky across `stop()`/`start()`: neither a reload
   * nor a remount may resume draining into a namespace that no longer exists.
   */
  private blockedBy: RestoreFailure | null
  /** Whether `start()` has scheduled the loops and `stop()` has not cleared them. */
  private loopsActive = false
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null
  /** A drain or tick pass is in flight; the next timer firing skips rather than overlapping. */
  private draining = false
  private ticking = false
  /**
   * Participants being auto-paired at setup, until all of them have paired.
   * Non-empty keeps the poll at the fast cadence, so the setup gate clears
   * promptly — and, being the engine's, stops doing so when the engine stops
   * rather than when some view remembers to say so.
   */
  private autoPairingIds: readonly string[] = []
  /** Auto-pairing runs once per runtime, however often `start()` is called. */
  private autoPairStarted = false

  /**
   * The replica flows' view of this vault's protocol, lock-guarded.
   *
   * Stable for the life of the runtime and never null: each method reads the
   * instance at *call* time, which is when the answer is needed, and throws a
   * legible error if the vault has not started.
   */
  readonly replicaProtocol: ReplicaProtocol

  constructor(vault: Vault, deps: VaultRuntimeDeps) {
    this.vaultId = vault.id
    this.vault = vault
    // Every entry this vault writes carries its id, so a console shared by
    // several vaults can tell them apart. Stamped here once rather than at each
    // of the call sites.
    this.deps = { ...deps, log: entry => deps.log({ ...entry, vaultId: vault.id }) }
    this.blockedBy = loadReplicaAdoptionBlock(vault.id)
    this.view = deps.effects ?? {}
    this.restorePendingReplicaOffer()

    const current = (): DeRecProtocol => {
      const protocol = this.protocolInstance?.protocol
      if (!protocol) throw new Error('Protocol not initialised yet — try again in a moment.')
      return protocol
    }
    this.replicaProtocol = {
      // The one flow it starts is a pairing — cleaned up like any other.
      start: (flowKind, params) =>
        this.withLock(() => this.forgetPendingOnFailure(() => current().start(flowKind, params))),
      getFingerprint: channelId => this.withLock(() => current().getFingerprint(channelId)),
      // Confirming a channel publishes the vault to it on the library's own
      // initiative, which a diverged vault must not do — see `protect`.
      verifyFingerprint: (channelId, fingerprint) => {
        const conflict = this.vault.replicaConflict
        if (conflict) {
          return Promise.reject(
            new Error(`Confirming would publish this vault. ${replicaConflictBlockReason(conflict)}`),
          )
        }
        return this.withLock(() => current().verifyFingerprint(channelId, fingerprint))
      },
      startReplicaDiscovery: () => this.withLock(() => current().start(FlowKind.ReplicaDiscovery)),
      startUnpairReplica: params => this.withLock(() => current().start(FlowKind.UnpairReplica, params)),
    }

    this.foldContext = {
      log: this.deps.log,
      notify: this.deps.notify,
      effects: this.effects,
      rounds: this.rounds,
      flowProgressed: () => {
        if (this.busy) this.armWatchdog()
      },
      roundResolved: () => {
        if (this.busy && this.rounds.hasAnyPendingRound) this.armWatchdog()
        else this.clearWatchdog()
      },
      getVault: () => this.vault,
      commit: next => this.commit(next),
      offerReplicaAdoption: offer => this.offerReplicaAdoption(offer),
      readChannelInfo: channelId =>
        readHelperChannelInfo(`vault:${this.vault.id}`, this.secretId, channelId),
      awaitingIdentityAnswer: channelId =>
        this.identityUpdate?.channels[channelId]?.outcome === 'pending',
      isShareHeld: (channelId, version) =>
        loadRawShare(this.namespace, this.partition, channelId, version) !== null,
      channelInfoOutcome: (channelId, outcome, detail) => {
        const next = withChannelOutcome(this.identityUpdate, channelId, outcome, detail)
        if (next === this.identityUpdate) return
        this.identityUpdate = next
        this.emit()
      },
    }

    this.inboundContext = {
      log: this.deps.log,
      raiseAttention: item => this.raiseAttention(item),
      config: () => resolveVaultConfig(this.vault.configOverrides, this.deps.getServerDefaults()),
      acceptAndFold: (action, current, failure, context) =>
        this.acceptAndFold(action, current, failure, context),
      // The batch that routes here already holds the lock.
      acceptStoreShare: (request, current) => this.acceptStoreShareUnlocked(request, current),
    }

    this.commandContext = {
      log: this.deps.log,
      notify: this.deps.notify,
      getVault: () => this.vault,
      commit: next => this.commit(next),
      getServerDefaults: () => this.deps.getServerDefaults(),
      instance: () => this.protocolInstance,
      withLock: fn => this.withLock(fn),
      fold: (current, event) => this.applyEvent(current, event),
      adoptInstance: instance => this.adoptInstance(instance),
      keepList: this.keepList,
    }

    this.catchUp = new ReplicaCatchUp({
      discover: () => this.discoverReplicas(),
      isEligible: channelId => {
        const state = loadReplicaState(this.vault.id)
        return (
          state.channels[channelId]?.role === 'replica_destination' &&
          isReplicaChannelConfirmedLocally(state, channelId)
        )
      },
      log: this.deps.log,
      onChange: () => {
        const before = this.pollIntervalMs
        this.catchingUp = this.catchUp.syncing().length > 0
        if (this.pollIntervalMs !== before) this.schedulePoll()
        this.emit()
      },
    })
  }

  /**
   * Attach the view that is showing this vault. Returns the detach.
   *
   * One view at a time — a vault is on one screen at most — so attaching
   * replaces whatever was attached, and a detach from a view already replaced
   * does nothing. With none attached every effect is a no-op: a vault running
   * in the background has nothing to open a dialog in, and raises attention
   * instead.
   */
  attachView(effects: Partial<VaultViewEffects>): () => void {
    this.view = effects
    return () => {
      if (this.view === effects) this.view = {}
    }
  }

  /**
   * View callbacks. Each reads the attached view when it is *called*, so this
   * one object can be handed out once — to the fold, say — and still reach
   * whichever view is attached later. With none attached, each is a no-op.
   */
  private readonly effects: VaultViewEffects = {
    refreshReplicas: () => this.view.refreshReplicas?.(),
    openFingerprint: channelId => this.view.openFingerprint?.(channelId),
    openAdoption: () => this.view.openAdoption?.(),
    pairingRejected: () => this.view.pairingRejected?.(),
    pairingCompleted: (channelId, vault) => this.view.pairingCompleted?.(channelId, vault),
    unpairSettled: channelId => this.view.unpairSettled?.(channelId),
    channelsLinked: () => this.view.channelsLinked?.(),
  }

  /**
   * The vault's answer to the library's per-round `keepList` question — the
   * versions helpers keep — read from the record at the moment the round is
   * built, whichever flow started it. See `vault/keepList.ts`.
   *
   * Logged, because what it decides happens on the helpers' side, out of
   * sight: the console is the only place a developer can see which versions a
   * round told them to drop.
   */
  private readonly keepList: KeepListSource = (secretId, version) => {
    const open = this.rounds.snapshotProtectRounds().map(round => round.version)
    const kept = keepListFor(this.vault, secretId, version, open)
    this.deps.log({
      role: 'owner',
      flow: 'sharing',
      step: 'keep_list',
      description:
        kept === null
          ? `Round v${version}: no committed version on record, so helpers keep every version they hold`
          : `Round v${version}: helpers keep ${[...kept, version].sort((a, b) => a - b).map(v => `v${v}`).join(', ')} and drop any other version of this secret`,
      payload: { secretId, version, keepList: kept },
    })
    return kept
  }

  /** The outside world, defaulted to the real backend. */
  private get io(): VaultRuntimeIo {
    const io = this.deps.io ?? {}
    return {
      pollMailbox: io.pollMailbox ?? pollMailbox,
      postBrowserContact: io.postBrowserContact ?? apiPostBrowserContact,
      markParticipantOffline:
        io.markParticipantOffline ?? (participantId => apiToggleParticipantStatus(participantId, true)),
      serverReachable:
        io.serverReachable ?? (async () => (await apiGetServerDefaults()).reachable),
      renameOwner: io.renameOwner ?? apiRenameOwner,
      participantContact:
        io.participantContact ?? (async id => dtoToContactMessage(await apiCreateActorContact(id))),
    }
  }

  /** How long a flow may make no progress before the watchdog fires. */
  private get flowTimeoutMs(): number {
    const configured =
      resolveVaultConfig(this.vault.configOverrides, this.deps.getServerDefaults())
        .protocolTimeoutSecs * 1000
    // A protect round is the library's to close, and it always does. The
    // watchdog only backstops it, so it must never fire first — firing early
    // reported a round as failed that then committed half a minute later.
    return this.rounds.hasAnyPendingRound ? Math.max(configured, PROTECT_ROUND_BACKSTOP_MS) : configured
  }

  private clearWatchdog(): void {
    if (this.flowTimeout !== null) {
      clearTimeout(this.flowTimeout)
      this.flowTimeout = null
    }
  }

  /** (Re)arm the watchdog. Called when a flow starts or makes progress. */
  private armWatchdog(): void {
    this.clearWatchdog()
    this.flowTimeout = setTimeout(() => this.onFlowTimeout(), this.flowTimeoutMs)
  }

  private onFlowTimeout(): void {
    this.flowTimeout = null

    const open = this.rounds.pendingRounds
    if (open.length > 0) {
      for (const round of open) this.settleOverdueRound(round.version)
      return
    }

    if (!this.busy) return // nothing actually in flight
    this.markDiscoveryUnanswered()
    this.rounds.abandonAll()
    this.setBusy(false)
    this.deps.notify.error(
      `Operation timed out — no response within ${Math.round(this.flowTimeoutMs / 1000)}s`,
    )
  }

  /**
   * The backstop fired on round `version` before the library closed it.
   *
   * A round that already met its threshold is not a failure: the helpers that
   * confirmed hold the new version, and the library commits it as soon as it
   * gives up on the rest. Its confirmations stay, and the round stays open to
   * be committed. Only a round below threshold is rolled back.
   */
  private settleOverdueRound(version: number): void {
    const confirmed = this.rounds.confirmedCount(version)
    if (confirmed < this.vault.minParticipants) {
      this.failSharingRound(version, 'timeout')
      return
    }
    this.setBusy(false)
    this.deps.log({
      role: 'owner',
      flow: 'sharing',
      step: 'sharing_round_overdue',
      description:
        `Sharing round v${version} reached its threshold (${confirmed} confirmed) but is still ` +
        'waiting on the rest. It is kept open and commits when the library closes it.',
      payload: { version, confirmed, threshold: this.vault.minParticipants },
    })
  }

  // ── Registering a round ────────────────────────────────────────────────────

  /**
   * Pick protect rounds back up after a reload, or after this vault was
   * stopped and started again mid-round.
   *
   * The library already holds each round and the helpers' answers wait in the
   * mailbox, so all that was lost is this side's record of the bag each round
   * commits. Restoring it means a round's `SharingComplete` commits the bag
   * with the secret in it, instead of being taken for an auto-publish of the
   * old one. The watchdog is armed afresh: if a round never resolves, it is
   * rolled back and reported like any other that times out.
   *
   * Called by `start`; public so specs can resume a round without WASM.
   */
  resumeProtectRound(): void {
    const persisted = this.vault.pendingProtectRounds ?? []
    if (persisted.length === 0 || this.rounds.hasAnyPendingRound) return

    // Already committed — the record was saved before the commit landed.
    const current = this.vault.secretBag?.currentVersion.version ?? 0
    const resumable = persisted.filter(round => round.version > current)
    if (resumable.length === 0) {
      this.commit(this.vault)
      return
    }

    for (const round of resumable) this.rounds.beginProtectRound(round)
    // Re-persist without any round that had already committed.
    if (resumable.length !== persisted.length) this.commit(this.vault)
    this.armWatchdog()

    const versions = resumable.map(round => `v${round.version}`).join(', ')
    this.deps.log({
      role: 'owner',
      flow: 'sharing',
      step: 'sharing_round_resumed',
      description:
        `Sharing round(s) ${versions} were still in flight when this vault last stopped — ` +
        'waiting for their participants again. Each commits once enough confirm.',
      payload: {
        rounds: resumable.map(round => ({ version: round.version, awaiting: round.channelIds })),
      },
    })
    this.deps.notify.info(
      `Resumed sharing round ${versions}, interrupted by a reload. The bag updates once enough participants confirm.`,
    )
  }

  /**
   * Pick verification challenges back up after a reload, so an answer that
   * lands now is applied rather than dropped. Called by `start`.
   */
  resumeVerifications(): void {
    const persisted = this.vault.pendingVerifications ?? []
    if (persisted.length === 0) return
    this.rounds.resumeVerifications(persisted)
    // Re-persist without any that expired while the vault was stopped.
    if (this.rounds.snapshotVerifications().length !== persisted.length) this.commit(this.vault)
  }

  /**
   * Register a dispatched `ProtectSecret` round and start its watchdog. Public
   * so specs can register a round without dispatching one.
   */
  beginProtectRound(round: Parameters<RoundTracker['beginProtectRound']>[0]): void {
    this.rounds.beginProtectRound(round)
    // Backstop for a round the library never closes — see `flowTimeoutMs`.
    this.armWatchdog()
  }

  /** Whether a round at this version is still awaiting its shares. */
  hasPendingRound(version: number): boolean {
    return this.rounds.hasPendingRound(version)
  }

  /**
   * Abandon a sharing round that will not complete.
   *
   * Drops the uncommitted bag. Shares still unanswered are marked refused
   * rather than erased: the progress view reads them, and erasing them sent it
   * from "2 of 4 confirmed" back to "0 of 4" with every row waiting again,
   * where it should have ended on the rolled-back banner.
   */
  failSharingRound(version: number, reason: string): void {
    if (!this.rounds.abandonRound(version)) return // already resolved
    this.clearWatchdog()

    this.commit({
      ...this.vault,
      participants: settleUnansweredShares(this.vault.participants, version),
    })

    this.setBusy(false)

    this.deps.notify.error(
      `Sharing round v${version} did not reach its threshold (${reason}) — the bag was rolled back`,
      undefined,
      { version, reason },
    )
    this.deps.log({
      role: 'owner',
      flow: 'sharing',
      step: 'sharing_round_failed',
      description:
        `Sharing round v${version} did not complete (${reason}). ` +
        'Too few helpers confirmed, so the bag was rolled back — please try again.',
      payload: { version, reason },
    })
  }

  get secretId(): string {
    return this.vault.secretId
  }

  state(): VaultRuntimeState {
    return {
      vault: this.vault,
      status: this.blockedBy ? 'blocked' : this.status,
      busy: this.busy,
      attention: this.attention(),
      failure: this.failure,
      blockedBy: this.blockedBy,
      replicaSyncing: this.catchUp.syncing(),
      replicaAutoSyncOutcome: this.autoSyncOutcome,
      identityUpdate: this.identityUpdate,
      autoPairing: this.autoPairingIds,
    }
  }

  // ── Attention ──────────────────────────────────────────────────────────────
  //
  // What this vault needs a person to decide. Held here rather than in the view
  // because a vault that is not on screen still has to raise one — that is what
  // the vault list badges from — and because the drain gate reads the same
  // queue, so a second copy in the view would let the gate disagree with what is
  // actually open.

  private items: Attention[] = []

  attention(): readonly Attention[] {
    return this.items
  }

  /** Raise something for a person to decide. Returns the id to resolve it with. */
  raiseAttention(item: Omit<Attention, 'id' | 'raisedAt'>): string {
    const id = randomId()
    this.items = [...this.items, { ...item, id, raisedAt: Date.now() }]
    this.armAutoReject(id, item.kind)
    this.emit()
    return id
  }

  /** Clear a resolved item. Unknown ids are ignored — the view can race a teardown. */
  resolveAttention(id: string): void {
    const timer = this.autoRejectTimers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.autoRejectTimers.delete(id)
    }
    const next = this.items.filter(item => item.id !== id)
    if (next.length === this.items.length) return
    this.items = next
    this.emit()
  }

  /** Deadlines of the open requests a person has to answer in time, by item id. */
  private readonly autoRejectTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * Refuse a peer's request nobody answered within the protocol timeout.
   *
   * Store-share, verify-share and unpair requests each wait on a person, and
   * each holds the mailbox while it does — every message behind it waits too.
   * The deadline is the engine's, not a dialog's: when it lived in the page, a
   * request raised on a vault off screen was never refused, and that vault's
   * whole mailbox stayed held behind it. The peer gets an explicit refusal
   * rather than silence.
   */
  private armAutoReject(id: string, kind: AttentionKind): void {
    if (kind !== 'store-share' && kind !== 'verify-share' && kind !== 'unpair') return
    const timeoutMs = this.protocolTimeoutMs()
    this.autoRejectTimers.set(
      id,
      setTimeout(() => {
        this.autoRejectTimers.delete(id)
        if (!this.items.some(item => item.id === id)) return
        this.deps.log({
          role: 'owner',
          flow: REJECTIONS[kind].flow,
          step: 'request_auto_rejected',
          description: `No answer within ${Math.round(timeoutMs / 1000)}s — the request was refused automatically`,
          payload: { kind },
        })
        void this.rejectAttention(id)
      }, timeoutMs),
    )
  }

  /**
   * Stage a mirrored-secret offer as this vault's one `replica-adoption` item.
   *
   * Merged into an already-open item rather than raised alongside it: there is
   * one adoption prompt, and `mergeReplicaSecretReceipt` keeps the newer of what
   * is staged and what arrived, so an at-least-once replay of a stale round can
   * never regress a fresher offer the owner has not yet acted on. The id is kept
   * so the view's handle on the item survives a newer offer landing under it.
   */
  stageReplicaAdoption(offer: PendingReplicaAdoption): void {
    const existing = this.items.find(item => item.kind === 'replica-adoption')
    if (!existing) {
      savePendingReplicaOffer(this.vault.id, offer)
      this.raiseAttention({ kind: 'replica-adoption', blocksDrain: false, payload: offer })
      return
    }
    const staged = existing.payload as PendingReplicaAdoption
    const merged = mergeReplicaSecretReceipt(staged, offer)
    if (merged === staged) return
    savePendingReplicaOffer(this.vault.id, merged)
    this.items = this.items.map(item => (item === existing ? { ...item, payload: merged } : item))
    this.emit()
  }

  /**
   * Put back the offer that was in front of the owner when the page went away.
   *
   * Raised as a quiet item — the banner's "Review…" — rather than reopening
   * the dialog over whatever the owner is doing: they have seen it once. An
   * offer for the secret this vault already runs is spent (it was adopted) and
   * is dropped instead.
   */
  private restorePendingReplicaOffer(): void {
    const offer = loadPendingReplicaOffer(this.vault.id)
    if (!offer) return
    if (offer.secretId === this.vault.secretId || this.blockedBy) {
      clearPendingReplicaOffer(this.vault.id)
      return
    }
    // Agreed to before the page went away: nothing to ask, only to finish.
    if (hasAdoptionConsent(loadReplicaState(this.vault.id))) {
      this.consentedOfferOnStart = offer
      return
    }
    this.items = [
      ...this.items,
      { kind: 'replica-adoption', blocksDrain: false, payload: offer, id: randomId(), raisedAt: Date.now() },
    ]
  }

  /**
   * A mirrored vault arrived for this device to take on.
   *
   * No check that this device confirmed the channel's fingerprint: the library
   * ignores everything a replica peer sends before this device confirms
   * (`MessageIgnored { reason: 'PendingVerification' }`), so an offer that
   * reaches the fold arrived over a verified channel.
   *
   * And confirming is the decision to adopt: the fingerprint dialog asks it
   * first and confirms only on a yes (SDK 0.0.7 documents this as the
   * application's job — the library installs the group's publishes as they
   * arrive). So an offer on a device whose person agreed is adopted at once,
   * without asking a second time. Only a channel confirmed before the app
   * asked — by an earlier version of it — still gets the adoption dialog.
   */
  offerReplicaAdoption(offer: PendingReplicaAdoption): void {
    if (hasAdoptionConsent(loadReplicaState(this.vault.id))) {
      this.adoptConsentedOffer(offer)
      return
    }
    this.stageReplicaAdoption(offer)
    // Erasing this device's vault is not something to advertise in a banner
    // at the bottom of the page, so the offer is raised where it cannot be
    // missed.
    this.effects.openAdoption()
  }

  /** An adoption the person agreed to is running — at most one at a time. */
  private adoptingConsented = false
  /** An agreed offer restored from storage, adopted once the vault starts. */
  private consentedOfferOnStart: PendingReplicaAdoption | null = null

  /**
   * Adopt a vault the person already agreed to take on, when they confirmed
   * the fingerprint.
   *
   * Persisted first, so a reload in the middle picks the adoption back up
   * rather than leaving the device holding the group's copy in the library's
   * stores and its own vault on screen. Scheduled behind the protocol lock and
   * not awaited: the offer arrives from inside a drain that holds it. A
   * failure blocks the vault, exactly as a confirmed adoption from the dialog
   * does.
   */
  private adoptConsentedOffer(offer: PendingReplicaAdoption): void {
    if (this.adoptingConsented || this.blockedBy) return
    savePendingReplicaOffer(this.vault.id, offer)
    this.adoptingConsented = true
    this.deps.log({
      role: 'owner',
      flow: 'sharing',
      step: 'replica_adoption_consented',
      description:
        `Adopting the mirrored vault v${offer.version} from replica ${offer.fromReplicaId}, as agreed ` +
        "when this device confirmed the fingerprint — this vault's own contents are replaced",
      payload: { channelId: offer.channelId, secretId: offer.secretId, version: offer.version },
    })
    void this.adoptReplica(offer)
      .then(() => {
        clearPendingReplicaOffer(this.vault.id)
        this.effects.refreshReplicas()
        this.deps.notify.info(`Adopted the replica group's vault (v${offer.version}) on this device`)
      })
      .catch(err => {
        this.deps.notify.error("Adopting the replica group's vault failed", err, {
          secretId: offer.secretId,
          version: offer.version,
        })
      })
      .finally(() => {
        this.adoptingConsented = false
      })
  }

  /**
   * This device has just confirmed the replica channel `channelId`.
   *
   * A copy pushed before this device confirmed was dropped, not held, and
   * confirming does not replay it: the destination asks the group for it
   * instead, until it lands — the source may confirm minutes later. What comes
   * back lands through the ordinary fold, as an offer. A source already holds
   * the vault, so it is not eligible and nothing starts.
   */
  replicaChannelConfirmed(channelId: string): void {
    const record = loadReplicaState(this.vault.id).channels[channelId]
    if (record?.role !== 'replica_destination') return
    this.catchUp.start(channelId)
  }

  /**
   * Whether the mailbox drain must not run.
   *
   * True while *any* blocking item is open, not merely the most recent: two
   * confirmations can be outstanding at once, and resolving one must not let the
   * drain mutate state the other is still asking about.
   */
  drainPaused(): boolean {
    return this.items.some(item => item.blocksDrain) || this.pauseReasons.size > 0
  }

  /** Add a named reason the drain must not run. Idempotent per reason. */
  pauseDrain(reason: string): void {
    this.pauseReasons.add(reason)
  }

  /** Remove a pause reason. The drain resumes when the last one clears. */
  resumeDrain(reason: string): void {
    this.pauseReasons.delete(reason)
  }

  subscribe(listener: (state: VaultRuntimeState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  instance(): ProtocolInstance | null {
    return this.protocolInstance
  }

  /**
   * Serialise this vault's work on its protocol instance.
   *
   * From SDK 0.0.6 the instance queues overlapping calls itself, so this is no
   * longer what keeps a call from hanging. It still decides what runs as one
   * step: a drain's whole batch, or a command's read-then-commit of the vault
   * record, must not interleave with another's — and `quiesce` waits on it.
   *
   * Per-runtime rather than global: two instances run overlapping calls
   * cleanly (`e2e/wasm-concurrency.spec.ts`), so vaults need not wait on each
   * other.
   */
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    // `then(fn, fn)` runs `fn` whether the previous call resolved or threw; the
    // separate `catch` below keeps the stored tail from ever being a rejected
    // promise, which would otherwise surface as an unhandled rejection.
    const run = this.lock.then(fn, fn)
    this.lock = run.catch(() => {})
    return run
  }

  async start(): Promise<void> {
    if (this.status === 'running' || this.status === 'starting') return

    this.setStatus('starting')
    try {
      const config = resolveVaultConfig(
        this.vault.configOverrides,
        this.deps.getServerDefaults(),
      )
      this.protocolInstance = buildProtocolInstance({
        namespace: `vault:${this.vault.id}`,
        secretId: this.vault.secretId,
        ownTransportUri: this.vault.transport.uri,
        communicationInfo: { name: this.vault.name },
        threshold: this.vault.minParticipants,
        keepList: this.keepList,
        timeoutSecs: config.protocolTimeoutSecs,
        unpairAck: config.unpairAck,
        replicaId: getOrCreateReplicaId(this.vault.id),
        relayActorId: this.vault.id,
        // See `BuildProtocolOptions.autoReplyTo`: needed to announce a new
        // endpoint (Edit Identity) the way SDK 0.0.7 documents.
        autoReplyTo: true,
      })
      const instance = this.protocolInstance

      this.deps.log({
        role: 'owner',
        flow: 'setup',
        step: 'protocol_init',
        description: `Protocol initialized for vault ${this.vault.id}`,
        payload: { vaultId: this.vault.id, secretId: this.vault.secretId },
      })
      this.setStatus('running')

      // A blocked vault reads an erased namespace: advertising it or draining
      // into it would only manufacture state on top of the wipe.
      if (this.blockedBy) return
      this.resumeProtectRound()
      this.resumeVerifications()
      // Requests still open from before a stop get their deadline back.
      for (const item of this.items) {
        if (!this.autoRejectTimers.has(item.id)) this.armAutoReject(item.id, item.kind)
      }
      // A pairing left unfinished when this vault last stopped is swept now,
      // not a tick from now: a broadcast started in between would trip on it.
      void this.withLock(async () => this.sweepAbandonedPairings()).catch(err =>
        this.deps.notify.error('Could not clear unfinished pairings', err),
      )
      this.replayOfflineFlags()
      const consented = this.consentedOfferOnStart
      this.consentedOfferOnStart = null
      if (consented) this.adoptConsentedOffer(consented)
      void this.publishContact(instance)
      this.startLoops()
      void this.autoPair()
    } catch (err) {
      // A vault that cannot build its instance must fail alone. An unhandled
      // throw from the old init effect had nowhere good to go; here it becomes a
      // listed vault with a retry, and every other runtime keeps running.
      this.failure = errorText(err)
      this.protocolInstance = null
      this.setStatus('failed')
      this.deps.notify.error(`Vault "${this.vault.name}" failed to start`, err, {
        vaultId: this.vault.id,
      })
    }
  }

  stop(): void {
    this.stopLoops()
    // An auto-pair cut short by the stop is abandoned, and with it the fast
    // cadence it held. If none of it got started, `prePairedCount` still asks
    // for it, and the runtime the vault is next opened with tries again.
    this.autoPairingIds = []
    for (const timer of this.autoRejectTimers.values()) clearTimeout(timer)
    this.autoRejectTimers.clear()
    this.catchUp.stopAll()
    this.protocolInstance = null
    this.setStatus('idle')
  }

  /**
   * Resolve once the work already queued on the protocol lock has finished.
   *
   * `stop` clears the timers, but a drain or command already inside the lock
   * runs to its end — and its store writes with it. Removing a vault waits on
   * this before erasing those stores. Work queued after the call is not
   * waited for; with the loops stopped and the instance gone, none starts.
   */
  async quiesce(): Promise<void> {
    await this.lock
  }

  /**
   * Stop this vault for good after a failed replica adoption.
   *
   * The adoption erased the stores the instance reads, so every message
   * processed after it would run against state that no longer exists — and the
   * mailbox is destructive, so those messages would be lost. Nothing is retried.
   */
  block(failure: RestoreFailure): void {
    // Persisted first: a reload must not be able to un-block a wiped device.
    saveReplicaAdoptionBlock(this.vault.id, failure)
    this.blockedBy = failure
    this.stopLoops()
    this.catchUp.stopAll()
    this.emit()
  }

  // ── Auto-pairing ───────────────────────────────────────────────────────────
  //
  // A vault set up with "pre-pair N" pairs with N provisioned participants as
  // soon as it starts. The engine's job rather than the page's: it needs no
  // DOM, a vault keeps running off screen, and when the page drove it, leaving
  // the page mid-pairing left the poll at the fast cadence for good.

  /**
   * Pair with the participants `prePairedCount` asks for, once per runtime.
   * `start()` calls it; public so specs can drive it with no WASM.
   *
   * `prePairedCount` is cleared once any pairing has started, so reopening the
   * vault does not pair a second set; if none could start, it stays, and the
   * runtime the vault is next opened with tries again.
   */
  async autoPair(): Promise<void> {
    if (this.autoPairStarted) return
    const count = this.vault.prePairedCount ?? 0
    if (count === 0) return
    this.autoPairStarted = true

    // Chosen at random, not off the top of the roster: the participant pool is
    // shared, so taking the first N would hand every browser context the same
    // few and leave the rest idle.
    const targets = selectAutoPairTargets(this.vault.participants, count)
    if (targets.length === 0) return
    this.setAutoPairing(targets.map(p => p.id))

    const started: PendingPairing[] = []
    for (const participant of targets) {
      // Stopped meanwhile: the rest wait for the next start.
      if (!this.protocolInstance) break
      try {
        const contact = await this.io.participantContact(participant.id)
        const channelId = await this.startPairing(contact, 'owner', participant.name)
        started.push({ channelId, participantId: participant.id })
        this.deps.log({
          role: 'owner',
          flow: 'pairing',
          step: 'auto_pair_initiated',
          description: `Auto-pair initiated for ${participant.name}`,
          payload: { participantId: participant.id, channelId: channelId.toString() },
        })
      } catch (err) {
        // Stopped while this one was in flight: not a failure worth reporting.
        if (!this.protocolInstance) break
        this.deps.notify.error(`Auto-pairing with "${participant.name}" failed`, err, {
          participantId: participant.id,
        })
        // Nothing will ever pair it, so the gate must not wait for it.
        this.setAutoPairing(this.autoPairingIds.filter(id => id !== participant.id))
      }
    }

    if (started.length === 0) return
    this.commit({
      ...this.vault,
      prePairedCount: 0,
      pendingPairings: [...this.vault.pendingPairings, ...started],
    })
  }

  private setAutoPairing(ids: readonly string[]): void {
    this.replaceAutoPairing(this.autoPairingDoneIn(this.vault, ids) ? [] : ids)
    this.emit()
  }

  /** Swap the auto-pairing set, moving the poll to the cadence it now calls for. */
  private replaceAutoPairing(ids: readonly string[]): void {
    const before = this.pollIntervalMs
    this.autoPairingIds = ids
    if (this.pollIntervalMs !== before) this.schedulePoll()
  }

  /** The gate is done once every participant it waits on has paired in `vault`. */
  private autoPairingDoneIn(vault: Vault, ids = this.autoPairingIds): boolean {
    return (
      ids.length > 0 &&
      ids.every(id =>
        vault.participants.some(p => p.id === id && p.connectionStatus === 'paired'),
      )
    )
  }

  // ── Loops ──────────────────────────────────────────────────────────────────
  //
  // Owned here, not by the view, because a vault that is off screen still has to
  // drain its mailbox: the counterparty's replay window keeps running whether or
  // not anything is rendering this vault.

  /**
   * How often to poll: fast while a flow is in flight, auto-pairing or catching
   * up a replica, slow otherwise. The slow cadence is a deliberate
   * counterparty-latency simulation, not a constraint.
   */
  private get pollIntervalMs(): number {
    return this.busy || this.autoPairingIds.length > 0 || this.catchingUp ? POLL_FAST_MS : POLL_IDLE_MS
  }

  private startLoops(): void {
    this.loopsActive = true
    this.schedulePoll()
    if (this.tickTimer === null) {
      this.tickTimer = setInterval(() => void this.tickOnce(), TICK_INTERVAL_MS)
    }
  }

  private stopLoops(): void {
    this.loopsActive = false
    if (this.identityExpiryTimer !== null) clearTimeout(this.identityExpiryTimer)
    this.identityExpiryTimer = null
    if (this.pollTimer !== null) clearTimeout(this.pollTimer)
    if (this.tickTimer !== null) clearInterval(this.tickTimer)
    this.pollTimer = null
    this.tickTimer = null
  }

  /**
   * (Re)schedule the next drain at the current cadence.
   *
   * A chained timeout rather than an interval so a cadence change takes effect
   * at once — a flow that goes busy must not wait out the remainder of an idle
   * five seconds before its first fast poll.
   */
  private schedulePoll(): void {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer)
    this.pollTimer = null
    if (!this.loopsActive) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      void this.drainOnce().finally(() => {
        // Unless something already rescheduled it while the drain ran.
        if (this.pollTimer === null) this.schedulePoll()
      })
    }, this.pollIntervalMs)
  }

  /** One poll-and-process pass. The poll timer calls this; tests call it directly. */
  async drainOnce(): Promise<void> {
    // Paused and blocked are checked *before* polling: the mailbox is
    // destructive, so a poll taken now would only have to be held.
    if (this.draining || this.blockedBy || this.drainPaused()) return
    if (!this.protocolInstance) return

    this.draining = true
    try {
      const vaultId = this.vault.id
      let messages: MailboxMessage[]
      try {
        messages = await this.io.pollMailbox(vaultId)
      } catch (err) {
        const unreachable = err instanceof NodeUnreachableError
        this.deps.pollReached?.(!unreachable)
        // An unreachable node is every vault's problem, reported once for the
        // node by whoever listens; an answer about this mailbox is this vault's.
        if (!unreachable || !this.deps.pollReached) {
          this.deps.notify.error('Mailbox poll failed', err, { vaultId })
        }
        return
      }
      this.deps.pollReached?.(true)

      // Older, held-back messages go first so the protocol sees them in order.
      if (this.pendingInbound.length > 0) {
        messages = [...this.pendingInbound, ...messages]
        this.pendingInbound = []
      }
      if (messages.length === 0) return

      await this.withLock(() => this.processBatch(messages))
    } catch (err) {
      this.deps.notify.error('Polling loop error', err)
    } finally {
      this.draining = false
    }
  }

  /**
   * Feed a drained batch through the protocol and fold the resulting events.
   *
   * Runs under the protocol lock. Stops at the first event that needs the
   * owner's decision and holds back the rest of the batch until it is resolved.
   */
  private async processBatch(messages: readonly MailboxMessage[]): Promise<void> {
    const initial = this.vault
    let updated = initial

    for (let mi = 0; mi < messages.length; mi++) {
      const { bytes } = messages[mi]
      const protocol = this.protocolInstance?.protocol
      if (!protocol) {
        // The instance went away under the batch — a claim or restore swapping
        // it. The mailbox is destructive, so the rest is held for the next
        // drain rather than dropped, and the console says so.
        this.pendingInbound = messages.slice(mi)
        this.deps.log({
          role: 'owner',
          flow: 'protocol',
          step: 'inbound_held',
          description: `Held ${messages.length - mi} incoming message(s) until this vault's protocol is running again`,
          payload: { held: messages.length - mi },
        })
        this.finishBatch(initial, updated, messages.length)
        return
      }

      let events: DeRecEvent[]
      // A failed message still carries the events `process()` produced before
      // it failed — the timeouts it settled, never reported again — and they
      // are folded exactly as a successful call's are. The error is reported
      // once they have been.
      let failure: { error: unknown } | null = null
      try {
        events = Array.from(await protocol.process(bytes))
      } catch (err) {
        failure = { error: err }
        events = eventsOfFailedProcess(err)
      }
      if (events.length === 0 && failure === null) {
        // Not an error — a reply to a request this device no longer tracks,
        // typically one sent before a claim or a reload — but never silent:
        // the console is where a developer looks for the answer that "never
        // arrived".
        this.deps.log({
          role: 'owner',
          flow: 'protocol',
          step: 'message_without_effect',
          description: 'An incoming message was processed and changed nothing here — likely a reply to a request this device no longer tracks',
          payload: { messageBytes: bytes.length },
        })
      }

      for (const event of events) {
        if (event.type === 'ActionRequired' && event.action) {
          const outcome = await routeActionRequired(event, updated, this.inboundContext)
          updated = outcome.vault
          if (outcome.holdBack) {
            // The mailbox is destructive: keep what follows so it replays once
            // this decision is made.
            this.pendingInbound = messages.slice(mi + 1)
            if (failure) updated = this.reportProcessFailureInBatch(failure.error, bytes.length, updated)
            this.finishBatch(initial, updated, messages.length)
            return
          }
          continue
        }

        try {
          updated = this.applyEvent(updated, event)
        } catch (err) {
          // Not every event variant carries a channel (SharingComplete, NoOp),
          // so read it defensively for the error context.
          this.deps.notify.error(`Failed to handle a ${event.type} event`, err, {
            channelId: 'channel_id' in event ? event.channel_id : undefined,
          })
        }

        if (event.type === 'PairingCompleted') {
          this.effects.pairingCompleted(event.channel_id, updated)
        }

        // Terminal events for the discovery and recovery flows: the expected
        // responses arrived, so the flow is resolved. A discovery is resolved
        // once every helper it asked has answered; until then the watchdog
        // stays armed, so a silent helper is marked rather than left pending.
        if (event.type === 'SecretsDiscovered') {
          this.discoveryTargets?.delete(event.channel_id)
          if (!this.discoveryTargets || this.discoveryTargets.size === 0) {
            this.discoveryTargets = null
            this.setBusy(false)
          }
        }
        if (event.type === 'SecretRecovered' || event.type === 'RecoveryShareError') {
          this.setBusy(false)
        }
        // Every helper asked has answered, and the fold found the shares short:
        // nothing more is coming, so the flow is over rather than left to the
        // watchdog.
        if (
          (event.type === 'RecoveryShareReceived' ||
            event.type === 'RecoveryShareRefused' ||
            event.type === 'RecoveryShareCorrupted') &&
          updated.recoveryProgress?.error
        ) {
          this.setBusy(false)
        }

        // An outgoing unpair either went through or was refused; either way the
        // in-flight marker is no longer accurate.
        if ((event.type === 'Unpaired' || event.type === 'UnpairRejected') && event.channel_id) {
          this.effects.unpairSettled(event.channel_id)
        }
      }

      if (failure) updated = this.reportProcessFailureInBatch(failure.error, bytes.length, updated)
    }

    this.finishBatch(initial, updated, messages.length)
  }

  /**
   * Report a failed message from inside a batch, and return the record the
   * batch continues from.
   *
   * What the batch folded so far is committed first: reporting can commit on
   * its own — forgetting a pairing the peer refused — and the batch's own
   * commit at the end must not then write back a record from before it.
   */
  private reportProcessFailureInBatch(err: unknown, messageBytes: number, updated: Vault): Vault {
    if (updated !== this.vault) this.commit(updated)
    this.reportProcessFailure(err, messageBytes)
    return this.vault
  }

  private finishBatch(initial: Vault, updated: Vault, messageCount: number): void {
    if (updated !== initial) this.commit(updated)
    const storageFailure = this.batchStorageFailure
    this.batchStorageFailure = null
    const recovering = this.vault.recoveryProgress
    if (storageFailure && recovering && !recovering.error) {
      this.failRecovery(recovering.secretId, recovering.version, storageFailure)
    }
    // Inbound progress while a flow is in flight resets the watchdog deadline,
    // so a slow-but-progressing multi-helper round is not false-killed; a fully
    // stalled flow still times out.
    if (this.busy && messageCount > 0) this.armWatchdog()
  }

  private reportProcessFailure(err: unknown, messageBytes: number): void {
    const nonOk = asNonOkStatus(err)
    if (nonOk) {
      this.deps.log({
        role: 'owner',
        flow: 'protocol',
        step: 'non_ok_status',
        description: `Counterparty responded with status ${nonOk.status}: ${nonOk.memo}`,
        payload: { status: nonOk.status, memo: nonOk.memo, channelId: nonOk.channelId },
      })
      // Sharing rejections arrive as ShareRejected events, not errors, so a
      // non-OK status here is a pairing or other flow rejection.
      this.effects.pairingRejected()
      // A refused pairing this vault started can never complete. Its record is
      // forgotten now rather than left for the sweep. (The batch holds the lock.)
      const refused = nonOk.channelId
      if (refused && this.vault.pendingPairings.some(p => p.channelId.toString() === refused)) {
        this.forgetPendingChannels([refused], `the peer refused the pairing (status ${nonOk.status})`)
      }
    } else if (isUnknownChannelError(err)) {
      // Expected, not a fault: mailboxes are store-and-forward, so a peer still
      // holding a channel this device has dropped (a retired recovery channel,
      // an unpair that crossed in flight) can always deliver one more message.
      this.deps.log({
        role: 'owner',
        flow: 'protocol',
        step: 'unknown_channel_ignored',
        description: `Ignored a message on unknown channel ${unknownChannelId(err) ?? '(unreported)'} — the sender still holds a channel this device has dropped`,
        payload: { channelId: unknownChannelId(err), messageBytes },
      })
    } else {
      const detail = describeStorageFailure(errorText(err))
      this.deps.notify.error('Failed to process an incoming message', detail, { messageBytes })
      // Storage refused a write: a recovery in flight can no longer complete.
      // Applied once the batch commits — see `finishBatch`.
      if (detail !== errorText(err)) this.batchStorageFailure = detail
    }
  }

  /** Accept an action and fold what it produces. Reports rather than throws. */
  private async acceptAndFold(
    action: Uint8Array,
    current: Vault,
    failure: string,
    context: Record<string, unknown>,
  ): Promise<Vault> {
    const protocol = this.protocolInstance?.protocol
    if (!protocol) return current
    try {
      let updated = current
      for (const e of Array.from(await protocol.accept(action)) as DeRecEvent[]) {
        updated = this.applyEvent(updated, e)
      }
      return updated
    } catch (err) {
      this.deps.notify.error(failure, err, context)
      // Into the app's own console as well as the toast: an auto-accepted
      // request has no dialog, so a failure here — an `UpdateChannelInfo` this
      // vault could not apply, say — was otherwise visible only in devtools,
      // while the peer that sent it sat waiting for an answer.
      this.deps.log({
        role: 'owner',
        flow: 'pairing',
        step: 'auto_accept_failed',
        description: `${failure}: ${errorText(err)}`,
        payload: context,
      })
      return current
    }
  }

  /**
   * One protocol-time advance.
   *
   * The mailbox poll only moves protocol time forward when a message arrives,
   * so a round whose peers all go quiet — a helper that closed its tab — would
   * otherwise stay open forever. Shares the lock with the drain because `tick`
   * mutates the same round state `process` does, and shares its gate because
   * applying timeouts underneath an open confirmation would mutate the state
   * the owner is being asked about.
   */
  async tickOnce(): Promise<void> {
    if (this.ticking || this.blockedBy || this.drainPaused()) return
    this.ticking = true
    try {
      await this.withLock(async () => {
        const protocol = this.protocolInstance?.protocol
        if (!protocol) return

        const events = Array.from(await protocol.tick())
        // Stands in for the library's automatic sweep, which is disabled so a
        // human-paced fingerprint comparison is not deleted mid-flow.
        const swept = await protocol.removeExpiredChannels(PENDING_CHANNEL_TTL_SECS)
        if (swept.length > 0) {
          this.deps.log({
            role: 'owner',
            flow: 'pairing',
            step: 'pending_channels_swept',
            description: `Removed ${swept.length} pending channel(s) never confirmed out of band`,
            payload: { channelIds: swept },
          })
        }
        this.sweepAbandonedPairings()
        if (events.length === 0) return

        const initial = this.vault
        let updated = initial
        for (const event of events) {
          try {
            updated = this.applyEvent(updated, event)
          } catch (err) {
            this.deps.notify.error(`Failed to handle a ${event.type} event from tick`, err)
          }
        }
        if (updated !== initial) this.commit(updated)
      })
    } catch (err) {
      this.deps.notify.error('Protocol tick failed', err)
    } finally {
      this.ticking = false
    }
  }

  /**
   * Re-apply persisted offline flags. The backend holds its disabled set in
   * memory, so a backend restart forgets what this device marked offline.
   */
  private replayOfflineFlags(): void {
    for (const participant of this.vault.participants) {
      if (participant.offline) {
        this.io.markParticipantOffline(participant.id).catch(() => {})
      }
    }
  }

  /** Publish this vault's contact so peers can discover and pair with it. */
  private async publishContact(instance: ProtocolInstance): Promise<void> {
    const vaultId = this.vault.id
    try {
      // Inline keys: the peer pairs directly against this contact. HashedKeys
      // and NoKeys need the PrePair round-trip, which this signaling path does
      // not carry.
      const contact = await this.withLock(() =>
        instance.protocol.createContact(null, ContactMode.InlineKeys),
      )
      const contactChannelId = contact.channel_id.toString()
      await this.io.postBrowserContact(vaultId, JSON.stringify(contactMessageToDto(contact)))
      this.deps.log({
        role: 'owner',
        flow: 'pairing',
        step: 'owner_contact_posted',
        description: 'Contact published for peer discovery',
        payload: { vaultId, contactChannelId },
      })
    } catch (err) {
      this.deps.notify.error('Failed to publish the contact for peer discovery', err, { vaultId })
    }
  }

  /**
   * Replace the vault record, then tell storage and subscribers.
   *
   * The staged protect rounds ride along on every commit, read from the round
   * tracker at that moment — the one place both are known — so the persisted
   * record can never disagree with what is in flight. See
   * `Vault.pendingProtectRounds`.
   */
  commit(next: Vault): void {
    const staged = this.rounds.snapshotProtectRounds()
    const withRounds =
      staged.length > 0
        ? { ...next, pendingProtectRounds: staged }
        : next.pendingProtectRounds === undefined
          ? next
          : { ...next, pendingProtectRounds: undefined }
    // The verification challenges ride along the same way, for the same reason.
    const challenges = this.rounds.snapshotVerifications()
    const record =
      challenges.length > 0
        ? { ...withRounds, pendingVerifications: challenges }
        : withRounds.pendingVerifications === undefined
          ? withRounds
          : { ...withRounds, pendingVerifications: undefined }
    this.vault = record
    if (this.autoPairingDoneIn(record)) this.replaceAutoPairing([])
    this.deps.onVaultChange(record)
    this.emit()
  }

  // ── Commands ───────────────────────────────────────────────────────────────
  //
  // Everything a person can ask this vault to do. Each takes the protocol lock
  // around its WASM calls and commits through `commit`; nothing here opens a
  // dialog or switches a tab — the view does that around the call.
  //
  // `busy` means "an owner-initiated flow is in flight", not "a call is in
  // flight": verification, discovery, recovery and protect rounds stay busy
  // until their responses arrive or the watchdog fires. `runFlow` is what
  // guarantees a flow that fails to *start* does not leave it set, which would
  // wedge every control on the page until the watchdog.

  private async runFlow<T>(fn: () => Promise<T>): Promise<T> {
    this.setBusy(true)
    try {
      return await fn()
    } catch (err) {
      this.setBusy(false)
      throw err
    }
  }

  /** The protocol, or a legible error if the vault has not started. */
  private requireProtocol(): DeRecProtocol {
    const protocol = this.protocolInstance?.protocol
    if (!protocol) throw new Error('Protocol not initialized')
    return protocol
  }

  /** Mint a contact for a peer to pair against. */
  createContact(mode: ContactModeKey = DEFAULT_CONTACT_MODE): Promise<ContactMessage> {
    return this.withLock(async () => {
      const protocol = this.requireProtocol()
      // `NoKeys` contacts are meant to be dictated, so they carry a short
      // human-readable nonce rather than a random u64.
      const nonce = mode === 'no_keys' ? humanNonce() : null
      return protocol.createContact(null, toContactMode(mode), nonce)
    })
  }

  /**
   * Initiate pairing against `contact`, declaring `role` as our side.
   *
   * `role` is load-bearing: it is the only thing that reaches the wire as
   * `sender_kind`, and the responder derives the complement from it.
   */
  startPairing(contact: ContactMessage, role: PairingRole, peerName?: string): Promise<bigint> {
    // A completed pairing publishes the vault to the new peer on the library's
    // own initiative, which a diverged vault must not do — see `protect`.
    const conflict = this.vault.replicaConflict
    if (conflict) {
      return Promise.reject(
        new Error(`Pairing would publish this vault. ${replicaConflictBlockReason(conflict)}`),
      )
    }
    return this.withLock(async () => {
      const protocol = this.requireProtocol()
      const events = await this.forgetPendingOnFailure(() =>
        protocol.start(FlowKind.Pairing, {
          kind: senderKindFor(role),
          contact,
          peerCommunicationInfo: peerName ? { name: peerName } : {},
        }),
      )
      return pairingChannelIdFrom(events)
    })
  }

  /** Record a pairing this vault initiated, until `PairingCompleted` resolves it. */
  addPendingPairing(channelId: bigint, participantId?: string, peerTransportUri?: string): void {
    const pending: PendingPairing = { channelId, participantId, peerTransportUri }
    const others = this.vault.pendingPairings.filter(p => p.channelId !== channelId)
    this.commit({ ...this.vault, pendingPairings: [...others, pending] })
  }

  // ── Abandoned pairings ─────────────────────────────────────────────────────
  //
  // A pairing this vault started leaves a `Pending` channel record until the
  // peer answers. One that never will — the send failed, the peer refused, or
  // it never replied — left that record behind for good, out of sight: nothing
  // lists a `Pending` helper channel. Up to SDK 0.0.6 a single leftover also
  // aborted every broadcast flow with `missing_shared_key`; the library now
  // targets `Paired` channels only, so this is housekeeping rather than a
  // workaround — a record that can never complete is still dead weight in the
  // store. Each is forgotten here once it is known to be dead.

  /** The storage namespace this vault's instance reads. */
  private get namespace(): string {
    return `vault:${this.vault.id}`
  }

  /** The secret partition the running instance is bound to. */
  private get partition(): string {
    return this.protocolInstance?.secretId ?? this.vault.secretId
  }

  /**
   * Run a `start(Pairing)`; if it throws, forget the `Pending` record it wrote
   * before failing. The caller holds the lock.
   */
  private async forgetPendingOnFailure<T>(start: () => Promise<T>): Promise<T> {
    const before = new Set(listHelperChannels(this.namespace, this.partition).map(c => c.channelId))
    try {
      return await start()
    } catch (err) {
      const leaked = listHelperChannels(this.namespace, this.partition)
        .filter(c => c.status === 'Pending' && !before.has(c.channelId))
        .map(c => c.channelId)
      const reason = explainDeliveryFailure(errorText(err))
      this.forgetPendingChannels(leaked, `the pairing request could not be sent: ${reason}`)
      throw reason === errorText(err) ? err : new Error(reason, { cause: err })
    }
  }

  /**
   * Forget `Pending` channel records — never a channel past `Pending` — and
   * the pending-pairing entries naming them. The caller holds the lock.
   */
  private forgetPendingChannels(channelIds: readonly string[], reason: string): void {
    const doomed = channelIds.filter(
      id => readHelperChannelStatus(this.namespace, this.partition, id) === 'Pending',
    )
    if (doomed.length === 0) return
    for (const channelId of doomed) forgetHelperChannel(this.namespace, this.partition, channelId)

    const remaining = this.vault.pendingPairings.filter(p => !doomed.includes(p.channelId.toString()))
    if (remaining.length !== this.vault.pendingPairings.length) {
      this.commit({ ...this.vault, pendingPairings: remaining })
    }
    this.deps.log({
      role: 'owner',
      flow: 'pairing',
      step: 'abandoned_pairing_forgotten',
      description: `Removed ${doomed.length} unfinished pairing channel(s) — ${reason}`,
      payload: { channelIds: doomed },
    })
  }

  /**
   * Forget the pairings this vault started that can no longer complete: still
   * `Pending` past the protocol timeout, by which point the peer's answer would
   * be refused as stale even if it came. Runs from the tick and once at start.
   * The caller holds the lock.
   *
   * Only channels this vault *started* are considered. A `Pending` channel can
   * also be a completed handshake waiting on a human fingerprint comparison —
   * every `NoKeys` and replica pairing — and those are the tick's hour-long
   * sweep's to expire, never this one's.
   */
  private sweepAbandonedPairings(): void {
    if (this.vault.pendingPairings.length === 0) return
    const started = new Set(this.vault.pendingPairings.map(p => p.channelId.toString()))
    const cutoffSecs = (Date.now() - this.protocolTimeoutMs() - ABANDONED_PAIRING_GRACE_MS) / 1000
    const stale = listHelperChannels(this.namespace, this.partition)
      .filter(
        c =>
          started.has(c.channelId) &&
          c.status === 'Pending' &&
          c.createdAtSecs !== null &&
          c.createdAtSecs < cutoffSecs,
      )
      .map(c => c.channelId)
    this.forgetPendingChannels(stale, 'the peer did not answer within the protocol timeout')
  }

  /**
   * The confirmed replica destinations a `ProtectSecret` round mirrors to.
   *
   * `ProtectSecretParams` carries no target list — the library fans out from
   * its own channel table, sending a `StoreShareRequest` to each paired helper
   * and a `ReplicaSecretPayload` to each paired replica destination. So this
   * does not select targets; it reproduces the selection for the console, which
   * is the only way to tell a destination that never acked from one that was
   * never sent to.
   *
   * Best-effort by design: a failed roster read must not fail a round the
   * library has already dispatched, so it degrades to an empty list.
   */
  private async confirmedReplicaTargets(): Promise<ReplicaSyncTarget[]> {
    try {
      const roster = await apiGetActors()
      return replicaSyncTargets(replicaViews(roster, loadReplicaState(this.vault.id)))
    } catch {
      return []
    }
  }

  /**
   * Dispatch one `ProtectSecret` round carrying `secrets`, stage the bag version
   * it produces, and report what the round is expected to reach.
   *
   * The single `start(FlowKind.ProtectSecret, …)` call site in the app: adding a
   * secret and the replica sync both come through here, so a round is
   * dispatched, versioned and staged in exactly one way.
   *
   * Returns `null` when the library dispatched no round; that failure is already
   * reported and the pending bag already unwound.
   */
  protect(
    secrets: UserSecret[],
    options: { resolvesReplicaConflict?: boolean } = {},
  ): Promise<ProtectRoundResult | null> {
    // Belt and braces behind the blocked screen: the instance still installed
    // after a failed adoption reads an erased namespace, so protecting a secret
    // here would build a bag against channels that no longer exist.
    if (this.blockedBy) {
      return Promise.reject(
        new Error(
          'This device is blocked: adopting a mirrored vault failed after its own vault was erased.',
        ),
      )
    }
    // Every publish comes through here — Add Secret, removing one, Sync now,
    // the automatic first sync of a new replica, the identity republish — so
    // this is the one gate that keeps a diverged vault from publishing. The
    // publish that resolves the conflict is the only one let through.
    const conflict = this.vault.replicaConflict
    if (conflict && !options.resolvesReplicaConflict) {
      return Promise.reject(new Error(replicaConflictBlockReason(conflict)))
    }
    return this.runFlow(async () => {
      const protocol = this.requireProtocol()

      // Both checked before anything is sent. A round sends each helper its
      // share *before* storing this side's copy, so running out of room
      // part-way left helpers holding a version this vault never recorded.
      const sizeProblem = bagSizeProblem(secrets)
      if (sizeProblem) throw new Error(sizeProblem)
      const shareTargets = this.vault.participants.filter(isShareTarget).length
      if (!hasStorageHeadroom(protectFootprintChars(bagBytes(secrets), shareTargets))) {
        throw new Error(`${STORAGE_FULL_MESSAGE} Nothing was sent, and the bag is unchanged.`)
      }

      // The JS shape the WASM binding expects.
      const wasmSecrets = secrets.map(s => ({
        id: userSecretIdBytes(s.id),
        name: s.name,
        data: new TextEncoder().encode(s.data),
      }))

      const startedAt = Date.now()
      let startEvents: DeRecEvent[]
      try {
        startEvents = await this.withLock(() =>
          protocol.start(FlowKind.ProtectSecret, { secrets: wasmSecrets, description: 'DeRec Vault' }),
        )
      } catch (err) {
        if (takeStorageQuotaFailure(startedAt)) {
          throw new Error(
            `${STORAGE_FULL_MESSAGE} The round stopped part-way, so some helpers may already hold ` +
              'the new version; publish again once there is room and they are brought back in step.',
            { cause: err },
          )
        }
        throw new Error(await this.unreachableReason('The round was not sent', err), { cause: err })
      }

      // Take the version the library assigned rather than deriving one: it also
      // bumps on pair-completion auto-publish, so any locally-computed number
      // drifts and the SharingComplete match silently fails — leaving the bag
      // uncommitted even though helpers stored their shares.
      startEvents = this.withDeliveryReasons(startEvents)
      const newVersion = protectVersionFrom(startEvents)
      const dispatched = startEvents.flatMap(e => (e.type === 'ProtectSecretStarted' ? [e.channel_id] : []))
      const undelivered = startEvents.flatMap(e => (e.type === 'ProtectSecretFailed' ? [e] : []))
      if (newVersion === null || (dispatched.length === 0 && undelivered.length > 0)) {
        this.setBusy(false)
        // The library sends each share request as it starts the round, so a
        // stopped backend looks exactly like "nobody to send to" from here.
        // Telling them apart matters: one is fixed by starting the server, the
        // other by pairing participants, and naming the wrong one sends the
        // user off to fix something that is fine.
        if (!(await this.io.serverReachable())) {
          throw new Error(
            'Cannot reach the DeRec server, so no share requests went out and the bag is unchanged. Start the backend, then try again.',
          )
        }
        if (undelivered.length > 0) {
          throw new Error(
            `None of the ${undelivered.length} share request(s) could be delivered, so the bag is ` +
              `unchanged. ${describeStorageFailure(undelivered[0].error)}`,
          )
        }
        throw new Error(
          'The protocol dispatched no share requests, so the bag is unchanged — check that enough participants are paired.',
        )
      }

      // Read after the await: the drain may have committed while `start` ran.
      const current = this.vault
      const existingBag = current.secretBag
      const pairedParticipants = current.participants.filter(isShareTarget)

      // The new bag version — not committed to the vault until SharingComplete.
      const newBagVersion: BagVersion = {
        version: newVersion,
        participantIds: [],
        verifiedParticipantIds: [],
        failedParticipantIds: [],
        secrets,
        rawBytes: '',
        helpers: pairedParticipants.map(h => ({ id: h.id, name: h.name, channelId: h.channelId })),
        // Read after `start` from the same store the library just built the
        // secret's `replicas` from, by the same rule.
        replicas: replicaGroupFromStore(
          listReplicaMembers(`vault:${current.id}`, current.secretId),
          getOrCreateReplicaId(current.id).toString(),
        ),
      }
      const pendingBag: SecretBag = existingBag
        ? {
            ...existingBag,
            currentVersion: newBagVersion,
            previousVersions: [existingBag.currentVersion, ...existingBag.previousVersions],
          }
        : {
            secretId: current.secretId,
            currentVersion: newBagVersion,
            previousVersions: [],
            threshold: current.minParticipants,
          }
      this.beginProtectRound({
        bag: pendingBag,
        version: newVersion,
        protocolSecretId: current.secretId,
        channelIds: pairedParticipants.map(h => h.channelId),
      })

      // A share request that could not be delivered will never be answered:
      // its row is settled as refused now, not left waiting on the round
      // timeout behind a dialog that cannot be closed meanwhile.
      const notDelivered = new Map(undelivered.map(e => [e.channel_id, e.error]))
      for (const [channelId, error] of notDelivered) {
        this.rounds.dropShare(channelId, newVersion)
        const participant = pairedParticipants.find(p => p.channelId === channelId)
        if (participant) {
          this.rounds.recordShareFailed(newVersion, {
            id: participant.id,
            status: 0,
            memo: `${UNDELIVERED_MEMO}: ${error}`,
          })
        }
      }

      // Mark participants with pending shares so the modal can track progress,
      // clearing any stale marks for this version from a previous failed attempt.
      this.commit({
        ...current,
        participants: current.participants.map(h =>
          pairedParticipants.some(ph => ph.id === h.id)
            ? {
                ...h,
                secretShares: [
                  ...h.secretShares.filter(s => s.version !== newVersion),
                  notDelivered.has(h.channelId)
                    ? {
                        version: newVersion,
                        status: 'rejected' as const,
                        verified: false,
                        failure: { status: 0, memo: `${UNDELIVERED_MEMO}: ${notDelivered.get(h.channelId)}` },
                      }
                    : { version: newVersion, status: 'pending' as const, verified: false },
                ],
              }
            : h,
        ),
      })

      // Too few requests went out for the round ever to reach its threshold:
      // say so now rather than after the round times out.
      if (notDelivered.size > 0 && dispatched.length < current.minParticipants) {
        this.failSharingRound(
          newVersion,
          `only ${dispatched.length} of ${pairedParticipants.length} share request(s) could be delivered`,
        )
      }

      // The same `start` fans out to confirmed replica destinations. They never
      // enter the bag roster, so record what the round is expected to reach
      // separately. Log-only: an inbound `ReplicaSecretAcked` resolves purely by
      // `channel_id`, never against this list.
      const replicaTargets = await this.confirmedReplicaTargets()

      return { version: newVersion, participants: pairedParticipants, replicaTargets }
    })
  }

  /**
   * Add a secret to the bag and distribute the new version.
   *
   * Returns the version the *library* assigned, not one derived here: rounds are
   * keyed by version and several can run at once, so anything watching this
   * round has to be told which one it is. `null` if no round was dispatched.
   */
  async addSecret(name: string, data: string): Promise<number | null> {
    // Per-user-secret ids are application-level random identifiers, hex-encoded.
    const idBytes = crypto.getRandomValues(new Uint8Array(16))
    const id = Array.from(idBytes).map(b => b.toString(16).padStart(2, '0')).join('')
    const newSecret: UserSecret = { id, name, data }
    // On top of the newest bag asked for, not just the committed one — a
    // secret whose round is still open must not drop out of this one.
    const allSecrets = [...this.rounds.latestSecrets(this.vault.secretBag), newSecret]

    const round = await this.protect(allSecrets)
    if (!round) return null

    this.deps.log({
      role: 'owner',
      flow: 'sharing',
      step: 'protect_secret',
      description: `Secret "${name}" added to bag (v${round.version}), distributed to ${round.participants.length} participant(s) and mirrored to ${round.replicaTargets.length} replica(s)`,
      payload: {
        version: round.version,
        secretCount: allSecrets.length,
        replicas: round.replicaTargets.map(r => ({ name: r.name, channelId: r.channelId })),
      },
    })
    return round.version
  }

  /**
   * Drop a secret from the bag and distribute the new version without it.
   *
   * Only the current version changes: earlier versions — and the shares helpers
   * hold for them — still carry it, which the confirmation dialog says. Returns
   * the library-assigned version, as `addSecret` does; `null` if no round was
   * dispatched.
   */
  async removeSecret(secretId: string): Promise<number | null> {
    const current = this.rounds.latestSecrets(this.vault.secretBag)
    const removed = current.find(s => s.id === secretId)
    if (!removed) throw new Error('That secret is no longer in the current version of the bag.')
    const remaining = current.filter(s => s.id !== secretId)

    const round = await this.protect(remaining)
    if (!round) return null

    this.deps.log({
      role: 'owner',
      flow: 'sharing',
      step: 'remove_secret',
      description: `Secret "${removed.name}" removed from bag (v${round.version}), distributed to ${round.participants.length} participant(s) and mirrored to ${round.replicaTargets.length} replica(s)`,
      payload: {
        version: round.version,
        secretCount: remaining.length,
        replicas: round.replicaTargets.map(r => ({ name: r.name, channelId: r.channelId })),
      },
    })
    return round.version
  }

  // ── Replica conflicts ──────────────────────────────────────────────────────
  //
  // The library README's procedure, from the app's side: the vault is marked
  // diverged when the conflict is reported (`fold/replica.ts`) and `protect`
  // refuses to publish from then on; the owner fetches the rival copy, merges,
  // and publishes the result once, here.

  /**
   * Ask the replica group for its copy of the vault, so the owner has the
   * rival to merge with. After a `ReplicaSyncRejected` this device holds only
   * its own copy; the group's arrives as a `ReplicaVersionConflict`, which the
   * fold records on `replicaConflict.rivalSecrets`.
   */
  async fetchReplicaConflictRival(): Promise<void> {
    if (!this.vault.replicaConflict) return
    const events = await this.discoverReplicas()
    this.deps.log({
      role: 'owner',
      flow: 'sharing',
      step: 'replica_conflict_rival_requested',
      description:
        "Asked the replica group for its copy of this vault, to merge with this device's — " +
        'it is offered here when it arrives',
      payload: { events: events.map(e => e.type) },
    })
  }

  /**
   * Publish the owner's resolution of a replica conflict: `secrets` — this
   * device's copy, the rival's, or a merge of the two — as one new version.
   *
   * That version is newer than both copies, so every member and helper takes
   * it, and the conflict is over everywhere. The vault stops being diverged as
   * soon as the round is dispatched; one that never goes out leaves it
   * diverged. Returns the round's version, or `null` when none was dispatched.
   */
  async resolveReplicaConflict(secrets: UserSecret[]): Promise<number | null> {
    const conflict = this.vault.replicaConflict
    if (!conflict) throw new Error('There is no replica conflict to resolve on this vault.')
    if (secrets.length === 0) {
      throw new Error('Keep at least one secret: a vault with nothing in it cannot be published.')
    }

    const round = await this.protect(secrets, { resolvesReplicaConflict: true })
    if (!round) return null

    this.commit({ ...this.vault, replicaConflict: undefined })
    this.deps.log({
      role: 'owner',
      flow: 'sharing',
      step: 'replica_conflict_resolved',
      description:
        `Replica conflict at v${conflict.version} resolved: published v${round.version} with ` +
        `${secrets.length} secret(s) to ${round.participants.length} participant(s) and ` +
        `${round.replicaTargets.length} replica(s). Publishing from this vault is resumed.`,
      payload: { conflictVersion: conflict.version, version: round.version, secretCount: secrets.length },
    })
    return round.version
  }

  /**
   * Mirror this vault to every replica destination the library holds `Paired`.
   *
   * Runs the ordinary protect round — the library mirrors to each such
   * destination on its own, so "sync now" *is* "protect now". `reason` only
   * colours the log line.
   *
   * With nothing in the bag there is nothing to mirror, and a round carrying no
   * secrets would only churn the version, so that is reported as
   * `nothing-to-mirror` rather than dispatched.
   */
  async syncReplicas(reason: ReplicaSyncReason): Promise<ReplicaSyncRoundResult> {
    const secrets = this.rounds.latestSecrets(this.vault.secretBag)
    if (secrets.length === 0) {
      this.deps.log({
        role: 'owner',
        flow: 'sharing',
        step: 'replica_sync_skipped',
        description:
          reason === 'manual'
            ? 'A replica sync was requested, but this vault holds no secrets yet — there is nothing to mirror'
            : 'A replica destination was confirmed, but this vault holds no secrets yet — it will receive them on the first protect round',
        payload: { reason },
      })
      return 'nothing-to-mirror'
    }

    const round = await this.protect([...secrets])
    if (!round) {
      // Already reported, and the pending bag unwound. Surfacing it as a
      // dispatch would tell the user a copy is on its way.
      throw new Error('The protocol dispatched no share requests — check that helpers are paired.')
    }

    this.deps.log({
      role: 'owner',
      flow: 'sharing',
      step: reason === 'manual' ? 'replica_sync_requested' : 'replica_sync_on_pairing',
      description:
        reason === 'manual'
          ? `Replica sync requested — vault mirrored in round v${round.version} to ${round.replicaTargets.length} replica(s)`
          : `Replica destination confirmed — vault mirrored in round v${round.version} to ${round.replicaTargets.length} replica(s)`,
      payload: {
        version: round.version,
        reason,
        replicas: round.replicaTargets.map(r => ({ name: r.name, channelId: r.channelId })),
      },
    })
    return 'dispatched'
  }

  /**
   * Challenge every participant that confirmed `version` to prove it still
   * holds its share. Resolves with the channels the challenge could not be
   * sent on; rejects, in words the owner can act on, when none went out.
   */
  verifyShares(version: number): Promise<VerifyDispatch> {
    return this.runFlow(async () => {
      this.armWatchdog()
      const protocol = this.requireProtocol()

      const current = this.vault
      const bag = current.secretBag
      if (!bag) throw new Error('No secret bag — protect a secret first')

      const bagVersion = bagVersionOf(bag, version)
      if (!bagVersion) throw new Error(`Version ${version} not found in bag`)
      // The library's contract, not a fault: say so before it says it worse.
      if (bagVersion.restoredFromRecovery) throw new Error(restoredVersionReason(version))

      // Only participants that confirmed this version are challenged — and only
      // over a channel the library still holds `Paired`. One that is not (a
      // helper since unpaired or forgotten) is reported as not reached: the
      // library would drop it from the target without a word (SDK 0.0.7), and
      // its row would then wait for an answer that cannot come.
      const confirmed = current.participants.filter(
        h => bagVersion.participantIds.includes(h.id) && h.channelId,
      )
      const reachable = confirmed.filter(h => this.isPairedHelperChannel(h.channelId))
      const notPaired = confirmed.filter(h => !reachable.includes(h)).map(h => h.channelId)
      if (reachable.length === 0) {
        throw new Error(
          confirmed.length === 0
            ? `No participant confirmed v${version}, so there is nobody to challenge.`
            : `None of the participants holding v${version} is still paired with this vault.`,
        )
      }

      // Clear prior results so this run tracks fresh responses.
      this.commit({
        ...current,
        secretBag: updateBagVersion(bag, version, v => ({
          ...v,
          verifiedParticipantIds: [],
          verifyRejections: undefined,
        })),
      })

      const deadline = Date.now() + VERIFICATION_ANSWER_WINDOW_MS
      for (const participant of reachable) {
        this.rounds.beginVerification(participant.channelId, {
          protocolSecretId: bag.secretId,
          version,
          deadline,
        })
      }
      // Persist the challenges before anything can be answered.
      this.commit(this.vault)

      let startEvents: DeRecEvent[]
      try {
        startEvents = Array.from(
          await this.withLock(() =>
            protocol.start(FlowKind.VerifyShares, {
              secretId: bag.secretId,
              version,
              target: reachable.map(h => BigInt(h.channelId)),
            }),
          ),
        )
      } catch (err) {
        for (const participant of reachable) this.rounds.endVerification(participant.channelId)
        this.commit(this.vault)
        throw new Error(
          describeVerifyFailure(await this.unreachableReason('No challenge was sent', err), version),
          { cause: err },
        )
      }

      startEvents = this.withDeliveryReasons(startEvents)
      const failed = startEvents.flatMap(e => (e.type === 'VerifySharesFailed' ? [e] : []))
      for (const event of failed) this.rounds.endVerification(event.channel_id)
      for (const event of failed) {
        this.deps.log({
          role: 'owner',
          flow: 'verification',
          step: 'VerifySharesFailed',
          description: `Verification challenge could not be sent on channel ${event.channel_id}: ${event.error}`,
          payload: { channelId: event.channel_id, version, error: event.error },
        })
      }
      if (failed.length > 0 && !startEvents.some(e => e.type === 'VerifySharesStarted')) {
        throw new Error(describeVerifyFailure(failed[0].error, version))
      }

      this.deps.log({
        role: 'owner',
        flow: 'verification',
        step: 'verify_shares',
        description: `Verification challenges sent for bag v${version} to ${reachable.length - failed.length} participant(s)`,
        payload: { version, participantCount: confirmed.length, failed: failed.length, notPaired },
      })
      return { failedChannelIds: [...failed.map(e => e.channel_id), ...notPaired] }
    })
  }

  /**
   * Ask every paired helper which secrets it holds shares for.
   *
   * Rejects, in words the owner can act on, when no request went out — no
   * paired helper, the server down, or every helper unreachable. A helper that
   * could not be reached, or never answers, is marked so on its row rather
   * than left "Pending" for good.
   */
  requestDiscovery(): Promise<void> {
    return this.runFlow(async () => {
      const protocol = this.requireProtocol()

      // Explicit, and paired only — the library does the same filtering itself
      // (SDK 0.0.7), but the rows asked are marked below, so the list has to be
      // known here.
      const targets = this.pairedHelperChannelIds('Helper')
      if (targets.length === 0) {
        throw new Error(
          'No paired helper to ask. Pair with the helpers that hold your shares, then discover again.',
        )
      }

      // Every row asked starts over, so an earlier answer cannot stand in for
      // this one — and a helper that never answers is visibly still waiting.
      const asked = new Set(targets)
      this.commit({
        ...this.vault,
        participants: this.vault.participants.map(p =>
          asked.has(p.channelId) ? { ...p, discoveryComplete: false, discoveryError: undefined } : p,
        ),
      })
      this.discoveryTargets = asked
      this.armWatchdog()

      let events: DeRecEvent[]
      try {
        events = Array.from(
          await this.withLock(() =>
            protocol.start(FlowKind.Discovery, { target: targets.map(id => BigInt(id)) }),
          ),
        )
      } catch (err) {
        this.discoveryTargets = null
        throw new Error(await this.unreachableReason('No discovery request was sent', err), { cause: err })
      }
      events = this.withDeliveryReasons(events)
      this.commitFolded(events)
      for (const event of events) {
        if (event.type === 'DiscoveryFailed') this.discoveryTargets?.delete(event.channel_id)
      }

      const sent = events.filter(e => e.type === 'DiscoveryStarted').length
      this.deps.log({
        role: 'owner',
        flow: 'recovery',
        step: 'request_discovery',
        description: `Discovery requested from ${sent} of ${targets.length} paired helper(s)`,
        payload: { channelIds: targets, sent },
      })
      const failure = events.find(e => e.type === 'DiscoveryFailed')
      if (sent > 0 || !failure) return

      this.discoveryTargets = null
      throw new Error(
        await this.unreachableReason(
          'No helper could be reached, so nothing was asked',
          failure.type === 'DiscoveryFailed' ? failure.error : undefined,
        ),
      )
    })
  }

  /** The channels the discovery in flight asked, or `null` when none is. */
  private discoveryTargets: Set<string> | null = null

  /**
   * A discovery's answers stopped arriving before every helper replied. The
   * silent ones are marked so their rows stop reading "Pending".
   */
  private markDiscoveryUnanswered(): void {
    const asked = this.discoveryTargets
    this.discoveryTargets = null
    if (!asked) return
    const reason = `No answer within ${Math.round(this.flowTimeoutMs / 1000)}s — the helper may be offline or gone.`
    let marked = 0
    const participants = this.vault.participants.map(p => {
      if (!asked.has(p.channelId) || p.discoveryComplete || p.discoveryError) return p
      marked++
      return { ...p, discoveryError: reason }
    })
    if (marked > 0) this.commit({ ...this.vault, participants })
  }

  /**
   * Why a request went nowhere, phrased for the owner: a server that does not
   * answer at all is named as such, since that is fixed by starting it rather
   * than by anything about the helpers.
   */
  private async unreachableReason(what: string, cause?: unknown): Promise<string> {
    let reachable = true
    try {
      reachable = await this.io.serverReachable()
    } catch {
      reachable = false
    }
    if (!reachable) {
      return `${what}: the DeRec server cannot be reached. Start the backend (or check your connection), then try again.`
    }
    return cause === undefined
      ? `${what}.`
      : `${what}: ${explainDeliveryFailure(describeStorageFailure(errorText(cause)))}`
  }

  /** Request the shares for one `(secretId, version)` from the helpers holding them. */
  recover(
    secretId: string,
    version: number,
    label: string,
    participantChannelIds: bigint[],
  ): Promise<void> {
    return this.runFlow(async () => {
      const protocol = this.requireProtocol()

      this.rounds.beginRecovery({ secretId, version, label })
      this.armWatchdog()
      const current = this.vault
      // Drop any prior failure for THIS (secretId, version) so its row drops back
      // to "Recovering…" instead of clinging to the previous "Incomplete".
      // Failures on other versions are preserved.
      this.commit({
        ...current,
        recoveryProgress: {
          secretId,
          version,
          sharesReceived: 0,
          totalRequested: participantChannelIds.length,
          requestedChannelIds: participantChannelIds.map(id => id.toString()),
          error: null,
        },
        recoveryFailures: removeRecoveryFailure(current.recoveryFailures, secretId, version),
      })
      let startEvents: DeRecEvent[]
      try {
        startEvents = Array.from(
          await this.withLock(() =>
            protocol.start(FlowKind.RecoverSecret, { secretId: BigInt(secretId), version }),
          ),
        )
      } catch (err) {
        const message = await this.unreachableReason('No share request was sent', err)
        this.failRecovery(secretId, version, message)
        throw new Error(message, { cause: err })
      }

      this.deps.log({
        role: 'owner',
        flow: 'recovery',
        step: 'recover_secret',
        description: `Recovery requested for "${label}" v${version} from ${participantChannelIds.length} participant(s)`,
        payload: { secretId, version, channels: participantChannelIds.map(c => c.toString()) },
      })

      // `start` reports one dispatch result per channel it reached. Surfacing
      // them is what separates "requests are in flight" from "nothing was sent",
      // which otherwise looks identical: a progress bar parked at 0 received.
      for (const event of startEvents) {
        if (event.type !== 'RecoverSecretFailed') continue
        this.deps.log({
          role: 'owner',
          flow: 'recovery',
          step: 'RecoverSecretFailed',
          description: `Share request could not be dispatched on channel ${event.channel_id}: ${event.error}`,
          payload: { channelId: event.channel_id, error: event.error },
        })
      }

      startEvents = this.withDeliveryReasons(startEvents)
      const started = startEvents.flatMap(e => (e.type === 'RecoverSecretStarted' ? [e.channel_id] : []))
      if (started.length > 0) {
        // The library asks every paired helper — `RecoverSecretParams` takes no
        // target list — but only those discovery found holding this version can
        // send a share; from SDK 0.0.7 the others answer `RecoveryShareRefused`
        // (`UNKNOWN_SHARE_VERSION`). The progress counts the holders that were
        // actually asked, and remembers which they are, so a non-holder's
        // refusal is not taken for one of their answers.
        const holders = new Set(participantChannelIds.map(id => id.toString()))
        const askedHolders = started.filter(id => holders.has(id))
        const expected = askedHolders.length > 0 ? askedHolders : started
        if (this.vault.recoveryProgress && this.vault.recoveryProgress.totalRequested !== expected.length) {
          this.commit({
            ...this.vault,
            recoveryProgress: {
              ...this.vault.recoveryProgress,
              totalRequested: expected.length,
              requestedChannelIds: expected,
            },
          })
        }
        return
      }

      // The protocol looks for the channels to ask under the partition of the
      // secret being recovered. A device whose instance is bound to a different
      // secret has none there, so nothing goes on the wire and no response can
      // ever arrive — fail now instead of waiting out the watchdog.
      const vaultSecretId = this.vault.secretId
      const firstFailure = startEvents.find(e => e.type === 'RecoverSecretFailed')
      const message =
        secretId !== vaultSecretId
          ? `This device is bound to secret ${vaultSecretId}, but "${label}" belongs to secret ${secretId}, ` +
            'and no share requests were sent. Set up again in recovery mode and claim the original ' +
            'owner actor so this device binds to the secret being recovered.'
          : firstFailure?.type === 'RecoverSecretFailed'
            ? await this.unreachableReason('No helper could be reached, so no share was requested', firstFailure.error)
            : 'No helper channel could be reached for this secret. Pair with the helpers holding it and try again.'

      this.failRecovery(secretId, version, message)

      this.deps.log({
        role: 'owner',
        flow: 'recovery',
        step: 'recover_secret_not_dispatched',
        description: message,
        payload: { secretId, vaultSecretId, version },
      })
      this.deps.notify.error('Recovery request was not sent to any helper', message, {
        secretId,
        vaultSecretId,
        version,
      })
    })
  }

  /** End the recovery of `(secretId, version)` in `message`, on its row and in the progress. */
  private failRecovery(secretId: string, version: number, message: string): void {
    this.setBusy(false)
    this.rounds.takeRecovery()
    const failed = this.vault
    this.commit({
      ...failed,
      recoveryProgress: failed.recoveryProgress
        ? { ...failed.recoveryProgress, error: message }
        : failed.recoveryProgress,
      recoveryFailures: upsertRecoveryFailure(failed.recoveryFailures, secretId, version, message),
    })
  }

  /**
   * Restore this vault from a recovered secret — see `commands/restore.ts`.
   * Reports its own failures. Returns whether the restore committed.
   */
  restoreFromRecovered(secret: RecoveredSecret): Promise<boolean> {
    return restoreVault(secret, this.commandContext)
  }

  /**
   * Adopt a mirrored vault offered by a replica source — see
   * `commands/adoption.ts`. Destructive; runs only on an explicit confirmation,
   * and blocks this vault if it fails after the wipe.
   */
  adoptReplica(adoption: PendingReplicaAdoption): Promise<void> {
    return adoptMirroredVault(adoption, {
      ...this.commandContext,
      block: failure => this.block(failure),
    })
  }

  /**
   * Ask the replica group which version its members hold.
   *
   * `ReplicaDiscoveryComplete` reports the outcome, and a hydration event
   * follows only if this device actually was behind.
   */
  async discoverReplicas(): Promise<readonly DeRecEvent[]> {
    const events = await startReplicaDiscovery(this.replicaProtocol)
    this.commitFolded(events)
    return events
  }

  /**
   * Announce the eviction of `peerReplicaId` from the replica group.
   *
   * Only the first of two steps: `start(RemoveReplica)` flags the member so the
   * next roster omits it, and the caller still has to publish that roster.
   */
  async announceReplicaEviction(peerReplicaId: string): Promise<void> {
    const events = await removeReplicaMember(
      this.replicaProtocol,
      peerReplicaId,
      `Removed by ${this.vault.name}`,
    )
    this.commitFolded(events)
  }

  /**
   * Drop the app-side records of an evicted replica member, and its participant
   * row when there is one. Unconditional by design: these are not reachable from
   * the library, so nothing else ever clears them.
   */
  forgetReplicaMember(peerReplicaId: string, channelId: string | null): void {
    forgetReplicaMember(this.vault.id, peerReplicaId)
    if (!channelId) return
    this.commit({
      ...this.vault,
      participants: this.vault.participants.filter(p => p.channelId !== channelId),
    })
  }

  /** The owner has seen a corrupted-share warning and closed it. */
  dismissCorruptShareReport(report: CorruptShareReport): void {
    const reports = this.vault.corruptShareReports ?? []
    const remaining = reports.filter(
      r => !(r.channelId === report.channelId && r.version === report.version && r.reason === report.reason),
    )
    if (remaining.length === reports.length) return
    this.commit({ ...this.vault, corruptShareReports: remaining.length > 0 ? remaining : undefined })
  }

  /** Fold events a command produced, committing only if something changed. */
  private commitFolded(events: readonly DeRecEvent[]): void {
    const initial = this.vault
    let updated = initial
    for (const event of events) updated = this.applyEvent(updated, event)
    if (updated !== initial) this.commit(updated)
  }

  /**
   * Send `start(Unpair)` on a channel.
   *
   * Terminal `Unpaired` / `UnpairRejected` events are what normally settle the
   * unpair — see `unpairSettled`. A dispatch failure is reported here and
   * returned with its reason, so the view can offer to forget the channel
   * locally when the peer is gone.
   */
  async unpair(channelId: string, peerName: string, participantId: string): Promise<UnpairDispatch> {
    const protocol = this.protocolInstance?.protocol
    if (!protocol) {
      const reason = 'Unpair failed: protocol not initialised'
      this.deps.notify.error(reason)
      return { dispatched: false, reason }
    }
    try {
      await this.withLock(() =>
        protocol.start(FlowKind.Unpair, { channel_id: channelId, memo: `unpair ${peerName}` }),
      )
      this.deps.log({
        role: 'owner',
        flow: 'unpairing',
        step: 'unpair_started',
        description: `Unpair request sent on channel ${channelId} (${peerName})`,
        payload: {
          channelId,
          participantId,
          unpairAck: resolveVaultConfig(this.vault.configOverrides, this.deps.getServerDefaults())
            .unpairAck,
        },
      })
      return { dispatched: true }
    } catch (err) {
      const reason = await this.unreachableReason(`The unpair request could not be sent to ${peerName}`, err)
      this.deps.notify.error('Failed to start unpair flow', reason, { channelId, participantId })
      return { dispatched: false, reason }
    }
  }

  /**
   * Remove a helper channel from this device alone, telling nobody.
   *
   * For a peer that can no longer agree to an unpair — deleted from its node,
   * or gone for good — where `unpair` can only fail. Drops the channel from the
   * library's stores and from the vault record exactly as a completed unpair
   * would. The peer, if it still exists, keeps its side of the channel and any
   * share it holds.
   */
  async forgetChannel(channelId: string): Promise<void> {
    if (this.blockedBy) throw new Error('This device is blocked; nothing can be changed on it.')
    const peer = this.vault.participants.find(p => p.channelId === channelId)
    await this.withLock(async () => {
      forgetHelperChannel(this.namespace, this.partition, channelId)
      this.commit(withoutChannel(this.vault, channelId))
    })
    this.effects.unpairSettled(channelId)
    this.effects.channelsLinked()
    this.deps.log({
      role: 'owner',
      flow: 'unpairing',
      step: 'channel_forgotten',
      description: `Channel ${channelId}${peer ? ` (${peer.name})` : ''} removed from this device only — the peer was not told`,
      payload: { channelId, participantId: peer?.id ?? null },
    })
    this.deps.notify.info(`${peer?.name ?? 'Channel'} forgotten on this device (channel ${channelId})`)
  }

  /**
   * Link two channels (undirected, transitive) and record the merged group's
   * "main" — name-bearing — channel.
   *
   * Throws if the channel store is not initialised; callers must handle.
   */
  async linkChannels(
    sourceChannelId: string,
    targetChannelId: string,
    options?: { mainChannelId?: string },
  ): Promise<void> {
    const channelStore = this.protocolInstance?.channelStore
    if (!channelStore) throw new Error('Channel store not initialized')

    // Choose the merged group's main channel BEFORE linking, from the pre-link
    // closures:
    //  - `options.mainChannelId` wins when the caller knows which side carries
    //    the identity (accept-and-link, where the source was only named by
    //    whatever the requester declared on the wire)
    //  - if the source's group already has >1 channel, it keeps its main
    //  - else if the target's group already has >1 channel, it keeps its main
    //  - else (two singletons) the clicked source is main
    const cur = this.vault
    const secretId = cur.secretId
    const pairedIds = new Set(
      cur.participants
        .filter(p => p.connectionStatus === 'paired' && p.channelId)
        .map(p => p.channelId),
    )
    const srcClosure = (await channelStore.linkedChannels(secretId, sourceChannelId))
      .filter(id => pairedIds.has(id))
    const tgtClosure = (await channelStore.linkedChannels(secretId, targetChannelId))
      .filter(id => pairedIds.has(id))
    const mains = cur.mainChannels ?? []
    const srcMain = srcClosure.find(id => mains.includes(id))
    const tgtMain = tgtClosure.find(id => mains.includes(id))

    let newMain: string
    if (options?.mainChannelId) newMain = options.mainChannelId
    else if (srcClosure.length > 1) newMain = srcMain ?? sourceChannelId
    else if (tgtClosure.length > 1) newMain = tgtMain ?? targetChannelId
    else newMain = sourceChannelId

    // Drop prior mains inside the merged component, then record the one chosen.
    const mergedIds = new Set<string>([...srcClosure, ...tgtClosure, sourceChannelId, targetChannelId])
    const nextMains = mains.filter(id => !mergedIds.has(id))
    nextMains.push(newMain)
    this.commit({ ...this.vault, mainChannels: nextMains })

    await channelStore.linkChannel(secretId, sourceChannelId, targetChannelId)
    this.effects.channelsLinked()
    this.deps.log({
      role: 'owner',
      flow: 'pairing',
      step: 'channel_linked',
      description: `Linked channel ${sourceChannelId} ↔ ${targetChannelId} (group main ${newMain})`,
      payload: { sourceChannelId, targetChannelId, mainChannelId: newMain },
    })
  }

  // ── Roster ─────────────────────────────────────────────────────────────────

  /**
   * Reconcile this vault's participants with the node's actor roster.
   *
   * Takes the roster rather than fetching it: `apiGetActors()` returns the same
   * node-wide list for every vault, so the fetch belongs to whoever holds all of
   * them and must not multiply with vault count.
   *
   * Config is deliberately *not* reconciled from the roster. It is owned by this
   * browser — chosen in the setup wizard and pushed to the backend only when
   * provisioning — so there is no server-held policy to drift from.
   */
  applyRoster(actors: readonly BEActorWithStatus[]): void {
    // A failed adoption left the namespace erased; reconciling into it would
    // only write state onto a vault that is gone.
    if (this.blockedBy) return

    const initial = this.vault
    const onNode = new Set(actors.map(a => a.id))

    // Forget placeholders for helpers the node no longer has. Nothing can be
    // done with one but fail with "actor not found" — the helper was removed,
    // or the row came from another node entirely (a tab that briefly ran
    // against a test backend wrote that one's fixtures here). Only rows with no
    // channel: a channel is protocol state, and a roster lookup must not erase it.
    const kept = initial.participants.filter(
      h => h.channelId !== '' || h.connectionStatus !== 'available' || onNode.has(h.id),
    )
    // The same array when nothing went, so an unchanged roster commits nothing.
    let participants = kept.length === initial.participants.length ? initial.participants : kept

    // Discover new participants. Every helper on the node is visible to every
    // vault, and always starts `available`: the backend's channel_id may belong
    // to another vault's pairing, so only `PairingCompleted` may promote it.
    for (const actor of actors) {
      if (actor.role !== 'helper') continue
      if (participants.some(h => h.id === actor.id)) continue
      participants = [
        ...participants,
        {
          id: actor.id,
          name: actor.name,
          channelId: '',
          transport: { protocol: actor.transport.protocol, uri: actor.transport.uri },
          transports: actor.transports,
          connectionStatus: 'available' as const,
          secretShares: [],
          browserManaged: actor.browser_managed ?? false,
        },
      ]
    }

    for (const actor of actors) {
      const participant = participants.find(h => h.id === actor.id)
      if (!participant) continue

      // Take the shared key once the node has one.
      const sharedKey = actor.shared_key && !participant.sharedKey ? actor.shared_key : undefined
      // Follow the node on whether a participant is switched off. The roster is
      // the truth: taking one offline is a node decision, and reconciling it
      // here is what keeps a second browser context from showing it online.
      const offline = actor.disabled ?? false
      if (sharedKey === undefined && participant.offline === offline) continue

      participants = participants.map(h =>
        h.id === actor.id ? { ...h, ...(sharedKey === undefined ? {} : { sharedKey }), offline } : h,
      )
    }

    if (participants !== initial.participants) this.commit({ ...initial, participants })

    this.followOwnAddress(actors)

    // Mirror to a replica destination the moment it becomes eligible. Driven
    // from the roster on purpose: the promotion to `paired` can complete with
    // nothing replica-shaped on screen, and it keys off the status transition
    // alone. Fired and forgotten — the trigger guards its own round and reports
    // its own failures.
    void this.replicaTrigger.observe(replicaViews(actors, loadReplicaState(this.vault.id)))
  }

  /**
   * Keep this vault's own address in step with where the node says it is.
   *
   * `vault.transport` is set once, from the owner registration at setup. The
   * node re-advertises every actor at its *current* public address after a
   * restart — a different published port, a new `DEREC_BASE_URL` — so a vault
   * that kept the address it was born with went on minting contacts that
   * pointed peers at an endpoint nothing serves. The node's roster lists this
   * vault's own owner actor (its id is the vault id); when that listing moves,
   * the record and the live protocol instance follow, and the published
   * contact is re-posted so discovery hands out the new one.
   *
   * Only the HTTPS endpoint: a browser cannot serve gRPC, and the instance is
   * built with that one transport (`buildProtocolInstance`). Peers already
   * paired keep the old address until told — that is the protocol's
   * `UpdateChannelInfo` flow, not done here.
   */
  private followOwnAddress(actors: readonly BEActorWithStatus[]): void {
    if (!actors.some(a => a.id === this.vault.id)) {
      this.ownListingRead = true
      return
    }
    const advertised = this.readOwnListing(actors)
    // Set by hand in Edit identity: the user chose this address over the node's.
    if (this.vault.ownTransportPinned) return
    // One identity change at a time, whichever path started it: the other one
    // reads the record before it awaits and writes it after.
    if (this.identityInFlight) return
    if (!advertised) return
    if (advertised.uri === this.vault.transport.uri) {
      this.retryNodeFollowUpdate()
      return
    }
    // A refused address is not retried every roster tick.
    if (this.movingOwnAddressTo === advertised.uri) return
    this.movingOwnAddressTo = advertised.uri
    this.identityInFlight = true
    this.nodeFollowRetries = { count: 0, lastAt: Date.now() }

    const previous = this.vault.transport.uri
    const instance = this.protocolInstance
    void (async () => {
      try {
        // Peers paired at the old address are told too, so their replies follow
        // — the replica group by a publish, helpers by `UpdateChannelInfo`.
        if (instance) await this.announceToReplicaGroup(instance, { endpoint: advertised.uri })
        const sent = instance
          ? await this.announceIdentity(instance, { endpoint: advertised.uri })
          : { dispatched: 0, failed: 0 }
        // Onto the record as it is *now*: the announcement folded its own
        // events in while it was awaited.
        this.commit({ ...this.vault, transport: { protocol: 'https', uri: advertised.uri } })
        this.movingOwnAddressTo = null
        this.deps.log({
          role: 'owner',
          flow: 'setup',
          step: 'own_transport_updated',
          description:
            `The node now advertises this vault at ${advertised.uri} (was ${previous}); ` +
            `new contacts carry the new address. ${peersToldText(sent)}`,
          payload: {
            vaultId: this.vault.id,
            previous,
            current: advertised.uri,
            peersDispatched: sent.dispatched,
            peersFailed: sent.failed,
          },
        })
        if (instance && instance === this.protocolInstance && !this.blockedBy) {
          void this.publishContact(instance)
        }
      } catch (err) {
        // Left set, so the same refusal is not repeated on every roster tick;
        // a different address from the node tries again.
        this.deps.notify.error('Could not update this vault’s own address to the node’s new one', err, {
          vaultId: this.vault.id,
          previous,
          advertised: advertised.uri,
        })
      } finally {
        this.identityInFlight = false
      }
    })()
  }

  /**
   * Send the node-follow address update again to the peers it did not reach.
   *
   * Following the node is automatic, so there is nobody to press "Resend" —
   * a peer that was offline when the address moved would otherwise keep
   * replying to an address nothing serves. Bounded on both axes: at most
   * `NODE_FOLLOW_MAX_RETRIES` resends, no closer together than one protocol
   * timeout, and only for an update that was an endpoint change.
   */
  private retryNodeFollowUpdate(): void {
    const update = this.identityUpdate
    const endpoint = update?.values.endpoint
    if (!update || endpoint === undefined || endpoint !== this.vault.transport.uri) return
    if (this.nodeFollowRetries.count >= NODE_FOLLOW_MAX_RETRIES) return
    if (Date.now() - this.nodeFollowRetries.lastAt < this.protocolTimeoutMs()) return
    if (undeliveredChannelIds(update).length === 0) return

    this.nodeFollowRetries = { count: this.nodeFollowRetries.count + 1, lastAt: Date.now() }
    void this.resendIdentityUpdate().catch(err =>
      this.deps.notify.error('Could not resend the address update to every peer', err, {
        vaultId: this.vault.id,
      }),
    )
  }
  /** The HTTPS address the node last listed for this vault, if it has listed one. */
  nodeAdvertisedAddress(): string | null {
    return this.nodeAdvertisedUri
  }

  /** Whether the node's roster has been read since this runtime was created. */
  nodeListingRead(): boolean {
    return this.ownListingRead
  }

  /**
   * Read where the node lists this vault now, without waiting for the next
   * roster tick. Edit Identity calls it when it opens — a vault just loaded
   * has not been through a tick yet, and deciding "the node has not listed
   * this vault" or "nothing changed" from that empty answer was wrong.
   *
   * Never throws: a node that cannot be reached leaves the last answer.
   */
  async refreshNodeAddress(): Promise<string | null> {
    try {
      const actors = await apiGetActors()
      this.readOwnListing(actors)
      this.emit()
    } catch {
      // The roster tick keeps trying; the modal shows what is known.
    }
    return this.nodeAdvertisedUri
  }

  /** Take this vault's own listing from a roster. */
  private readOwnListing(actors: readonly BEActorWithStatus[]): BEActorWithStatus['transport'] | null {
    this.ownListingRead = true
    const self = actors.find(a => a.id === this.vault.id)
    const advertised = self
      ? [...(self.transports ?? []), self.transport].find(t => t.protocol === 'https')
      : undefined
    this.nodeAdvertisedUri = advertised?.uri ?? null
    return advertised ?? null
  }

  /**
   * Change how this vault presents itself to peers, and tell every paired peer.
   *
   * `endpoint: null` follows the node's address again (and unpins); a string
   * pins that address, so the roster stops moving it. Either change is pushed
   * into the live protocol instance — new contacts carry it — and announced to
   * every helper-type channel with `UpdateChannelInfo`; each peer's answer
   * lands in `state().identityUpdate`.
   *
   * A vault in a replica group publishes a new version first, as the library
   * README prescribes: `UpdateChannelInfo` reaches helper channels only, and a
   * member's name and endpoint travel in the group roster instead, refreshed
   * from this device's configuration on every publish — see
   * `announceToReplicaGroup`.
   *
   * Returns the update, or `null` when nothing changed.
   */
  async updateIdentity(input: { name: string; endpoint: string | null }): Promise<IdentityUpdate | null> {
    const instance = this.protocolInstance
    if (!instance || this.blockedBy) throw new Error('Start this vault before changing how peers see it.')
    if (this.identityInFlight) throw new Error('An identity update is already being sent — try again in a moment.')

    const name = input.name.trim()
    const nameError = vaultNameProblem(name)
    if (nameError) throw new Error(nameError)

    const pinned = input.endpoint !== null
    // Following the node needs to know where the node lists this vault; a
    // vault just loaded may not have read the roster yet.
    if (!pinned && this.nodeAdvertisedUri === null) await this.refreshNodeAddress()
    const uri = pinned ? input.endpoint!.trim() : (this.nodeAdvertisedUri ?? this.vault.transport.uri)
    if (pinned) {
      const uriError = endpointProblem(uri)
      if (uriError) throw new Error(uriError)
    }

    const before = this.vault
    const nameChanged = name !== before.name
    const endpointChanged = uri !== before.transport.uri

    if (!nameChanged && !endpointChanged) {
      if (Boolean(before.ownTransportPinned) !== pinned) {
        this.commit({ ...before, ownTransportPinned: pinned })
      }
      // Nothing new to say — but the last update may not have reached
      // everyone, and diffing against local state can never notice that: the
      // record already holds what was sent. Saving again sends it again, to
      // exactly the peers it did not reach.
      return undeliveredChannelIds(this.identityUpdate).length > 0
        ? this.resendIdentityUpdate()
        : null
    }

    this.identityInFlight = true
    let sent: { dispatched: number; failed: number }
    try {
      const change = {
        ...(nameChanged ? { name } : {}),
        ...(endpointChanged ? { endpoint: uri } : {}),
      }
      await this.announceToReplicaGroup(instance, change)
      sent = await this.announceIdentity(instance, change)
      // Merged onto the record as it is *after* the await, never onto the
      // snapshot taken before it: the announcement folds its own events in,
      // and a roster tick may have committed meanwhile. Writing the stale
      // snapshot back reverted both.
      this.commit({
        ...this.vault,
        name,
        transport: { protocol: 'https', uri },
        ownTransportPinned: pinned,
      })
    } finally {
      this.identityInFlight = false
    }
    // The published contact carries the name and address too.
    if (instance === this.protocolInstance) void this.publishContact(instance)
    if (nameChanged) void this.renameOnNode(name)

    this.deps.log({
      role: 'owner',
      flow: 'pairing',
      step: 'identity_updated',
      description:
        `Identity updated${nameChanged ? ` — name "${before.name}" → "${name}"` : ''}` +
        `${endpointChanged ? ` — endpoint ${before.transport.uri} → ${uri}` : ''}. ` +
        peersToldText(sent),
      payload: {
        nameChanged,
        endpointChanged,
        pinned,
        endpoint: uri,
        peersDispatched: sent.dispatched,
        peersFailed: sent.failed,
      },
    })
    return this.identityUpdate
  }

  /**
   * Send the latest identity update again, to the peers it did not reach —
   * never delivered, or silent past the protocol timeout. Returns the update,
   * or `null` when there is nobody to resend to.
   */
  async resendIdentityUpdate(): Promise<IdentityUpdate | null> {
    const instance = this.protocolInstance
    if (!instance || this.blockedBy) throw new Error('Start this vault before changing how peers see it.')
    const update = this.identityUpdate
    const targets = undeliveredChannelIds(update)
    if (!update || targets.length === 0) return null
    if (this.identityInFlight) throw new Error('An identity update is already being sent — try again in a moment.')

    this.identityInFlight = true
    let sent: { dispatched: number; failed: number }
    try {
      sent = await this.announceIdentity(instance, update.values, targets)
    } finally {
      this.identityInFlight = false
    }
    // The node may have missed the rename for the same reason a peer missed
    // the update — this device was offline. Renaming is idempotent.
    if (update.values.name !== undefined) void this.renameOnNode(update.values.name)
    this.deps.log({
      role: 'owner',
      flow: 'pairing',
      step: 'identity_resent',
      description: `Identity update resent to ${targets.length} peer(s) that had not received it. ${peersToldText(sent)}`,
      payload: { channelIds: targets, peersDispatched: sent.dispatched, peersFailed: sent.failed },
    })
    return this.identityUpdate
  }

  /**
   * Keep the node's roster label in step with a rename. Never fails the
   * rename: the vault's own name changed and peers were told; only other
   * browser contexts' view of the roster lags.
   */
  private async renameOnNode(name: string): Promise<void> {
    try {
      const result = await this.io.renameOwner(this.vault.id, name)
      if (result.kind === 'unsupported') {
        console.info(
          `[derec] The node does not support renaming owners (PATCH /api/v1/owners/${this.vault.id}); its roster keeps the old name.`,
        )
        return
      }
      this.deps.log({
        role: 'owner',
        flow: 'setup',
        step: 'owner_renamed_on_node',
        description: `The node now lists this vault as "${result.name}"`,
        payload: { vaultId: this.vault.id, name: result.name },
      })
    } catch (err) {
      console.warn('[derec] Renaming the vault on the node failed', err)
      this.deps.log({
        role: 'owner',
        flow: 'setup',
        step: 'owner_rename_on_node_failed',
        description: `The vault was renamed and peers were told, but the node still lists the old name: ${errorText(err)}`,
        payload: { vaultId: this.vault.id, name },
      })
    }
  }

  /** The protocol timeout this vault runs with, in milliseconds. */
  private protocolTimeoutMs(): number {
    return (
      resolveVaultConfig(this.vault.configOverrides, this.deps.getServerDefaults())
        .protocolTimeoutSecs * 1000
    )
  }

  /**
   * Arm (or re-arm) the check that turns a peer still silent past the protocol
   * timeout into `no-answer`. One timer for the whole update, set for the
   * earliest pending peer, re-armed after each pass while any remain.
   */
  private scheduleIdentityExpiry(): void {
    if (this.identityExpiryTimer !== null) clearTimeout(this.identityExpiryTimer)
    this.identityExpiryTimer = null
    const pending = Object.values(this.identityUpdate?.channels ?? {}).filter(c => c.outcome === 'pending')
    if (pending.length === 0) return
    const timeoutMs = this.protocolTimeoutMs()
    const earliest = Math.min(...pending.map(c => c.sentAt))
    const delay = Math.max(0, earliest + timeoutMs - Date.now()) + IDENTITY_EXPIRY_GRACE_MS
    this.identityExpiryTimer = setTimeout(() => {
      this.identityExpiryTimer = null
      const next = withExpiredWaits(this.identityUpdate, Date.now(), timeoutMs)
      if (next !== this.identityUpdate) {
        this.identityUpdate = next
        this.emit()
      }
      this.scheduleIdentityExpiry()
    }, delay)
  }

  /**
   * Tell this vault's replica group about a new name or endpoint — step 1 of
   * the library README's procedure for a replica member, before helpers are
   * told with `UpdateChannelInfo`.
   *
   * `UpdateChannelInfo` reaches helper channels only. A member's values travel
   * in the group roster, which the library refreshes from this device's own
   * configuration each time it publishes; so the new values are set on the
   * instance and the same secrets are published as a new version. Every
   * member records the new row, and the helpers receive a roster that is
   * recoverable with it.
   *
   * Never throws: a group that could not be told is reported, and the helpers
   * are still told. Skipped — and said so — when the vault is in no group,
   * holds nothing to publish yet (the first publish carries the new values),
   * or is diverged from its group, which must not publish until resolved.
   *
   * The README also asks for `reply_to` on that round, so helpers that still
   * hold the old endpoint answer at the new one. The web SDK's
   * `ProtectSecretParams` has no such field; this app's old endpoint is the
   * same node's mailbox and keeps answering, which is what the README's
   * "keep the old endpoint serving" asks for anyway.
   */
  private async announceToReplicaGroup(
    instance: ProtocolInstance,
    change: { name?: string; endpoint?: string },
  ): Promise<void> {
    if (change.name === undefined && change.endpoint === undefined) return
    const ownReplicaId = getOrCreateReplicaId(this.vault.id).toString()
    const inGroup = listReplicaMembers(this.namespace, this.partition).some(
      member => member.replicaId !== ownReplicaId,
    )
    if (!inGroup) return

    const what = [change.name !== undefined ? 'name' : null, change.endpoint !== undefined ? 'endpoint' : null]
      .filter(Boolean)
      .join(' and ')
    const skip = (reason: string) => {
      this.deps.log({
        role: 'owner',
        flow: 'sharing',
        step: 'identity_replica_publish_skipped',
        description: `The replica group was not told about the new ${what}: ${reason}`,
        payload: { change },
      })
    }

    const conflict = this.vault.replicaConflict
    if (conflict) {
      skip('publishing is paused until the replica conflict is resolved; the resolving publish carries it')
      this.deps.notify.error(
        `The replica group was not told about the new ${what}: ${replicaConflictBlockReason(conflict)} ` +
          'The publish that resolves it carries the new values.',
      )
      return
    }
    const secrets = this.rounds.latestSecrets(this.vault.secretBag)
    if (secrets.length === 0) {
      skip('this vault holds nothing to publish yet — the first publish carries it')
      return
    }

    try {
      // The roster row is refreshed from the instance's own configuration as
      // the round is built, so the new values go in before the publish.
      await this.withLock(async () => {
        if (change.name !== undefined) await instance.protocol.setCommunicationInfo({ name: change.name })
        if (change.endpoint !== undefined) {
          await instance.protocol.setOwnTransports([{ uri: change.endpoint, protocol: 'https' }])
        }
      })
      const round = await this.protect([...secrets])
      if (!round) {
        skip('the publish dispatched nothing')
        return
      }
      this.deps.log({
        role: 'owner',
        flow: 'sharing',
        step: 'identity_replica_publish',
        description:
          `Published v${round.version} so the replica group's roster carries the new ${what} — ` +
          `mirrored to ${round.replicaTargets.length} replica(s); helpers are told next`,
        payload: { version: round.version, change },
      })
    } catch (err) {
      skip(errorText(err))
      this.deps.notify.error(`The replica group could not be told about the new ${what}`, err)
    }
  }

  /**
   * Push a new name and/or endpoint into the live instance and announce it —
   * to every helper-type channel, or to `targets` alone for a resend. Returns
   * how many peers it was dispatched to and how many it could not reach.
   *
   * The bookkeeping is recorded *before* the start events are folded, so a
   * channel the library could not reach is already listed when its
   * `UpdateChannelInfoFailed` arrives.
   */
  private async announceIdentity(
    instance: ProtocolInstance,
    change: { name?: string; endpoint?: string },
    targets?: readonly string[],
  ): Promise<{ dispatched: number; failed: number }> {
    const sent = Array.from(
      await this.withLock(async () => {
        if (change.name !== undefined) {
          await instance.protocol.setCommunicationInfo({ name: change.name })
        }
        if (change.endpoint !== undefined) {
          await instance.protocol.setOwnTransports([{ uri: change.endpoint, protocol: 'https' }])
        }
        // An explicit list of *paired* channels. The library itself targets
        // `Paired` channels only (SDK 0.0.7; before that one `Pending` channel
        // aborted the whole update), but a resend needs a list anyway, and
        // naming the recipients here is what the per-peer outcomes are
        // recorded against.
        const recipients = (targets ?? this.pairedHelperChannelIds()).filter(id =>
          this.isPairedHelperChannel(id),
        )
        // Never an empty list: the library reads that as "every channel".
        if (recipients.length === 0) return []
        return instance.protocol.start(FlowKind.UpdateChannelInfo, {
          target: recipients.map(id => BigInt(id)),
          ...(change.name !== undefined ? { communication_info: { name: change.name } } : {}),
          ...(change.endpoint !== undefined
            ? { own_transports: [{ uri: change.endpoint, protocol: 'https' as const }] }
            : {}),
        })
      }),
    )

    const now = Date.now()
    const events = this.withDeliveryReasons(sent)
    this.identityUpdate =
      targets && this.identityUpdate
        ? withIdentityResend(this.identityUpdate, events, this.vault.participants, now)
        : identityUpdateFrom(events, this.vault.participants, change, now)
    this.emit()
    this.scheduleIdentityExpiry()

    let folded = this.vault
    for (const event of events) folded = this.foldReporting(folded, event)
    if (folded !== this.vault) this.commit(folded)

    return {
      dispatched: events.filter(e => e.type === 'UpdateChannelInfoStarted').length,
      failed: events.filter(e => e.type === 'UpdateChannelInfoFailed').length,
    }
  }

  /**
   * The helper-type channels the library holds `Paired`, optionally only those
   * whose peer has `peerRole` (`Helper` or `Owner`). Read from the library's own
   * store, which is what a broadcast would otherwise fan out over.
   */
  private pairedHelperChannelIds(peerRole?: 'Helper' | 'Owner'): string[] {
    return listHelperChannels(this.namespace, this.partition)
      .filter(c => c.status === 'Paired' && (peerRole === undefined || c.peerRole === peerRole))
      .map(c => c.channelId)
  }

  private isPairedHelperChannel(channelId: string): boolean {
    return readHelperChannelStatus(this.namespace, this.partition, channelId) === 'Paired'
  }

  /**
   * `event` with the transport's own reason put back into its `error`. The
   * library reports every failed send as a bare "transport.send promise
   * rejected"; the node's actual answer — gRPC off, relay disabled, unknown
   * actor — is what tells the owner what to fix. See `explainDeliveryFailure`.
   */
  private withDeliveryReason(event: DeRecEvent): DeRecEvent {
    if (!('error' in event) || typeof event.error !== 'string' || !('channel_id' in event)) return event
    const channelId = event.channel_id
    const row = this.vault.participants.find(p => p.channelId === channelId)
    const stored = readHelperChannelInfo(this.namespace, this.partition, channelId)
    const uris = [
      ...(stored?.transports ?? []),
      ...(row?.transports ?? (row ? [row.transport] : [])),
    ].map(t => t.uri)
    const error = explainDeliveryFailure(event.error, uris.length > 0 ? uris : undefined)
    return error === event.error ? event : { ...event, error }
  }

  private withDeliveryReasons(events: DeRecEvent[]): DeRecEvent[] {
    return events.map(event => this.withDeliveryReason(event))
  }

  /** Whether the latest identity update still has peers waiting or unreached. */
  identityUpdateOutstanding(): boolean {
    return hasOutstandingPeers(this.identityUpdate)
  }

  /** Mirror now, on the user's request. Shares the automatic round's guard. */
  syncReplicasNow(): Promise<ManualReplicaSyncOutcome> {
    return this.replicaTrigger.syncNow()
  }

  /** Clear the automatic-sync notice — a manual round superseded it, or the user dismissed it. */
  dismissReplicaAutoSyncOutcome(): void {
    if (this.autoSyncOutcome === null) return
    this.autoSyncOutcome = null
    this.emit()
  }

  /** Whether this vault wants the roster at the fast cadence too. */
  wantsFastCadence(): boolean {
    return this.pollIntervalMs === POLL_FAST_MS
  }

  // ── Deciding attention items ───────────────────────────────────────────────
  //
  // The accept and reject halves of the four confirmations. Each clears its item
  // once it has acted. If the vault has not started, the item is left open —
  // there is nothing to answer it with yet.

  /** Accept a pairing, share-storage, verification or unpair request. */
  async acceptAttention(id: string): Promise<void> {
    const item = this.items.find(i => i.id === id)
    const protocol = this.protocolInstance?.protocol
    if (!item || !protocol) return

    switch (item.kind) {
      case 'pairing': {
        const request = item.payload as PendingPairingConfirmation
        try {
          const events = Array.from(await this.withLock(() => protocol.accept(request.action)))
          let updated = this.vault
          let pairedChannelId: string | null = null
          for (const event of events) {
            updated = this.foldReporting(updated, event)
            if (event.type === 'PairingCompleted') pairedChannelId = event.channel_id
          }
          if (updated !== this.vault) this.commit(updated)
          // No discovery is fired here. A helper can only answer once it has
          // linked this channel to an owner it already helps, which happens out
          // of band — so discovery is driven explicitly from the Recovery tab.
          // Accepting a `NoKeys` request leaves the channel `Pending` on this
          // side too, which the fingerprint gate the view raises handles.
          if (pairedChannelId !== null) this.effects.pairingCompleted(pairedChannelId, updated)
        } catch (err) {
          this.deps.notify.error('Failed to accept pairing request', err, { channelId: request.channelId })
        }
        this.deps.log({
          role: 'owner',
          flow: 'pairing',
          step: 'pairing_confirmed',
          description: `Accepted pairing request from "${request.peerName}"`,
          payload: { channelId: request.channelId },
        })
        break
      }

      case 'store-share': {
        const request = item.payload as StoreShareRequest
        const updated = await this.withLock(() => this.acceptStoreShareUnlocked(request, this.vault))
        if (updated !== this.vault) this.commit(updated)
        this.deps.log({
          role: 'owner',
          flow: 'sharing',
          step: 'store_share_confirmed',
          description: `Accepted share storage from "${request.peerName}" (version ${request.version})`,
          payload: { channelId: request.channelId, version: request.version },
        })
        break
      }

      case 'verify-share': {
        const request = item.payload as VerifyShareRequest
        await this.acceptAndCommit(protocol, request.action, 'Failed to accept verification request', {
          channelId: request.channelId,
          version: request.version,
        })
        this.deps.log({
          role: 'owner',
          flow: 'verification',
          step: 'verify_share_confirmed',
          description: `Accepted verification from "${request.peerName}" (version ${request.version})`,
          payload: { channelId: request.channelId, version: request.version },
        })
        break
      }

      case 'unpair': {
        const request = item.payload as UnpairRequest
        await this.acceptAndCommit(protocol, request.action, 'Failed to accept unpair request', {
          channelId: request.channelId,
        })
        this.deps.log({
          role: 'owner',
          flow: 'unpairing',
          step: 'unpair_accepted',
          description: `Accepted unpair from "${request.peerName}"`,
          payload: { channelId: request.channelId },
        })
        break
      }

      case 'replica-adoption':
        // Accepted through `adoptReplica`, which needs the dialog's confirmation.
        return
    }

    this.resolveAttention(id)
  }

  /**
   * Accept a pairing and link the channel it creates into `targetChannelId`'s
   * group — the "accept + link" path of the User authentication method.
   *
   * The response goes out only once the user has picked the target, and the link
   * follows the accept, so recovery discovery from the requester reaches shares
   * held under this peer's sibling channels.
   */
  async acceptPairingAndLink(id: string, targetChannelId: string): Promise<void> {
    const item = this.items.find(i => i.id === id && i.kind === 'pairing')
    const protocol = this.protocolInstance?.protocol
    if (!item || !protocol) return
    const request = item.payload as PendingPairingConfirmation

    try {
      const events = Array.from(await this.withLock(() => protocol.accept(request.action)))
      let updated = this.vault
      // Accepting rotates the handshake off the transient pairing id the request
      // carries onto a fresh long-term one, and deletes the transient one.
      // Linking the transient id would record an edge to a channel that no
      // longer exists, so the id comes off the completion event.
      let pairedChannelId: string | null = null
      for (const event of events) {
        updated = this.foldReporting(updated, event)
        if (event.type === 'PairingCompleted') pairedChannelId = event.channel_id ?? null
      }
      if (updated !== this.vault) this.commit(updated)
      if (pairedChannelId) this.effects.pairingCompleted(pairedChannelId, updated)

      if (!pairedChannelId) {
        this.deps.notify.error(
          'Pairing accepted but no channel to link',
          new Error('accept() returned no PairingCompleted event'),
          { pairingChannelId: request.channelId, linkTo: targetChannelId },
        )
      } else {
        try {
          // The target is the established side of this peer, so it keeps the
          // group's name.
          await this.linkChannels(pairedChannelId, targetChannelId, { mainChannelId: targetChannelId })
        } catch (err) {
          // Pairing succeeded; surface the link failure without tearing it down.
          this.deps.notify.error('Pairing accepted but linking failed', err, {
            channelId: pairedChannelId,
            linkTo: targetChannelId,
          })
        }
      }

      this.deps.log({
        role: 'owner',
        flow: 'pairing',
        step: 'pairing_confirmed_and_linked',
        description: `Accepted pairing from "${request.peerName}" and linked to channel ${targetChannelId}`,
        payload: { pairingChannelId: request.channelId, channelId: pairedChannelId, linkedTo: targetChannelId },
      })
    } catch (err) {
      this.deps.notify.error('Failed to accept pairing for link', err, { channelId: request.channelId })
    }

    this.resolveAttention(id)
  }

  /** Reject a pairing, share-storage, verification or unpair request; dismiss an adoption offer. */
  async rejectAttention(id: string): Promise<void> {
    const item = this.items.find(i => i.id === id)
    if (!item) return
    if (item.kind === 'replica-adoption') {
      // Nothing to answer: the offer is only staged, and the source's next sync
      // re-offers it. Dropped from storage too, or a reload would raise the
      // offer the owner just turned down — or just adopted.
      clearPendingReplicaOffer(this.vault.id)
      this.resolveAttention(id)
      return
    }

    const protocol = this.protocolInstance?.protocol
    if (!protocol) return

    const { action, channelId, peerName } = item.payload as {
      action: Uint8Array
      channelId: string
      peerName: string
    }
    const version = (item.payload as { version?: number }).version
    const rejection = REJECTIONS[item.kind]
    try {
      await this.withLock(() => protocol.reject(action, REJECTED_STATUS, rejection.memo))
      this.deps.log({
        role: 'owner',
        flow: rejection.flow,
        step: rejection.step,
        description: `${rejection.verb} from "${peerName}"${version === undefined ? '' : ` (version ${version})`}`,
        payload: version === undefined ? { channelId } : { channelId, version },
      })
    } catch (err) {
      this.deps.notify.error(rejection.failure, err, version === undefined ? { channelId } : { channelId, version })
    }

    this.resolveAttention(id)
  }

  /**
   * Accept a share-storage request and fold what it produces onto `current`.
   * Reports rather than throws, returning `current` on failure.
   *
   * The caller holds the lock: the dialog takes it, and the inbound batch that
   * auto-accepts already runs under it.
   */
  private async acceptStoreShareUnlocked(request: StoreShareRequest, current: Vault): Promise<Vault> {
    const protocol = this.protocolInstance?.protocol
    if (!protocol) return current
    try {
      const events = Array.from(await protocol.accept(request.action))
      // Record the held share with full metadata BEFORE folding: the fold's
      // ShareStored arm sees it is already tracked and skips its own entry,
      // which lacks the secret id and description.
      let updated: Vault = {
        ...current,
        heldShares: [
          ...(current.heldShares ?? []),
          {
            channelId: request.channelId,
            secretId: request.secretId,
            version: request.version,
            description: request.description,
          },
        ],
      }
      for (const event of events) updated = this.foldReporting(updated, event)
      return updated
    } catch (err) {
      this.deps.notify.error('Failed to accept share-storage request', err, {
        channelId: request.channelId,
        version: request.version,
      })
      return current
    }
  }

  /** Fold one event, reporting a throw rather than abandoning the rest. */
  private foldReporting(current: Vault, event: DeRecEvent): Vault {
    try {
      return this.applyEvent(current, event)
    } catch (err) {
      this.deps.notify.error(`Failed to handle a ${event.type} event`, err)
      return current
    }
  }

  /** Accept an action, fold what it produces and commit. Reports rather than throws. */
  private async acceptAndCommit(
    protocol: DeRecProtocol,
    action: Uint8Array,
    failure: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    try {
      const events = Array.from(await this.withLock(() => protocol.accept(action)))
      let updated = this.vault
      for (const event of events) updated = this.foldReporting(updated, event)
      if (updated !== this.vault) this.commit(updated)
    } catch (err) {
      this.deps.notify.error(failure, err, context)
    }
  }

  setBusy(busy: boolean): void {
    if (this.busy === busy) return
    const before = this.pollIntervalMs
    this.busy = busy
    // With nothing in flight the watchdog has nothing to guard.
    if (!busy) this.clearWatchdog()
    if (this.pollIntervalMs !== before) this.schedulePoll()
    this.emit()
  }

  /**
   * Rebind this runtime to an instance built elsewhere.
   *
   * Exists for replica adoption and restoring from a recovered bag, the two
   * flows that legitimately replace a running instance: each wipes the stores
   * this instance was reading and binds the device to a *different* secret id,
   * so the instance the runtime built is now pointed at a namespace that no
   * longer exists. Leaving it in place would run every later flow against empty
   * stores.
   */
  adoptInstance(instance: ProtocolInstance): void {
    this.protocolInstance = instance
    this.setStatus('running')
  }

  /**
   * Install a fake instance. **Test-only**: specs must be able to drive the
   * engine without loading WASM, and the alternative is casting the runtime to
   * `any` at every call site.
   */
  __setInstanceForTest(instance: ProtocolInstance): void {
    this.protocolInstance = instance
    this.setStatus('running')
  }

  private setStatus(status: VaultStatus): void {
    this.status = status
    this.emit()
  }

  private emit(): void {
    const snapshot = this.state()
    for (const listener of this.listeners) listener(snapshot)
  }

  /**
   * Fold one protocol event into vault state — see `fold/`.
   *
   * A reducer: returns the next vault rather than mutating it, and the caller
   * threads the result forward. Public for the specs that drive it directly.
   */
  applyEvent(current: Vault, event: DeRecEvent): Vault {
    const next = foldEvent(current, this.withDeliveryReason(event), this.foldContext)
    // Every event passes here, whichever path delivered it — drain, tick or a
    // command — so this is the one place a replica catch-up can see its outcome.
    this.catchUp.observe(event)
    return next
  }

}

/**
 * The bytes of a user-secret id, as `ProtectSecret` takes them.
 *
 * Ids this app mints are hex. Ids that came back out of a recovered or adopted
 * snapshot are the library's base64url rendering of the same bytes, and
 * parsing those as hex turned every one into zero bytes — so the first publish
 * after a restore rewrote the ids of every secret it carried.
 */
function userSecretIdBytes(id: string): Uint8Array {
  if (/^(?:[0-9a-f]{2})+$/i.test(id)) {
    return Uint8Array.from(id.match(/.{2}/g) ?? [], b => parseInt(b, 16))
  }
  return fromBase64Url(id)
}

/**
 * Slack past the protocol timeout before a pairing this vault started, still
 * unanswered, is given up on.
 */
const ABANDONED_PAIRING_GRACE_MS = 30_000

/**
 * How long a verification challenge waits for its answer. Long on purpose: a
 * helper whose tab is closed answers when it next opens, and that answer is
 * still worth recording against the version it proves.
 */
const VERIFICATION_ANSWER_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * What a share request that never left this device is recorded with. Names
 * the transport, which is how `owner/shareFailure.ts` tells a failed send from
 * a peer that refused or went quiet.
 */
const UNDELIVERED_MEMO = 'Not delivered (transport.send failed)'

/**
 * Characters of browser storage one protect round of a `bagBytes` bag needs:
 * a base64 share per helper, the library's own copy of the secrets, and the
 * vault record's staged and committed bag — with room to spare.
 */
function protectFootprintChars(bagBytesCount: number, shareTargets: number): number {
  const base64 = Math.ceil((bagBytesCount * 4) / 3) + 1024
  return (shareTargets + 4) * base64 + 16 * 1024
}

/** Resends of a node-follow address update before it is left to the user. */
const NODE_FOLLOW_MAX_RETRIES = 3

/** Slack after the protocol timeout before a silent peer is called `no-answer`. */
const IDENTITY_EXPIRY_GRACE_MS = 1000

/**
 * How many peers an announcement actually went to, for the console.
 *
 * Counted from the start events rather than from the bookkeeping: a channel the
 * library could not reach is listed there too, and "3 peers were told" when all
 * three sends failed was the opposite of what happened.
 */
function peersToldText(sent: { dispatched: number; failed: number }): string {
  if (sent.dispatched === 0 && sent.failed === 0) return 'No paired peer to tell.'
  const told = `Sent to ${sent.dispatched} paired peer(s)`
  return sent.failed > 0 ? `${told}; ${sent.failed} could not be reached.` : `${told}.`
}
