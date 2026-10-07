// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { apiGetActors, type BEActorWithStatus } from '../../api'
import { toBytes } from '../../bytes'
import { isReplicaChannel } from '../../ownerPairing'
import { buildProtocolInstance, type ProtocolInstance } from '../../owner/protocol'
import { resolveVaultConfig } from '../../protocolDefaults'
import {
  ReplicaAdoptionError,
  adoptReplicaSecret,
  adoptedVaultState,
  clearReplicaState,
  describeRestoreFailure,
  recordConfirmation,
  recordReplicaChannel,
  replicaChannelRowId,
  type AdoptedVaultState,
  type PendingReplicaAdoption,
  type ReplicaAdoptionOutcome,
} from '../../replicaFlows'
import { getOrCreateReplicaId } from '../../replicaIdentity'
import { clearNamespace } from '../../stores'
import type { SecretBag } from '../../types'
import type { AdoptionContext } from './context'

/**
 * Adopt a mirrored vault offered by a replica source.
 *
 * Destructive, and only ever run on an explicit confirmation. The sequence
 * itself lives in `adoptReplicaSecret`; this is the wiring and the commit.
 *
 * Failures are deliberately **not** recovered from. The namespace is erased
 * before `adoptReplicaSecret` can reject, so this vault is blocked — persisted,
 * so a reload stays blocked — and the rejection is re-thrown unchanged: the
 * caller has to see the library's own words.
 */
export async function adoptMirroredVault(
  adoption: PendingReplicaAdoption,
  ctx: AdoptionContext,
): Promise<void> {
  const current = ctx.getVault()
  const config = resolveVaultConfig(current.configOverrides, ctx.getServerDefaults())
  // Captured out of the injected builder: `adoptReplicaSecret` only knows the
  // structural slice it drives, while the runtime installs the full instance.
  const built: { instance: ProtocolInstance | null } = { instance: null }

  let outcome: ReplicaAdoptionOutcome
  try {
    outcome = await ctx.withLock(() =>
      adoptReplicaSecret({
        adoption,
        namespace: `vault:${current.id}`,
        config: {
          ownTransportUri: current.transport.uri,
          communicationInfo: { name: current.name },
          threshold: current.minParticipants,
          keepList: ctx.keepList,
          timeoutSecs: config.protocolTimeoutSecs,
          unpairAck: config.unpairAck,
        },
        deps: {
          clearNamespace,
          clearReplicaBookkeeping: () => clearReplicaState(current.id),
          getReplicaId: () => getOrCreateReplicaId(current.id),
          // Written through the app's own store: the library has no API to hand
          // tracking shares back — `restore` deliberately writes none. The
          // payload names a channel per share, so each lands where verification
          // later looks for it.
          saveTrackingShares: async (shares, secretId, version) => {
            const store = built.instance?.shareStore
            if (!store) return
            for (const share of shares) {
              await store.save(secretId, share.channel_id, {
                secretId,
                version,
                bytes: toBytes(share.committed_share),
              })
            }
          },
          buildInstance: params => {
            const instance = buildProtocolInstance({ ...params, relayActorId: current.id })
            built.instance = instance
            return instance
          },
          // Folded for console output only: the commit below replaces
          // participants and bag wholesale from the adopted snapshot.
          onEvent: event => {
            try {
              ctx.fold(ctx.getVault(), event)
            } catch (err) {
              ctx.notify.error(`Failed to handle a ${event.type} event from adoption`, err)
            }
          },
        },
      }),
    )
  } catch (err) {
    const failure = err instanceof ReplicaAdoptionError ? err.failure : describeRestoreFailure(err)
    ctx.block(failure)
    ctx.log({
      role: 'owner',
      flow: 'sharing',
      step: 'replica_adoption_failed',
      description: `Adoption of the mirrored vault failed after this device's vault was erased — the page is blocked: ${failure.text}`,
      payload: {
        code: failure.code,
        channelIds: failure.channelIds,
        wipeDidNotTake: failure.wipeDidNotTake,
        channelId: adoption.channelId,
        secretId: adoption.secretId,
        version: adoption.version,
      },
    })
    throw err
  }

  // Rebind to the adopted vault: the old instance is bound to its own secret
  // id over a namespace that no longer exists.
  if (built.instance) ctx.adoptInstance(built.instance)

  // Non-fatal: without the roster the adopted helpers keep snapshot-only
  // identities, but the adoption itself has already committed.
  let actors: BEActorWithStatus[] = []
  try {
    actors = await apiGetActors()
  } catch (err) {
    ctx.notify.error('Could not re-identify the adopted helpers against the roster', err, {
      secretId: outcome.secretId,
    })
  }

  // Everything from here is *projection* — the adoption has committed. A throw
  // would reach the dialog's handler and be reported as "the vault was erased
  // and the restore did not complete", the opposite of what happened.
  let projected: AdoptedVaultState
  try {
    projected = adoptedVaultState(adoption, actors, current.minParticipants)
  } catch (err) {
    ctx.notify.error(
      'The mirrored vault was adopted, but its roster could not be rendered',
      err,
      { secretId: outcome.secretId },
    )
    projected = { participants: [], secretBag: null as unknown as SecretBag }
  }
  const { participants, secretBag } = projected

  // Put the replica bookkeeping back. The wipe cleared it — it is keyed by
  // vault, not by namespace — and without it the destination would offer to
  // confirm a comparison that already happened at pairing and cannot succeed.
  const group = adoption.secret.replicas
  const source = group?.members?.find(m => m.role === 'Source')
  if (group?.channel_id && source) {
    try {
      recordReplicaChannel(current.id, {
        channelId: group.channel_id,
        // This device took the mirror, so it is the destination.
        role: 'replica_destination',
        peerName: source.communication_info?.['name'],
        establishedAt: Date.now(),
        peerReplicaId: source.replica_id,
      })
      // Keyed by the channel's row id, which is how `replicaViews` reads it
      // back — not by the peer's replica id.
      recordConfirmation(current.id, replicaChannelRowId(group.channel_id), {
        // Confirmed before the adoption — it would not have been offered otherwise.
        local: true,
        peer: 'protocol-verified',
        channelId: group.channel_id,
      })
    } catch (err) {
      ctx.notify.error(
        'The adopted vault is in place, but its replica pairing could not be re-recorded',
        err,
        { secretId: outcome.secretId },
      )
    }
  }

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
    secretId: outcome.secretId,
  })

  ctx.log({
    role: 'owner',
    flow: 'sharing',
    step: 'replica_secret_adopted',
    description: `Adopted mirrored vault v${outcome.version} (${participants.filter(p => !isReplicaChannel(p)).length} helper(s), ${secretBag.currentVersion.secrets.length} secret(s)) — this device's own vault was erased`,
    payload: {
      secretId: outcome.secretId,
      version: outcome.version,
      replicaId: outcome.replicaId.toString(),
      fromReplicaId: adoption.fromReplicaId,
      channelId: adoption.channelId,
      teardownEvents: outcome.events.map(e => e.type),
    },
  })
}
