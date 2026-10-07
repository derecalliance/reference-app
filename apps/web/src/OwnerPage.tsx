// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { ModalFrame } from './ModalFrame'
import { memo, useState, useEffect, useRef, useMemo, useCallback, useSyncExternalStore } from 'react'
import { errorText } from './errorText'
import { Alert, Button, Stack } from '@mui/material'
import { advertisedEndpoints, type ContactMessage } from '@derec-alliance/web'
import './OwnerPage.css'
import type { Vault, PairedParticipant, RecoveredSecret, UserSecret } from './types'
import { useConsole, type ConsoleEntryInput } from './ConsoleContext'
import { reportError, reportInfo } from './toastBus'
import { protocolTimeoutMs } from './config'
import { resolveVaultConfig } from './protocolDefaults'
import type { VaultRuntime } from './vault/runtime'
import { useServerDefaults, useVaultManager } from './vault/managerContext'
import type {
  Attention,
  AttentionKind,
  StoreShareRequest,
  UnpairRequest,
  VerifyShareRequest,
} from './vault/types'
import { ProtocolConfigProvider } from './ProtocolConfig'
import {
  readHelperChannelStatus,
  listReplicaMembers,
  type StoredReplicaMember,
} from './stores'
import { readReplicaId } from './replicaIdentity'
import {
  DEFAULT_CONTACT_MODE,
  humanNonce,
  type ContactModeKey,
} from './contactModes'
import {
  type ProvisionedChannel,
  type ProvisioningSettings,
  apiListParticipantChannels,
  apiLinkHelperChannels,
  apiAddHelper,
  apiCreateActorContact,
  apiGetBrowserContact,
  apiStartActorPairing,
  apiToggleParticipantStatus,
} from './api'
import type { PairingRole } from './pairingRoles'
import { canDrivePeerViaBackend } from './ownerPairing'
import { BROWSER_PAIRING_ROLE_OPTIONS, pairingRoleLabel } from './pairingRoleOptions'
import { ReplicaPairingRequestDialog } from './ReplicaPairingRequestDialog'
import type { PendingPairingConfirmation } from './inboundPairing'
import {
  isReplicaChannel,
  isShareTarget,
  splitPairedChannels,
} from './ownerPairing'
import {
  adoptionSourceLabel,
  canRequestReplicaSync,
  forgetReplicaChannel,
  loadReplicaState,
  pairReplica,
  recordConfirmation,
  replicaViews,
  type ManualReplicaSyncOutcome,
  type PendingReplicaAdoption,
  type ReplicaRecord,
  type ReplicaView,
  type RestoreFailure,
} from './replicaFlows'
import { contactMessageToDto, dtoToContactMessage } from './contactDto'
import { AppMuiTheme } from './AppMuiTheme'
import { ReplicaAdoptionDialog } from './ReplicaAdoptionDialog'
import { effectiveRecommended } from './owner/recommendedParticipants'
import { ReplicaFingerprintDialog } from './ReplicaFingerprintDialog'
import { ChannelFingerprintDialog } from './ChannelFingerprintDialog'
import { ReplicasTab } from './ReplicasTab'
import { ReplicaRemovalDialog } from './ReplicaRemovalDialog'
import { removalRequestFor, type ReplicaRemovalRequest } from './replicaRemoval'
import {
  describeAutomaticSyncOutcome,
  describeManualSyncOutcome,
  isSyncNoticeAnswered,
  type ReplicaRowSyncNotice,
} from './replicaSyncNotice'
import { OwnerReplicaSection } from './OwnerReplicaSection'
import { ReplicaAdoptionBlockedScreen } from './ReplicaAdoptionBlockedScreen'

import { AddSecretModal } from './owner/AddSecretModal'
import { RemoveSecretModal } from './owner/RemoveSecretModal'
import { EditIdentityModal } from './owner/EditIdentityModal'
import { LinkChannelModal } from './owner/LinkChannelModal'
import { OwnerParticipantPanel } from './owner/OwnerParticipantPanel'
import { PairInitiatorModal } from './owner/PairInitiatorModal'
import { PairedParticipantsList } from './owner/PairedParticipantsList'
import { OutgoingUnpairDialog, type OutgoingUnpairConfirmation } from './owner/OutgoingUnpairDialog'
import { CorruptShareWarnings } from './owner/CorruptShareWarnings'
import { ReplicaConflictPanel } from './ReplicaConflictPanel'
import { replicaConflictBlockReason } from './vault/replicaConflict'
import { committedVersionsOf } from './owner/heldShares'
import { HeldSharesList, RecoveryPanel } from './owner/RecoveryPanel'
import { SecretBagPanel } from './owner/SecretBagPanel'
import { ShareContactModal } from './owner/ShareContactModal'
import type { ProtocolInstance } from './owner/protocol'
import { OwnerTabBar, type ActiveTab } from './owner/OwnerTabBar'
import { useLinkGroups } from './owner/useLinkGroups'
import { runtimeStateStore } from './vault/runtimeStateStore'
import { groupMemberRows } from './owner/groupMembers'

interface Props {
  /**
   * The vault's engine, run by the `VaultManager` whether or not this page is
   * mounted. The page attaches to it and renders what it holds; it never
   * builds, starts or stops one. Keyed by vault id by the caller, so this is the
   * same runtime for the page's whole life.
   */
  runtime: VaultRuntime
}

/**
 * Memoised: `App` re-renders whenever any vault's row changes, and this page
 * renders from its own runtime's state, which it subscribes to directly — so
 * another vault's row changing has nothing to tell it.
 */
export default memo(OwnerPage)

function OwnerPage({ runtime }: Props) {
  /**
   * Follow the engine's state, which is the only writer of it — the vault record
   * included. Subscribing rather than keeping copies is what stops the engine and
   * the view disagreeing about the record, whether a flow is in flight, or which
   * confirmations are open.
   */
  const runtimeStore = useMemo(() => runtimeStateStore(runtime), [runtime])
  const runtimeState = useSyncExternalStore(runtimeStore.subscribe, runtimeStore.getSnapshot)
  const vault = runtimeState.vault
  const manager = useVaultManager()

  const { log: consoleLog } = useConsole()
  // Everything this page logs is about the vault it shows, so it carries that
  // vault's id — as the engine's entries do — and a vault filter shows both.
  const log = useCallback(
    (entry: ConsoleEntryInput) => consoleLog({ ...entry, vaultId: vault.id }),
    [consoleLog, vault.id],
  )

  // The node's own defaults, the bottom tier of the config merge — fetched once
  // for the whole tab by the provider, which the runtimes read them from too.
  const serverDefaults = useServerDefaults()

  /**
   * What this vault actually runs with: node defaults, this browser's overrides,
   * then the vault's own. The single place the page reads configuration — reading
   * `vault.configOverrides` directly would see nothing for a vault that
   * overrides nothing.
   */
  const vaultConfig = useMemo(
    () => resolveVaultConfig(vault.configOverrides, serverDefaults),
    [vault.configOverrides, serverDefaults],
  )
  // The record as the engine holds it *now*, for closures that outlive a render.
  // Read through the runtime rather than copied into a ref: a handler running
  // after a commit but before the re-render must not build on the old record.
  const vaultRef = useMemo(
    () => ({
      get current(): Vault {
        return runtime.state().vault
      },
    }),
    [runtime],
  )

  // Single protocol timeout (ms) — drives the FE watchdog and all
  // app-level wall-clock timers; the same value (in seconds) is passed to the
  // WASM constructor for the library's passive process() expiry.
  const flowTimeoutMs = protocolTimeoutMs(vaultConfig.protocolTimeoutSecs)

  // Protocol settings this device pushes to the backend whenever it provisions
  // an actor. Configuration is FE-owned, so the backend has no policy of its
  // own for a new participant or replica to inherit.
  const provisioningSettings: ProvisioningSettings = {
    protocolTimeoutSecs: vaultConfig.protocolTimeoutSecs,
    unpairAck: vaultConfig.unpairAck,
  }
  const [activeTab, setActiveTab] = useState<ActiveTab>(
    'participants',
  )
  const [shareOpen, setShareOpen] = useState(false)
  const [pairOpen, setPairOpen] = useState(false)
  const [protectOpen, setProtectOpen] = useState(false)
  const [secretToRemove, setSecretToRemove] = useState<UserSecret | null>(null)
  const [identityOpen, setIdentityOpen] = useState(false)
  // Set of paired channel IDs watched by PairInitiatorModal to detect when pairing completes.
  const pairedChannelIds = useMemo(() => {
    const ids = new Set<string>()
    for (const p of vault.participants) {
      if (p.connectionStatus === 'paired' && p.channelId) ids.add(p.channelId)
    }
    return ids
  }, [vault.participants])

  // Polled by PairInitiatorModal — incremented on process() errors with "non-ok status".
  const [pairingRejectionCount, setPairingRejectionCount] = useState(0)

  // Fallback success signal for recovery pairings where protocol.start() returns a
  // different channel ID than PairingCompleted.channel_id (so pairedChannelIds won't match).
  const [pairingCompletedSignal, setPairingCompletedSignal] = useState(0)

  // Non-empty while the engine is auto-pairing at setup; shows a setup gate.
  const autoPairingIds = runtimeState.autoPairing

  // Shape and replica/participant discrimination live in `inboundPairing.ts`;
  // both verdicts share this one slot so the accept/reject handlers, and the
  // poll gate that holds back the destructive mailbox drain, stay single-path.
  // The confirmations themselves are engine state — see `attentionOf` below.
  // They live there because a vault that is not on screen still has to raise
  // one, and because the drain gate reads the same queue.

  // ── Pairing modal: in-modal "accept + link" path (User auth method) ────────
  // The modal has two views: the decision view (Accept / Reject / Link) and an
  // in-place link picker. Switching to the picker does NOT send the pairing
  // response yet — the response is sent only when the user confirms the link,
  // at which point we accept the pairing and then call `linkChannelsAtomic`.
  type PairingModalView = 'decision' | 'linking'
  const [pairingModalView, setPairingModalView] = useState<PairingModalView>('decision')
  const [pairingLinkTarget, setPairingLinkTarget] = useState<string | null>(null)
  const [pairingLinkSubmitting, setPairingLinkSubmitting] = useState(false)

  // The reset effect for this modal lives below, next to where the pairing
  // confirmation is derived from the engine's attention queue.

  // `StoreShareRequest`, `VerifyShareRequest` and `UnpairRequest` moved to
  // `vault/types.ts` with the attention queue that now carries them.

  /**
   * A helper channel that completed its handshake but is still `Pending`,
   * awaiting an out-of-band fingerprint comparison.
   *
   * Only `NoKeys` pairings land here — `InlineKeys` and `HashedKeys` both
   * commit to the keys, so the library promotes them to `Paired` immediately.
   */
  interface PendingFingerprintGate {
    channelId: string
    peerName: string
    /** `null` when the peer is another browser, which confirms on its own screen. */
    peerActorId: string | null
  }

  const [pendingFingerprintGate, setPendingFingerprintGate] =
    useState<PendingFingerprintGate | null>(null)

  /**
   * Bumped whenever a channel's stored status may have moved, so the derived
   * set below is recomputed. The status lives in the library's own store rather
   * than in React state, and nothing re-renders when the library writes to it.
   */
  const [channelStatusNonce, setChannelStatusNonce] = useState(0)

  /**
   * Channels whose handshake completed but which the library still holds
   * `Pending`.
   *
   * Read from the channel store rather than tracked alongside the roster: the
   * library owns this state and promotes the channel itself, so a second copy
   * in app state could only drift — and drifting the wrong way means telling
   * the user a channel is paired while every share sent to it is dropped.
   */
  const unconfirmedChannelIds = useMemo<ReadonlySet<string>>(() => {
    const pending = new Set<string>()
    const namespace = `vault:${vault.id}`

    for (const participant of vault.participants) {
      if (!participant.channelId) continue
      if (readHelperChannelStatus(namespace, vault.secretId, participant.channelId) === 'Pending') {
        pending.add(participant.channelId)
      }
    }
    return pending
    // `channelStatusNonce` is deliberately a dependency the body never reads:
    // the status lives in the library's store, not in React state, so bumping
    // the nonce is the only way to make this recompute after a confirmation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault.id, vault.secretId, vault.participants, channelStatusNonce])

  /**
   * Raise the fingerprint gate if the library left `channelId` `Pending`.
   *
   * Reading the stored status rather than remembering which mode was chosen is
   * what makes this work on the *responding* side too, where the app never saw
   * the contact and so never knew its mode. It is also the library's own answer
   * rather than the app's guess about it.
   */
  function maybeRaiseFingerprintGate(channelId: string, snapshot: Vault): void {
    const status = readHelperChannelStatus(`vault:${snapshot.id}`, secretIdRef.current, channelId)
    if (status !== 'Pending') return

    const peer = snapshot.participants.find(p => p.channelId === channelId)
    setPendingFingerprintGate({
      channelId,
      peerName: peer?.name ?? 'this peer',
      // Only when the backend actually knows this peer — see
      // `canDrivePeerViaBackend`. A browser peer confirms on its own screen,
      // and a synthetic row has no actor id to ask about.
      peerActorId: canDrivePeerViaBackend(peer) ? peer!.id : null,
    })

    log({
      role: 'owner',
      flow: 'pairing',
      step: 'fingerprint_gate_raised',
      description: `Channel ${channelId} is pending an out-of-band fingerprint confirmation`,
      payload: { channelId, peerName: peer?.name ?? null },
    })
  }

  // A mirrored secret this device (as a replica destination) has received but
  // not yet been asked to adopt. Deliberately plain component state, not part
  // of `Vault` or persisted storage: adopting it — wiping this device's
  // vault and calling `protocol.restore` — is Task 11's explicit, user-gated
  // step, and nothing here performs it or survives a reload to retry it
  // automatically. Losing an unconfirmed offer on refresh is the safe
  // direction; the source's next sync round re-offers it.

  // The last automatic replica sync round that sent nothing is the engine's
  // (`runtimeState.replicaAutoSyncOutcome`): the trigger runs there, so a vault
  // off screen still mirrors — and still records a round that sent nothing.
  const replicaAutoSyncOutcome = runtimeState.replicaAutoSyncOutcome

  // ── Replica projection ─────────────────────────────────────────────────────
  //
  // One projection, read by two surfaces: the replica rows in the channel list
  // and the fingerprint modal. The side panel's "Replicas" section holds no
  // list of its own — it only offers "+ Add", which pairs a helper in replica
  // mode — so it does not read this. Fed by the roster poll that already runs
  // below — an earlier version of the side panel ran a second poll of its own,
  // which is what let the two disagree about a row's status.
  // Fed by the manager's shared roster poll, which reads once for every vault.
  const [replicaRows, setReplicaRows] = useState<ReplicaView[]>(() => {
    const roster = manager.roster()
    return roster ? replicaViews(roster, loadReplicaState(vault.id)) : []
  })
  /**
   * A helper provisioned for an Add Replica attempt whose pairing then failed.
   *
   * Held so the retry reuses it. Nothing removes an actor — there is no such
   * route — so the alternative is a helper left in the shared pool for every
   * press of a button the user is being invited to press again.
   */
  const pendingReplicaHelperRef = useRef<{ name: string; helperId: string } | null>(null)

  /**
   * The replica group as the **library** holds it, not as the app remembers it.
   *
   * The two diverge, and only this side decides whether a peer may rejoin: a
   * member the app has forgotten still occupies its replica id, and the peer is
   * turned away with "replica id is already in use by another member of the
   * group" with nothing on screen to explain it. Reading the store is how such
   * a member becomes visible — and, through `evictReplicaMember`, removable.
   */
  const [storedMembers, setStoredMembers] = useState<readonly StoredReplicaMember[]>([])

  const refreshStoredMembers = useCallback(() => {
    const secretId = secretIdRef.current
    if (!secretId) return
    setStoredMembers(listReplicaMembers(`vault:${vault.id}`, secretId))
  }, [vault.id])

  /**
   * Recompute the projection from the roster already in hand.
   *
   * Local replica state is written synchronously — by the pairing fold, by a
   * fingerprint confirmation — so after either of those this is current
   * immediately, and the row does not have to wait a poll interval to stop
   * lying about its status.
   */
  const refreshReplicaRows = useCallback(() => {
    // Unconditional, and before the roster guard: the library's own group is
    // readable without a roster, and it is precisely when the app's picture is
    // incomplete that seeing the protocol's matters.
    refreshStoredMembers()

    const snapshot = manager.roster()
    if (!snapshot) return
    setReplicaRows(replicaViews(snapshot, loadReplicaState(vault.id)))
    // `refreshStoredMembers` is itself a stable callback over the same owner id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault.id])

  /**
   * Every actor id the node's latest roster lists, or `null` before the first
   * roster lands. `null` reads as "unknown", never as "gone": a row is only
   * marked removed once a roster has positively left it out.
   */
  const [nodeActorIds, setNodeActorIds] = useState<ReadonlySet<string> | null>(() => {
    const roster = manager.roster()
    return roster ? new Set(roster.map(a => a.id)) : null
  })

  // Follow the shared roster. Members are read at mount too: they are part of
  // the same projection, and nothing else reads them on a page that loads into
  // an established group — the event-driven refresh only fires on *changes*.
  useEffect(() => {
    refreshStoredMembers()
    return manager.subscribeRoster(actors => {
      setReplicaRows(replicaViews(actors, loadReplicaState(vault.id)))
      setNodeActorIds(new Set(actors.map(a => a.id)))
      refreshStoredMembers()
    })
  }, [manager, vault.id, refreshStoredMembers])

  /**
   * The replica channel whose fingerprint comparison is on screen, or `null`.
   *
   * Raised automatically when a replica handshake completes — on both sides —
   * and re-openable from the row for as long as the channel is unconfirmed.
   * Dismissing writes nothing and cancels nothing: the channel stays `Pending`,
   * the row keeps its prompt, and the expiry keeps counting down.
   */
  const [fingerprintChannelId, setFingerprintChannelId] = useState<string | null>(null)

  /**
   * The replica removal — "Forget" or "Remove from group" — awaiting
   * confirmation, or `null`.
   *
   * Both are confirmed. Forget is silent on the wire, so the user has to be
   * told the peer keeps mirroring before it happens; Remove from group erases
   * the evicted device's copy, and when that device is the source it erases
   * the vault's original. See `ReplicaRemovalDialog`.
   */
  const [removalRequest, setRemovalRequest] = useState<ReplicaRemovalRequest | null>(null)

  /** The replica channel whose "Sync now" is in flight. One at a time: a round is global. */
  const [syncingChannelId, setSyncingChannelId] = useState<string | null>(null)
  /** The result of a sync the user explicitly asked for, and the row they asked on. */
  const [manualSyncNotice, setManualSyncNotice] = useState<{
    channelId: string
    notice: ReplicaRowSyncNotice
    outcome: ManualReplicaSyncOutcome['kind']
    sentAt: number
  } | null>(null)

  /** Whether the pending adoption's confirmation dialog is open. */
  const [adoptionOpen, setAdoptionOpen] = useState(false)
  /**
   * Spent adoption verdicts, keyed by channel — deliberately not by version.
   *
   * The source re-sends the mirrored vault every round, so a failed attempt is
   * always followed by a v+1 offer. Keying by channel is what stops that newer
   * offer from re-arming the destructive confirm with the prior failure's
   * evidence erased.
   */
  const [adoptionFailures, setAdoptionFailures] = useState<Record<string, RestoreFailure>>({})


  // Outgoing-unpair confirmation: when the Vault clicks "Unpair" on a paired
  // channel, surface a modal so the user sees an immediate response (and
  // can't fire a second request before the first is processed).
  const [outgoingUnpairConfirmation, setOutgoingUnpairConfirmation] = useState<OutgoingUnpairConfirmation | null>(null)

  // Channels whose unpair request has been sent and is awaiting the peer's
  // response (or timeout). Used to disable the Unpair button so a repeated
  // click can't push a second envelope down a channel whose shared key the
  // peer has already deleted — which surfaces on the peer side as
  // "unknown channel_id: no shared key or pairing secret found".
  const [unpairingChannelIds, setUnpairingChannelIds] = useState<Set<string>>(() => new Set())

  // A group-wide sync check is in flight. Group-wide rather than per-row: the
  // flow takes no parameters and asks every member at once.
  const [replicaDiscoveryRunning, setReplicaDiscoveryRunning] = useState(false)
  // Replica ids whose eviction is in flight, keyed by the protocol-level
  // replica id the flow names — not the backend actor id.
  const [removingReplicaIds, setRemovingReplicaIds] = useState<Set<string>>(() => new Set())

  // Channel whose "Link" button was clicked; drives the link modal.
  const [linkSourceChannelId, setLinkSourceChannelId] = useState<string | null>(null)
  // Bumped after a successful link so the grouped channel view recomputes.
  const [linkVersion, setLinkVersion] = useState(0)
  // Paired channels grouped by their channel-link connected component.
  const linkGroups = useLinkGroups({
    participants: vault.participants,
    mainChannels: vault.mainChannels,
    linkVersion,
    getChannelStore: () => ownInstance()?.channelStore ?? null,
    getSecretId: () => secretIdRef.current,
  })

  // ── Vault engine ───────────────────────────────────────────────────────────
  //
  // The engine is the manager's, not this page's. The page attaches the things
  // only a DOM can do; while it is not mounted they are no-ops and the engine
  // raises attention instead. Each reads a ref or a state setter at call time,
  // so the object stays valid for the life of the page.
  const runtimeRef = useRef(runtime)
  useEffect(
    () =>
      runtime.attachView({
        refreshReplicas: () => refreshReplicaRows(),
        openFingerprint: channelId => setFingerprintChannelId(channelId),
        openAdoption: () => setAdoptionOpen(true),
        pairingRejected: () => setPairingRejectionCount(c => c + 1),
        pairingCompleted: (channelId, snapshot) => {
          setPairingCompletedSignal(c => c + 1)
          // A `NoKeys` handshake completes into `Pending`, not `Paired`.
          maybeRaiseFingerprintGate(channelId, snapshot)
        },
        unpairSettled: channelId => {
          setUnpairingChannelIds(prev => {
            if (!prev.has(channelId)) return prev
            const next = new Set(prev)
            next.delete(channelId)
            return next
          })
          setOutgoingUnpairConfirmation(cur => (cur?.channelId === channelId ? null : cur))
        },
        channelsLinked: () => setLinkVersion(v => v + 1),
      }),
    // The effects read refs and setters at call time; re-attaching on every
    // render would only churn. One attach per runtime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runtime],
  )

  /** The vault's protocol instance, or null before it has started. */
  function ownInstance(): ProtocolInstance | null {
    return runtimeRef.current?.instance() ?? null
  }

  /**
   * The secret this vault protects.
   *
   * Still a ref so the ~20 store-reading call sites are untouched, but sourced
   * from the runtime: refs initialise during render where effects do not, and
   * anything reading a secret-partitioned store on mount would otherwise
   * address the empty partition and find nothing.
   */
  const secretIdRef = useRef<string>(vault.secretId)
  secretIdRef.current = vault.secretId

  /** The replica flows' view of this vault's protocol, lock-guarded; owned by the engine. */
  const replicaProtocol = runtime.replicaProtocol

  // Set when a wipe-and-adopt erased this device's namespace and then failed.
  // The page is then not merely showing an error — it is unusable, and says so.
  // Terminal by design: no retry, no automatic repair, and no path back until
  // the user erases this browser's DeRec data. The engine persists it, so a
  // reload of the unchanged vault record stays blocked.
  const adoptionBlock = runtimeState.blockedBy

  /** The open item of `kind`, if any. The engine owns these; this only reads. */
  function attentionOf<P>(kind: AttentionKind): Attention<P> | null {
    const found = runtimeState.attention.find(item => item.kind === kind)
    return (found as Attention<P> | undefined) ?? null
  }

  const pairingAttention = attentionOf<PendingPairingConfirmation>('pairing')
  const storeShareAttention = attentionOf<StoreShareRequest>('store-share')
  const verifyShareAttention = attentionOf<VerifyShareRequest>('verify-share')
  const unpairAttention = attentionOf<UnpairRequest>('unpair')
  const replicaAdoptionAttention = attentionOf<PendingReplicaAdoption>('replica-adoption')

  const pendingPairingConfirmation = pairingAttention?.payload ?? null
  const pendingStoreShareConfirmation = storeShareAttention?.payload ?? null
  const pendingVerifyShareConfirmation = verifyShareAttention?.payload ?? null
  const pendingUnpairConfirmation = unpairAttention?.payload ?? null
  const pendingReplicaAdoption = replicaAdoptionAttention?.payload ?? null

  /** Accept the open item of `kind`. The engine answers the protocol and clears it. */
  function acceptAttentionOf(kind: AttentionKind): Promise<void> {
    const item = attentionOf(kind)
    return item ? runtime.acceptAttention(item.id) : Promise.resolve()
  }

  /** Reject the open item of `kind` — or, for an adoption offer, dismiss it. */
  function rejectAttentionOf(kind: AttentionKind): Promise<void> {
    const item = attentionOf(kind)
    return item ? runtime.rejectAttention(item.id) : Promise.resolve()
  }

  // Reset the pairing modal's view and selection whenever a new confirmation
  // opens. Keyed on the channel so a second pairing does not inherit the first
  // one's half-finished link choice. Adjusted during render, so the new
  // confirmation never paints with the previous one's state.
  const pairingChannelId = pendingPairingConfirmation?.channelId
  const [pairingModalChannelId, setPairingModalChannelId] = useState(pairingChannelId)
  if (pairingModalChannelId !== pairingChannelId) {
    setPairingModalChannelId(pairingChannelId)
    setPairingModalView('decision')
    setPairingLinkTarget(null)
    setPairingLinkSubmitting(false)
  }

  // ── Deciding attention items ───────────────────────────────────────────────
  //
  // The engine answers the protocol and clears the item; the view only picks
  // which item and keeps its own modal state around the call.

  const handleAcceptPairing = () => acceptAttentionOf('pairing')
  const handleRejectPairing = () => rejectAttentionOf('pairing')

  /**
   * Accept a pairing and link it into an existing channel's group — the User
   * authentication method. The response is sent only once a target is picked.
   */
  async function handleAcceptAndLinkPairing(targetChannelId: string) {
    if (!pairingAttention) return
    setPairingLinkSubmitting(true)
    try {
      await runtime.acceptPairingAndLink(pairingAttention.id, targetChannelId)
    } finally {
      setPairingLinkSubmitting(false)
    }
  }

  // A request nobody answers is refused by the engine once the protocol
  // timeout passes — whether or not this page is showing it.
  const handleAcceptStoreShare = () => acceptAttentionOf('store-share')
  const handleRejectStoreShare = () => rejectAttentionOf('store-share')

  const handleAcceptVerifyShare = () => acceptAttentionOf('verify-share')
  const handleRejectVerifyShare = () => rejectAttentionOf('verify-share')

  const handleAcceptUnpair = () => acceptAttentionOf('unpair')
  const handleRejectUnpair = () => rejectAttentionOf('unpair')

  const createOwnerContact = (mode?: ContactModeKey) => runtime.createContact(mode)

  function getParticipantFunctions(participantId: string) {
    const participant = vault.participants.find(h => h.id === participantId)

    // Browser-managed participants (other owners) post their own contact via the
    // browser-contact endpoint. Pairing is always initiated by Alice's WASM.
    if (participant?.browserManaged) {
      return {
        // No mode parameter is honoured here: this fetches a contact the peer
        // browser already minted, so the mode was theirs to choose.
        createContact: async (): Promise<ContactMessage> => {
          const dto = await apiGetBrowserContact(participantId)
          if (!dto) throw new Error('Peer contact not available yet — they may still be loading.')
          return dtoToContactMessage(dto)
        },
        startPairing: (contact: ContactMessage, role: PairingRole): Promise<bigint> =>
          runtime.startPairing(contact, role, participant.name),
        startPairingAsInitiator: undefined,
      }
    }

    // Backend-managed participants: the actor initiates pairing using the owner's contact (Flow 1).
    // The owner's WASM creates a contact and the backend actor calls protocol.start with it.
    return {
      createContact: async (
        mode: ContactModeKey = DEFAULT_CONTACT_MODE,
      ): Promise<ContactMessage> => {
        const nonce = mode === 'no_keys' ? humanNonce() : undefined
        const dto = await apiCreateActorContact(participantId, mode, nonce)
        return dtoToContactMessage(dto)
      },
      startPairing: (contact: ContactMessage, role: PairingRole): Promise<bigint> =>
        runtime.startPairing(contact, role, participant?.name),
      startPairingAsInitiator: async (
        ownContact: ContactMessage,
        role: 'owner' | 'helper',
      ): Promise<bigint> => {
        // The backend actor scans our contact and initiates, so `role` is
        // already that actor's own declaration — it goes through unchanged.
        // We become the complement when its request reaches us.
        const dto = contactMessageToDto(ownContact)
        const result = await apiStartActorPairing(participantId, dto, role)
        return BigInt(result.channel_id)
      },
    }
  }

  /** Channels a provisioned helper holds, for the operator's link picker. */
  async function listParticipantChannels(participantId: string): Promise<ProvisionedChannel[]> {
    return apiListParticipantChannels(participantId)
  }

  /**
   * Declare, on a provisioned helper, that our channel and one it already
   * holds belong to the same owner.
   *
   * This is the step a real helper would take only after authenticating the
   * person — and the step that lets it answer a Discovery request from a
   * re-paired owner. Nothing on the wire can establish it.
   */
  async function linkParticipantChannels(
    participantId: string,
    channelId: string,
    linkTo: string,
  ): Promise<void> {
    await apiLinkHelperChannels(participantId, channelId, linkTo)
    log({
      role: 'owner',
      flow: 'pairing',
      step: 'operator_link',
      description: `Linked channel ${channelId} to ${linkTo} on a provisioned helper`,
      payload: { participantId, channelId, linkTo },
    })
    reportInfo('Channels linked — the helper can now answer discovery for this owner.')
  }

  const ownerStartPairing = (contact: ContactMessage, role: PairingRole, peerName?: string) =>
    runtime.startPairing(contact, role, peerName)

  async function ownerAddSecret(name: string, data: string): Promise<number | null> {
    const version = await runtime.addSecret(name, data)
    if (version !== null) setActiveTab('secrets')
    return version
  }

  const ownerRemoveSecret = (secretId: string) => runtime.removeSecret(secretId)

  // Adding and removing a secret both publish a new bag version, so both need
  // enough channels that can actually receive a share.
  const shareTargetCount = vault.participants.filter(isShareTarget).length
  const publishBlockedReason = vault.replicaConflict
    ? replicaConflictBlockReason(vault.replicaConflict)
    : shareTargetCount < vault.minParticipants
      ? `Need at least ${vault.minParticipants} paired participant${vault.minParticipants !== 1 ? 's' : ''} (currently ${shareTargetCount})`
      : null

  const ownerVerifyShares = (version: number) => runtime.verifyShares(version)
  const ownerRequestDiscovery = () => runtime.requestDiscovery()
  const ownerRecoverSecret = (
    secretId: string,
    version: number,
    label: string,
    participantChannelIds: bigint[],
  ) => runtime.recover(secretId, version, label, participantChannelIds)

  /** Restore this vault from a recovered secret, then return to the participants. */
  async function handleRestoreFromBag(secret: RecoveredSecret): Promise<void> {
    if (await runtime.restoreFromRecovered(secret)) setActiveTab('participants')
  }

  // ── Replica actions ────────────────────────────────────────────────────────

  /**
   * Pair a helper as a replica of this owner's vault.
   *
   * There is no such thing as a provisioned *replica* any more: a replica is a
   * pairing mode, and the counterparty is an ordinary helper that gains a
   * protocol instance bound to this owner's secret when the contact is minted.
   * `ownerSecretId` is what selects that instance, and it is the whole of what
   * separates this from pairing the same actor as an ordinary helper.
   *
   * Adding and pairing are one action because they always were one intent — the
   * separate Pair step existed only because a replica *actor* had to be
   * provisioned before anything could be paired with it.
   *
   * A helper is provisioned rather than drawn from the free ones already in the
   * pool, for two reasons. The name is the first: a provisioned actor advertises
   * its own name as `communication_info["name"]`, and that is what the peer
   * records and every replica row is labelled from — so reusing "Alex" for a
   * replica the user named "Laptop" would file it under "Alex" with no way back
   * to the name they chose. The second is that the pool is shared server-wide
   * and sized deliberately in the setup wizard; quietly consuming one of its
   * members would take a helper the user meant to pair as a helper.
   *
   * The one it adds is a `helper`, though, where the old path added a
   * `replica` — so unlike the old one it joins the shared pool the setup
   * wizard counts. That is correct under this model (a replica-backing helper
   * really is a helper) but it does mean the pool grows, which is why a failed
   * attempt must not add to it. See `pendingReplicaHelperRef`.
   *
   * This device is always the `replica_source`: a helper has no UI to consent
   * with, so the only direction that makes sense is mirroring *out*. The role
   * goes through `pairReplica`, which resolves it via `senderKindFor`.
   */
  async function handleAddReplica(name: string): Promise<void> {
    // Reuse the helper a previous failed attempt provisioned under this name.
    // The modal stays open on error so the user can retry, and no route removes
    // an actor — so minting a fresh one per attempt would leave a trail of
    // them in the shared pool, one per press. Reuse is safe: the replica
    // instance is created idempotently, and a half-finished pairing leaves at
    // most a `Pending` channel, which the library expires on its own.
    const pending = pendingReplicaHelperRef.current
    const helperId =
      pending?.name === name
        ? pending.helperId
        : (await apiAddHelper(name, provisioningSettings)).id

    // Recorded *before* anything that can throw, so a failure leaves the id
    // findable rather than stranded.
    pendingReplicaHelperRef.current = { name, helperId }

    await pairReplica({
      protocol: replicaProtocol,
      vaultId: vault.id,
      replicaId: helperId,
      replicaName: name,
      role: 'replica_source',
      // What makes this a replica of *this* vault rather than a helper of it.
      ownerSecretId: vault.secretId,
    })

    pendingReplicaHelperRef.current = null

    // The handshake completes over the mailbox poll; `PairingCompleted` is what
    // raises the fingerprint modal. This refresh only brings the roster forward
    // sooner, so a failure must not propagate: the pairing has already happened,
    // and throwing here would leave the modal open on a completed attempt —
    // a retry would then mint a second helper and run a second replica pairing,
    // producing two identically-named replica channels. The poll catches up.
    try {
      await refreshRosterSnapshot()
    } catch (error) {
      console.warn('roster refresh after replica pairing failed', error)
    }
  }

  /**
   * Ask the replica group which version its members hold.
   *
   * The events land through the ordinary event fold: `ReplicaDiscoveryComplete`
   * reports the outcome, and a hydration event follows only if this device
   * actually was behind.
   */
  async function handleReplicaDiscovery(): Promise<void> {
    setReplicaDiscoveryRunning(true)
    try {
      await runtime.discoverReplicas()
    } catch (err) {
      reportError('Replica discovery failed', err)
    } finally {
      setReplicaDiscoveryRunning(false)
    }
  }

  /**
   * Evict a member from the replica group.
   *
   * Two steps, and the second is not optional. `start(RemoveReplica)` only
   * *announces* the eviction: it flags the member so the next roster omits it
   * while leaving it on the distribution list, which is how the evicted device
   * learns it may tear itself down. Publishing that roster is the application's
   * job — without it the member is marked and nothing else ever happens, no
   * `ReplicaRemoved` is emitted, and the row stays put forever.
   */
  function handleRemoveFromGroup(replica: ReplicaView): void {
    const request = removalRequestFor(replica)
    if (!request) {
      // The row gates this action on the same field, so reaching here means the
      // projection changed under the click. Saying so beats returning in
      // silence, which is how this button came to look broken: a pairing that
      // never announced a replica id has no member to evict, and "Forget" is
      // the way off the screen for such a row.
      reportError(
        `${replica.name} never announced a replica id, so there is no group member to remove. Use “Forget” to drop the row from this device.`,
      )
      return
    }

    // Confirmed first, always: eviction erases the evicted device's copy.
    setRemovalRequest(request)
  }

  /** Carry out a removal the user has just confirmed. */
  function handleConfirmRemoval(request: ReplicaRemovalRequest): void {
    setRemovalRequest(null)
    if (request.kind === 'forget') {
      handleForgetReplica(request.channelId, request.name)
      return
    }
    void evictReplicaMember(request.replicaId, request.channelId)
  }

  /**
   * Evict `peerReplicaId`, whatever the app still remembers about it.
   *
   * Takes the id rather than a row because a member can outlive its row: the
   * library's group is its own record, and nothing the app forgets reaches it.
   * `channelId` is the row's, when there is one, so the participant entry goes
   * with it.
   */
  async function evictReplicaMember(
    peerReplicaId: string,
    channelId: string | null,
  ): Promise<void> {
    setRemovingReplicaIds(prev => new Set(prev).add(peerReplicaId))
    try {
      await runtime.announceReplicaEviction(peerReplicaId)

      // Publish the roster the announcement just changed. A vault with no
      // secret has no roster to publish, so the eviction stays pending until
      // one exists — there is nothing to carry it.
      if (runtime.state().vault.secretBag) {
        await runtime.syncReplicasNow()
      } else {
        reportInfo(
          'Eviction announced. It completes on the next protect round — this vault holds no secret to publish yet.',
        )
      }

      // Drop the app-side records unconditionally. The library has flagged the
      // member either way, and leaving these behind is what stranded rows
      // before: they are not reachable from the library, so nothing else ever
      // clears them, and a row that survives its member keeps offering actions
      // that can no longer do anything.
      runtime.forgetReplicaMember(peerReplicaId, channelId)

      refreshReplicaRows()
      refreshStoredMembers()
    } catch (err) {
      reportError(`Could not remove replica ${peerReplicaId} from the group`, err, {
        replicaId: peerReplicaId,
      })
    } finally {
      setRemovingReplicaIds(prev => {
        const next = new Set(prev)
        next.delete(peerReplicaId)
        return next
      })
    }
  }

  /**
   * Drop a replica row from this device, without involving the protocol.
   *
   * The escape hatch, and the only replica action that cannot fail. A replica
   * has no channel-level unpair — `RemoveReplica` names a *member*, and that id
   * arrives on `ReplicaPaired`, which a pairing that failed never sends — so a
   * row left by a broken handshake has nothing the library will act on. Before
   * this existed the row's "Unpair" dispatched the *helper* unpair flow at it,
   * which the library rejects with "channel id not present in channel store" on
   * every replica channel, healthy or not; the row could never be cleared.
   *
   * Local by construction: the peer is told nothing and keeps its own channel.
   * That is a real cost, which is why the confirmation says so.
   */
  function handleForgetReplica(channelId: string, name: string): void {
    forgetReplicaChannel(vault.id, channelId)

    const next: Vault = {
      ...vaultRef.current,
      participants: vaultRef.current.participants.filter(p => p.channelId !== channelId),
    }
    runtime.commit(next)

    // The comparison for a channel that is no longer listed has nothing left to
    // confirm, and would otherwise stay on screen over an empty tab.
    setFingerprintChannelId(cur => (cur === channelId ? null : cur))
    refreshReplicaRows()

    log({
      role: 'owner',
      flow: 'unpairing',
      step: 'replica_forgotten',
      description: `Forgot replica ${name} (channel ${channelId}) on this device only`,
      payload: { channelId, peerName: name },
    })
  }

  /**
   * Suspend or resume delivery to a replica channel's peer, from its row.
   *
   * A helper paired in replica mode answers on `/helpers` like any other
   * helper. `helperActorId` is non-null only for such a peer, so the guard is a
   * type narrowing rather than a real branch — the row offers no control at all
   * for a browser peer, which has no backend actor to suspend.
   */
  async function handleToggleReplicaPeerOffline(replica: ReplicaView): Promise<void> {
    const helperActorId = replica.helperActorId
    if (!helperActorId) return

    try {
      await apiToggleParticipantStatus(helperActorId, !replica.offline)
      await refreshRosterSnapshot()
    } catch (err) {
      reportError(
        `Could not take ${replica.name} ${replica.offline ? 'online' : 'offline'}`,
        err,
        { helperActorId },
      )
    }
  }

  /** Re-read the roster now rather than waiting out a poll interval. */
  /** Re-read the roster now rather than waiting out a poll interval. */
  function refreshRosterSnapshot(): Promise<void> {
    return manager.refreshRoster()
  }

  /**
   * Record one side of a fingerprint comparison.
   *
   * The projection is re-derived from what was just persisted rather than
   * patched beside it, so a row can never disagree with the next poll about
   * whether this device has confirmed.
   */
  function handleReplicaConfirmed(
    replicaId: string,
    patch: Partial<ReplicaRecord>,
    channelId: string | null,
  ) {
    recordConfirmation(vault.id, replicaId, patch)
    refreshReplicaRows()
    // A mirrored copy that arrived before this device confirmed was held back;
    // this confirmation is what makes it safe to offer.
    if (patch.local && channelId) runtime.replicaChannelConfirmed(channelId)
  }

  /**
   * Record that the person comparing codes on this device said they differ.
   *
   * Local only — the protocol carries no refusal — so the row is where it is
   * kept visible; without this the channel looked merely unanswered.
   */
  function handleReplicaRefused(replica: ReplicaView): void {
    recordConfirmation(vault.id, replica.id, { refused: true })
    refreshReplicaRows()
    log({
      role: 'owner',
      flow: 'pairing',
      step: 'fingerprint_refused',
      description: `Reported that the fingerprint for ${replica.name} (channel ${replica.channelId}) does not match — the channel stays unconfirmed on this device`,
      payload: { channelId: replica.channelId, peerName: replica.name },
    })
  }

  /**
   * Record that the person, on a destination, declined to adopt the peer's
   * vault. The fingerprint was not confirmed — that is the refusal, as far as
   * the library is concerned — so this only keeps the row from reading as an
   * unanswered prompt.
   */
  function handleReplicaAdoptionDeclined(replica: ReplicaView): void {
    recordConfirmation(vault.id, replica.id, { adoptionDeclined: true, adoptionConsented: false })
    refreshReplicaRows()
    log({
      role: 'owner',
      flow: 'pairing',
      step: 'replica_adoption_declined',
      description: `Declined to adopt ${replica.name}'s vault (channel ${replica.channelId}) — the fingerprint was not confirmed, so this vault is unchanged`,
      payload: { channelId: replica.channelId, peerName: replica.name },
    })
  }

  /**
   * Mirror this vault on demand, from a replica row.
   *
   * The round reaches every `Paired` destination, not just this row — the
   * library picks its own targets — so the row is only where the request is
   * made. Every outcome is reported, including the two that dispatch nothing:
   * an action that appears to do nothing is precisely the failure this exists
   * to recover from.
   */
  async function handleReplicaSyncNow(replica: ReplicaView): Promise<void> {
    const channelId = replica.channelId
    if (!channelId) return
    setSyncingChannelId(channelId)
    setManualSyncNotice(null)
    const sentAt = Date.now()
    try {
      const outcome = await runtime.syncReplicasNow()
      setManualSyncNotice({
        channelId,
        notice: describeManualSyncOutcome(outcome, replica.name),
        outcome: outcome.kind,
        sentAt,
      })
      // A round the user watched supersedes the automatic notice that told them
      // to run it.
      runtime.dismissReplicaAutoSyncOutcome()
    } finally {
      setSyncingChannelId(null)
      refreshReplicaRows()
    }
  }

  /**
   * The sync message a given replica row should show.
   *
   * A result the user just asked for wins on the row they asked it on. The
   * automatic notice has no row of its own — the trigger dispatches a global
   * round and is told nothing about who it was for — so it goes on every row
   * that can act on it, which is exactly where its "use Sync now" instruction
   * points.
   */
  function replicaSyncNoticeFor(replica: ReplicaView): ReplicaRowSyncNotice | null {
    if (manualSyncNotice?.channelId === replica.channelId) {
      // "Will acknowledge it" stops being true the moment the ack lands.
      return isSyncNoticeAnswered(manualSyncNotice.outcome, manualSyncNotice.sentAt, replica)
        ? null
        : manualSyncNotice.notice
    }
    if (manualSyncNotice) return null
    if (!replicaAutoSyncOutcome || !canRequestReplicaSync(replica)) return null
    return describeAutomaticSyncOutcome(replicaAutoSyncOutcome)
  }

  function dismissReplicaSyncNotice() {
    if (manualSyncNotice) setManualSyncNotice(null)
    else runtime.dismissReplicaAutoSyncOutcome()
  }

  /**
   * Adopt a mirrored vault offered by a replica source.
   *
   * Destructive, and gated behind `ReplicaAdoptionDialog` — this only runs on an
   * explicit confirmation. A failure blocks the vault inside the engine and is
   * re-thrown unchanged, so the dialog shows the library's own words.
   */
  async function handleAdoptReplicaSecret(adoption: PendingReplicaAdoption): Promise<void> {
    await runtime.adoptReplica(adoption)
    secretIdRef.current = runtime.secretId
    setActiveTab('participants')
  }

  const addPendingPairing = (channelId: bigint, participantId?: string, peerTransportUri?: string) =>
    runtime.addPendingPairing(channelId, participantId, peerTransportUri)

  async function handleAddParticipant(name: string, autoPair: boolean) {
    const resp = await apiAddHelper(name, provisioningSettings)
    const newParticipant: PairedParticipant = {
      id: resp.id,
      name: resp.name,
      channelId: '',
      transport: { protocol: resp.transport.protocol, uri: resp.transport.uri },
      connectionStatus: 'available',
      secretShares: [],
    }

    let updated = { ...vault, participants: [...vault.participants, newParticipant] }

    log({
      role: 'owner',
      flow: 'setup',
      step: 'participant_added',
      description: `Participant "${name}" added${autoPair ? ' (auto-pair)' : ''}`,
      payload: { participantId: resp.id, name, autoPair },
    })

    if (autoPair) {
      if (!runtime.instance()) {
        runtime.commit(updated)
        return
      }
      try {
        const dto = await apiCreateActorContact(resp.id)
        const contact = dtoToContactMessage(dto)
        const channelId = await runtime.startPairing(contact, 'owner', resp.name)
        updated = {
          ...updated,
          pendingPairings: [...updated.pendingPairings, { channelId, participantId: resp.id }],
        }

        log({
          role: 'owner',
          flow: 'pairing',
          step: 'auto_pair_initiated',
          description: `Auto-pair initiated for ${name}`,
          payload: { participantId: resp.id, channelId: channelId.toString() },
        })
      } catch (err) {
        reportError(`Auto-pairing with "${name}" failed`, err, { participantId: resp.id })
      }
    }

    runtime.commit(updated)
  }

  /**
   * Send the unpair, marking the channel in flight first so the button cannot
   * fire a second one. A dispatch failure clears the marker and any modal opened
   * for it; the terminal `Unpaired` / `UnpairRejected` events clear it otherwise.
   */
  async function dispatchUnpair(
    channelId: string,
    peerName: string,
    participantId: string,
  ): Promise<void> {
    setUnpairingChannelIds(prev => new Set(prev).add(channelId))
    const result = await runtime.unpair(channelId, peerName, participantId)
    if (result.dispatched) return

    clearUnpairInFlight(channelId)
    // Not a spinner that will never resolve, and not a silent close either:
    // the dialog says why, and — a peer deleted from its node can never agree
    // to an unpair — offers to forget the channel here.
    setOutgoingUnpairConfirmation({ participantId, peerName, channelId, failure: result.reason })
  }

  function clearUnpairInFlight(channelId: string): void {
    setUnpairingChannelIds(prev => {
      if (!prev.has(channelId)) return prev
      const next = new Set(prev)
      next.delete(channelId)
      return next
    })
  }

  /** Remove the channel from this device alone, after the user confirmed it. */
  async function handleForgetChannel(channelId: string): Promise<void> {
    try {
      await runtime.forgetChannel(channelId)
      setOutgoingUnpairConfirmation(cur => (cur?.channelId === channelId ? null : cur))
    } catch (err) {
      reportError('Could not forget the channel', err, { channelId })
    }
  }

  /**
   * Entry point for the Unpair button. Branches on the owner's
   * `unpairAck` policy:
   *
   *   - **Required**: open a confirmation modal. Clicking "Unpair" inside
   *     the modal calls `dispatchUnpair` and keeps the modal open with a
   *     spinner — same pattern as the pairing modal. The modal closes when
   *     `Unpaired` / `UnpairRejected` arrives (or on the safety-net
   *     timeout below).
   *   - **NotRequired (fire-and-forget)**: skip the modal entirely. The
   *     library drops local state on `start(Unpair)` and emits `Unpaired`
   *     synchronously, which the polling loop turns into the channel being
   *     removed from the owner.
   *
   * Placeholder rows for not-yet-paired actors carry no channel ID — they
   * have no protocol state to tear down, so we drop them locally.
   */
  function handleTogglePair(participantId: string) {
    const participant = vault.participants.find(h => h.id === participantId)
    if (!participant) return

    if (participant.connectionStatus !== 'paired' || !participant.channelId) {
      runtime.commit({
        ...vault,
        participants: vault.participants.filter(p => p.id !== participantId),
      })
      return
    }

    // An unpair request is already in flight for this channel — ignore the
    // click (the button is also disabled in the UI, but guard anyway).
    if (unpairingChannelIds.has(participant.channelId)) return

    const unpairAck = vaultConfig.unpairAck
    if (unpairAck === 'not_required') {
      void dispatchUnpair(participant.channelId, participant.name, participantId)
      return
    }

    setOutgoingUnpairConfirmation({
      participantId,
      peerName: participant.name,
      channelId: participant.channelId,
    })
  }

  /**
   * Cancel is only allowed before the request has been dispatched. Once the
   * envelope is on the wire we have to wait for the peer's ACK (or the
   * timeout sweep), otherwise we'd desync state from the peer.
   */
  function handleCancelOutgoingUnpair() {
    if (
      outgoingUnpairConfirmation &&
      unpairingChannelIds.has(outgoingUnpairConfirmation.channelId)
    ) {
      return
    }
    setOutgoingUnpairConfirmation(null)
  }

  async function handleConfirmOutgoingUnpair() {
    const confirmation = outgoingUnpairConfirmation
    if (!confirmation) return
    if (unpairingChannelIds.has(confirmation.channelId)) return

    // A retry starts clean: the previous failure no longer describes it.
    if (confirmation.failure) setOutgoingUnpairConfirmation({ ...confirmation, failure: undefined })

    // Intentionally do NOT close the modal here — under `UnpairAck::Required`
    // the user should see the in-flight state until the peer responds. The
    // modal closes when the polling loop receives the terminal `Unpaired` /
    // `UnpairRejected` event for this channel.
    await dispatchUnpair(
      confirmation.channelId,
      confirmation.peerName,
      confirmation.participantId,
    )
  }

  // Safety-net: if the library's internal timeout sweep doesn't emit an
  // Unpaired event for an in-flight outgoing unpair within the protocol
  // timeout window (plus a small grace), close the modal client-side. The
  // library should normally beat us to it — this just prevents the user
  // from being stranded on a spinner if the event never arrives.
  useEffect(() => {
    if (!outgoingUnpairConfirmation) return
    const cid = outgoingUnpairConfirmation.channelId
    if (!unpairingChannelIds.has(cid)) return

    const timer = setTimeout(() => {
      clearUnpairInFlight(cid)
      const seconds = Math.round(flowTimeoutMs / 1000)
      // What is reported has to match what happened: the library may already
      // have torn the channel down on its own deadline.
      const stillPaired = vaultRef.current.participants.some(p => p.channelId === cid)
      if (!stillPaired) {
        setOutgoingUnpairConfirmation(cur => (cur?.channelId === cid ? null : cur))
        reportInfo(
          `Unpaired on this device. The peer never acknowledged within ${seconds}s, so it may still hold its side of channel ${cid}.`,
        )
        return
      }
      setOutgoingUnpairConfirmation(cur =>
        cur?.channelId === cid
          ? {
              ...cur,
              failure: `${cur.peerName} did not acknowledge the unpair within ${seconds}s, so the channel is still paired on this device.`,
            }
          : cur,
      )
      log({
        role: 'owner',
        flow: 'unpairing',
        step: 'unpair_unacknowledged',
        description: `Unpair of channel ${cid} not acknowledged within ${seconds}s — the channel is still paired here`,
        payload: { channelId: cid },
      })
    }, flowTimeoutMs + 5000)

    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outgoingUnpairConfirmation, unpairingChannelIds])

  function handleLinkChannel(channelId: string) {
    setLinkSourceChannelId(channelId)
  }

  async function handleConfirmLink(targetChannelId: string) {
    const sourceChannelId = linkSourceChannelId
    if (!sourceChannelId) return

    try {
      await runtime.linkChannels(sourceChannelId, targetChannelId)
    } catch (err) {
      log({
        role: 'owner',
        flow: 'pairing',
        step: 'channel_link_failed',
        description: `Failed to link channels: ${errorText(err)}`,
        payload: { sourceChannelId, targetChannelId },
      })
    } finally {
      setLinkSourceChannelId(null)
    }
  }

  // A wipe-and-adopt erased this device's vault and then failed. Everything
  // below this point would operate over the erased namespace, so nothing below
  // renders. The library's own words are shown verbatim — this screen is the
  // only place they now live, since the dialog that raised them is unmounted
  // with the rest of the page.
  if (adoptionBlock) {
    return (
      <ReplicaAdoptionBlockedScreen failure={adoptionBlock} vaultName={vault.name} />
    )
  }

  // Show a setup gate while auto-pairing is in progress.
  if (autoPairingIds.length > 0) {
    const pairedCount = autoPairingIds.filter(id =>
      vault.participants.some(h => h.id === id && h.connectionStatus === 'paired'),
    ).length
    const total = autoPairingIds.length

    return (
      <div className="owner-setup-gate">
        <h2 className="setup-gate-title">Setting up</h2>
        <p className="setup-gate-description">
          Pairing {total} participant{total > 1 ? 's' : ''}…
        </p>

        <div className="setup-gate-progress">
          <div className="share-progress-bar-track">
            <div
              className="share-progress-bar-fill"
              style={{ width: `${Math.round((pairedCount / total) * 100)}%` }}
              role="progressbar"
              aria-valuenow={pairedCount}
              aria-valuemin={0}
              aria-valuemax={total}
            />
          </div>
          <p className="share-progress-summary">{pairedCount} of {total} paired</p>
        </div>

        <ul className="share-progress-list" role="list">
          {autoPairingIds.map(id => {
            const participant = vault.participants.find(h => h.id === id)
            const isPaired = participant?.connectionStatus === 'paired'
            return (
              <li
                key={id}
                className={`share-progress-item ${isPaired ? 'share-progress-item--confirmed' : ''}`}
              >
                <span className="verify-progress-icon">
                  {isPaired
                    ? <span className="verify-progress-icon--done" aria-label="Paired">✓</span>
                    : <span className="verify-spinner" role="status" aria-label="Pairing…" />
                  }
                </span>
                <span className="share-progress-item-name">{participant?.name ?? id}</span>
                <span className={`share-progress-item-status ${isPaired ? 'status--verified' : ''}`}>
                  {isPaired ? 'Paired' : 'Pairing…'}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
    )
  }

  // The same timeout the protocol instance was built with, so every replica
  // countdown runs against the deadline the library will actually drop the
  // channel on.
  const protocolTimeoutSecs =
    vaultConfig.protocolTimeoutSecs

  const replicaViewByChannelId = new Map(
    replicaRows.flatMap(view => (view.channelId === null ? [] : [[view.channelId, view] as const])),
  )

  // The two channel lists, from one pass over the roster: participant channels
  // go to the Channels tab and replica channels to the Replicas tab, and a
  // channel is in exactly one of them.
  //
  // Channels the library still holds `Pending` are excluded outright rather
  // than listed with a caveat. They carry no shares and ignore inbound
  // messages, so counting one here would put a channel in the tally of what
  // protects this secret when it protects nothing.
  const pairedChannels = splitPairedChannels(
    vault.participants.filter(p => !p.channelId || !unconfirmedChannelIds.has(p.channelId)),
  )

  /**
   * Members the library holds that no row on this page accounts for.
   *
   * This device's own `Source` entry is excluded — it is the group, not a peer
   * in it — as is every member a replica row already renders. What remains is
   * the state that has no other way to be seen: a member left behind by a
   * pairing the app forgot, or never recorded, still occupying its replica id
   * and turning that peer away on every attempt to pair again.
   */
  // Read, never minted, here: see `readReplicaId`. Empty matches no member.
  const ownReplicaId = readReplicaId(vault.id)?.toString() ?? ''
  const knownReplicaIds = new Set(
    replicaRows.flatMap(view => (view.peerReplicaId === null ? [] : [view.peerReplicaId])),
  )
  // Members of the group this device never paired with — two destinations of
  // one source are in the same group and have no channel between them. They
  // render as ordinary rows; see `groupMemberRows` for what such a row can and
  // cannot do.
  const memberRows = groupMemberRows(storedMembers, ownReplicaId, knownReplicaIds)

  // The row the fingerprint modal is for. Resolved by channel because that is
  // what both the auto-raise and the row's own prompt carry — and because the
  // channel is the only thing a replica relationship is written down against.
  const fingerprintReplica =
    fingerprintChannelId === null ? null : replicaViewByChannelId.get(fingerprintChannelId) ?? null

  // Provisioned helpers this vault still holds a channel to that the node no
  // longer lists. The roster prunes unpaired placeholders on its own; a paired
  // row is protocol state and stays, marked rather than counted as on the node.
  const removedFromNodeIds: ReadonlySet<string> =
    nodeActorIds === null
      ? new Set()
      : new Set(
          vault.participants
            .filter(p => p.channelId !== '' && !p.browserManaged && !nodeActorIds.has(p.id))
            .map(p => p.id),
        )

  // Who holds the rival copy of a diverged vault, by the name this device
  // knows them under.
  const replicaConflict = vault.replicaConflict ?? null
  const conflictRivalId = replicaConflict?.rivalReplicaId ?? null
  const conflictRivalLabel =
    conflictRivalId === null
      ? 'Another member'
      : (replicaRows.find(view => view.peerReplicaId === conflictRivalId)?.name ??
        memberRows.find(member => member.replicaId === conflictRivalId)?.name ??
        `Replica ${conflictRivalId}`)

  const adoptionLabel = pendingReplicaAdoption
    ? adoptionSourceLabel(pendingReplicaAdoption, manager.roster())
    : ''
  const adoptionFailure = pendingReplicaAdoption
    ? (adoptionFailures[pendingReplicaAdoption.channelId] ?? null)
    : null

  return (
    <ProtocolConfigProvider timeoutMs={flowTimeoutMs}>
    <div className="owner-page">
      <div className="owner-info-bar">
        <div className="owner-badge">
          <span className="meta-label">Vault</span>
          <span className="owner-name">{vault.name}</span>
        </div>

        <div className="header-transport">
          <span className="protocol-badge">{vault.transport.protocol.toUpperCase()}</span>
          <code className="header-uri">{vault.transport.uri}</code>
        </div>

        <div className="header-actions">
          <button
            className="secondary"
            onClick={() => {
              setIdentityOpen(true)
              // Read where the node lists this vault now, so the dialog does
              // not decide from a roster tick that has not run yet.
              void runtime.refreshNodeAddress()
            }}
            title="Change this vault’s name or endpoint, and tell every paired peer"
          >
            Edit Identity
          </button>
          <button className="primary" onClick={() => setShareOpen(true)}>
            Share Contact
          </button>
          <button className="secondary" onClick={() => setPairOpen(true)}>
            Pair
          </button>
          {/* No guard against a round already being in flight: the library
              keys each publishing round by its version, so concurrent rounds
              accumulate independently. They are routine here — pairing a
              helper auto-publishes, and confirming a gated channel publishes
              from `verifyFingerprint` — so blocking on one would disable this
              button for reasons the user never caused. */}
          <button
            className="primary"
            onClick={() => setProtectOpen(true)}
            disabled={publishBlockedReason !== null}
            title={publishBlockedReason ?? undefined}
          >
            Add Secret
          </button>
        </div>
      </div>

      {/*
        The standing notice for a mirrored vault on offer, at the top of the
        page where it cannot scroll out of sight. It is the way back into the
        decision whenever the dialog is not on screen — after a reload restores
        the offer, or while a fingerprint comparison is open over it.
      */}
      {pendingReplicaAdoption && !(adoptionOpen && !fingerprintReplica) && (
        <AppMuiTheme>
          <Alert
            severity={adoptionFailure ? 'error' : 'warning'}
            sx={{ mx: 2, my: 1, textAlign: 'left' }}
            action={
              <Stack direction="row" spacing={1}>
                <Button color="inherit" size="small" onClick={() => setAdoptionOpen(true)}>
                  {adoptionFailure ? 'See what failed…' : 'Review…'}
                </Button>
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => void rejectAttentionOf('replica-adoption')}
                >
                  Dismiss
                </Button>
              </Stack>
            }
          >
            {adoptionFailure ? (
              <>
                An earlier attempt to adopt {adoptionLabel}’s vault on this channel failed
                after this device’s own vault was erased, and will not be retried.{' '}
                {adoptionLabel} has since re-sent the copy (v{pendingReplicaAdoption.version}),
                but adopting it again is blocked until the device has been inspected.
              </>
            ) : (
              <>
                {adoptionLabel} sent this device a mirrored copy of their vault (v
                {pendingReplicaAdoption.version}, {pendingReplicaAdoption.shares.length} helper
                share{pendingReplicaAdoption.shares.length === 1 ? '' : 's'}). Adopting it
                erases everything this vault holds on this device. Nothing has been erased yet. Dismiss to
                discard the offer; the source's next sync will re-offer it.
              </>
            )}
          </Alert>
        </AppMuiTheme>
      )}

      {replicaConflict && (
        <ReplicaConflictPanel
          conflict={replicaConflict}
          mySecrets={vault.secretBag?.currentVersion.secrets ?? []}
          rivalLabel={conflictRivalLabel}
          onFetchRival={() => runtime.fetchReplicaConflictRival()}
          onResolve={secrets => runtime.resolveReplicaConflict(secrets)}
        />
      )}

      <CorruptShareWarnings
        reports={vault.corruptShareReports ?? []}
        participants={vault.participants}
        // Always confirmed, whatever the unpair policy: this is a suggestion
        // the app makes, not a click the owner made on the helper's row.
        onUnpair={participant =>
          setOutgoingUnpairConfirmation({
            participantId: participant.id,
            peerName: participant.name,
            channelId: participant.channelId,
          })
        }
        onDismiss={report => runtime.dismissCorruptShareReport(report)}
      />

      {shareOpen && (
        <ShareContactModal
          title="Share Contact"
          transport={vault.transport}
          createContact={createOwnerContact}
          onClose={() => setShareOpen(false)}
        />
      )}

      {pairOpen && (
        <PairInitiatorModal
          label="Participant Contact QR Payload"
          placeholder="Paste the JSON payload from the participant's Share Contact QR code"
          pairedChannelIds={pairedChannelIds}
          pairingRejectionCount={pairingRejectionCount}
          pairingCompletedSignal={pairingCompletedSignal}
          onClose={() => setPairOpen(false)}
          onSuccess={() => {}}
          onPairingRequestSent={(channelId, participantId, peerTransportUri) =>
            addPendingPairing(channelId, participantId, peerTransportUri)
          }
          resolveParticipantId={contact =>
            vault.participants.find(p => p.transport.uri === advertisedEndpoints(contact)[0]?.uri)?.id
          }
          startPairing={ownerStartPairing}
          // Browser-to-browser pairing does not go through the backend's
          // `start-pairing` route, so it is not bound by that route's
          // Vault/Helper contract: all four roles are on offer here, and a
          // browser replica is established by picking one of them.
          roleOptions={BROWSER_PAIRING_ROLE_OPTIONS}
        />
      )}

      {protectOpen && (
        <AddSecretModal
          participants={vault.participants}
          secretBag={vault.secretBag}
          threshold={vault.minParticipants}
          onClose={() => { setProtectOpen(false); runtimeRef.current?.setBusy(false) }}
          onAddSecret={ownerAddSecret}
        />
      )}

      {identityOpen && (
        <EditIdentityModal
          vaultId={vault.id}
          currentName={vault.name}
          currentEndpoint={vault.transport.uri}
          pinned={vault.ownTransportPinned ?? false}
          nodeAddress={runtime.nodeAdvertisedAddress()}
          rosterLoaded={runtime.nodeListingRead()}
          timeoutSecs={protocolTimeoutSecs}
          update={runtimeState.identityUpdate}
          onSubmit={input => runtime.updateIdentity(input)}
          onResend={() => runtime.resendIdentityUpdate()}
          onClose={() => setIdentityOpen(false)}
        />
      )}

      {secretToRemove && (
        <RemoveSecretModal
          secret={secretToRemove}
          participants={vault.participants}
          threshold={vault.minParticipants}
          onClose={() => { setSecretToRemove(null); runtimeRef.current?.setBusy(false) }}
          onRemoveSecret={ownerRemoveSecret}
        />
      )}

      {(() => {
        const pairedCount = vault.participants.filter(isShareTarget).length
        const belowMin = pairedCount < vault.minParticipants
        const recommended = effectiveRecommended(
          vault.recommendedParticipants,
          vault.minParticipants,
          vault.participants.length,
        )
        const belowRecommended = !belowMin && pairedCount < recommended
        if (belowMin) {
          return (
            <div className="owner-banner owner-banner--error" role="alert">
              Secret protection is disabled — {pairedCount} of {vault.minParticipants} required participants paired.
            </div>
          )
        }
        if (belowRecommended) {
          return (
            <div className="owner-banner owner-banner--warning" role="status">
              Only {pairedCount} of {recommended} recommended participants paired. Consider pairing more before protecting secrets.
            </div>
          )
        }
        return null
      })()}

      <div className="owner-layout">
        <div className="owner-content">
          <OwnerTabBar
            tabs={[
              { id: 'participants', label: 'Channels', count: pairedChannels.participants.length },
              {
                id: 'replicas',
                label: 'Replicas',
                // Members too, not just channels: a destination has no channel
                // to its sibling destinations, so counting channels alone made
                // the tab claim fewer replicas than it goes on to list.
                count: pairedChannels.replicas.length + memberRows.length,
              },
              { id: 'secrets', label: 'Secrets', count: vault.secretBag?.currentVersion.secrets.length ?? 0 },
              { id: 'shares', label: 'Shares', count: (vault.heldShares ?? []).length },
              { id: 'recovery', label: 'Recovery', count: (vault.recoveredSecrets ?? []).length },
            ]}
            active={activeTab}
            onSelect={setActiveTab}
          />

          <div className="tab-panel" role="tabpanel">
            {activeTab === 'participants' && (
              <PairedParticipantsList
                groups={linkGroups}
                committedVersions={committedVersionsOf(vault.secretBag)}
                unpairingChannelIds={unpairingChannelIds}
                onTogglePair={handleTogglePair}
                onLink={handleLinkChannel}
              />
            )}
            {/*
              A listing only. The fingerprint modal is mounted below, outside
              this switch, and raises itself whether or not this tab has ever
              been opened — the tab offers the way *back* into it after a
              dismissal, nothing more.
            */}
            {activeTab === 'replicas' && (
              <ReplicasTab
                channels={pairedChannels.replicas}
                viewByChannelId={replicaViewByChannelId}
                protocolTimeoutSecs={protocolTimeoutSecs}
                syncingChannelId={syncingChannelId}
                catchingUpChannelIds={runtimeState.replicaSyncing}
                syncNoticeFor={replicaSyncNoticeFor}
                onDismissSyncNotice={dismissReplicaSyncNotice}
                onOpenFingerprint={setFingerprintChannelId}
                onSyncNow={replica => void handleReplicaSyncNow(replica)}
                onForget={(channelId, name) => setRemovalRequest({ kind: 'forget', channelId, name })}
                onReplicaDiscovery={() => void handleReplicaDiscovery()}
                replicaDiscoveryRunning={replicaDiscoveryRunning}
                onRemoveFromGroup={handleRemoveFromGroup}
                removingReplicaIds={removingReplicaIds}
                onToggleOffline={replica => void handleToggleReplicaPeerOffline(replica)}
                memberRows={memberRows}
                vaultVersion={vault.secretBag?.currentVersion.version ?? null}
                groupSourceReplicaId={
                  vault.secretBag?.currentVersion.replicas?.members.find(m => m.role === 'Source')
                    ?.replicaId ?? null
                }
                onRemoveMember={replicaId => {
                  const member = memberRows.find(m => m.replicaId === replicaId)
                  if (!member) return
                  setRemovalRequest({
                    kind: 'remove',
                    replicaId: member.replicaId,
                    channelId: member.channelId,
                    name: member.name,
                    targetIsSource: member.peerRole === 'replica_source',
                  })
                }}
              />
            )}
            {activeTab === 'secrets' && (
              <SecretBagPanel bag={vault.secretBag} participants={vault.participants} pendingRounds={vault.pendingProtectRounds ?? []} onVerify={ownerVerifyShares} onVerifyClose={() => runtimeRef.current?.setBusy(false)} onAddSecret={() => setProtectOpen(true)} onRemoveSecret={setSecretToRemove} removeDisabledReason={publishBlockedReason} />
            )}
            {activeTab === 'shares' && (
              <HeldSharesList
                shares={vault.heldShares ?? []}
                participants={vault.participants}
                vaultId={vault.id}
                secretId={vault.secretId}
              />
            )}
            {activeTab === 'recovery' && (
              <RecoveryPanel
                vault={vault}
                onRequestDiscovery={ownerRequestDiscovery}
                onRecover={ownerRecoverSecret}
                onRestoreFromBag={handleRestoreFromBag}
              />
            )}
          </div>
        </div>

        <OwnerParticipantPanel
          // Provisioned helpers only. Not `!p.browserManaged`: a browser peer
          // the roster could not identify has a synthetic id and no flag, and
          // would be listed here as if it lived on this node.
          participants={vault.participants.filter(
            p => canDrivePeerViaBackend(p) && !isReplicaChannel(p),
          )}
          replicaSection={
            <OwnerReplicaSection onAdd={handleAddReplica} />
          }
          listChannels={listParticipantChannels}
          linkChannels={linkParticipantChannels}
          onTogglePair={handleTogglePair}
          onPairingRequestSent={(channelId, actorId) => addPendingPairing(channelId, actorId)}
          onAddParticipant={handleAddParticipant}
          getParticipantFunctions={getParticipantFunctions}
          pairedChannelIds={pairedChannelIds}
          pairingRejectionCount={pairingRejectionCount}
          pairingCompletedSignal={pairingCompletedSignal}
          unconfirmedChannelIds={unconfirmedChannelIds}
          onConfirmFingerprint={channelId =>
            maybeRaiseFingerprintGate(channelId, vaultRef.current)
          }
          unpairingChannelIds={unpairingChannelIds}
          removedFromNodeIds={removedFromNodeIds}
          grpcRelayEnabled={serverDefaults.grpcRelayEnabled}
        />
      </div>

      {/*
        Replica fingerprint comparison.

        Raised by `PairingCompleted` on both sides of a replica handshake rather
        than waiting to be found, and re-openable from the channel row or the
        side panel for as long as the channel is unconfirmed. `replicaProtocol`
        is a stable accessor that reads the instance at call time, so — unlike
        the panel this replaces — the control here can never be handed a `null`
        protocol captured during an early render and left disabled forever.
      */}
      {fingerprintReplica && (
        <AppMuiTheme>
          <ReplicaFingerprintDialog
            // A newly raised channel resets the dialog's own attempt state
            // rather than inheriting the previous channel's.
            key={fingerprintReplica.channelId ?? fingerprintReplica.id}
            open
            replica={fingerprintReplica}
            protocol={replicaProtocol}
            protocolTimeoutSecs={protocolTimeoutSecs}
            onConfirm={patch =>
              handleReplicaConfirmed(fingerprintReplica.id, patch, fingerprintReplica.channelId)
            }
            onDeclineAdoption={() => handleReplicaAdoptionDeclined(fingerprintReplica)}
            onRefuse={() => handleReplicaRefused(fingerprintReplica)}
            // Non-destructive by construction: nothing is written and nothing is
            // cancelled. The channel stays `Pending`, its row keeps a standing
            // prompt to reopen this, and the expiry keeps counting down.
            onClose={() => setFingerprintChannelId(null)}
          />
        </AppMuiTheme>
      )}

      {/*
        The same comparison for a *helper* channel paired with `NoKeys`. Kept
        page-level for the same reason as the replica dialog: the channel is
        unusable until it is resolved, whichever tab the user is on.
      */}
      {pendingFingerprintGate && (
        <AppMuiTheme>
          <ChannelFingerprintDialog
            key={pendingFingerprintGate.channelId}
            open
            peerName={pendingFingerprintGate.peerName}
            channelId={pendingFingerprintGate.channelId}
            peerActorId={pendingFingerprintGate.peerActorId}
            getFingerprint={replicaProtocol.getFingerprint}
            verifyFingerprint={replicaProtocol.verifyFingerprint}
            onConfirmed={channelId => {
              log({
                role: 'owner',
                flow: 'pairing',
                step: 'fingerprint_confirmed',
                description: `Confirmed the fingerprint for channel ${channelId}`,
                payload: { channelId },
              })
              // The library has just promoted the channel in its own store;
              // nothing else would tell React to look again.
              setChannelStatusNonce(n => n + 1)
            }}
            // Writes nothing: the channel stays `Pending` and is swept by the
            // tick if it is never confirmed.
            onClose={() => setPendingFingerprintGate(null)}
          />
        </AppMuiTheme>
      )}

      {/*
        A mirrored vault offered by a replica source. Page-level because it is an
        offer to erase this device, which must not depend on which tab is open.
      */}
      {pendingReplicaAdoption && (
        <AppMuiTheme>

          {/*
            Not over an open fingerprint comparison: confirming a channel is what
            releases a held offer, and the owner should finish that dialog
            before being asked to erase their vault.
          */}
          {adoptionOpen && !fingerprintReplica && (
            <ReplicaAdoptionDialog
              // Keyed by the offered version so a newer offer arriving underneath
              // an open dialog resets its in-flight state rather than showing a
              // stale payload. `priorFailure` is what stops that reset from
              // re-arming a confirm whose previous attempt failed.
              key={`${pendingReplicaAdoption.channelId}:${pendingReplicaAdoption.version}`}
              open
              adoption={pendingReplicaAdoption}
              sourceLabel={adoptionLabel}
              onAdopt={handleAdoptReplicaSecret}
              priorFailure={adoptionFailure}
              onFailed={failure =>
                setAdoptionFailures(current => ({
                  ...current,
                  [pendingReplicaAdoption.channelId]: failure,
                }))
              }
              onAdopted={() => {
                setAdoptionOpen(false)
                void rejectAttentionOf('replica-adoption')
                refreshReplicaRows()
              }}
              onCancel={() => {
                setAdoptionOpen(false)
                void rejectAttentionOf('replica-adoption')
              }}
            />
          )}
        </AppMuiTheme>
      )}

      {/* Pairing confirmation modal — two views: decision and (User auth) link picker.
          A replica pairing takes the replica-specific dialog instead: it cannot be
          linked, and the destination side needs to be told what it is agreeing to.
          Both dialogs share the same accept/reject handlers. */}
      {pendingPairingConfirmation && (() => {
        const confirmation = pendingPairingConfirmation
        const replica = confirmation.replica
        if (replica) {
          return (
            <ReplicaPairingRequestDialog
              open
              peerName={confirmation.peerName}
              channelId={confirmation.channelId}
              localRole={replica.localRole}
              peerRole={replica.peerRole}
              onAccept={() => void handleAcceptPairing()}
              onReject={() => void handleRejectPairing()}
            />
          )
        }

        const userAuthMethod = vaultConfig.authenticationMethod === 'user'
        // Linking declares two channels to belong to the same owner so shares
        // can be inherited. A replica channel holds no shares, so it is never a
        // candidate.
        const linkCandidates = vault.participants.filter(
          p =>
            p.connectionStatus === 'paired' &&
            p.channelId &&
            p.channelId !== confirmation.channelId &&
            !isReplicaChannel(p),
        )
        const linkAvailable = userAuthMethod && linkCandidates.length > 0

        return (
          <ModalFrame
            overlayClassName="modal-overlay"
            className="modal"
            labelledBy="pairing-confirm-title"
          >
            <div className="modal-header">
              {pairingModalView === 'linking' && (
                <button
                  type="button"
                  className="modal-back-btn"
                  onClick={() => {
                    setPairingModalView('decision')
                    setPairingLinkTarget(null)
                  }}
                  aria-label="Back to pairing decision"
                  disabled={pairingLinkSubmitting}
                >
                  ‹ Back
                </button>
              )}
              <h2 className="modal-title" id="pairing-confirm-title">
                Incoming Pairing Request
              </h2>
            </div>

            <div className="modal-body">
              {pairingModalView === 'decision' ? (
                <>
                  <p>
                    <strong>{confirmation.peerName}</strong>{' '}
                    wants to pair with you. Do you want to accept this pairing?
                  </p>
                  <div className="modal-actions">
                    <button className="secondary" onClick={handleRejectPairing}>
                      Reject
                    </button>
                    {linkAvailable && (
                      <button
                        className="secondary"
                        onClick={() => setPairingModalView('linking')}
                        title="Accept and link this channel to an existing one in a single step"
                      >
                        Link to existing
                      </button>
                    )}
                    <button className="primary" onClick={handleAcceptPairing}>
                      Accept
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p>
                    Pair with <strong>{confirmation.peerName}</strong> and link the new
                    channel to an existing one. Linked channels share their stored shares,
                    so a recovering owner can re-pair and inherit prior shares.
                  </p>

                  <div
                    className="link-channel-list"
                    role="listbox"
                    aria-label="Channels to link"
                  >
                    {linkCandidates.map(c => {
                      const isSelected = pairingLinkTarget === c.channelId
                      return (
                        <button
                          key={c.channelId}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          className={`link-channel-option${isSelected ? ' link-channel-option--selected' : ''}`}
                          onClick={() => setPairingLinkTarget(c.channelId)}
                          disabled={pairingLinkSubmitting}
                        >
                          <span className="link-channel-option__name">
                            {c.name}
                            {c.peerRole && (
                              <span className={`role-tag role-tag--${c.peerRole}`}>
                                {pairingRoleLabel(c.peerRole)}
                              </span>
                            )}
                          </span>
                          <span className="link-channel-option__meta">channel {c.channelId}</span>
                        </button>
                      )
                    })}
                  </div>

                  <div className="modal-actions">
                    <button
                      className="secondary"
                      onClick={() => {
                        setPairingModalView('decision')
                        setPairingLinkTarget(null)
                      }}
                      disabled={pairingLinkSubmitting}
                    >
                      Cancel
                    </button>
                    <button
                      className="primary"
                      onClick={() => pairingLinkTarget && handleAcceptAndLinkPairing(pairingLinkTarget)}
                      disabled={!pairingLinkTarget || pairingLinkSubmitting}
                    >
                      {pairingLinkSubmitting ? 'Pairing…' : 'Pair + Link'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </ModalFrame>
        )
      })()}

      {/* Store-share confirmation modal */}
      {pendingStoreShareConfirmation && (
        <ModalFrame
          overlayClassName="modal-overlay"
          className="modal"
          labelledBy="storeshare-confirm-title"
        >
          <div className="modal-header">
            <h2 className="modal-title" id="storeshare-confirm-title">Incoming Share Storage Request</h2>
          </div>
          <div className="modal-body">
            <p>
              <strong>{pendingStoreShareConfirmation.peerName}</strong> wants to store
              a secret share{pendingStoreShareConfirmation.description
                ? ` ("${pendingStoreShareConfirmation.description}")`
                : ''} — version {pendingStoreShareConfirmation.version}.
            </p>
            <p>Do you want to accept and store this share?</p>
            <div className="modal-actions">
              <button className="secondary" onClick={handleRejectStoreShare}>
                Reject
              </button>
              <button className="primary" onClick={handleAcceptStoreShare}>
                Accept
              </button>
            </div>
          </div>
        </ModalFrame>
      )}

      {/* Verify-share confirmation modal */}
      {pendingVerifyShareConfirmation && (
        <ModalFrame
          overlayClassName="modal-overlay"
          className="modal"
          labelledBy="verifyshare-confirm-title"
        >
          <div className="modal-header">
            <h2 className="modal-title" id="verifyshare-confirm-title">Incoming Verification Request</h2>
          </div>
          <div className="modal-body">
            <p>
              <strong>{pendingVerifyShareConfirmation.peerName}</strong> wants to verify
              that you still hold the secret share.
            </p>
            {pendingVerifyShareConfirmation.secretId && (
              <p className="verify-confirm-detail">
                Secret ID: <code>{pendingVerifyShareConfirmation.secretId}</code>
              </p>
            )}
            <p className="verify-confirm-detail">
              Version: <strong>V{pendingVerifyShareConfirmation.version}</strong>
            </p>
            <p>Do you want to respond to this verification challenge?</p>
            <div className="modal-actions">
              <button className="secondary" onClick={handleRejectVerifyShare}>
                Reject
              </button>
              <button className="primary" onClick={handleAcceptVerifyShare}>
                Accept
              </button>
            </div>
          </div>
        </ModalFrame>
      )}

      {/* Unpair confirmation modal */}
      {pendingUnpairConfirmation && (
        <ModalFrame
          overlayClassName="modal-overlay"
          className="modal"
          labelledBy="unpair-confirm-title"
        >
          <div className="modal-header">
            <h2 className="modal-title" id="unpair-confirm-title">Incoming Unpair Request</h2>
          </div>
          <div className="modal-body">
            <p>
              <strong>{pendingUnpairConfirmation.peerName}</strong> wants to
              end the pairing on channel{' '}
              <code>{pendingUnpairConfirmation.channelId}</code>.
            </p>
            <p>
              Accepting drops the shared key, channel record, and any shares
              stored under this channel. The peer will be notified.
            </p>
            <div className="modal-actions">
              <button className="secondary" onClick={handleRejectUnpair}>
                Reject
              </button>
              <button className="primary" onClick={handleAcceptUnpair}>
                Accept
              </button>
            </div>
          </div>
        </ModalFrame>
      )}

      {/*
        Forget / Remove-from-group confirmation. Forget is silent on the wire and
        leaves the protocol mirroring; Remove from group erases the evicted
        device's copy. Both are said before they happen, never after.
      */}
      {removalRequest && (
        <ReplicaRemovalDialog
          request={removalRequest}
          onCancel={() => setRemovalRequest(null)}
          onConfirm={handleConfirmRemoval}
        />
      )}

      {/* Outgoing unpair: the confirmation (UnpairAck::Required path), the
          wait for the peer, and — when it did not go through — the way out. */}
      {outgoingUnpairConfirmation && (
        <OutgoingUnpairDialog
          confirmation={outgoingUnpairConfirmation}
          inFlight={unpairingChannelIds.has(outgoingUnpairConfirmation.channelId)}
          onCancel={handleCancelOutgoingUnpair}
          onConfirm={() => void handleConfirmOutgoingUnpair()}
          onForget={() => void handleForgetChannel(outgoingUnpairConfirmation.channelId)}
        />
      )}

      {/* Link channel modal */}
      {linkSourceChannelId && (() => {
        const sourceChannel = vault.participants.find(
          p => p.channelId === linkSourceChannelId,
        )
        if (!sourceChannel) return null
        const candidates = vault.participants.filter(
          p =>
            p.connectionStatus === 'paired' &&
            p.channelId &&
            p.channelId !== linkSourceChannelId,
        )
        return (
          <LinkChannelModal
            sourceChannel={sourceChannel}
            candidates={candidates}
            onConfirm={handleConfirmLink}
            onClose={() => setLinkSourceChannelId(null)}
          />
        )
      })()}
    </div>
    </ProtocolConfigProvider>
  )
}
