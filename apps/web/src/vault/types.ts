// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * Types shared by a vault's engine and the view that renders it.
 *
 * Kept separate from `runtime.ts` so the view can import the shapes it renders
 * without importing the engine itself.
 */

import type { ContactMessage } from '@derec-alliance/web'

import type { RenameOwnerResult } from '../api'
import type { ConsoleEntry } from '../ConsoleContext'
import type { MailboxMessage } from '../derecApi'
import type { ServerDefaults } from '../config'
import type { ReplicaSyncTarget, RestoreFailure, UnresolvedAutomaticSync } from '../replicaFlows'
import type { PairedParticipant, SecretBag, Vault } from '../types'

export type VaultStatus =
  /** Built, not started. */
  | 'idle'
  /** `start()` is in flight. */
  | 'starting'
  /** Polling, ticking and processing. */
  | 'running'
  /**
   * Stopped by a failed replica adoption: the stores this instance reads were
   * erased to make room for a mirrored vault, so draining the (destructive)
   * mailbox into it would lose messages against state that no longer exists.
   */
  | 'blocked'
  /** `start()` threw. The vault is listed with a retry rather than taking the app down. */
  | 'failed'

/** Exactly what `useConsole().log` accepts — see `ConsoleContext.tsx`. */
export type VaultLogInput = Omit<ConsoleEntry, 'id' | 'timestamp'>

export type VaultLogger = (entry: VaultLogInput) => void

export interface VaultNotifier {
  /** Signature mirrors `reportError` in `toastBus.ts`. */
  error: (message: string, cause?: unknown, context?: Record<string, unknown>) => void
  info: (message: string) => void
  /**
   * A flow reached its end. Worth a banner only for a vault off screen — the
   * vault on screen already shows it — so the manager drops it otherwise.
   */
  outcome: (message: string) => void
}

/**
 * Everything the engine reaches the outside world through, injected so specs can
 * drive a runtime with no backend and no timers.
 */
export interface VaultRuntimeIo {
  pollMailbox: (actorId: string) => Promise<MailboxMessage[]>
  /** Publish this vault's contact so peers can discover and pair with it. */
  postBrowserContact: (actorId: string, contactJson: string) => Promise<void>
  /** Mark a participant offline on the backend. */
  markParticipantOffline: (participantId: string) => Promise<unknown>
  /** Whether the backend answers at all — to tell "server down" from "no one to send to". */
  serverReachable: () => Promise<boolean>
  /** Change the name the node lists this vault's owner actor under. */
  renameOwner: (ownerId: string, name: string) => Promise<RenameOwnerResult>
  /** Mint a contact for a provisioned participant — what auto-pairing pairs against. */
  participantContact: (participantId: string) => Promise<ContactMessage>
}

/**
 * View-side callbacks the engine pokes.
 *
 * Deliberately limited to the set the extracted code already needed — nothing
 * may be added here without a recorded reason, or the split between engine and
 * view stops meaning anything.
 */
export interface VaultViewEffects {
  /** Re-read replica projections from the stores. */
  refreshReplicas: () => void
  /** Raise the fingerprint dialog for a channel. */
  openFingerprint: (channelId: string) => void
  /** Open the replica adoption panel. */
  openAdoption: () => void
  /**
   * A counterparty answered with a non-OK status.
   *
   * Added when the drain moved in: `PairInitiatorModal` counts these to tell a
   * rejected pairing from a slow one, and that modal is view state.
   */
  pairingRejected: () => void
  /**
   * A pairing completed on `channelId`; `vault` is the record with it folded in.
   *
   * Added when the drain moved in: it signals a waiting `PairInitiatorModal`
   * (whose `start()` channel id can differ from the completed one on recovery)
   * and raises the fingerprint gate for a `NoKeys` handshake — both dialogs.
   */
  pairingCompleted: (channelId: string, vault: Vault) => void
  /**
   * An outgoing unpair on `channelId` went through or was refused.
   *
   * Added when the drain moved in: the in-flight marker that disables the
   * Unpair button, and the confirmation modal, are view state.
   */
  unpairSettled: (channelId: string) => void
  /**
   * Two channels were linked in the channel store.
   *
   * Added when the commands moved in: the grouped channel view is derived from
   * the store, which React cannot observe, so it has to be told to recompute.
   */
  channelsLinked: () => void
}

/** What asking a peer to unpair amounted to. */
export type UnpairDispatch =
  | { dispatched: true }
  /** Nothing reached the peer; `reason` says why, in words to show. */
  | { dispatched: false; reason: string }

/** What one dispatched `ProtectSecret` round produced. */
export interface ProtectRoundResult {
  /** The version the library assigned to the round. */
  version: number
  /** The participants the round registered pending shares for. */
  participants: PairedParticipant[]
  /** The replica destinations the round is expected to mirror to. */
  replicaTargets: ReplicaSyncTarget[]
}

/** A share dispatched in the current round, awaiting its confirmation. */
export interface PendingShare {
  version: number
}

/** The bag being built during a sharing round, committed only on success. */
export interface PendingBag {
  bag: SecretBag
  version: number
  protocolSecretId: string
}

/**
 * Where one peer stands on this vault's latest identity update.
 *
 * `no-answer` is the protocol timeout passing with the peer still silent — the
 * update was sent but nothing came back, most often because it went to an
 * endpoint the peer cannot answer, or the peer is offline. Distinct from
 * `failed`, which never left this device.
 */
export type ChannelInfoOutcome = 'pending' | 'updated' | 'rejected' | 'failed' | 'no-answer'

/**
 * The latest `UpdateChannelInfo` this vault sent: one entry per channel it
 * went to. Live state only — a reload forgets it, and the peers' records are
 * what matters afterwards.
 */
export interface IdentityUpdate {
  /** What changed, for the summary line. */
  changed: { name: boolean; endpoint: boolean }
  /**
   * What was announced — kept so the same update can be sent again to the
   * peers that did not get it, after local state has already moved on and a
   * diff against it would say "nothing changed".
   */
  values: { name?: string; endpoint?: string }
  /** When it was sent, epoch millis. */
  sentAt: number
  /** Keyed by channel id. */
  channels: Readonly<Record<string, IdentityUpdateChannel>>
}

export interface IdentityUpdateChannel {
  peerName: string
  /** When it was last sent to this peer, epoch millis — a resend restarts the wait. */
  sentAt: number
  outcome: ChannelInfoOutcome
  /** The peer's memo or the dispatch error, when there is one. */
  detail: string | null
}

export interface VaultRuntimeState {
  vault: Vault
  status: VaultStatus
  /** A command is in flight; controls that would race it are disabled. */
  busy: boolean
  attention: readonly Attention[]
  /** Why `status` is `failed`, for display. */
  failure: string | null
  /**
   * Why `status` is `blocked`: the failed replica adoption that erased this
   * vault's stores, in the library's own words. Persisted, so a reload stays
   * blocked.
   */
  blockedBy: RestoreFailure | null
  /**
   * Replica channels this device, as a destination, is still fetching its
   * source's copy over — shown as "Syncing" until the copy lands.
   */
  replicaSyncing: readonly string[]
  /**
   * The last automatic replica sync that sent nothing, until a round dispatches
   * or it is dismissed — see `VaultRuntime.dismissReplicaAutoSyncOutcome`.
   */
  replicaAutoSyncOutcome: UnresolvedAutomaticSync | null
  /** The latest identity update this vault sent, and how each peer answered. */
  identityUpdate: IdentityUpdate | null
  /**
   * Participants this vault is auto-pairing with at setup, until every one of
   * them has paired. The view shows a setup gate while it is non-empty.
   */
  autoPairing: readonly string[]
}

export interface VaultRuntimeDeps {
  log: VaultLogger
  notify: VaultNotifier
  /** Persist and publish a new vault record. */
  onVaultChange: (vault: Vault) => void
  getServerDefaults: () => ServerDefaults
  /** Defaults to the real `derecApi` functions. */
  io?: Partial<VaultRuntimeIo>
  /** Defaults to no-ops. */
  effects?: Partial<VaultViewEffects>
  /**
   * Told whether each mailbox poll reached the node at all.
   *
   * Every vault polls the same node, so when it is down they all fail together;
   * whoever runs several vaults folds their answers into one notice. Without
   * it, an unreachable node is reported as this vault's own error.
   */
  pollReached?: (reached: boolean) => void
}

// ── Attention ────────────────────────────────────────────────────────────────

export type AttentionKind =
  | 'pairing'
  | 'store-share'
  | 'verify-share'
  | 'unpair'
  | 'replica-adoption'

/** An inbound store-share request awaiting the owner's decision. */
export interface StoreShareRequest {
  peerName: string
  channelId: string
  secretId: string
  version: number
  description: string
  /** Opaque action token from the `ActionRequired` event — pass to accept or reject. */
  action: Uint8Array
}

/** An inbound verification challenge awaiting the owner's decision. */
export interface VerifyShareRequest {
  peerName: string
  channelId: string
  version: number
  secretId: string
  action: Uint8Array
}

/** An inbound unpair request awaiting the owner's decision. */
export interface UnpairRequest {
  peerName: string
  channelId: string
  action: Uint8Array
}

/**
 * Something this vault needs a person to decide.
 *
 * Owned by the runtime rather than the view, because a vault that is not on
 * screen still has to be able to raise one — that is what a badge in the vault
 * list renders from. The view derives its modals from these; it must not keep
 * its own copy, or the two drift and the drain gate stops matching what is
 * actually open.
 */
export interface Attention<P = unknown> {
  id: string
  kind: AttentionKind
  /**
   * Whether the mailbox drain pauses while this is unresolved.
   *
   * True for the four confirmations: processing further messages would mutate
   * the very state the owner is being asked about. False for
   * `replica-adoption` — that offer is staged and the drain continues, because
   * `mergeReplicaSecretReceipt` keeps the newer of what is staged and what
   * arrives, so a replayed stale round cannot regress a fresher offer.
   *
   * Collapsing the two would either stall a vault that need not stall, or drain
   * a destructive mailbox underneath a question still on screen.
   */
  blocksDrain: boolean
  raisedAt: number
  payload: P
}
