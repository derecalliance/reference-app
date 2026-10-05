// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { apiGetActors, type BEActorWithStatus } from '../../api'
import { VERSION_CONFLICT_STATUS } from '../../owner/protocol'
import { isReplicaChannel } from '../../ownerPairing'
import {
  adoptedVaultState,
  channelsOfMember,
  clearReplicaState,
  forgetReplicaMember,
  loadReplicaState,
  recordPeerReplicaId,
  recordReplicaSync,
  resolveAckChannelId,
  type PendingReplicaAdoption,
} from '../../replicaFlows'
import type { Vault } from '../../types'
import type { EventHandlers, EventOf, FoldContext } from './context'

/**
 * This device, as a replica destination, received the full mirrored secret
 * from its source.
 *
 * `ReplicaSecretInstalled` carries the identical payload and differs only in
 * being the *first* sync for a `secret_id` this device held nothing for. Both
 * stage the same offer: the library has written the mirror to its own stores
 * either way, but adopting it — wiping this device's vault and calling
 * `restore` — stays the owner's explicit decision. Staging keeps the newer of
 * what is staged and what arrived, so an at-least-once replay of a stale round
 * cannot regress a fresher offer.
 */
function receiveMirroredSecret(
  current: Vault,
  event: EventOf<'ReplicaSecretReceived' | 'ReplicaSecretInstalled'>,
  ctx: FoldContext,
): Vault {
  if (!event.channel_id) return current
  const {
    channel_id: channelId,
    from_replica_id: fromReplicaId,
    secret_id: secretId,
    version,
    secret,
    shares,
  } = event

  // A newer version of the vault this device *already* holds is an update, not
  // a takeover: there is nothing of its own to erase, and the library has
  // already written the mirror to its stores. Compared against the secret this
  // device runs, not the event type: `ReplicaSecretInstalled` only says the
  // *library* held nothing for this id, which is also true right after a fresh
  // pairing on a device with its own vault — a genuine takeover.
  const isUpdateToOwnVault = secretId === current.secretId

  ctx.log({
    role: 'owner',
    flow: 'sharing',
    step: event.type,
    description: isUpdateToOwnVault
      ? `Mirrored update v${version} applied to the vault this device already holds`
      : event.type === 'ReplicaSecretInstalled'
        ? `First mirrored copy of secret ${secretId} (v${version}) installed from replica source ${fromReplicaId}`
        : `Mirrored secret v${version} received from replica source ${fromReplicaId} on channel ${channelId}`,
    payload: { channelId, fromReplicaId, secretId, version, shareCount: shares.length, isUpdateToOwnVault },
  })

  const offer: PendingReplicaAdoption = { channelId, fromReplicaId, secretId, version, secret, shares }
  if (isUpdateToOwnVault) {
    // The member this came from holds `version` — it published or served it.
    // Recorded as that member's latest known version, or a source receiving
    // a version its own destination published would list that destination as
    // "Behind" a version it wrote itself.
    recordReplicaSync(
      current.id,
      resolveAckChannelId(loadReplicaState(current.id), fromReplicaId, channelId),
      { version, syncedAt: Date.now() },
    )
    // Project the new contents straight in. No prompt, no wipe, no `restore`.
    applyMirroredUpdate(offer, ctx)
    return current
  }

  // Held back while this device has not confirmed the channel's fingerprint:
  // until it has, nothing proves the copy came from the peer it names.
  // Erasing this device's vault is not something to advertise in a banner at
  // the bottom of the page, so once offered it is raised where it cannot be
  // missed.
  if (ctx.offerReplicaAdoption(offer)) ctx.effects.openAdoption()
  return current
}

/** Replica events: mirrored secrets, their acknowledgements, and group membership. */
export const replicaHandlers = {
  ReplicaSecretReceived: receiveMirroredSecret,
  ReplicaSecretInstalled: receiveMirroredSecret,

  // A replica destination acknowledged a mirrored secret. Handled outside the
  // participant roster on purpose: the roster row a replica channel carries
  // holds no sync state, and the ack's channel id is already the key
  // replica-local state is organised by.
  ReplicaSecretAcked: (current, event, ctx) => {
    if (!event.channel_id) return current
    const { channel_id: channelId, version, status, memo } = event

    // `status` is the wire `StatusEnum`; 0 is Ok. Anything else means the
    // destination declined, so no sync is recorded — leaving the replica
    // visibly behind rather than falsely up to date.
    if (status !== 0) {
      ctx.log({
        role: 'owner',
        flow: 'sharing',
        step: 'ReplicaSecretRejected',
        description: `Replica on channel ${channelId} rejected the mirrored secret v${version} (status=${status}, memo=${memo})`,
        payload: { channelId, version, status, memo },
      })
      ctx.notify.error(`A replica rejected the mirrored secret (v${version})`, memo || `status ${status}`, {
        channelId,
        version,
        status,
        memo,
      })
      return current
    }

    // Attributed to the member that answered, not to the channel it answered
    // on: every member of a group acks on the one shared channel. See
    // `resolveAckChannelId`.
    const rowChannelId = resolveAckChannelId(
      loadReplicaState(current.id),
      event.from_replica_id,
      channelId,
    )
    recordReplicaSync(current.id, rowChannelId, { version, syncedAt: Date.now() })
    ctx.log({
      role: 'owner',
      flow: 'sharing',
      step: 'ReplicaSecretAcked',
      description: `Replica ${event.from_replica_id} mirrored the secret (v${version})`,
      payload: { channelId, rowChannelId, version, fromReplicaId: event.from_replica_id },
    })
    ctx.effects.refreshReplicas()
    return current
  },

  // Fires alongside `PairingCompleted` on a replica handshake, and is the only
  // announcement of the peer's replica id — which `RemoveReplica` needs, since
  // every member answers on the one group channel.
  ReplicaPaired: (current, event, ctx) => {
    if (!event.channel_id) return current
    recordPeerReplicaId(current.id, event.channel_id, event.peer_replica_id)
    ctx.log({
      role: 'owner',
      flow: 'pairing',
      step: 'ReplicaPaired',
      description: `Replica channel ${event.channel_id} belongs to replica ${event.peer_replica_id}`,
      payload: { channelId: event.channel_id, peerReplicaId: event.peer_replica_id },
    })
    ctx.effects.refreshReplicas()
    return current
  },

  // A member refused a sync. Keyed by `replica_id`, not `channel_id`: every
  // member answers on the one group channel.
  // Two members published the same version with different contents. The
  // library kept this device's copy and refused the incoming one; nothing was
  // written. A fresh publish supersedes both everywhere, so that is the advice.
  ReplicaVersionConflict: (current, event, ctx) => {
    const held = event.held_author_replica_id ?? 'unknown'
    const incoming = event.incoming_author_replica_id ?? 'unknown'
    ctx.notify.error(
      `Two replicas published different copies of v${event.version}. This device kept its own; ` +
        'publish a new version (Sync now, or add or remove a secret) to settle it everywhere.',
      undefined,
      { fromReplicaId: event.from_replica_id, version: event.version },
    )
    ctx.log({
      role: 'owner',
      flow: 'sharing',
      step: 'ReplicaVersionConflict',
      description:
        `Replica ${event.from_replica_id} offered a different v${event.version} ` +
        `(published by ${incoming}) than the one held here (published by ${held}); kept the held copy`,
      payload: {
        channelId: event.channel_id,
        fromReplicaId: event.from_replica_id,
        secretId: event.secret_id,
        version: event.version,
        heldAuthorReplicaId: event.held_author_replica_id,
        incomingAuthorReplicaId: event.incoming_author_replica_id,
      },
    })
    return current
  },

  ReplicaSyncRejected: (current, event, ctx) => {
    const conflict = event.status === VERSION_CONFLICT_STATUS
    ctx.notify.error(
      conflict
        ? `Replica ${event.replica_id} already holds a different v${event.version}. Re-publish at a new version.`
        : `Replica ${event.replica_id} refused the sync of v${event.version}: ${event.memo}`,
      undefined,
      { replicaId: event.replica_id, version: event.version, status: event.status },
    )
    ctx.log({
      role: 'owner',
      flow: 'sharing',
      step: 'ReplicaSyncRejected',
      description: `Replica ${event.replica_id} rejected v${event.version} (status ${event.status})`,
      payload: {
        replicaId: event.replica_id,
        secretId: event.secret_id,
        version: event.version,
        status: event.status,
        memo: event.memo,
        versionConflict: conflict,
      },
    })
    return current
  },

  // Distinct from a rejection: the member never got the message at all.
  ReplicaSyncFailed: (current, event, ctx) => {
    ctx.log({
      role: 'owner',
      flow: 'sharing',
      step: 'ReplicaSyncFailed',
      description: `Could not deliver v${event.version} to replica ${event.replica_id}: ${event.reason}`,
      payload: { replicaId: event.replica_id, version: event.version, reason: event.reason },
    })
    // Not retried on its own: say so where it is seen, with the way to retry.
    ctx.notify.error(
      `v${event.version} was not delivered to a replica — it stays behind until it is reachable and you use Sync now`,
      event.reason,
      { replicaId: event.replica_id, version: event.version },
    )
    return current
  },

  // Per-round report of who acknowledged. The library keeps no durable
  // per-member sync state, so this is the only retry hook there is — surfaced
  // rather than acted on, since replicas are best-effort.
  ReplicaSyncComplete: (current, event, ctx) => {
    ctx.log({
      role: 'owner',
      flow: 'sharing',
      step: 'ReplicaSyncComplete',
      description:
        event.behind.length === 0
          ? `Every replica is current at v${event.version}`
          : `v${event.version}: ${event.synced.length} synced, ${event.behind.length} behind`,
      payload: { version: event.version, synced: event.synced, behind: event.behind },
    })
    return current
  },

  ReplicaDiscoveryComplete: (current, event, ctx) => {
    const caughtUp = event.fetched_from !== undefined
    ctx.log({
      role: 'owner',
      flow: 'sharing',
      step: 'ReplicaDiscoveryComplete',
      description: caughtUp
        ? `Caught up from v${event.local_version} to v${event.group_version} via replica ${event.fetched_from}`
        : // About *this* device only: discovery asks whether it is behind the
          // group, not whether every member has caught up to it. A member
          // that missed a version shows as "Behind" on its own row.
          `This device already holds the group's newest version (v${event.local_version}); members that missed it show as Behind on their rows`,
      payload: {
        localVersion: event.local_version,
        groupVersion: event.group_version,
        fetchedFrom: event.fetched_from ?? null,
      },
    })
    if (caughtUp) ctx.notify.info(`Caught up to v${event.group_version} from the replica group`)
    return current
  },

  // Fires on the members that remain — including when *another* member did
  // the evicting, which this device never initiated and so never cleaned up
  // after. The library has dropped the member; the app's own row for it is
  // dropped here too, or it goes on reading "Verified" with a live "Sync now"
  // for a device that is no longer in the group.
  ReplicaRemoved: (current, event, ctx) => {
    const doomed = channelsOfMember(loadReplicaState(current.id), event.replica_id)
    forgetReplicaMember(current.id, event.replica_id)
    ctx.log({
      role: 'owner',
      flow: 'unpairing',
      step: 'ReplicaRemoved',
      description: `Replica ${event.replica_id} left the group`,
      payload: { replicaId: event.replica_id, channelIds: doomed },
    })
    ctx.effects.refreshReplicas()
    if (doomed.length === 0) return current
    return {
      ...current,
      participants: current.participants.filter(p => !doomed.includes(p.channelId)),
    }
  },

  // Source succession. The library promotes the first eligible entry of
  // `listReplicas` when the source leaves; this only reports the outcome.
  ReplicaSourceChanged: (current, event, ctx) => {
    ctx.log({
      role: 'owner',
      flow: 'unpairing',
      step: 'ReplicaSourceChanged',
      description: `Replica ${event.replica_id} is now the group's source`,
      payload: { replicaId: event.replica_id },
    })
    ctx.notify.info(`Replica ${event.replica_id} is now the source for this group`)
    ctx.effects.refreshReplicas()
    return current
  },

  // This device was evicted and has torn down its own `secret_id` partition.
  // Fires only after it was told to leave *and* saw a roster excluding it;
  // absence alone never destroys a copy.
  SelfRemovedFromGroup: (current, event, ctx) => {
    ctx.log({
      role: 'owner',
      flow: 'unpairing',
      step: 'SelfRemovedFromGroup',
      description: `This device was removed from the replica group at v${event.version} — local state for this secret is gone`,
      payload: { version: event.version },
    })
    // The library dropped the whole `secret_id` partition: the group channel,
    // every helper channel, the shares and the secrets. The record is brought
    // into line with that rather than left listing helpers as PAIRED — with
    // Add Secret enabled over channels that no longer exist, every attempt
    // failed. A helper row survives only if its channel record still does,
    // so nothing the library kept is hidden.
    clearReplicaState(current.id)
    // Rows with no channel are pool helpers this vault never paired with: the
    // library had nothing of theirs to erase, so they stay, and they are not
    // counted — the count is of channels, and one channel can carry two rows.
    const surviving = current.participants.filter(
      p => p.channelId === '' || (!isReplicaChannel(p) && ctx.readChannelInfo(p.channelId) !== null),
    )
    const erasedCount = new Set(
      current.participants.filter(p => p.channelId !== '' && !surviving.includes(p)).map(p => p.channelId),
    ).size
    ctx.notify.error(
      'This vault was removed from its replica group by another member. The protocol erased ' +
        `its copy of the vault — secrets, shares and ${erasedCount} channel(s) — so it now holds nothing.`,
    )
    ctx.effects.refreshReplicas()
    const keptIds = new Set(surviving.filter(p => p.channelId !== '').map(p => p.channelId))
    return {
      ...current,
      secretBag: null,
      heldShares: [],
      participants: surviving,
      mainChannels: current.mainChannels.filter(id => keptIds.has(id)),
    }
  },
} satisfies Partial<EventHandlers>

/**
 * Fold a newer version of the vault this device already runs into its state.
 *
 * The counterpart to adoption, for the case that is not a takeover. Nothing is
 * erased and `restore` is not called: the library wrote the mirrored contents to
 * its own stores before delivering the event. All that is missing is the
 * projection the screen reads — the bag at the new version, and the roster of
 * helpers the source now protects with.
 *
 * Commits on its own schedule, after a roster fetch, rather than through the
 * reducer's return value. Errors are reported rather than thrown: a failed
 * projection leaves stale numbers on screen, and the next sync re-delivers.
 */
function applyMirroredUpdate(update: PendingReplicaAdoption, ctx: FoldContext): void {
  void (async () => {
    let actors: BEActorWithStatus[] = []
    try {
      actors = await apiGetActors()
    } catch {
      // Only affects how helpers are named; the contents land either way.
    }

    try {
      const snapshot: Vault = ctx.getVault()
      const { participants, secretBag } = adoptedVaultState(update, actors, snapshot.minParticipants)

      // Only the *helper* rows come from the snapshot. This device's replica
      // channels are its own and the snapshot does not describe them from this
      // device's point of view; replacing the whole roster dropped them, and a
      // source receiving an update from its own destination listed *itself* as
      // a replica source.
      const ownReplicaChannels = snapshot.participants.filter(isReplicaChannel)
      const merged = [...participants.filter(p => !isReplicaChannel(p)), ...ownReplicaChannels]

      ctx.commit({ ...snapshot, participants: merged, secretBag })
      // The group roster may have gained a member with this round, and it is
      // read from the library rather than carried on `Vault`.
      ctx.effects.refreshReplicas()
      ctx.notify.info(`Replica update applied — vault now at v${update.version}`)
    } catch (err) {
      ctx.notify.error('A mirrored update arrived but could not be applied to this screen', err, {
        secretId: update.secretId,
        version: update.version,
      })
    }
  })()
}
