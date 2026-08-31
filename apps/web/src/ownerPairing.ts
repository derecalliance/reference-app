import { SenderKind, type DeRecEvent } from '@derec-alliance/web'
import type { ChannelRole, Owner, PairedParticipant } from './types'
import type { ConsoleEntry } from './ConsoleContext'
import { apiGetActors } from './api'
import {
  complementRole,
  isReplicaRole,
  isReplicaSenderKind,
  replicaRoleForSenderKind,
  type ReplicaPairingRole,
} from './pairingRoles'
import { pairingRoleLabel } from './pairingRoleOptions'
import { recordReplicaChannel, resolveReplicaPairing } from './replicaFlows'
import { resolvePeerActor } from './peerIdentity'

/**
 * The `PairingCompleted` fold, lifted out of `OwnerPage`, together with
 * the share-roster predicate it feeds.
 *
 * A replica channel now *does* reach the participant roster — it is shown in the
 * Replicas tab flagged with its role — so the guarantee that it never receives a
 * share no longer rests on the row being absent. It rests on the row's role, and
 * on [`isShareTarget`] reading it. Both live here, in one file, because they are
 * one invariant, and it has to be provable without mounting the page.
 *
 * [`splitPairedChannels`] is the other half of the story: it is what decides
 * *where* a channel is listed, and it reads the same role.
 */

/**
 * Whether a channel is a target for our own secret's shares.
 *
 * Two conditions, and both are load-bearing:
 *
 * - Only channels where *this* node is the Owner qualify. On a helper-role
 *   channel the peer protects their own secret and we hold shares for them —
 *   sending ours there would be backwards. The library applies the same rule
 *   when it picks helpers for a round, so mirroring it keeps the app's pending
 *   marks and bag roster in step with what the protocol actually sent.
 * - A **replica** channel is never a target, at any confirmation state. A
 *   replica mirrors whole secrets and holds no VSS share; handing it one would
 *   put the owner's material on a device before either side had compared a
 *   fingerprint. This used to be enforced by keeping replica channels out of the
 *   roster altogether. They are in it now, so the role test below *is* the
 *   guarantee — deleting it re-opens exactly that hole.
 */
export function isShareTarget(h: PairedParticipant): boolean {
  if (h.connectionStatus !== 'paired' || !h.channelId) return false
  if (h.peerRole !== undefined && isReplicaRole(h.peerRole)) return false
  return h.peerRole !== 'owner'
}

/**
 * Whether a roster row is a replica channel rather than a participant one.
 *
 * A replica channel reaches the participant roster like any other, so every
 * place that treats a row as a *participant* — a discovery candidate, a link
 * target, a provisioned actor, the main channel list — has to say so.
 * [`isShareTarget`] carries the same test for the one case where getting it
 * wrong is a safety failure rather than a cosmetic one.
 */
export function isReplicaChannel(h: PairedParticipant): boolean {
  return h.peerRole !== undefined && isReplicaRole(h.peerRole)
}

/**
 * A paired replica channel, with its role already narrowed to the two it can be.
 *
 * The narrowing happens once, here, beside the fold that writes the role —
 * rather than at each render site, where a widened `ChannelRole` would let a
 * participant channel be drawn with a replica badge.
 */
export interface ReplicaChannel {
  /** Roster row id — what an unpair request is addressed to. */
  id: string
  name: string
  channelId: string
  /** The peer's side of the mirror. */
  peerRole: ReplicaPairingRole
}

/** This owner's paired channels, split by what kind of peer is on the far end. */
export interface PairedChannelSplit {
  /** Participant channels — the main channel list, and only there. */
  participants: PairedParticipant[]
  /** Replica channels — the Replicas tab, and only there. */
  replicas: ReplicaChannel[]
}

/**
 * Split the roster into the two lists the owner page draws.
 *
 * One pass, one predicate, two outputs: a channel is in exactly one of them, so
 * a replica cannot be listed twice and cannot be listed nowhere. The main
 * channel list is fed from `participants` and the Replicas tab from `replicas`,
 * which is what keeps a replica out of the participant list — deleting the role
 * branch below puts it back in both.
 */
export function splitPairedChannels(rows: readonly PairedParticipant[]): PairedChannelSplit {
  const participants: PairedParticipant[] = []
  const replicas: ReplicaChannel[] = []

  for (const h of rows) {
    if (h.connectionStatus !== 'paired' || !h.channelId) continue
    const peerRole = h.peerRole
    if (peerRole !== undefined && isReplicaRole(peerRole)) {
      replicas.push({ id: h.id, name: h.name, channelId: h.channelId, peerRole })
    } else {
      participants.push(h)
    }
  }

  return { participants, replicas }
}

/**
 * The **peer's** role on a channel, from `PairingCompleted.kind`.
 *
 * `kind` is the *local* party's role — the library sets it from what this side
 * declared when the handshake ran — so the peer's is its inverse. Storing the
 * peer's role mirrors `Channel.peer_role`: a row describes who is on the other
 * end.
 *
 * Replica kinds are resolved through `replicaRoleForSenderKind` and inverted
 * with `complementRole`, never by matching enum members here: a replica kind
 * collapsing into the participant fallback — which reports `helper` for
 * anything that is not `Helper` — is the defect this whole feature was built
 * around, and it would make the channel satisfy [`isShareTarget`].
 */
export function peerRoleFromKind(kind: SenderKind | undefined): ChannelRole {
  const localReplicaRole = replicaRoleForSenderKind(kind)
  if (localReplicaRole !== null) return complementRole(localReplicaRole)
  return kind === SenderKind.Helper ? 'owner' : 'helper'
}

/**
 * The effects the `PairingCompleted` fold needs from the page.
 *
 * Injected rather than closed over so the fold is a module-level function the
 * tests can drive directly — it is the single point at which a replica channel's
 * role is decided, and that role is the whole of what keeps it out of the share
 * roster, so the invariant has to be provable without mounting the page.
 */
/** The `PairingCompleted` member of the event union. */
export type PairingCompletedEvent = Extract<DeRecEvent, { type: 'PairingCompleted' }>

export interface PairingCompletedDeps {
  log: (entry: Omit<ConsoleEntry, 'id' | 'timestamp'>) => void
  /** Latest committed owner state, read when the async identity lookup lands. */
  getOwner: () => Owner
  /** Commit owner state produced after this fold has already returned. */
  commit: (next: Owner) => void
  /**
   * A replica handshake just completed on `channelId`.
   *
   * Fired on **both** sides — the event reaches the source and the destination
   * alike — and it is what raises the fingerprint modal without the user going
   * looking for it. Optional so the fold stays drivable from a test that only
   * cares about the roster.
   */
  onReplicaChannelEstablished?: (channelId: string) => void
}

/**
 * Fold a `PairingCompleted` event into owner state.
 *
 * Extracted from `applyOwnerEvent` so the role it writes on each new row is
 * testable in isolation; `applyOwnerEvent` delegates every `PairingCompleted`
 * here and does nothing else with the event.
 */
export function applyPairingCompleted(
  current: Owner,
  event: PairingCompletedEvent,
  deps: PairingCompletedDeps,
): Owner {
  const { log, getOwner, commit, onReplicaChannelEstablished } = deps

  // The handshake atomically rotates to a long-term channel id at
  // completion. `pairing_channel_id` is the transient id that travelled on
  // the ContactMessage — the one pending pairings were recorded under —
  // so match on it, then key all persisted state on the new id.
  const channelId = event.channel_id
  if (!channelId) return current
  const pairingChannelId = event.pairing_channel_id

  // Pending pairings are recorded under the transient id, so that is what
  // matches here — the long-term `channel_id` never appears in the pending
  // list.
  const pending = current.pendingPairings.find(
    p => p.channelId.toString() === pairingChannelId,
  )
  const actorId = pending?.participantId

  log({
    role: 'owner',
    flow: 'pairing',
    step: 'PairingCompleted',
    description: `Pairing complete for channel ${channelId}`,
    payload: { channelId, pairingChannelId, actorId },
  })

  let updated: Owner = {
    ...current,
    pendingPairings: pending
      ? current.pendingPairings.filter(p => p !== pending)
      : current.pendingPairings.filter(
          p => p.channelId.toString() !== pairingChannelId,
        ),
  }

  // A replica channel *is* a channel, and it now takes a row in the channel
  // list like any other — flagged with its replica role. What must never happen
  // is it reaching the *share* roster: it mirrors whole secrets and holds no
  // VSS share, so a share sent there is the owner's material on a device no one
  // has yet compared a fingerprint with. That is `isShareTarget`'s job, and the
  // role written on the row below is what it reads. Nothing downstream
  // re-derives the role, so getting it wrong here is getting it wrong
  // everywhere — hence `peerRoleFromKind`, never an inline kind test.
  if (isReplicaSenderKind(event.kind)) {
    resolveReplicaPairing(current.ownerId, pairingChannelId, channelId)

    // This is the only point at which *both* sides of a replica handshake are
    // observed — the initiator and the responder each get this event — so it is
    // where the channel itself is written down. A browser peer joins as an
    // ordinary owner actor and leaves nothing distinguishing on the roster, so this
    // record is the sole thing the replica projection can build a view from,
    // and the roster row below carries no status of its own.
    //
    // `kind` is the local party's role, so it names *this* device's side of the
    // mirror. The narrowing is a formality: inside this branch
    // `isReplicaSenderKind` has already established that a role exists.
    const localRole = replicaRoleForSenderKind(event.kind)
    if (localRole) {
      recordReplicaChannel(current.ownerId, {
        channelId,
        role: localRole,
        peerName: event.peer_communication_info?.['name'],
        // The app's stand-in for the library's `Channel.created_at`, which the
        // frontend is never told. This event *is* the channel's creation
        // observed here, so the two differ only by delivery latency — and
        // without it nothing can warn that a channel left `Pending` too long is
        // about to be dropped.
        establishedAt: Date.now(),
      })
    }

    // The peer's side of the mirror, and the only thing that keeps this row out
    // of the share roster.
    const peerRole = peerRoleFromKind(event.kind)
    const replicaName =
      event.peer_communication_info?.name?.trim() || pairingRoleLabel(peerRole)

    updated = {
      ...updated,
      participants: updated.participants.some(h => h.channelId === channelId)
        ? // Idempotent: a duplicate delivery must not add a second row, and must
          // not be able to downgrade the role that keeps this channel out of the
          // share roster.
          updated.participants.map(h =>
            h.channelId === channelId
              ? { ...h, connectionStatus: 'paired' as const, peerRole }
              : h,
          )
        : [
            ...updated.participants,
            {
              // Channel-scoped, exactly as for a participant channel: the same
              // peer may hold several channels and each gets its own row.
              id: `peer-${channelId}`,
              name: replicaName,
              channelId,
              // Deliberately not resolved against the backend roster the way a
              // participant row is. A browser replica is an ordinary owner actor
              // that is indistinguishable from any other, and a provisioned one
              // is a `Role::Replica` actor the participant resolver does not
              // model — either way the lookup could only relabel this row with
              // somebody else's identity.
              transport: { protocol: 'https' as const, uri: '' },
              connectionStatus: 'paired' as const,
              peerRole,
              secretShares: [],
            },
          ],
    }

    log({
      role: 'owner',
      flow: 'pairing',
      step: 'replica_pairing_completed',
      description: `Replica channel ${channelId} established — pending fingerprint confirmation`,
      payload: { channelId, pairingChannelId, role: localRole, peerRole },
    })

    // Raise the fingerprint comparison rather than waiting to be found. Last,
    // so the row it points at is already in the state this fold returns.
    onReplicaChannelEstablished?.(channelId)
    return updated
  }

  if (actorId && updated.participants.some(h => h.id === actorId && !h.channelId)) {
    // Fill in a pre-created participant placeholder (e.g. a provisioned
    // actor added via handleAddParticipant whose channelId is still empty).
    // Pairing is unidirectional and per-channel, so only an *unpaired*
    // placeholder is updated in place — never an already-paired entry.
    const peerRole = peerRoleFromKind(event.kind)
    updated = {
      ...updated,
      participants: updated.participants.map(h =>
        h.id === actorId && !h.channelId
          ? { ...h, channelId, connectionStatus: 'paired' as const, peerRole }
          : h,
      ),
    }
  } else if (updated.participants.some(h => h.channelId === channelId)) {
    // Idempotent: this channel already has a row (duplicate event
    // delivery). Just ensure it is marked paired with the correct role.
    const peerRole = peerRoleFromKind(event.kind)
    updated = {
      ...updated,
      participants: updated.participants.map(h =>
        h.channelId === channelId
          ? { ...h, connectionStatus: 'paired' as const, peerRole }
          : h,
      ),
    }
  } else {
    // New channel. A peer may be paired multiple times (same or different
    // role); each pairing is a distinct channel that gets its own row.
    // `actorId` is set when the peer was already identified by a previous
    // pairing — carry over its identity instead of treating it as unknown.
    const knownActor = actorId
      ? updated.participants.find(h => h.id === actorId)
      : undefined
    const peerName =
      event.peer_communication_info?.name || knownActor?.name || 'Peer'
    const peerRole = peerRoleFromKind(event.kind)

    // Channel-scoped id so repeated pairings with the same peer stay
    // distinct (channelId is unique per pairing).
    const tempId = syntheticPeerId(channelId)
    updated = {
      ...updated,
      participants: [...updated.participants, {
        id: tempId,
        name: peerName,
        channelId,
        transport: knownActor?.transport ?? { protocol: 'https' as const, uri: '' },
        connectionStatus: 'paired' as const,
        peerRole,
        secretShares: [],
        browserManaged: knownActor?.browserManaged,
      }],
    }

    // Resolve identity from the backend only when the peer is genuinely
    // unknown. When it was already identified by a prior pairing, the
    // name/transport are carried over above.
    if (!actorId) {
      const ownerId = current.ownerId
      // The URI we paired against, when we were the initiator. Without it
      // (responder side) resolution falls back to inference, which only
      // commits when a single candidate exists — a server holding stale owner
      // actors from a device that reset and registered again would otherwise
      // relabel this channel with the wrong peer's identity.
      const peerTransportUri = pending?.peerTransportUri
      apiGetActors().then(actors => {
        const snapshot = getOwner()
        const peerActor = resolvePeerActor(actors, {
          selfActorId: ownerId,
          knownActorIds: new Set(snapshot.participants.map(h => h.id)),
          peerTransportUri,
        })
        if (!peerActor) return
        // Replace the placeholder with real actor info.
        commit({
          ...snapshot,
          participants: snapshot.participants.map(h =>
            h.id === tempId
              ? { ...h, id: peerActor.id, name: peerActor.name, transport: { protocol: peerActor.transport.protocol, uri: peerActor.transport.uri }, browserManaged: peerActor.browser_managed ?? false }
              : h
          ),
        })
      }).catch(() => {})
    }
  }

  // Discovery is NOT triggered here — the participant must first associate
  // the new channel with the old one. Roster polling detects when
  // pendingRecoveryChannelId clears and triggers discovery at that point.

  // Read the shared key from the local secret store for browser-managed peers.
  // Backend-managed participants get their shared key from the backend poll,
  // but for WASM-to-WASM pairing the key only exists locally.
  const localSharedKey = localStorage.getItem(
    `derec:owner:${current.ownerId}:secret:${channelId}:0`,
  )
  if (localSharedKey) {
    // Target the row by channelId — each paired entry owns a unique
    // channel, so this works whether a placeholder was filled in or a
    // new per-channel row was created.
    updated = {
      ...updated,
      participants: updated.participants.map(h =>
        h.channelId === channelId ? { ...h, sharedKey: localSharedKey } : h,
      ),
    }
  }

  return updated
}

// ── Peer identity ────────────────────────────────────────────────────────────

/** Prefix marking a row the app minted for a peer it has no roster entry for. */
const SYNTHETIC_PEER_PREFIX = 'peer-'

/**
 * Row id for a peer that completed a handshake without appearing on the actor
 * roster — a second browser, typically, which registered as its own owner.
 *
 * Channel-scoped, because the same peer can pair more than once and each
 * pairing is its own channel.
 */
export function syntheticPeerId(channelId: string): string {
  return `${SYNTHETIC_PEER_PREFIX}${channelId}`
}

/**
 * Whether this device can drive the peer's half of a flow through the backend.
 *
 * True only for a peer that really is a provisioned actor: its id has to be one
 * the backend will recognise. Two rows fail that and must not be confused with
 * one that passes:
 *
 * - a **browser** peer, which runs its own protocol instance and confirms for
 *   itself;
 * - a peer the app minted a {@link syntheticPeerId} for, whose id is not an
 *   actor id at all.
 *
 * The second is why this is a function rather than `!row.browserManaged`. That
 * flag is copied from a roster entry, so on a synthetic row it is `undefined`,
 * and `!undefined` reads as "provisioned" — sending `peer-<channelId>` to an
 * endpoint expecting a UUID, which fails with a parse error naming neither the
 * peer nor the flow that asked.
 */
export function canDrivePeerViaBackend(
  row: { id: string; browserManaged?: boolean } | undefined,
): boolean {
  if (!row) return false
  if (row.browserManaged) return false
  return !row.id.startsWith(SYNTHETIC_PEER_PREFIX)
}
