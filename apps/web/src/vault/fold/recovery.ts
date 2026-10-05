// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { snapshotFromEvent } from '../../owner/recoveredSecret'
import { removeRecoveryFailure, upsertRecoveryFailure } from '../../owner/recoveryFailures'
import { describeStorageFailure } from '../../stores'
import type { EventHandlers } from './context'

/** Discovery and secret-recovery events. */
export const recoveryHandlers = {
  // `restore` wrote no channel for this roster entry — the recovered roster
  // named no endpoint the library can use. Everything else was restored; this
  // peer needs pairing again to be reachable. The restore command leaves the
  // helper out of the participant list.
  PeerNotRestored: (current, event, ctx) => {
    const who =
      event.replica_id !== undefined
        ? `replica ${event.replica_id}`
        : `helper on channel ${event.channel_id}`
    ctx.notify.error(
      `The ${who} could not be restored (${event.reason}) — pair with it again to reach it.`,
      undefined,
      { channelId: event.channel_id, replicaId: event.replica_id, reason: event.reason },
    )
    ctx.log({
      role: 'owner',
      flow: 'recovery',
      step: 'PeerNotRestored',
      description: `Restore skipped the ${who}: ${event.reason}`,
      payload: { channelId: event.channel_id, replicaId: event.replica_id ?? null, reason: event.reason },
    })
    return current
  },

  SecretsDiscovered: (current, event, ctx) => {
    const channelId = event.channel_id
    if (!channelId || !event.secrets) return current
    const participant = current.participants.find(h => h.channelId === channelId)
    if (!participant) return current

    const discoveredVersions = event.secrets.flatMap(s => {
      const secretId = String(s.secret_id)
      return s.versions.map(v => ({ secretId, version: v.version, description: v.description }))
    })

    // Always mark discovery complete on response — including the empty case.
    // An empty response means the helper genuinely holds no shares for this
    // owner. It is *not* a race: Discovery is fired only after `PairingCompleted`,
    // so the helper's pair handler already ran to completion. Leaving the
    // participant at `discoveryComplete=false` would make the recovery retry
    // loop fan out Discovery every 3 s forever.
    ctx.log({
      role: 'owner',
      flow: 'recovery',
      step: 'SecretsDiscovered',
      description:
        discoveredVersions.length === 0
          ? `Discovery complete from ${participant.name} — helper holds no shares for this owner`
          : `Discovered ${discoveredVersions.length} version(s) from ${participant.name}`,
      payload: { channelId, versions: discoveredVersions },
    })

    return {
      ...current,
      participants: current.participants.map(h =>
        h.id === participant.id
          ? { ...h, discoveryComplete: true, discoveryError: undefined, discoveredVersions }
          : h,
      ),
    }
  },

  RecoveryShareReceived: (current, event, ctx) => {
    const progress = current.recoveryProgress
    if (!progress) return current

    const sharesReceived = event.shares_received ?? progress.sharesReceived

    // The library emits RecoveryShareReceived (not RecoveryShareError) on
    // InsufficientShares — it keeps the bucket open waiting for more. So the
    // app has to notice when every requested response is in and reconstruction
    // still failed, and surface the error itself.
    const allResponsesIn = sharesReceived >= progress.totalRequested
    const error = allResponsesIn
      ? 'Not enough shares to reconstruct the secret. Pair with more helpers and try again.'
      : null

    ctx.log({
      role: 'owner',
      flow: 'recovery',
      step: 'RecoveryShareReceived',
      description: `Share received (${sharesReceived}/${progress.totalRequested})${allResponsesIn ? ' — insufficient, giving up' : ''}`,
      payload: { channelId: event.channel_id, sharesReceived, totalRequested: progress.totalRequested },
    })

    // A terminal "insufficient" goes on the per-version failure list, so it
    // survives later Recover clicks on other versions.
    const failures = error
      ? upsertRecoveryFailure(current.recoveryFailures, progress.secretId, progress.version, error)
      : current.recoveryFailures

    return {
      ...current,
      recoveryProgress: { ...progress, sharesReceived, error },
      recoveryFailures: failures,
    }
  },

  RecoveryShareError: (current, event, ctx) => {
    ctx.log({
      role: 'owner',
      flow: 'recovery',
      step: 'RecoveryShareError',
      description: `Recovery share error: ${event.error}`,
      payload: { channelId: event.channel_id, sharesReceived: event.shares_received, error: event.error },
    })

    const progress = current.recoveryProgress
    if (!progress) return current

    // A full browser storage surfaces from the library as a bare "store
    // backend error"; named for what it is, it is something the owner can fix.
    const message = describeStorageFailure(event.error ?? 'Unknown recovery error')
    ctx.notify.outcome(`Recovery failed: ${message}`)
    return {
      ...current,
      recoveryProgress: {
        ...progress,
        sharesReceived: event.shares_received ?? progress.sharesReceived,
        error: message,
      },
      recoveryFailures: upsertRecoveryFailure(
        current.recoveryFailures,
        progress.secretId,
        progress.version,
        message,
      ),
    }
  },

  SecretRecovered: (current, event, ctx) => {
    if (!event.secret) return current
    // The library decodes the snapshot itself and hands over a typed one, so
    // there is no app-side bag parsing left — only encoding it for storage.
    // Decoded *before* the request is taken: if this throws, the request stays
    // in flight and a redelivered event can still match it.
    const snapshot = snapshotFromEvent(event.secret)
    const pending = ctx.rounds.takeRecovery()

    ctx.log({
      role: 'owner',
      flow: 'recovery',
      step: 'SecretRecovered',
      description: `Secret recovered: ${pending?.label ?? 'unknown'}`,
      payload: {
        secretId: pending?.secretId,
        version: pending?.version,
        helperCount: snapshot.helpers.length,
        secretCount: snapshot.secrets.length,
        replicaCount: snapshot.replicas?.members.length ?? 0,
      },
    })

    if (!pending) return current

    ctx.notify.outcome('Secret recovered')
    return {
      ...current,
      recoveryProgress: null,
      recoveryFailures: removeRecoveryFailure(current.recoveryFailures, pending.secretId, pending.version),
      recoveredSecrets: [
        ...(current.recoveredSecrets ?? []),
        { secretId: pending.secretId, version: pending.version, label: pending.label, snapshot },
      ],
    }
  },
} satisfies Partial<EventHandlers>
