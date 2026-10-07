// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { FlowKind } from '@derec-alliance/web'

import { apiGetActors, type BEActorWithStatus } from '../../api'
import { bytesToHex } from '../../bytes'
import { TRANSPORT_PROTOCOL_HTTPS, protocolName } from '../../contactDto'
import { fromBase64Url } from '../../derecApi'
import { buildProtocolInstance } from '../../owner/protocol'
import { decodeSecretText, snapshotToPayload } from '../../owner/recoveredSecret'
import { isReplicaChannel } from '../../ownerPairing'
import { resolveRosterEntries } from '../../peerIdentity'
import { resolveVaultConfig } from '../../protocolDefaults'
import { getOrCreateReplicaId } from '../../replicaIdentity'
import { clearNamespace } from '../../stores'
import type { BagVersion, PairedParticipant, RecoveredSecret, SecretBag } from '../../types'
import type { CommandContext } from './context'

/**
 * Restore this vault from a recovered secret.
 *
 * 1. Retires the ephemeral recovery channels while their keys still exist —
 *    only those: a channel the snapshot itself names is restored, not retired.
 * 2. Wipes the namespace and replays the snapshot through an instance bound to
 *    the recovered `secret_id`.
 * 3. Announces this device's endpoint to the restored helpers via
 *    `UpdateChannelInfo` — the snapshot carries the *pre-loss* transport,
 *    which is what those helpers still have on their channel records.
 * 4. Installs that instance in the running vault and commits the rebuilt
 *    vault — participants, bag, threshold — bound to the recovered secret.
 *
 * Reports its own failures. Returns whether the restore committed.
 */
export async function restoreVault(
  secret: RecoveredSecret,
  ctx: CommandContext,
): Promise<boolean> {
  try {
    const current = ctx.getVault()
    const targetNs = `vault:${current.id}`

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
    const restoredChannelIds = new Set(secret.snapshot.helpers.map(h => h.channelId))
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
    const config = resolveVaultConfig(current.configOverrides, ctx.getServerDefaults())
    const restoreInstance = buildProtocolInstance({
      namespace: targetNs,
      secretId: secret.secretId,
      ownTransportUri: current.transport.uri,
      communicationInfo: { name: current.name },
      threshold: current.minParticipants,
      keepList: ctx.keepList,
      timeoutSecs: config.protocolTimeoutSecs,
      unpairAck: config.unpairAck,
      replicaId: getOrCreateReplicaId(current.id),
      relayActorId: current.id,
      // The restored instance becomes the vault's live one (`adoptInstance`),
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
        await restoreInstance.protocol.restore(snapshotToPayload(secret.snapshot), secret.version),
      )
    })
    const notRestored = new Set(
      restoreEvents.flatMap(e =>
        e.type === 'PeerNotRestored' && e.replica_id === undefined ? [e.channel_id] : [],
      ),
    )
    for (const event of restoreEvents) {
      try {
        ctx.fold(ctx.getVault(), event)
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
        secretId: secret.secretId,
      })
    }

    // A helper the library could not restore has no channel to drive; listing
    // it would offer flows that fail against a channel that does not exist.
    const restorable = secret.snapshot.helpers.filter(h => !notRestored.has(h.channelId))
    const matches = resolveRosterEntries(
      restorable.map(h => ({
        channelId: h.channelId,
        transports: h.transports,
        name: h.communicationInfo?.['name'],
      })),
      actors,
    )
    const participants: PairedParticipant[] = restorable.map((h, i) => {
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
        secretShares: [{ version: secret.version, status: 'confirmed' as const, verified: false }],
        browserManaged: actor?.browser_managed,
      }
    })

    const bagVersion: BagVersion = {
      version: secret.version,
      participantIds: participants.map(p => p.id),
      verifiedParticipantIds: [],
      failedParticipantIds: [],
      secrets: secret.snapshot.secrets.map(s => ({
        // The snapshot keeps ids base64url; the vault spells them in hex.
        id: bytesToHex(fromBase64Url(s.id)),
        name: s.name,
        data: decodeSecretText(s.data),
      })),
      // Display-only and unread; the library decodes the snapshot itself.
      rawBytes: '',
      // `restore` writes no tracking shares, so this version cannot be verified
      // — the library's contract. The next published version can.
      restoredFromRecovery: true,
      helpers: participants.map(p => ({ id: p.id, name: p.name, channelId: p.channelId })),
      // The group the recovered secret carried, as the library decoded it.
      replicas: secret.snapshot.replicas
        ? {
            channelId: secret.snapshot.replicas.channelId,
            members: secret.snapshot.replicas.members.map(m => ({
              replicaId: m.replicaId,
              role: m.role,
              name: m.communicationInfo?.['name'] || null,
            })),
          }
        : null,
    }
    const secretBag: SecretBag = {
      secretId: secret.secretId,
      currentVersion: bagVersion,
      previousVersions: [],
      // The threshold is not carried in the bag; the vault's configured
      // minimum is the most sensible default.
      threshold: current.minParticipants,
    }

    // 3. Announce our current endpoint to every restored helper.
    if (participants.length > 0) {
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
          target: participants.map(p => BigInt(p.channelId)),
          communication_info: { name: current.name },
          // Named, as every app-facing endpoint is since SDK 0.0.6.
          own_transports: [{ uri: current.transport.uri, protocol: 'https' }],
        })
        ctx.log({
          role: 'owner',
          flow: 'recovery',
          step: 'announce_endpoint',
          description: `Announced the recovered endpoint to ${participants.length} helper(s)`,
          payload: { transportUri: current.transport.uri, secretId: secret.secretId },
        })
      } catch (err) {
        // Non-fatal: the restore succeeded, and helpers may already point here.
        ctx.notify.error('Failed to announce the recovered endpoint to helpers', err, {
          secretId: secret.secretId,
        })
      }
    }

    // 4. Install and commit, bound to the *recovered* secret: `restore` rebuilt
    //    state under that id, and the instance the vault was running is bound
    //    to the old one over a namespace just wiped — left in place, every
    //    later protect or verify runs against empty stores until a reload.
    //    Swapped and committed in one locked step, so no drain sees the new
    //    instance against the old record or the other way round.
    await ctx.withLock(async () => {
      ctx.adoptInstance(restoreInstance)
      ctx.commit({
        ...ctx.getVault(),
        participants,
        secretBag,
        pendingPairings: [],
        heldShares: [],
        recoveredSecrets: [],
        recoveryProgress: null,
        recoveryFailures: [],
        mainChannels: [],
        secretId: secret.secretId,
      })
    })

    ctx.log({
      role: 'owner',
      flow: 'recovery',
      step: 'recovery_completed',
      description: `Restored ${participants.length} helper(s) and ${secret.snapshot.secrets.length} secret(s) from recovered bag`,
      payload: {
        secretId: secret.secretId,
        version: secret.version,
        helperCount: participants.length,
        secretCount: secret.snapshot.secrets.length,
      },
    })
    return true
  } catch (err) {
    ctx.notify.error('Failed to restore from recovered bag', err, {
      secretId: secret.secretId,
      version: secret.version,
    })
    return false
  }
}
