/**
 * Replica pairing and fingerprint confirmation.
 *
 * A replica is a second device of the *same* owner, mirroring that owner's
 * vault. Pairing is unidirectional — `ReplicaSource` (the owner's primary
 * device) against `ReplicaDestination` (the mirror) — and, unlike a helper
 * pairing, the handshake alone is not enough: the channel stays `Pending`
 * until *both* devices verify the shared fingerprint out of band. Only then
 * is it eligible to receive the owner's secrets.
 *
 * This module owns the orchestration (protocol calls + backend calls) so the
 * components stay presentational.
 */

import {
  FlowKind,
  type DeRecEvent,
  type PairingParams,
} from '@derec-alliance/web'
import { complementRole, senderKindFor, type ReplicaPairingRole } from './pairingRoles'
import { pairingRoleLabel } from './pairingRoleOptions'
import {
  apiConfirmReplicaFingerprint,
  apiCreateActorContact,
  apiGetReplicaFingerprint,
  type BEActorWithStatus,
} from './api'
import { dtoToContactMessage } from './contactDto'
import { toBase64Url } from './derecApi'
import type { BagVersion, PairedParticipant, SecretBag } from './types'

/** One row of the actor roster, as the backend reports it. */
type RosterActor = BEActorWithStatus

// ── Mirrored-secret payload shape ────────────────────────────────────────────

/** The typed `Secret` a destination receives on `ReplicaSecretReceived`. */
export type ReplicaSecretPayload = Extract<DeRecEvent, { type: 'ReplicaSecretReceived' }>['secret']

/** The per-helper committed shares carried alongside the secret. */
export type ReplicaSecretShares = Extract<DeRecEvent, { type: 'ReplicaSecretReceived' }>['shares']

/** The typed `Secret` recovery produces, and the sole input `protocol.restore` accepts. */
type RecoveredSecretPayload = Extract<DeRecEvent, { type: 'SecretRecovered' }>['secret']

/**
 * True iff `X` and `Y` are the *same* type, not merely mutually assignable.
 *
 * The conditional is deferred behind an unresolved type parameter, so the
 * compiler compares the two identically rather than checking assignability in
 * each direction — which would also accept, say, a widened or optional-ised
 * variant of a field.
 */
type ExactlyEqual<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false

/**
 * Compile-time proof that a mirrored secret is byte-for-byte the shape
 * `protocol.restore` takes.
 *
 * `restore` is typed against `SecretRecovered['secret']` specifically, and the
 * whole point of mirroring is that a destination can install what it was sent
 * through the ordinary recovery path — no adapter, no re-encoding. The library
 * documents the two payloads as mirroring each other, but documentation is not
 * a guarantee: this is a rebuild of the WASM package away from silently
 * drifting. If the shapes ever diverge, `npm run typecheck` fails *here*,
 * naming the reason, instead of a `restore` call somewhere downstream failing
 * with a shape error at runtime on a device that is mid-recovery.
 */
export const REPLICA_PAYLOAD_MIRRORS_RECOVERY: ExactlyEqual<
  ReplicaSecretPayload,
  RecoveredSecretPayload
> = true

// ── Status machine ───────────────────────────────────────────────────────────

/**
 * Lifecycle of a replica channel as the app presents it.
 *
 * These are the library's own channel states, not a second opinion on them:
 *
 * - `unpaired` — no handshake yet, so there is no channel and nothing to verify.
 * - `pending`  — the library holds the channel `Pending`; it is not a share target.
 * - `paired`   — the library holds the channel `Paired`; it is eligible to receive secrets.
 */
export type ReplicaStatus = 'unpaired' | 'pending' | 'paired'

export interface ReplicaConfirmationFlags {
  /**
   * This device's own `verifyFingerprint` returned `true` for this channel.
   *
   * That call *is* the library's `Pending → Paired` transition: it compares the
   * entered code against this node's locally-derived fingerprint and, on a
   * match, rewrites the channel record. So this flag is not an app-side opinion
   * about pairing — it is the app's record of the library's channel status, and
   * it is the same status `ProtectSecret` filters its fan-out on.
   *
   * It is deliberately the *only* input. The peer's confirmation promotes the
   * peer's channel, not ours, and requiring it here would hold the app stricter
   * than the protocol — which for a browser replica means permanently `pending`,
   * because nothing on this device can ever observe the other browser's verify.
   */
  localConfirmed: boolean
  /**
   * The most recent comparison came back as a mismatch.
   *
   * Deliberately **not** consulted below: a mismatch means the two codes did
   * not match on this attempt, which is an ordinary out-of-band typo. The
   * channel simply stays `pending` and the user tries again — there is no
   * failure state to fall into and nothing to reset.
   */
  lastAttemptFailed?: boolean
}

/**
 * Fold a confirmation outcome into a replica's status.
 *
 * Nothing here can promote a channel the library has not itself promoted: the
 * only promoting input is `localConfirmed`, which is written on a
 * `verifyFingerprint` that returned `true` and on nothing else. There is no
 * app path that marks a channel paired without a real verification.
 */
export function nextReplicaStatus(
  current: ReplicaStatus,
  flags: ReplicaConfirmationFlags,
): ReplicaStatus {
  // Without a channel there is nothing to confirm, and `paired` is terminal —
  // confirmation is never withdrawn, only unpairing removes the channel.
  if (current === 'unpaired' || current === 'paired') return current

  return flags.localConfirmed ? 'paired' : 'pending'
}

// ── Pending-channel expiry ───────────────────────────────────────────────────
//
// The library drops a channel that is still `Pending` once
// `now - created_at > timeout` (`cleanup_expired_channels`), where `timeout` is
// the very `protocolTimeoutSecs` this app hands the protocol at construction.
// That behaviour is correct and is not worked around here — the clock simply
// runs from the channel's *creation*, not from the last thing the user did, so
// a person comparing codes at leisure can lose the channel with no explanation.
// Telling them is what this derivation is for.
//
// `created_at` is not exposed to the frontend, so the app stamps its own
// [`ReplicaChannelRecord.establishedAt`] when the handshake completes. The app
// configures the timeout *and* observes the event the channel's creation
// produced, so the only skew is that event's delivery latency — immaterial
// against a timeout measured in minutes, and small enough that a real countdown
// is honest rather than a hedge.

/** How close a pending replica channel is to being dropped by the library. */
export type ReplicaExpiryState =
  /** Comfortably inside the window; a plain figure is enough. */
  | 'ample'
  /** Within [`REPLICA_EXPIRY_WARNING_SECS`] of the deadline. */
  | 'expiring-soon'
  /** Past the deadline: the library has dropped, or is about to drop, the channel. */
  | 'expired'

export interface ReplicaExpiry {
  /** The coarse state, so the UI escalates without restating the rule. */
  state: ReplicaExpiryState
  /** Whole seconds left, rounded up. `0` once expired. */
  remainingSecs: number
  /** Epoch milliseconds at which the channel stops being confirmable. */
  expiresAt: number
}

/** How close to the deadline counts as "act now". */
export const REPLICA_EXPIRY_WARNING_SECS = 60

/** The inputs the expiry rule reads off a channel. A [`ReplicaView`] satisfies it. */
export interface ReplicaChannelTiming {
  status: ReplicaStatus
  /** Epoch milliseconds this device recorded for the handshake, or `null`. */
  establishedAt: number | null
}

/**
 * How long a pending replica channel has left, and how loudly to say so.
 *
 * Pure and `now`-injected on purpose: the boundaries are the whole point of the
 * function, and a rule that read the clock itself could only be tested by
 * waiting for it.
 *
 * `null` means "nothing expires here", and it is returned for three genuinely
 * different reasons, none of which may be shown as a deadline:
 *
 *  - the channel is not `pending`. `cleanup_expired_channels` only removes
 *    channels in `Pending`, so a `paired` channel is never dropped by it and
 *    must never report as expiring; an `unpaired` row has no channel to lose.
 *  - there is no stamp — a record written before stamping existed. Unknown is
 *    not expired, and guessing a start time would invent a deadline.
 *  - the timeout is not a usable duration.
 */
export function replicaChannelExpiry(
  channel: ReplicaChannelTiming,
  timeoutSecs: number,
  now: number,
): ReplicaExpiry | null {
  if (channel.status !== 'pending') return null
  if (channel.establishedAt === null) return null
  if (!Number.isFinite(timeoutSecs) || timeoutSecs <= 0) return null

  const expiresAt = channel.establishedAt + timeoutSecs * 1000
  const remainingMs = expiresAt - now

  // At the deadline the library's own comparison is still `>`, so the channel
  // survives by a hair. Reporting it as gone is the safe direction: the user is
  // told to pair again a moment early rather than shown a live countdown for a
  // channel the next cleanup pass will remove.
  if (remainingMs <= 0) return { state: 'expired', remainingSecs: 0, expiresAt }

  const remainingSecs = Math.ceil(remainingMs / 1000)
  return {
    state: remainingSecs <= REPLICA_EXPIRY_WARNING_SECS ? 'expiring-soon' : 'ample',
    remainingSecs,
    expiresAt,
  }
}

// ── Fingerprint formatting ───────────────────────────────────────────────────

const FINGERPRINT_DIGITS = 16
const FINGERPRINT_GROUP = 4

/**
 * Normalise a hand-typed or pasted fingerprint to the canonical
 * `XXXX-XXXX-XXXX-XXXX` form the library emits, so a code pasted without
 * separators still compares equal.
 *
 * Anything that is not exactly 16 digits is returned trimmed but otherwise
 * untouched — it is simply a wrong code, and the protocol reports the
 * mismatch like any other.
 */
export function formatFingerprint(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length !== FINGERPRINT_DIGITS) return raw.trim()
  return (digits.match(new RegExp(`.{1,${FINGERPRINT_GROUP}}`, 'g')) ?? []).join('-')
}

// ── Protocol operations ──────────────────────────────────────────────────────

/**
 * The slice of the protocol the replica flows need.
 *
 * Declared structurally rather than as `Pick<DeRecProtocol, …>` so callers can
 * pass a wrapper — the page serialises WASM access behind a lock, and a
 * non-overloaded `start` is what makes that wrapper expressible.
 */
export interface ReplicaProtocol {
  start(flowKind: FlowKind.Pairing, params: PairingParams): Promise<DeRecEvent[]>
  getFingerprint(channelId: bigint | number): Promise<string>
  verifyFingerprint(channelId: bigint | number, fingerprint: string): Promise<boolean>
  /** Ask the group which version its members hold. Takes no parameters. */
  startSyncCheck(): Promise<DeRecEvent[]>
  /** Remove a member from the group by its decimal `replica_id`. */
  startRemoveReplica(params: { replica_id: string; memo?: string }): Promise<DeRecEvent[]>
}

/**
 * Ask the group which version its members hold, and catch up if this device is
 * behind.
 *
 * Takes no parameters — the group and this device's own version both come from
 * the stores. Resolves once the round is dispatched; the outcome arrives later
 * as `SyncCheckComplete`, and a hydration event follows only when this device
 * actually was behind.
 */
export async function startSyncCheck(protocol: ReplicaProtocol): Promise<DeRecEvent[]> {
  return protocol.startSyncCheck()
}

/**
 * Remove a member from the replica group.
 *
 * Naming this device is a voluntary departure; naming another is an eviction.
 * `replicaId` is a **decimal string** rather than a number so ids above 2^53
 * survive JS number handling — the same reason the wire carries it as a string.
 *
 * Removing the member that holds `Source` is not usable in this app: the
 * library's succession is not yet implemented end to end, so a group whose
 * source leaves is left without one.
 */
export async function removeReplicaMember(
  protocol: ReplicaProtocol,
  replicaId: string,
  memo?: string,
): Promise<DeRecEvent[]> {
  return protocol.startRemoveReplica({
    replica_id: replicaId,
    ...(memo === undefined ? {} : { memo }),
  })
}

export type { ReplicaPairingRole }

export interface PairReplicaOptions {
  protocol: ReplicaProtocol
  /** This device's own owner actor id — the key its replica bookkeeping lives under. */
  ownerId: string
  /** Backend actor id of the replica to pair with. */
  replicaId: string
  /** Display name, forwarded to the peer as communication info. */
  replicaName: string
  /**
   * The role *this* device declares on the wire. The owner's primary device
   * is the `replica_source`; the peer derives the complement.
   */
  role?: ReplicaPairingRole
}

/**
 * Initiate a replica pairing and return the transient pairing channel id.
 *
 * `role` is load-bearing: it is the only thing that reaches the wire as
 * `sender_kind`, and it must resolve through `senderKindFor` so a replica
 * pairing is not silently downgraded to a helper one.
 *
 * The returned id is the transient one carried on the contact — the handshake
 * rotates to a long-term id that arrives later on `PairingCompleted`. It is
 * also recorded here, against the replica it belongs to, so that completion can
 * be attributed: the long-term id never appears on the initiating side until
 * the event arrives.
 */
export async function pairReplica(opts: PairReplicaOptions): Promise<bigint> {
  const contact = dtoToContactMessage(await apiCreateActorContact(opts.replicaId))

  const events = await opts.protocol.start(FlowKind.Pairing, {
    kind: senderKindFor(opts.role ?? 'replica_source'),
    contact,
    peerCommunicationInfo: opts.replicaName ? { name: opts.replicaName } : {},
  })

  const started = events.find(e => e.type === 'PairingStarted')
  if (!started) throw new Error('replica pairing dispatched no PairingStarted event')

  recordPendingReplicaPairing(opts.ownerId, started.channel_id, opts.replicaId)
  return BigInt(started.channel_id)
}

/** This device's fingerprint for `channelId`, as `XXXX-XXXX-XXXX-XXXX`. */
export async function fetchFingerprint(
  protocol: ReplicaProtocol,
  channelId: string | bigint,
): Promise<string> {
  return protocol.getFingerprint(BigInt(channelId))
}

/**
 * Record that the operator compared both screens and the codes matched,
 * promoting this device's side of the channel from `Pending` to `Paired`.
 *
 * Deliberately passes this device's **own** code to `verifyFingerprint`. The
 * comparison is the human's — the same model Bluetooth numeric comparison uses:
 * both ends display a code derived from the shared key, a person checks they are
 * identical, and each end records its own decision. Nothing is typed, so there
 * is no peer-supplied string for the library to re-check.
 *
 * The consequence is worth being explicit about: because the code being verified
 * is the one just derived here, this call cannot report a mismatch. `false` is
 * therefore not "the codes differ" but "the channel key changed underneath us",
 * which is why callers surface it as an error rather than as a retry prompt.
 * Refusing a mismatch is done by *not calling this* — see the dialog's reject
 * action, which leaves the channel `Pending`.
 */
export async function acceptFingerprintMatch(
  protocol: ReplicaProtocol,
  channelId: string | bigint,
  ownCode: string,
): Promise<boolean> {
  return protocol.verifyFingerprint(BigInt(channelId), formatFingerprint(ownCode))
}

// ── Peer-side operations (provisioned replicas) ──────────────────────────────
//
// A provisioned replica has no UI of its own, so this device drives both ends:
// it reads the fixture's fingerprint over HTTP and posts its own back for the
// fixture to verify.

/** Read a provisioned replica's own fingerprint. */
export async function fetchPeerFingerprint(replicaId: string): Promise<string> {
  return apiGetReplicaFingerprint(replicaId)
}

/** Have a provisioned replica verify our fingerprint. `false` on mismatch. */
export async function confirmPeerFingerprint(
  replicaId: string,
  channelId: string,
  ownCode: string,
): Promise<boolean> {
  return apiConfirmReplicaFingerprint(replicaId, channelId, formatFingerprint(ownCode))
}

// ── Local replica state ──────────────────────────────────────────────────────
//
// Two things the actor roster cannot tell us have to be remembered locally:
//
//  1. Which side has confirmed. `record.local` is set the moment this device
//     verifies the peer's fingerprint — before the backend's own
//     `replica_confirmed` flag can possibly have caught up.
//  2. The long-term channel id, learned from this device's own
//     `PairingCompleted` event as soon as the handshake completes here — ahead
//     of the backend's `replica_channels`, which only updates once its own
//     protocol instance for the replica observes the same completion.
//  3. The replica channels themselves. A browser replica is an ordinary owner
//     actor — the relationship lives on the *channel*, established by the role
//     each side declared at pairing time — so the actor roster has nothing to
//     project a row from. `channels` is the only record that such a pairing
//     happened, and the only place the direction is written down.
//
// Sharing the `derec:` prefix keeps all of it inside the app's storage sweep.

const REPLICA_STATE_KEY_PREFIX = 'derec:replica-state:'

/**
 * Whether a replica's peer has confirmed the shared fingerprint.
 *
 * `protocol-verified` is set only once the peer's own protocol instance has
 * verified this device's code — see `confirmPeerFingerprint`.
 *
 * **Not** a gate on this device's own status: the peer's verify promotes the
 * peer's channel record, and this device's promotion is settled by its own
 * verify alone. What it *is* is the answer to a question the source cannot
 * otherwise ask — "will a mirror I send now be accepted?" A destination whose
 * channel is still `Pending` drops an incoming sync silently, so a source that
 * confirmed first has to re-send once the destination catches up. That is the
 * whole reason an explicit sync action exists; see
 * [`ManualReplicaSyncOutcome`].
 *
 * Only ever observable for a *provisioned* replica, whose confirmation this
 * device drives over HTTP. A browser peer confirms on its own screen against
 * its own protocol instance, and stays `'none'` here because this device has no
 * way to see it.
 */
export type PeerConfirmation = 'none' | 'protocol-verified'

export interface ReplicaRecord {
  /** This device verified the peer's fingerprint against its own. */
  local: boolean
  peer: PeerConfirmation
  /** Long-term channel id learned from `PairingCompleted`, when known here. */
  channelId?: string
  /**
   * A `ProtectSecret` round has already been dispatched on this destination's
   * behalf since it became eligible — see `createReplicaFirstSyncTrigger`.
   *
   * Persisted rather than held in memory because the trigger is driven by a
   * poll: a reload, or the projection being rebuilt, must not re-arm a round
   * for a destination that has already had one.
   */
  firstSyncStarted?: boolean
}

/**
 * A replica channel this device took part in establishing.
 *
 * Recorded from `PairingCompleted` for **every** replica pairing, provisioned or
 * browser-to-browser. For a provisioned replica it is redundant with the roster
 * (which is why `replicaViews` de-duplicates on `channelId`); for a browser peer
 * it is the only evidence the channel exists, because that peer joined the
 * registered as an ordinary owner actor.
 */
export interface ReplicaChannelRecord {
  /** Long-term channel id — the key of this record. */
  channelId: string
  /**
   * The role **this** device declared on the channel.
   *
   * Fixed at handshake time and never inferred: it decides whether this device
   * mirrors its vault out (`replica_source`) or is offered the peer's
   * (`replica_destination`), and the latter is the destructive side.
   */
  role: ReplicaPairingRole
  /** The peer's `communication_info` name, when the handshake carried one. */
  peerName?: string
  /**
   * Epoch milliseconds at which this device observed the handshake complete.
   *
   * The app's stand-in for the library's own `Channel.created_at`, which is not
   * exposed to the frontend: it is what `cleanup_expired_channels` measures a
   * still-`Pending` channel against, so without a timestamp of some kind the app
   * cannot say a channel is about to be dropped. Written from
   * `PairingCompleted`, one event delivery after the library created the
   * channel — a skew of milliseconds against a timeout measured in minutes.
   *
   * Optional because a record written before this existed has no stamp, and a
   * missing stamp must read as "unknown", never as "expired" — see
   * [`replicaChannelExpiry`].
   */
  establishedAt?: number
  /**
   * The peer's protocol-level replica id, as a decimal string.
   *
   * Learned from `ReplicaPaired`, which fires alongside `PairingCompleted` on
   * replica handshakes and is the only place it is announced. Distinct from the
   * backend actor id the roster is keyed by, and required to name this member
   * in a `RemoveReplica` flow — every member of a group answers on one shared
   * channel, so the channel cannot identify who is being evicted.
   *
   * Optional because a record written before this existed has none, and a
   * browser peer paired through an older build will not have announced it.
   */
  peerReplicaId?: string
}

/** The last mirrored version a destination acknowledged. */
export interface ReplicaSyncRecord {
  /** Secret-bag version carried on the ack. */
  version: number
  /** Epoch milliseconds at which the ack was observed. */
  syncedAt: number
}

export interface ReplicaState {
  /** Keyed by replica actor id. */
  replicas: Record<string, ReplicaRecord>
  /**
   * Transient pairing channel id → replica actor id, recorded when a pairing is
   * dispatched and consumed when it completes. The handshake rotates to a
   * long-term id, so this is the only thing that ties the completion event back
   * to the replica it belongs to.
   */
  pendingPairings: Record<string, string>
  /**
   * Long-term channel id → the replica channel established under it.
   *
   * Keyed by channel because that is what a replica pairing *is* under the
   * corrected model: there is no replica actor to key on when the peer is
   * another browser.
   */
  channels: Record<string, ReplicaChannelRecord>
  /**
   * Long-term channel id → last acknowledged sync.
   *
   * Keyed by *channel*, not by replica actor id, because that is the only
   * identifier a `ReplicaSecretAcked` carries that this device can resolve.
   * `from_replica_id` is the peer's protocol-level replica id, which is not the
   * backend actor id the roster is keyed by, and when the destination is a
   * second browser device — an ordinary owner actor, paired browser-to-browser
   * — the backend never learns the channel at all, so a replica-id key would be
   * unresolvable for exactly the replicas that need it most.
   */
  syncs: Record<string, ReplicaSyncRecord>
}

const EMPTY_STATE: ReplicaState = {
  replicas: {},
  pendingPairings: {},
  channels: {},
  syncs: {},
}

const EMPTY_RECORD: ReplicaRecord = { local: false, peer: 'none' }

function stateKey(ownerId: string): string {
  return `${REPLICA_STATE_KEY_PREFIX}${ownerId}`
}

/**
 * Drop this owner's replica bookkeeping.
 *
 * `derec:replica-state:<ownerId>` sits outside every `derec:<ns>:` partition,
 * so `clearNamespace` does not reach it — which is what adoption needs, because
 * the confirmations and `syncs` recorded here are keyed by channel ids the
 * library drops when the vault is replaced. Left behind, a destination that had
 * itself paired a replica keeps showing that row as `paired` against a channel
 * that no longer exists.
 *
 * Deliberately narrow: `derec:replica-id` (this device's identity) is a
 * different key and must survive adoption, or the device would silently become
 * a different peer.
 */
export function clearReplicaState(ownerId: string): void {
  try {
    localStorage.removeItem(stateKey(ownerId))
  } catch {
    // Storage unavailable — nothing to clear.
  }
}

export function loadReplicaState(ownerId: string): ReplicaState {
  try {
    const raw = localStorage.getItem(stateKey(ownerId))
    if (!raw) return EMPTY_STATE
    const parsed = JSON.parse(raw) as Partial<ReplicaState>
    return {
      replicas: parsed.replicas ?? {},
      pendingPairings: parsed.pendingPairings ?? {},
      channels: parsed.channels ?? {},
      syncs: parsed.syncs ?? {},
    }
  } catch {
    // Corrupt or unavailable storage — start from "nothing confirmed", which is
    // the safe direction: the user re-confirms rather than a channel being
    // wrongly treated as a sync target.
    return EMPTY_STATE
  }
}

function saveReplicaState(ownerId: string, state: ReplicaState): ReplicaState {
  try {
    localStorage.setItem(stateKey(ownerId), JSON.stringify(state))
  } catch {
    // Storage unavailable — the returned value still drives this tab's UI.
  }
  return state
}

/** Merge a patch into one replica's record and persist. Returns the new state. */
export function recordConfirmation(
  ownerId: string,
  replicaId: string,
  patch: Partial<ReplicaRecord>,
): ReplicaState {
  const current = loadReplicaState(ownerId)
  const existing = current.replicas[replicaId] ?? EMPTY_RECORD
  return saveReplicaState(ownerId, {
    ...current,
    replicas: { ...current.replicas, [replicaId]: { ...existing, ...patch } },
  })
}

/**
 * Record that a post-pairing sync round has been dispatched for each of
 * `replicaIds`, so it is never dispatched for them again.
 *
 * Written *before* the round rather than after it: a round that fails must not
 * leave the trigger armed, or the next poll would start another one and the
 * failure would repeat on a loop. The destination is not stranded — the next
 * ordinary protect round still mirrors to it, which is exactly the behaviour
 * that existed before the trigger.
 */
export function markReplicaFirstSyncStarted(
  ownerId: string,
  replicaIds: readonly string[],
): ReplicaState {
  const current = loadReplicaState(ownerId)
  if (replicaIds.length === 0) return current

  const replicas = { ...current.replicas }
  for (const replicaId of replicaIds) {
    replicas[replicaId] = { ...(replicas[replicaId] ?? EMPTY_RECORD), firstSyncStarted: true }
  }
  return saveReplicaState(ownerId, { ...current, replicas })
}

/**
 * Note that `transientChannelId` belongs to `replicaId`, so the eventual
 * `PairingCompleted` can be attributed without guessing.
 */
export function recordPendingReplicaPairing(
  ownerId: string,
  transientChannelId: string,
  replicaId: string,
): ReplicaState {
  const current = loadReplicaState(ownerId)
  return saveReplicaState(ownerId, {
    ...current,
    pendingPairings: { ...current.pendingPairings, [transientChannelId]: replicaId },
  })
}

/**
 * Attribute a completed replica handshake to the replica that started it and
 * store the long-term channel id. A no-op when the transient id is unknown —
 * the pairing was started elsewhere (another tab, or before this record
 * existed) and the backend roster remains the only source for it.
 */
export function resolveReplicaPairing(
  ownerId: string,
  transientChannelId: string,
  channelId: string,
): ReplicaState {
  const current = loadReplicaState(ownerId)
  const replicaId = current.pendingPairings[transientChannelId]
  if (!replicaId) return current

  const pendingPairings = Object.fromEntries(
    Object.entries(current.pendingPairings).filter(([id]) => id !== transientChannelId),
  )
  const existing = current.replicas[replicaId] ?? EMPTY_RECORD
  return saveReplicaState(ownerId, {
    ...current,
    replicas: { ...current.replicas, [replicaId]: { ...existing, channelId } },
    pendingPairings,
  })
}

/**
 * Record a replica channel this device just established.
 *
 * Called for every completed replica pairing — see the `PairingCompleted` fold
 * in `ownerPairing.ts`, which is the one place both the initiating and the
 * responding side of a handshake are observed. `resolveReplicaPairing` cannot
 * stand in for it: that path only fires for a pairing *this* device dispatched
 * through `pairReplica`, so a browser peer that merely answered a handshake — or
 * one paired through the ordinary browser role picker — would leave no trace at
 * all.
 *
 * Idempotent under mailbox redelivery: `role` and `channelId` are what the
 * handshake settled and cannot change, and a repeat that carries no `peerName`
 * keeps the one already on file rather than blanking it.
 *
 * `establishedAt` is *first write wins* for the same reason but with sharper
 * consequences: the library's expiry clock runs from the channel's creation, so
 * letting a redelivered completion refresh the stamp would silently extend a
 * countdown the library is not extending, and the app would promise time the
 * channel does not have.
 */
export function recordReplicaChannel(
  ownerId: string,
  record: ReplicaChannelRecord,
): ReplicaState {
  const current = loadReplicaState(ownerId)
  const existing = current.channels[record.channelId]
  const peerName = record.peerName ?? existing?.peerName
  const establishedAt = existing?.establishedAt ?? record.establishedAt
  const peerReplicaId = record.peerReplicaId ?? existing?.peerReplicaId

  return saveReplicaState(ownerId, {
    ...current,
    channels: {
      ...current.channels,
      [record.channelId]: {
        channelId: record.channelId,
        role: record.role,
        ...(peerName === undefined ? {} : { peerName }),
        ...(establishedAt === undefined ? {} : { establishedAt }),
        ...(peerReplicaId === undefined ? {} : { peerReplicaId }),
      },
    },
  })
}

/**
 * Drop this device's bookkeeping for a member that has left the group.
 *
 * The library removes the member from its own roster, but the app keeps a
 * parallel record per *channel* — that is what a browser peer's row is built
 * from — and nothing in the library reaches it. Without this the member is
 * gone from the protocol while its row stays on screen, offering actions that
 * can no longer do anything.
 *
 * Keyed by the peer's replica id, so a member whose channel moved during an
 * admission handover is still found.
 */
export function forgetReplicaMember(ownerId: string, peerReplicaId: string): ReplicaState {
  const current = loadReplicaState(ownerId)

  const doomed = Object.values(current.channels)
    .filter(c => c.peerReplicaId === peerReplicaId)
    .map(c => c.channelId)
  if (doomed.length === 0) return current

  const channels = { ...current.channels }
  const syncs = { ...current.syncs }
  for (const channelId of doomed) {
    delete channels[channelId]
    delete syncs[channelId]
  }

  // Confirmation rows are keyed by row id, which for a browser peer is derived
  // from the channel and for a provisioned one is the actor id.
  const replicas = Object.fromEntries(
    Object.entries(current.replicas).filter(
      ([id, record]) =>
        !doomed.includes(replicaChannelRowId(id)) &&
        (record.channelId === undefined || !doomed.includes(record.channelId)),
    ),
  )

  return saveReplicaState(ownerId, { ...current, channels, syncs, replicas })
}

/**
 * Record the peer's replica id, announced by `ReplicaPaired`.
 *
 * Kept separate from `recordReplicaChannel` because the two events arrive in
 * the same batch but in no guaranteed order: this merges into whatever record
 * exists, and creates nothing on its own, so a `ReplicaPaired` seen before its
 * `PairingCompleted` is simply ignored rather than writing a record with no
 * role on it.
 */
export function recordPeerReplicaId(
  ownerId: string,
  channelId: string,
  peerReplicaId: string,
): ReplicaState {
  const current = loadReplicaState(ownerId)
  const existing = current.channels[channelId]
  if (!existing) return current

  return saveReplicaState(ownerId, {
    ...current,
    channels: {
      ...current.channels,
      [channelId]: { ...existing, peerReplicaId },
    },
  })
}

// ── Mirrored-secret sync ─────────────────────────────────────────────────────

/**
 * Fold an incoming ack into what is already recorded for a channel.
 *
 * Monotonic in `version`: the mailbox is a store-and-forward queue with
 * at-least-once delivery, so a redelivered ack for an older round can arrive
 * after a newer one. Taking the incoming record unconditionally would walk the
 * displayed version backwards and make a destination look stale when it is not.
 *
 * A redelivery of the *current* version keeps the original `syncedAt` — that is
 * when the destination actually acknowledged; the redelivery carries no new
 * information and must not refresh the timestamp.
 */
export function mergeReplicaSync(
  existing: ReplicaSyncRecord | undefined,
  incoming: ReplicaSyncRecord,
): ReplicaSyncRecord {
  if (!existing) return incoming
  return incoming.version > existing.version ? incoming : existing
}

/**
 * Record a destination's acknowledgement of a mirrored secret version.
 *
 * Keyed by the acking channel — see `ReplicaState.syncs`. Returns the new
 * state so the caller can render from it without a second read.
 */
export function recordReplicaSync(
  ownerId: string,
  channelId: string,
  sync: ReplicaSyncRecord,
): ReplicaState {
  const current = loadReplicaState(ownerId)
  return saveReplicaState(ownerId, {
    ...current,
    syncs: {
      ...current.syncs,
      [channelId]: mergeReplicaSync(current.syncs[channelId], sync),
    },
  })
}

// ── Mirrored-secret adoption (destination side) ──────────────────────────────
//
// The counterpart to the sync bookkeeping above: this is what a *destination*
// holds after `ReplicaSecretReceived` arrives, before the user has decided
// whether to adopt it. Deliberately kept in component state rather than
// persisted — adoption (wiping this device's vault and calling
// `protocol.restore`) is a separate, explicitly user-gated step, and nothing
// here performs it or prepares to perform it automatically on reload.

/** A mirrored secret received from a replica source, staged for the user's
 *  adoption decision but not yet acted on in any way. */
export interface PendingReplicaAdoption {
  /** This destination's channel to the source that sent the secret. */
  channelId: string
  /** The source's protocol-level replica id (hex-encoded u64). */
  fromReplicaId: string
  /** The source's protocol-level secret id. */
  secretId: string
  /** Secret-bag version this round carried. */
  version: number
  secret: ReplicaSecretPayload
  shares: ReplicaSecretShares
}

/**
 * Fold a newly received mirrored secret into what is already staged.
 *
 * Monotonic in `version`, mirroring `mergeReplicaSync` for the same reason:
 * the mailbox redelivers at least once, so a stale `ReplicaSecretReceived`
 * can arrive after a newer one the user has not yet acted on. Taking the
 * incoming payload unconditionally would replace a fresher pending offer
 * with a stale one out from under the user.
 */
export function mergeReplicaSecretReceipt(
  existing: PendingReplicaAdoption | null,
  incoming: PendingReplicaAdoption,
): PendingReplicaAdoption {
  if (!existing) return incoming
  return incoming.version > existing.version ? incoming : existing
}

/**
 * Who the pending offer belongs to, for the confirmation prompt.
 *
 * A destination adopts a *named owner's* vault, so the prompt has to name that
 * owner rather than an opaque replica id. The only reliable link is the secret:
 * the roster records each owner actor's `secret_id`, and the offer carries the
 * source's. Matching on that — rather than on "the owner", which is not well
 * defined when several owner actors are registered at once — is what keeps a
 * destructive prompt from naming the wrong person.
 *
 * The role check matters as much as the id check: this device may act as helper
 * for the same owner, which puts a *participant* row on the roster carrying the
 * very same `secret_id`.
 */
export function adoptionSourceLabel(
  adoption: PendingReplicaAdoption,
  actors: readonly RosterActor[] | null,
): string {
  const owner = actors?.find(a => a.role === 'owner' && a.secret_id === adoption.secretId)
  const name = owner?.name.trim()
  return name ? name : `replica source ${adoption.fromReplicaId}`
}

// ── Restore failure reporting ────────────────────────────────────────────────

/**
 * The `code` values `protocol.restore` rejects with, plus `UNKNOWN` for a
 * rejection that carries none.
 */
export type RestoreFailureCode =
  | 'ALREADY_RESTORED'
  | 'CONFLICT'
  | 'INVARIANT'
  | 'STORAGE'
  | 'UNKNOWN'

const RESTORE_FAILURE_CODES: readonly RestoreFailureCode[] = [
  'ALREADY_RESTORED',
  'CONFLICT',
  'INVARIANT',
  'STORAGE',
]

/**
 * The two codes `restore` rejects with *before* it mutates any store:
 * `ALREADY_RESTORED` (a user-secret snapshot already exists for this
 * `secret_id`) and `CONFLICT` (a channel already occupies a canonical
 * helper/replica id).
 *
 * Adoption clears the namespace first precisely so neither can be reached.
 * Seeing one therefore means the wipe did not take, and the device is in a
 * state no retry can improve.
 */
const PRECONDITION_CODES: readonly RestoreFailureCode[] = ['ALREADY_RESTORED', 'CONFLICT']

export interface RestoreFailure {
  code: RestoreFailureCode
  /** The rejected value's own message, verbatim. Empty when it carried none. */
  message: string
  /** Colliding channel ids a `CONFLICT` carries, verbatim and in order. */
  channelIds: string[]
  /**
   * True for the two preconditions above. Callers must not retry: the wipe that
   * was supposed to make them unreachable evidently did not happen, and a second
   * attempt would run `restore` against half-adopted state.
   */
  wipeDidNotTake: boolean
  /** Single-line rendering carrying every detail the rejection carried. */
  text: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function readMessage(err: unknown, record: Record<string, unknown> | null, coded: boolean): string {
  if (typeof err === 'string') return err
  const message = record?.['message']
  if (typeof message === 'string') return message
  if (record) {
    // A structured rejection with no `message`. When it did not even carry a
    // recognised code there is nothing else to show, so serialise it rather
    // than reporting "[object Object]" and losing the whole payload.
    if (coded) return ''
    try {
      return JSON.stringify(record)
    } catch {
      return String(err)
    }
  }
  return err === null || err === undefined ? '' : String(err)
}

function readChannelIds(record: Record<string, unknown> | null): string[] {
  const raw = record?.['channel_ids'] ?? record?.['channelIds']
  return Array.isArray(raw) ? raw.map(id => String(id)) : []
}

/**
 * Render a `restore` rejection into something the UI can show without editing
 * it down.
 *
 * Nothing here summarises or reinterprets: the code, the message and any
 * `channel_ids` all survive into `text` as they arrived. A wipe-and-adopt that
 * fails leaves the device's own vault already erased, so the user needs the
 * library's own words, not the app's paraphrase of them.
 */
export function describeRestoreFailure(err: unknown): RestoreFailure {
  const record = asRecord(err)
  const rawCode = record?.['code']
  const code = RESTORE_FAILURE_CODES.find(c => c === rawCode) ?? 'UNKNOWN'
  const message = readMessage(err, record, code !== 'UNKNOWN')
  const channelIds = readChannelIds(record)

  const head =
    [code === 'UNKNOWN' ? '' : code, message].filter(part => part.length > 0).join(': ') ||
    'restore was rejected without an error message'

  return {
    code,
    message,
    channelIds,
    wipeDidNotTake: PRECONDITION_CODES.includes(code),
    text: channelIds.length > 0 ? `${head} (channel_ids: ${channelIds.join(', ')})` : head,
  }
}

/** A `restore` rejection during adoption, carrying the verbatim detail. */
export class ReplicaAdoptionError extends Error {
  readonly failure: RestoreFailure

  constructor(failure: RestoreFailure) {
    super(failure.text)
    this.name = 'ReplicaAdoptionError'
    this.failure = failure
  }
}

// ── Wipe-and-adopt ───────────────────────────────────────────────────────────

/**
 * Protocol configuration an adopted instance is built with, minus the two
 * things adoption itself determines — see `ReplicaAdoptionInstanceParams`.
 */
export interface ReplicaAdoptionProtocolConfig {
  ownTransportUri: string
  communicationInfo: Record<string, string>
  threshold: number
  keepVersionsCount: number
  timeoutSecs: number
  unpairAck: 'required' | 'not_required'
}

export interface ReplicaAdoptionInstanceParams extends ReplicaAdoptionProtocolConfig {
  namespace: string
  /**
   * The **source's** secret id, never this device's own.
   *
   * `restore` reseats the protocol's `secret_id` namespace; the backend share
   * store keys on `(secret_id, channel_id, version, replica_id)`; and the
   * snapshot's helper roster carries channel ids that only attach inside that
   * namespace. All three point the same way.
   */
  secretId: string
  /** This device's own replica id, which survives the wipe. */
  replicaId: bigint
  /**
   * Always `true` for an adopted instance. Every helper in the adopted
   * roster still has the *source's* endpoint on file — it is who they
   * paired with — so without this, a request this device sends would get
   * its response delivered to the source instead of here. Not part of
   * `ReplicaAdoptionProtocolConfig`: it is not caller-configurable, it is
   * what adoption *is*.
   */
  autoReplyTo: boolean
}

/** The slice of a built protocol instance adoption drives. */
export interface AdoptableInstance {
  protocol: {
    restore(secret: ReplicaSecretPayload, version: number): Promise<DeRecEvent[]>
  }
}

/**
 * The effectful collaborators, injected so the order below is observable — and
 * therefore testable — without a WASM instance.
 */
export interface ReplicaAdoptionDeps {
  /** Erase every store in the namespace. */
  clearNamespace(namespace: string): void
  /**
   * Erase this owner's replica bookkeeping — see [`clearReplicaState`].
   *
   * Part of the wipe, not a follow-up: it is keyed by owner rather than by
   * namespace, so `clearNamespace` cannot reach it, and everything it records
   * is keyed by channel ids `restore` is about to drop.
   */
  clearReplicaBookkeeping(): void
  /**
   * This device's stable replica id. Read *after* the wipe: the identity lives
   * outside every `derec:<ns>:` partition, and reading it here is what proves
   * the device stays the same peer across adoption.
   */
  getReplicaId(): bigint
  /** Build a protocol instance over the freshly-cleared namespace. */
  buildInstance(params: ReplicaAdoptionInstanceParams): AdoptableInstance
  /** Feed one event from the restore's own teardown to the app's handler. */
  onEvent(event: DeRecEvent): void
}

export interface ReplicaAdoptionOptions {
  adoption: PendingReplicaAdoption
  /** The destination's own namespace — the one being erased. */
  namespace: string
  config: ReplicaAdoptionProtocolConfig
  deps: ReplicaAdoptionDeps
}

export interface ReplicaAdoptionOutcome {
  /** The instance now bound to the adopted vault. Callers must install it. */
  instance: AdoptableInstance
  /** The adopted (source's) secret id. */
  secretId: string
  version: number
  /** This device's replica id, unchanged by the wipe. */
  replicaId: bigint
  /** Events `restore` returned, already drained through `deps.onEvent`. */
  events: DeRecEvent[]
}

/**
 * Erase this device's vault and adopt the source's.
 *
 * The order is the whole point and must not be rearranged:
 *
 *  1. `clearNamespace` — first, unconditionally. `restore` refuses before
 *     touching a store when a user-secret snapshot already exists for the
 *     `secret_id` (`ALREADY_RESTORED`) or when a channel already sits at a
 *     canonical helper/replica id (`CONFLICT`). Wiping is what makes both
 *     unreachable. It is not a way around the library's contract: the product
 *     rule is one vault per device, and the library's preconditions say the
 *     same thing from the other side. `clearReplicaBookkeeping` belongs to the
 *     same step: the FE's replica records are keyed by owner rather than by
 *     namespace, and everything in them is keyed by channel ids `restore` is
 *     about to drop.
 *  2. Build the instance — over the now-empty namespace, at the *source's*
 *     `secretId` and this device's own `replicaId`.
 *  3. `restore` — exactly once. A rejection is reported, never retried.
 *  4. Drain the returned events (one `Unpaired` per wiped channel) through the
 *     app's handler, so the teardown is visible rather than silently dropped.
 *
 * Mirrors the proven path in `OwnerPage.handleRestoreFromBag`, which
 * already builds a fresh instance at another secret's id in a cleared namespace
 * and drains what `restore` returns.
 */
export async function adoptReplicaSecret(
  opts: ReplicaAdoptionOptions,
): Promise<ReplicaAdoptionOutcome> {
  const { adoption, namespace, config, deps } = opts

  // 1. Wipe. Nothing below may run before these two lines. The FE's own replica
  //    bookkeeping lives outside the namespace, so it takes a second call.
  deps.clearNamespace(namespace)
  deps.clearReplicaBookkeeping()

  // 2. Identity read after the wipe, and the instance built on top of it.
  const replicaId = deps.getReplicaId()
  const instance = deps.buildInstance({
    ...config,
    namespace,
    secretId: adoption.secretId,
    replicaId,
    // See `ReplicaAdoptionInstanceParams.autoReplyTo`: this is what routes
    // helper responses to the destination instead of the source post-takeover.
    autoReplyTo: true,
  })

  // 3. One attempt. `ALREADY_RESTORED` / `CONFLICT` here mean step 1 did not
  //    take, and retrying would restore over partially-adopted state.
  let events: DeRecEvent[]
  try {
    events = Array.from(await instance.protocol.restore(adoption.secret, adoption.version))
  } catch (err) {
    throw new ReplicaAdoptionError(describeRestoreFailure(err))
  }

  // 4. Drain. `onEvent` owns its own failures — a handler that throws must not
  //    turn a completed adoption into a reported failure.
  for (const event of events) deps.onEvent(event)

  return { instance, secretId: adoption.secretId, version: adoption.version, replicaId, events }
}

/** The FE owner state an adopted vault implies. */
export interface AdoptedVaultState {
  participants: PairedParticipant[]
  secretBag: SecretBag
}

/**
 * Project an adopted snapshot into the roster and bag the owner page renders.
 *
 * The snapshot carries only what travelled on the wire, so helpers are
 * re-identified against the actor roster by transport URI — unique per actor —
 * exactly as the recovery path does. Without it the adopted rows would be
 * anonymous placeholders that backend polling, which reconciles by actor id,
 * could never match.
 */
export function adoptedVaultState(
  adoption: PendingReplicaAdoption,
  actors: readonly RosterActor[],
  threshold: number,
): AdoptedVaultState {
  const actorByUri = new Map(actors.map(a => [a.transport.uri, a]))

  const participants: PairedParticipant[] = adoption.secret.helpers.map(h => {
    const actor = actorByUri.get(h.transport_uri)
    return {
      id: actor?.id ?? `peer-${h.channel_id}`,
      name: actor?.name || h.communication_info['name'] || 'Unknown',
      channelId: h.channel_id,
      transport: { protocol: 'https' as const, uri: h.transport_uri },
      connectionStatus: 'paired' as const,
      // Every peer in the owner's snapshot held a share for that owner.
      peerRole: 'helper' as const,
      secretShares: [{ version: adoption.version, status: 'confirmed' as const, verified: false }],
      browserManaged: actor?.browser_managed,
    }
  })

  const currentVersion: BagVersion = {
    version: adoption.version,
    participantIds: participants.map(p => p.id),
    verifiedParticipantIds: [],
    failedParticipantIds: [],
    secrets: adoption.secret.secrets.map(s => ({
      id: toBase64Url(s.id),
      name: s.name,
      // Payloads are text in this app; decode lossily so a binary surprise
      // renders as replacement characters instead of throwing.
      data: new TextDecoder('utf-8', { fatal: false }).decode(s.data),
    })),
    // Display-only and unread — the library decodes the snapshot itself and no
    // longer surfaces the raw wire bytes.
    rawBytes: '',
    helpers: participants.map(p => ({ id: p.id, name: p.name, channelId: p.channelId })),
  }

  return {
    participants,
    secretBag: {
      secretId: adoption.secretId,
      currentVersion,
      previousVersions: [],
      // The threshold is not carried in the snapshot; the owner's configured
      // minimum is the same value the source protected with.
      threshold,
    },
  }
}

// ── ProtectSecret target selection ───────────────────────────────────────────

/** A replica destination this device expects a `ProtectSecret` round to reach. */
export interface ReplicaSyncTarget {
  /** Backend actor id. */
  replicaId: string
  name: string
  /** Long-term channel id — the key `ReplicaSecretAcked` comes back under. */
  channelId: string
}

/**
 * The replica destinations a `start(FlowKind.ProtectSecret)` round will mirror to.
 *
 * The library performs the fan-out itself and picks its targets from its own
 * channel table — every `Paired` channel whose `peer_role` is `Helper` or
 * `ReplicaDestination`, dispatching `StoreShareRequest` to helpers and a
 * `ReplicaSecretPayload` to replica destinations. There is no target list on
 * `ProtectSecretParams` to pass, so this does not *drive* selection; it
 * reproduces it, so the app can say which destinations a round is expected to
 * reach and can tell a missing ack from one that was never due.
 *
 * Two gates, and both are the library's own rather than a second opinion on it:
 *
 *  - **`paired`** is what keeps an unconfirmed destination out. A view only
 *    reaches `paired` when `localConfirmed` is set, and that flag is written
 *    solely on a `verifyFingerprint` that returned `true` — the very call that
 *    promotes the library's channel from `Pending` to `Paired`. So every target
 *    listed here is `Paired` in the library too, and a channel the library would
 *    refuse can never appear.
 *  - **`direction === 'replica_source'`** is what keeps the *other* side of the
 *    mirror out. On a `replica_destination` row the peer is the source: the
 *    library's `peer_role` there is `ReplicaSource`, which it does not select,
 *    and a round dispatched from here would push this device's vault at a peer
 *    that never asked for it — on the destination, seconds before adoption
 *    erases the vault it just re-split.
 *
 * The direction test lives here, in the one selector, precisely so the manual
 * and automatic paths inherit it and cannot diverge.
 *
 * `offline` is deliberately not filtered on: it is a backend liveness flag on
 * the actor, not a channel state, so the library still dispatches to it. Such a
 * destination is genuinely a target that will simply not ack until it is back.
 */
export function replicaSyncTargets(views: readonly ReplicaView[]): ReplicaSyncTarget[] {
  return views.flatMap(view =>
    view.status === 'paired' && view.channelId !== null && view.direction === 'replica_source'
      ? [{ replicaId: view.id, name: view.name, channelId: view.channelId }]
      : [],
  )
}

/**
 * Whether this row may offer an explicit "sync now".
 *
 * Exactly `replicaSyncTargets` — reused rather than re-stated, so the button can
 * never be offered on a row a round would not reach. That includes the
 * `replica_source` test, which now lives in the selector itself.
 */
export function canRequestReplicaSync(view: ReplicaView): boolean {
  return replicaSyncTargets([view]).length > 0
}

// ── Sync as soon as a destination becomes eligible ───────────────────────────
//
// A replica channel sits `Pending` after the handshake; bilateral fingerprint
// confirmation is what promotes it to `Paired`, and `ProtectSecret` only ever
// selects `Paired` destinations. So the moment a destination becomes eligible
// is the moment confirmation completes — and, without a nudge, the mirrored
// secret would not leave until some later protect round happened to run,
// separating the pairing warning from the erase it warned about.

/**
 * Eligible destinations that have not yet had a round dispatched for them.
 *
 * Built by *composing* `replicaSyncTargets` rather than re-deriving its
 * predicate: the `paired` and `replica_source` gates then live in exactly one
 * place and this can only ever remove destinations from that list, never add
 * one. In particular a `replica_destination` row never becomes due here, so
 * confirming a fingerprint on the receiving device does not dispatch a round
 * from it.
 *
 * ## Why the peer's confirmation gates the *automatic* round
 *
 * `status` reaches `paired` on this device's own verify alone — the peer's
 * confirmation is a separate event this device may never observe. Dispatching
 * on that alone sends a round to a destination whose channel is very likely
 * still `Pending`, and such a destination drops it in silence. The cost is not
 * just a wasted round:
 *
 *  - a round that is dropped is never acked, so it holds the owner's single
 *    in-flight-flow slot until the protocol timeout expires, which reports
 *    "Sync now" as `busy` and ends in a spurious "operation timed out" — the
 *    manual retry this design leans on is disabled for exactly as long as it
 *    is needed;
 *  - it is redundant anyway. The library publishes the mirror itself when
 *    `verify_fingerprint` moves the channel `Pending`→`Paired` on the source,
 *    so the newly-confirmed peer is already served without a follow-up round.
 *
 * So the automatic path waits for positive evidence that the peer will accept.
 * That is only ever available for a provisioned replica, whose confirmation
 * this device drives over HTTP. A browser peer stays `'none'` and is mirrored
 * by the user pressing "Sync now" once both screens are confirmed —
 * `canRequestReplicaSync` deliberately does not consult this.
 */
export function replicasAwaitingFirstSync(views: readonly ReplicaView[]): ReplicaSyncTarget[] {
  return replicaSyncTargets(
    views.filter(
      view => !view.firstSyncStarted && view.peerConfirmation === 'protocol-verified',
    ),
  )
}

/** Why a round is being dispatched. Log context only — it selects nothing. */
export type ReplicaSyncReason = 'first-sync' | 'manual'

/** What one dispatch attempt actually did. */
export type ReplicaSyncRoundResult =
  /** A `ProtectSecret` round went out. */
  | 'dispatched'
  /** The vault holds no secrets, so there was nothing to mirror and no round ran. */
  | 'nothing-to-mirror'

/**
 * Outcome of an explicitly requested sync, reported back to the user.
 *
 * Every arm is surfaced: a manual action that silently did nothing is exactly
 * the failure this action exists to recover from.
 */
export type ManualReplicaSyncOutcome =
  | { kind: 'dispatched' }
  | { kind: 'nothing-to-mirror' }
  /** A round was already in flight — automatic or manual. Nothing was started. */
  | { kind: 'busy' }
  | { kind: 'failed'; error: unknown }

/**
 * What an *automatic* round did — the round nobody asked for and nobody is
 * watching.
 *
 * There is no `busy` arm: the automatic path defers instead of reporting, and
 * a deferral is not an outcome the user has to hear about, because the
 * destination stays due and the next poll tries again.
 */
export type AutomaticReplicaSyncOutcome =
  | { kind: 'dispatched' }
  | { kind: 'nothing-to-mirror' }
  | { kind: 'failed'; error: unknown }

/** An automatic round the user has to be told about — see [`automaticSyncNeedsAttention`]. */
export type UnresolvedAutomaticSync = Exclude<AutomaticReplicaSyncOutcome, { kind: 'dispatched' }>

/**
 * Whether an automatic round left something the user must be told.
 *
 * The automatic round is marked as spent *before* it runs, so it is never
 * retried — which makes a failed or empty one the end of the line unless the
 * user intervenes. They can: `canRequestReplicaSync` does not consult the
 * automatic attempt at all, so "Sync now" is available on exactly the same rows
 * it was available on before. What was missing is the user having any reason to
 * press it, and that is what this predicate exists to drive.
 *
 * `dispatched` is the working case and needs no notice; both of the others sent
 * nothing at all.
 */
export function automaticSyncNeedsAttention(
  outcome: AutomaticReplicaSyncOutcome,
): outcome is UnresolvedAutomaticSync {
  return outcome.kind !== 'dispatched'
}

export interface ReplicaFirstSyncTriggerDeps {
  /**
   * Whether a round may be dispatched right now.
   *
   * A protect round stages a pending bag and arms the flow watchdog, so it must
   * not be started on top of another in-flight flow. Returning `false` defers:
   * the destination stays due and the next observation tries again.
   */
  canProtect(): boolean
  /** Persist "a round has been dispatched for these" — see [`markReplicaFirstSyncStarted`]. */
  markStarted(replicaIds: readonly string[]): void
  /**
   * Dispatch exactly one `ProtectSecret` round.
   *
   * Carries no target list *by design*, and `reason` is not one:
   * `ProtectSecretParams` has no target field at all — the library fans out
   * from its own channel table, to `Paired` channels only — so this seam
   * decides *when* a round runs and nothing about who receives it. `reason` is
   * console context, so a manual round is distinguishable from an automatic one
   * in the log. There is deliberately no seam here through which a destination
   * the library has not itself promoted to `Paired` could be reached.
   */
  runProtectRound(reason: ReplicaSyncReason): Promise<ReplicaSyncRoundResult>
  /**
   * What the *automatic* round did. Reported, never retried — see `markStarted`.
   *
   * Every arm is reported, not just the rejection: a round that dispatched
   * nothing is as invisible to the user as one that threw, and both leave a
   * destination without the copy the pairing warning promised it. The caller
   * decides what deserves the screen — see [`automaticSyncNeedsAttention`].
   */
  onOutcome(outcome: AutomaticReplicaSyncOutcome): void
}

export interface ReplicaFirstSyncTrigger {
  /**
   * Feed the latest projection of the roster.
   *
   * Safe to call on every poll tick and safe to call concurrently: at most one
   * round is ever in flight, and each destination is dispatched for at most
   * once.
   */
  observe(views: readonly ReplicaView[]): Promise<void>
  /**
   * Dispatch one round on the user's explicit request.
   *
   * Shares the automatic trigger's in-flight guard rather than carrying its
   * own, so the two can never overlap in either order; a request that arrives
   * mid-round returns `busy` instead of queueing. Never throws — a rejected
   * round comes back as `failed` so the caller can show it. `deps.onError` is
   * deliberately not called: the user is standing in front of this one and the
   * result belongs on screen, not only in the console.
   */
  syncNow(): Promise<ManualReplicaSyncOutcome>
}

/**
 * Start a `ProtectSecret` round the first time a replica destination becomes
 * eligible to receive the mirrored secret.
 *
 * Three things keep repeated confirmations — retries, mailbox redelivery, a
 * user pressing confirm twice — from starting overlapping rounds or looping:
 *
 *  1. `running` is set synchronously, before the first `await`, so two
 *     observations in the same tick cannot both get past it.
 *  2. `dispatched` records every destination a round has been started for, so a
 *     destination is never dispatched for twice for this owner even if the
 *     persisted marker cannot be written (storage full or unavailable).
 *  3. `markStarted` persists the same fact, so a reload or a remount of the
 *     panel does not re-arm a destination that has already had its round.
 *
 * Marking happens *before* the round, so a failure ends the trigger rather than
 * repeating it. Deferral is the one path that leaves a destination armed, and
 * it marks nothing: `canProtect()` returning `false` means "not now", not
 * "never".
 *
 * The same object also owns the user's explicit [`ReplicaFirstSyncTrigger.syncNow`].
 * That is the point of putting it here rather than beside it: one `running`
 * flag, set synchronously before either path's first `await`, is what makes the
 * automatic and the manual round mutually exclusive in both orders. Two
 * independent guards could each believe itself to be the only one running.
 */
export function createReplicaFirstSyncTrigger(
  deps: ReplicaFirstSyncTriggerDeps,
): ReplicaFirstSyncTrigger {
  let running = false
  const dispatched = new Set<string>()

  return {
    async observe(views: readonly ReplicaView[]): Promise<void> {
      if (running) return

      const due = replicasAwaitingFirstSync(views).filter(t => !dispatched.has(t.replicaId))
      if (due.length === 0) return
      if (!deps.canProtect()) return

      running = true
      try {
        const replicaIds = due.map(t => t.replicaId)
        for (const replicaId of replicaIds) dispatched.add(replicaId)
        deps.markStarted(replicaIds)
        const result = await deps.runProtectRound('first-sync')
        deps.onOutcome(
          result === 'dispatched' ? { kind: 'dispatched' } : { kind: 'nothing-to-mirror' },
        )
      } catch (error) {
        deps.onOutcome({ kind: 'failed', error })
      } finally {
        running = false
      }
    },

    async syncNow(): Promise<ManualReplicaSyncOutcome> {
      // Both checks before the first `await`, and `running` is set in the same
      // tick — a click landing mid-round can neither start a second round nor
      // slip between the guard and the dispatch.
      if (running || !deps.canProtect()) return { kind: 'busy' }

      running = true
      try {
        const result = await deps.runProtectRound('manual')
        return result === 'dispatched' ? { kind: 'dispatched' } : { kind: 'nothing-to-mirror' }
      } catch (error) {
        return { kind: 'failed', error }
      } finally {
        running = false
      }
    },
  }
}

// ── Roster projection ────────────────────────────────────────────────────────

/** A replica as the panel renders it. */
export interface ReplicaView {
  id: string
  name: string
  /** Long-term channel id once the handshake completed, else `null`. */
  channelId: string | null
  status: ReplicaStatus
  offline: boolean
  /**
   * Whether the *peer* has confirmed, when that is observable at all.
   *
   * Not a second notion of `paired` — `status` is the only one, and it is the
   * library's. This says whether a mirror sent right now would be accepted or
   * dropped on arrival; see [`PeerConfirmation`].
   *
   * There is deliberately no `localConfirmed` beside it: this device's own
   * confirmation *is* `status === 'paired'`, and carrying both invited them to
   * disagree.
   */
  peerConfirmation: PeerConfirmation
  /** Last mirrored version this destination acknowledged, or `null`. */
  lastSync: ReplicaSyncRecord | null
  /**
   * When this device saw the channel established, or `null` when unknown.
   *
   * Carried on the row so the panel and the fingerprint dialog can both derive
   * the same deadline through [`replicaChannelExpiry`] instead of each holding
   * its own clock.
   */
  establishedAt: number | null
  /**
   * A round has already been dispatched for this destination since it became
   * eligible — see [`createReplicaFirstSyncTrigger`].
   */
  firstSyncStarted: boolean
  /**
   * Backed by a `Role::Replica` actor on the roster.
   *
   * `false` for a browser peer, which joined as an ordinary owner actor. The
   * distinction is operational, not cosmetic: the backend replica endpoints
   * (fingerprint read/confirm, take offline) exist only for a provisioned
   * replica and reject anything else, so only a `provisioned` row may call them.
   */
  provisioned: boolean
  /**
   * Which side of the mirror **this** device is on for this channel.
   *
   * `replica_source` mirrors its vault to the peer; `replica_destination` is
   * offered the peer's. Read from the channel record written at pairing time.
   */
  direction: ReplicaPairingRole
  /**
   * The peer's protocol-level replica id, or `null` until `ReplicaPaired`
   * announces it. Required to evict this member — see
   * [`removeReplicaMember`].
   */
  peerReplicaId: string | null
}

/**
 * Row id for a replica channel that has no provisioned actor to be keyed by.
 *
 * Prefixed so it can never collide with a backend actor id, and derived from the
 * channel so it is stable across reloads — `recordConfirmation` and
 * `markReplicaFirstSyncStarted` key their records on the row id, and a row that
 * changed identity between polls would lose both.
 */
export function replicaChannelRowId(channelId: string): string {
  return `replica-channel:${channelId}`
}

/** What to call a replica peer whose handshake carried no name. */
function defaultPeerLabel(localRole: ReplicaPairingRole): string {
  // Name the peer's side, not ours: the row describes who is on the other end.
  return pairingRoleLabel(complementRole(localRole))
}

/** Project one locally-recorded replica channel into a row. */
function localChannelView(channel: ReplicaChannelRecord, state: ReplicaState): ReplicaView {
  const id = replicaChannelRowId(channel.channelId)
  const record = state.replicas[id] ?? EMPTY_RECORD

  return {
    id,
    name: channel.peerName?.trim() || defaultPeerLabel(channel.role),
    channelId: channel.channelId,
    // A recorded channel is a *completed* handshake, so `unpaired` is not
    // reachable here. Everything after that is the ordinary machine: this
    // device's own `verifyFingerprint` promotes it, exactly as in the library.
    status: nextReplicaStatus('pending', { localConfirmed: record.local }),
    // `disabled` is a backend actor flag; a browser peer has no such actor and
    // this device has no way to observe its liveness.
    offline: false,
    peerConfirmation: record.peer,
    lastSync: state.syncs[channel.channelId] ?? null,
    establishedAt: channel.establishedAt ?? null,
    firstSyncStarted: record.firstSyncStarted === true,
    provisioned: false,
    direction: channel.role,
    peerReplicaId: channel.peerReplicaId ?? null,
  }
}

/**
 * Project the actor roster and this device's own channel records into replica
 * rows.
 *
 * There are **two** row sources, because there are two kinds of replica:
 *
 * - A *provisioned* replica is a `Role::Replica` actor on the roster.
 * - A *browser* replica is another browser that joined as an ordinary owner
 *   actor and paired on a replica channel. Nothing on the roster distinguishes
 *   it from any other owner, so its row can only come from the channel record
 *   this device wrote at pairing time.
 *
 * Every locally-recorded channel that no provisioned row already accounts for
 * gets a row. De-duplication is on `channelId`: a provisioned replica writes a
 * channel record too (the fold that writes them does not, and should not, know
 * what kind of peer it paired with), so keying the merge on anything else would
 * show it twice.
 *
 * Within a provisioned row, two merges happen, both in the same direction — the
 * backend is authoritative once it has caught up, and local state fills the gap
 * until then:
 *
 * - `channel_id` comes from the backend's own protocol instance for the
 *   replica, which only learns it once that instance observes the same
 *   `PairingCompleted` this device already has. Until then, this falls back
 *   to what this device recorded locally.
 * - `replica_confirmed` is the *peer's* confirmation, reported once the
 *   backend has verified it. When set it outranks local bookkeeping. It informs
 *   `peerConfirmation` and nothing else — a peer's verify promotes the peer's
 *   channel, never this device's.
 */
export function replicaViews(actors: readonly RosterActor[], state: ReplicaState): ReplicaView[] {
  const provisioned = actors
    .filter(a => a.role === 'replica')
    .map((a): ReplicaView => {
      const record = state.replicas[a.id] ?? EMPTY_RECORD
      const channelId = a.channel_id ?? record.channelId ?? null
      const peerConfirmation: PeerConfirmation =
        a.replica_confirmed === true ? 'protocol-verified' : record.peer

      return {
        id: a.id,
        name: a.name,
        channelId,
        status: nextReplicaStatus(channelId ? 'pending' : 'unpaired', {
          localConfirmed: record.local,
        }),
        offline: a.disabled === true,
        peerConfirmation,
        lastSync: channelId ? state.syncs[channelId] ?? null : null,
        // Only ever this device's own stamp: the backend reports neither the
        // channel's creation time nor the replica's, so a provisioned row whose
        // handshake completed in another tab has no deadline to show.
        establishedAt: (channelId ? state.channels[channelId]?.establishedAt : undefined) ?? null,
        firstSyncStarted: record.firstSyncStarted === true,
        provisioned: true,
        // A provisioned replica is only ever paired from the panel's own Pair
        // action, which declares `replica_source`; the recorded channel says so
        // outright once the handshake has completed here.
        direction: (channelId ? state.channels[channelId]?.role : undefined) ?? 'replica_source',
        peerReplicaId: (channelId ? state.channels[channelId]?.peerReplicaId : undefined) ?? null,
      }
    })

  const alreadyShown = new Set(
    provisioned.flatMap(view => (view.channelId === null ? [] : [view.channelId])),
  )

  const local = Object.values(state.channels)
    .filter(channel => !alreadyShown.has(channel.channelId))
    .map(channel => localChannelView(channel, state))

  return [...provisioned, ...local]
}
