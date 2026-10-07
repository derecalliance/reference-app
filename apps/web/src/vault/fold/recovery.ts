// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { snapshotFromEvent } from '../../owner/recoveredSecret'
import { removeRecoveryFailure, upsertRecoveryFailure } from '../../owner/recoveryFailures'
import { describeStorageFailure } from '../../stores'
import type { CorruptionReason, RecoveryProgress, Vault } from '../../types'
import type { EventHandlers, FoldContext } from './context'

/** How each `RecoveryShareCorrupted` reason reads in a sentence. */
const CORRUPTION_TEXT: Record<CorruptionReason, string> = {
  Malformed: 'an unreadable recovery share (no decodable share for this secret and version)',
  InvalidProof: 'a recovery share that fails its own proof',
  Inconsistent: 'a recovery share that disagrees with the shares the secret was rebuilt from',
}

/** The helper on `channelId` by name, for a sentence. */
function helperName(vault: Vault, channelId: string): string {
  return vault.participants.find(p => p.channelId === channelId)?.name ?? `The helper on channel ${channelId}`
}

/**
 * The helpers asked that have answered so far, with a share or without one.
 *
 * A refusal or a set-aside share counts only when it came from a helper the
 * progress was expecting: the library asks every paired helper, and one that
 * never held this version refuses too, without having been counted in.
 */
function answeredCount(progress: RecoveryProgress): number {
  const expected = progress.requestedChannelIds ? new Set(progress.requestedChannelIds) : null
  const withoutShare = new Set(
    [...(progress.refusals ?? []), ...(progress.corrupted ?? [])]
      .map(answer => answer.channelId)
      .filter(channelId => expected === null || expected.has(channelId)),
  )
  return progress.sharesReceived + withoutShare.size
}

/**
 * Apply `next` as the recovery's progress, and end it as insufficient once
 * every helper asked has answered and no secret came of it.
 *
 * The library keeps a recovery open while shares are short, waiting for more —
 * it never reports "insufficient" itself — so the app has to notice that no
 * more answers are coming. Refusals and set-aside shares are answers too:
 * without them a recovery whose last helper refused waited for the watchdog.
 */
function settleIfEveryAnswerIsIn(current: Vault, next: RecoveryProgress, ctx: FoldContext): Vault {
  if (next.error !== null || answeredCount(next) < next.totalRequested) {
    return { ...current, recoveryProgress: next }
  }
  const withoutShare = (next.refusals?.length ?? 0) + (next.corrupted?.length ?? 0)
  const error =
    'Not enough shares to reconstruct the secret' +
    (withoutShare > 0
      ? ` — ${withoutShare} helper${withoutShare === 1 ? '' : 's'} answered without a usable share`
      : '') +
    '. Pair with more helpers and try again.'
  ctx.log({
    role: 'owner',
    flow: 'recovery',
    step: 'recovery_insufficient',
    description: `Every helper asked has answered (${next.sharesReceived} share(s), ${withoutShare} without one) — insufficient, giving up`,
    payload: { sharesReceived: next.sharesReceived, withoutShare, totalRequested: next.totalRequested },
  })
  // A terminal "insufficient" goes on the per-version failure list, so it
  // survives later Recover clicks on other versions.
  return {
    ...current,
    recoveryProgress: { ...next, error },
    recoveryFailures: upsertRecoveryFailure(current.recoveryFailures, next.secretId, next.version, error),
  }
}

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
    const next = { ...progress, sharesReceived }

    ctx.log({
      role: 'owner',
      flow: 'recovery',
      step: 'RecoveryShareReceived',
      description: `Share received (${sharesReceived}/${progress.totalRequested})`,
      payload: { channelId: event.channel_id, sharesReceived, totalRequested: progress.totalRequested },
    })

    return settleIfEveryAnswerIsIn(current, next, ctx)
  },

  // A helper answered with a refusal instead of a share — typically
  // `UNKNOWN_SHARE_VERSION`, a helper that never held, or has since dropped,
  // the version asked for. Not a share, so it never counts towards the
  // threshold, but it is that helper's answer: shown on the progress, and
  // counted when deciding whether every answer is in.
  RecoveryShareRefused: (current, event, ctx) => {
    const { channel_id: channelId, version, status, memo } = event
    const who = helperName(current, channelId)
    ctx.log({
      role: 'owner',
      flow: 'recovery',
      step: 'RecoveryShareRefused',
      description: `${who} refused to send its share of v${version} (status=${status}${memo ? `, memo=${memo}` : ''})`,
      payload: { channelId, version, status, memo },
    })

    const progress = current.recoveryProgress
    if (!progress || progress.version !== version) return current
    if ((progress.refusals ?? []).some(r => r.channelId === channelId)) return current
    const next = { ...progress, refusals: [...(progress.refusals ?? []), { channelId, status, memo }] }
    return settleIfEveryAnswerIsIn(current, next, ctx)
  },

  // A helper answered with a share that cannot be part of the secret. An
  // honest helper never does, so beyond setting the share aside — which the
  // library has done — the owner is told which helper and why, and offered to
  // unpair it. `Inconsistent` arrives alongside `SecretRecovered`, after the
  // recovery has already succeeded without it, so only the arrival-time
  // reasons count as an answer on the progress.
  RecoveryShareCorrupted: (current, event, ctx) => {
    const { channel_id: channelId, version, reason } = event
    const peerName = helperName(current, channelId)
    ctx.log({
      role: 'owner',
      flow: 'recovery',
      step: 'RecoveryShareCorrupted',
      description: `${peerName} sent ${CORRUPTION_TEXT[reason]} for v${version} — set aside (${reason})`,
      payload: { channelId, version, reason },
    })
    ctx.notify.error(
      `${peerName} sent ${CORRUPTION_TEXT[reason]} for v${version}. It was set aside and did not ` +
        'count towards the recovery. An honest helper never does this — the helper may be damaged ' +
        'or compromised; consider unpairing it.',
      undefined,
      { channelId, version, reason },
    )

    const reports = current.corruptShareReports ?? []
    const known = reports.some(
      r => r.channelId === channelId && r.version === version && r.reason === reason,
    )
    let next: Vault = known
      ? current
      : {
          ...current,
          corruptShareReports: [
            ...reports,
            { channelId, peerName, version, reason, reportedAt: Date.now() },
          ],
        }

    const progress = next.recoveryProgress
    if (
      reason !== 'Inconsistent' &&
      progress &&
      progress.version === version &&
      !(progress.corrupted ?? []).some(c => c.channelId === channelId)
    ) {
      next = settleIfEveryAnswerIsIn(
        next,
        { ...progress, corrupted: [...(progress.corrupted ?? []), { channelId, reason }] },
        ctx,
      )
    }
    return next
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
