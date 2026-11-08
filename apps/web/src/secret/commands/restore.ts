// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { secretNamespace } from '../../secretStorage'
import { FlowKind } from '@derec-alliance/web'

import { apiGetActors, type BEActorWithStatus } from '../../api'
import { bytesToHex } from '../../bytes'
import { TRANSPORT_PROTOCOL_HTTPS, protocolName } from '../../contactDto'
import { fromBase64Url } from '../../derecApi'
import { buildProtocolInstance } from '../../owner/protocol'
import { withGroupThreshold } from '../../owner/publishPolicy'
import { decodeItemText, snapshotToPayload } from '../../owner/recoveredSecret'
import { pairingRoleLabel } from '../../pairingRoleOptions'
import { isReplicaChannel } from '../../ownerPairing'
import { resolveRosterEntries, type RosterMatch } from '../../peerIdentity'
import { resolveSecretConfig } from '../../protocolDefaults'
import {
  loadReplicaState,
  recordConfirmation,
  recordReplicaChannel,
  replicaChannelRowId,
  retainReplicaChannels,
} from '../../replicaFlows'
import { getOrCreateReplicaId, readReplicaId, setReplicaId } from '../../replicaIdentity'
import { clearNamespace } from '../../stores'
import type { BagVersion, PairedParticipant, RecoveredSecret, ItemBag, Secret } from '../../types'
import type { CommandContext } from './context'
import {
  restoredGroupPeer,
  restoredReplicaIdentity,
  type RecoveredReplicaGroup,
  type RestoredGroupPeer,
} from './restoreReplicas'

/**
 * Restore this secret from what recovery returned.
 *
 * 1. Retires the ephemeral recovery channels while their keys still exist —
 *    only those: a channel the snapshot itself names is restored, not retired.
 * 2. Wipes the namespace and replays the snapshot through an instance bound to
 *    the recovered `secret_id`, under a replica id the recovered group names —
 *    see `restoredReplicaIdentity`.
 * 3. Announces this device's endpoint to the restored helpers via
 *    `UpdateChannelInfo` — the snapshot carries the *pre-loss* transport,
 *    which is what those helpers still have on their channel records.
 * 4. Installs that instance in the running secret and commits the rebuilt
 *    secret — helpers, the replica group's channel, bag, threshold — bound to
 *    the recovered secret.
 *
 * Reports its own failures. Returns whether the restore committed.
 */
export async function restoreSecret(
  recovered: RecoveredSecret,
  ctx: CommandContext,
): Promise<boolean> {
  try {
    const current = ctx.getSecret()
    const targetNs = secretNamespace(current.id)

    // 1. Retire the recovery channels. Wiping the namespace without telling
    //    the peers leaves them paired to a channel this device can no longer
    //    decrypt: every later message would land as "unknown channel_id".
    //    Best-effort — a peer we cannot reach must not block the restore.
    //    Replica channels are excluded: they were not part of the recovery
    //    and the snapshot does not replace them.
    //
    //    So are the channels the snapshot names. Restoring on the device that
    //    protected the bag, every helper channel it holds *is* one the
    //    snapshot restores, under the same id and key — unpairing those told
    //    the helpers to drop the very channels and shares being restored, and
    //    the next protect reached nobody.
    const restoredChannelIds = new Set(recovered.snapshot.helpers.map(h => h.channelId))
    const recoveryChannelIds = current.participants
      .filter(
        p =>
          p.connectionStatus === 'paired' &&
          p.channelId &&
          !isReplicaChannel(p) &&
          !restoredChannelIds.has(p.channelId),
      )
      .map(p => p.channelId)
    const recoveryInstance = ctx.instance()
    if (recoveryChannelIds.length > 0 && recoveryInstance) {
      for (const channelId of recoveryChannelIds) {
        try {
          await ctx.withLock(() =>
            recoveryInstance.protocol.start(FlowKind.Unpair, {
              channel_id: channelId,
              memo: 'recovery complete — ephemeral channel retired',
            }),
          )
        } catch (err) {
          ctx.notify.error('Failed to retire a recovery channel', err, { channelId })
        }
      }
      ctx.log({
        role: 'owner',
        flow: 'recovery',
        step: 'recovery_channels_retired',
        description: `Unpaired ${recoveryChannelIds.length} ephemeral recovery channel(s)`,
        payload: { channelIds: recoveryChannelIds },
      })
    }

    // 2. Clean slate, then replay. Clearing first also avoids `restore`
    //    failing with ALREADY_RESTORED against an existing snapshot. Under the
    //    lock, as adoption does it: a drain landing between the wipe and the
    //    replay would write into a namespace that is half gone.
    const config = resolveSecretConfig(current.configOverrides)
    const group = recovered.snapshot.replicas
    // Chosen before the instance is built, because it is built with it. The
    // library cannot publish for a group that does not name this device, and
    // `restore` leaves that choice to the application.
    const identity = restoredReplicaIdentity(group, readReplicaId(current.id))
    const replicaId = identity?.replicaId ?? getOrCreateReplicaId(current.id)
    const restoreInstance = buildProtocolInstance({
      namespace: targetNs,
      secretId: recovered.secretId,
      ownTransportUri: current.transport.uri,
      communicationInfo: { name: current.name },
      threshold: current.minParticipants,
      keepVersion: ctx.keepVersion,
      timeoutSecs: config.protocolTimeoutSecs,
      unpairAck: config.unpairAck,
      replicaId,
      relayActorId: current.id,
      // The restored instance becomes the secret's live one (`adoptInstance`),
      // so it carries the same setting as the runtime's — see
      // `BuildProtocolOptions.autoReplyTo`.
      autoReplyTo: true,
    })
    // `restore` returns the events from its own recovery-channel teardown, and
    // a `PeerNotRestored` for each roster entry it wrote no channel for (no
    // usable endpoint). Folded for their console output; step 4 replaces
    // participants wholesale from the snapshot, minus the helpers skipped here.
    const restoreEvents = await ctx.withLock(async () => {
      clearNamespace(targetNs)
      return Array.from(
        await restoreInstance.protocol.restore(snapshotToPayload(recovered.snapshot), recovered.version),
      )
    })
    const notRestored = new Set(
      restoreEvents.flatMap(e =>
        e.type === 'PeerNotRestored' && e.replica_id === undefined ? [e.channel_id] : [],
      ),
    )
    const membersNotRestored = new Set(
      restoreEvents.flatMap(e =>
        e.type === 'PeerNotRestored' && e.replica_id !== undefined ? [e.replica_id] : [],
      ),
    )
    // Committed: from here this secret *is* the group member it was restored
    // as, and every later instance must be built as that member too.
    if (identity?.takesOverSource) {
      setReplicaId(current.id, identity.replicaId)
      ctx.log({
        role: 'owner',
        flow: 'recovery',
        step: 'replica_identity_adopted',
        description:
          `This device now answers to the replica group as its source (replica ${identity.replicaId}), ` +
          'the device the recovered secret was protected from. Its next publish tells the group where it is now.',
        payload: { replicaId: identity.replicaId.toString(), groupChannelId: group?.channelId },
      })
    }
    for (const event of restoreEvents) {
      try {
        ctx.fold(ctx.getSecret(), event)
      } catch (err) {
        ctx.notify.error(`Failed to handle a ${event.type} event from restore`, err)
      }
    }

    // Peers are re-identified against the roster — see `resolveRosterEntries`.
    // Without it the restored rows would be anonymous and the roster poll,
    // which reconciles by actor id, would never match them.
    let actors: BEActorWithStatus[] = []
    try {
      actors = await apiGetActors()
    } catch (err) {
      ctx.notify.error('Could not re-identify restored peers against the roster', err, {
        secretId: recovered.secretId,
      })
    }

    // A helper the library could not restore has no channel to drive; listing
    // it would offer flows that fail against a channel that does not exist.
    const restorable = recovered.snapshot.helpers.filter(h => !notRestored.has(h.channelId))
    // The replica group comes back too: `restore` wrote its members, and the
    // destinations keep taking every publish. Without a row for it the
    // Replicas tab read "No replicas yet" while the mirroring went on.
    const groupPeer = group
      ? restoredGroupPeer(
          group,
          replicaId.toString(),
          membersNotRestored,
          loadReplicaState(current.id).channels[group.channelId]?.peerReplicaId ?? null,
        )
      : null
    // Re-identified together, so no two of them can claim one actor.
    const matches = resolveRosterEntries(
      [
        ...restorable.map(h => ({
          channelId: h.channelId,
          transports: h.transports,
          name: h.communicationInfo?.['name'],
        })),
        ...(group && groupPeer
          ? [
              {
                channelId: group.channelId,
                transports: groupPeer.peer.transports,
                name: groupPeer.peer.communicationInfo?.['name'],
              },
            ]
          : []),
      ],
      actors,
    )
    const helpers: PairedParticipant[] = restorable.map((h, i) => {
      const { actor, transportUri } = matches[i]
      // The matched entry's own discriminant: a `grpc` or `both` helper's
      // first-recognised endpoint may be a `grpc://` one.
      const transportProtocol = protocolName(
        h.transports.find(t => t.uri === transportUri)?.protocol ?? TRANSPORT_PROTOCOL_HTTPS,
      )
      return {
        id: actor?.id ?? `peer-${h.channelId}`,
        name: actor?.name || h.communicationInfo?.['name'] || 'Unknown',
        channelId: h.channelId,
        transport: { protocol: transportProtocol, uri: transportUri },
        // Every endpoint the peer offered, so a helper reachable both ways is
        // shown as such rather than by the one endpoint matched above.
        transports: h.transports.map(t => ({ protocol: protocolName(t.protocol), uri: t.uri })),
        connectionStatus: 'paired' as const,
        // Every peer in a recovered snapshot held a share for us.
        peerRole: 'helper' as const,
        secretShares: [
          { version: recovered.version, status: 'confirmed' as const, verified: false, weight: h.weight },
        ],
        browserManaged: actor?.browser_managed,
        // `restore` writes the roster weight into the channel record, so this
        // is what the next publish gives the helper.
        weight: h.weight,
      }
    })
    const replicaRow =
      group && groupPeer
        ? replicaGroupRow(current, group, groupPeer, matches[restorable.length])
        : null
    const participants = replicaRow ? [...helpers, replicaRow] : helpers

    const bagVersion: BagVersion = {
      version: recovered.version,
      participantIds: helpers.map(p => p.id),
      verifiedParticipantIds: [],
      failedParticipantIds: [],
      items: recovered.snapshot.items.map(s => ({
        // The snapshot keeps ids base64url; the secret spells them in hex.
        id: bytesToHex(fromBase64Url(s.id)),
        name: s.name,
        data: decodeItemText(s.data),
      })),
      // Display-only and unread; the library decodes the snapshot itself.
      rawBytes: '',
      // `restore` writes no tracking shares, so this version cannot be verified
      // — the library's contract. The next published version can.
      restoredFromRecovery: true,
      // The threshold the recovered version was split with (SDK 0.0.9); absent
      // on rosters from before it was recorded.
      ...(recovered.snapshot.threshold !== undefined ? { threshold: recovered.snapshot.threshold } : {}),
      helpers: helpers.map(p => ({ id: p.id, name: p.name, channelId: p.channelId })),
      // The group the recovered secret carried, as the library decoded it.
      replicas: recovered.snapshot.replicas
        ? {
            channelId: recovered.snapshot.replicas.channelId,
            members: recovered.snapshot.replicas.members.map(m => ({
              replicaId: m.replicaId,
              role: m.role,
              name: m.communicationInfo?.['name'] || null,
            })),
          }
        : null,
    }
    const itemBag: ItemBag = {
      secretId: recovered.secretId,
      currentVersion: bagVersion,
      previousVersions: [],
      // The roster's threshold when it carries one — `restore` stores it as
      // the next publish's — otherwise the secret's configured minimum.
      threshold: recovered.snapshot.threshold ?? current.minParticipants,
    }
    // The publish dialogs start from the same threshold the library will use.
    const publishPolicy = withGroupThreshold(current, recovered.snapshot.threshold)

    // 3. Announce our current endpoint to every restored helper. Not to the
    //    replica group: `UpdateChannelInfo` addresses helper channels, and a
    //    group learns a member's endpoint from the roster on its next publish.
    if (helpers.length > 0) {
      try {
        // Both local setters first: `start(UpdateChannelInfo)` tells the peers
        // but does not change what *this* node believes about itself, and the
        // next pairing would otherwise advertise the pre-recovery values.
        // Awaited: both return promises as of SDK 0.0.6, and a rejection must
        // land in this `try` rather than escape as an unhandled error.
        await restoreInstance.protocol.setOwnTransports([
          { uri: current.transport.uri, protocol: 'https' },
        ])
        await restoreInstance.protocol.setCommunicationInfo({ name: current.name })
        await restoreInstance.protocol.start(FlowKind.UpdateChannelInfo, {
          target: helpers.map(p => BigInt(p.channelId)),
          communication_info: { name: current.name },
          // Named, as every app-facing endpoint is since SDK 0.0.6.
          own_transports: [{ uri: current.transport.uri, protocol: 'https' }],
        })
        ctx.log({
          role: 'owner',
          flow: 'recovery',
          step: 'announce_endpoint',
          description: `Announced the recovered endpoint to ${helpers.length} helper(s)`,
          payload: { transportUri: current.transport.uri, secretId: recovered.secretId },
        })
      } catch (err) {
        // Non-fatal: the restore succeeded, and helpers may already point here.
        ctx.notify.error('Failed to announce the recovered endpoint to helpers', err, {
          secretId: recovered.secretId,
        })
      }
    }

    // 4. Install and commit, bound to the *recovered* secret: `restore` rebuilt
    //    state under that id, and the instance the secret was running is bound
    //    to the old one over a namespace just wiped — left in place, every
    //    later protect or verify runs against empty stores until a reload.
    //    Swapped and committed in one locked step, so no drain sees the new
    //    instance against the old record or the other way round.
    await ctx.withLock(async () => {
      ctx.adoptInstance(restoreInstance)
      recordRestoredGroup(current.id, group, groupPeer)
      ctx.commit({
        ...ctx.getSecret(),
        participants,
        itemBag,
        pendingPairings: [],
        heldShares: [],
        recoveredSecrets: [],
        recoveryProgress: null,
        recoveryFailures: [],
        mainChannels: [],
        secretId: recovered.secretId,
        ...(publishPolicy ? { publishPolicy } : {}),
      })
    })

    ctx.log({
      role: 'owner',
      flow: 'recovery',
      step: 'recovery_completed',
      description:
        `Restored ${helpers.length} helper(s)` +
        (replicaRow ? `, the replica group with ${groupPeer?.peer.communicationInfo?.['name'] ?? 'its members'},` : '') +
        ` and ${recovered.snapshot.items.length} item(s) from recovered bag`,
      payload: {
        secretId: recovered.secretId,
        version: recovered.version,
        helperCount: helpers.length,
        replicaGroupChannelId: replicaRow?.channelId ?? null,
        secretCount: recovered.snapshot.items.length,
      },
    })
    return true
  } catch (err) {
    ctx.notify.error('Failed to restore from recovered bag', err, {
      secretId: recovered.secretId,
      version: recovered.version,
    })
    return false
  }
}

/**
 * The participant row for the restored replica group's channel.
 *
 * Restoring on the device that held the group keeps the row it already had —
 * same id, name and endpoint. A new device builds one from the roster member
 * `groupPeer` names, as adopting a mirrored secret does.
 */
function replicaGroupRow(
  current: Secret,
  group: RecoveredReplicaGroup,
  groupPeer: RestoredGroupPeer,
  match: RosterMatch<BEActorWithStatus> | undefined,
): PairedParticipant {
  const existing = current.participants.find(
    p => isReplicaChannel(p) && p.connectionStatus === 'paired' && p.channelId === group.channelId,
  )
  if (existing) return existing

  const { peer, peerRole } = groupPeer
  const actor = match?.actor
  const transportUri = match?.transportUri ?? peer.transports[0]?.uri ?? ''
  return {
    id: actor?.id ?? `peer-${group.channelId}`,
    name: actor?.name || peer.communicationInfo?.['name'] || pairingRoleLabel(peerRole),
    channelId: group.channelId,
    transport: {
      protocol: protocolName(
        peer.transports.find(t => t.uri === transportUri)?.protocol ?? TRANSPORT_PROTOCOL_HTTPS,
      ),
      uri: transportUri,
    },
    transports: peer.transports.map(t => ({ protocol: protocolName(t.protocol), uri: t.uri })),
    connectionStatus: 'paired',
    peerRole,
    // A replica holds no share for this device — it mirrors the whole secret.
    secretShares: [],
    browserManaged: actor?.browser_managed,
  }
}

/**
 * Put this device's replica bookkeeping in line with the restored group.
 *
 * `restore` wiped every channel the library held and wrote back the group's
 * one, so any other recorded replica channel is gone. The group's channel is
 * recorded as confirmed: `restore` writes its members `Paired` — confirming a
 * fingerprint is what admitted them in the first place — and it is flagged as
 * already synced once, so the restore does not publish on its own.
 */
function recordRestoredGroup(
  localSecretId: string,
  group: RecoveredReplicaGroup | undefined,
  groupPeer: RestoredGroupPeer | null,
): void {
  if (!group || !groupPeer) {
    retainReplicaChannels(localSecretId, [])
    return
  }
  retainReplicaChannels(localSecretId, [group.channelId])
  recordReplicaChannel(localSecretId, {
    channelId: group.channelId,
    role: groupPeer.ownRole,
    peerName: groupPeer.peer.communicationInfo?.['name'],
    establishedAt: Date.now(),
    peerReplicaId: groupPeer.peer.replicaId,
  })
  recordConfirmation(localSecretId, replicaChannelRowId(group.channelId), {
    local: true,
    channelId: group.channelId,
    firstSyncStarted: true,
  })
}
