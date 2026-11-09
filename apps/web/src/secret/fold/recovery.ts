// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { snapshotFromEvent } from '../../owner/recoveredSecret'
import { removeRecoveryFailure, upsertRecoveryFailure } from '../../owner/recoveryFailures'
import type { RecoveryHelper } from '@derec-alliance/web'

import type {
  CorruptionReason,
  RecoveredSecret,
  RecoveryDispute,
  RecoveryHelperRef,
  RecoveryProgress,
  Secret,
} from '../../types'
import type { EventHandlers, EventOf, FoldContext } from './context'
import { dispatchFailed } from './outcomes'

/** How each `RecoveryShareCorrupted` reason reads in a sentence. */
const CORRUPTION_TEXT: Record<CorruptionReason, string> = {
  Malformed: 'an unreadable recovery share (no decodable share for this secret and version)',
  InvalidProof: 'a recovery share that fails its own proof',
  Forged: 'a recovery share whose group reconstructs to no valid secret, or that reconstructs alone',
  // Removed in SDK 0.0.11; kept for reports saved before it.
  Inconsistent: 'a recovery share that disagrees with the shares the secret was rebuilt from',
}

/**
 * What the owner should make of each reason, after "It was set aside…".
 *
 * `Malformed` has an innocent cause the others do not: a share protected
 * before an SDK upgrade that changed the share format no longer decodes, while
 * verification — a hash over the bytes the helper still holds — keeps passing.
 * Blaming the helper there sends the owner to unpair a healthy one.
 */
const CORRUPTION_ADVICE: Record<CorruptionReason, string> = {
  Malformed:
    'Either this version was protected before an SDK upgrade that changed the share format — ' +
    'protecting a new version replaces it — or the helper is damaged or compromised.',
  InvalidProof: 'An honest helper never does this — the helper may be damaged or compromised; consider unpairing it.',
  Forged: 'An honest split never produces this — the helper may be damaged or compromised; consider unpairing it.',
  Inconsistent: 'An honest helper never does this — the helper may be damaged or compromised; consider unpairing it.',
}

/** The helper on `channelId` by name, for a sentence. */
function helperName(secret: Secret, channelId: string): string {
  return secret.participants.find(p => p.channelId === channelId)?.name ?? `The helper on channel ${channelId}`
}

/** A helper a recovery decision names, as the owner knows it. */
function helperRef(secret: Secret, helper: RecoveryHelper): RecoveryHelperRef {
  const paired = secret.participants.find(p => p.channelId === helper.channel_id)?.name
  const advertised = helper.communication_info?.['name']
  return { channelId: helper.channel_id, name: paired ?? advertised ?? `Channel ${helper.channel_id}` }
}

/** `names` as one phrase: "Alex", "Alex and Richard", "Alex, Bob and Richard". */
function listNames(refs: readonly RecoveryHelperRef[]): string {
  const names = refs.map(r => r.name)
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Why a recovery closed without a secret, from what its progress recorded:
 * how many shares came, which helpers answered without one, and which never
 * answered at all.
 */
function incompleteReason(progress: RecoveryProgress | null, sharesReceived: number): string {
  const withoutShare = (progress?.refusals?.length ?? 0) + (progress?.corrupted?.length ?? 0)
  const timedOut = progress?.timedOut?.length ?? 0
  const unreadable = (progress?.corrupted ?? []).some(c => c.reason === 'Malformed')
  const details = [
    `${sharesReceived} share${sharesReceived === 1 ? '' : 's'} collected`,
    ...(withoutShare > 0 ? [`${withoutShare} helper${withoutShare === 1 ? '' : 's'} answered without a usable share`] : []),
    ...(timedOut > 0 ? [`${timedOut} did not answer in time`] : []),
  ]
  return (
    `Not enough shares to reconstruct the secret (${details.join(', ')})` +
    (unreadable
      ? '. Unreadable shares usually mean this version was protected before an SDK upgrade that ' +
        'changed the share format: protect a new version, then recover that one.'
      : '. Pair with more helpers and try again.')
  )
}

/**
 * Close the recovery in flight on one or more secrets the owner must judge
 * before restoring (`RecoveryDisputed`, `RecoveryConflict`). They join the
 * recovered list like any other, carrying the dispute, and nothing is restored
 * until the owner picks one.
 */
function closeWithDispute(
  current: Secret,
  ctx: FoldContext,
  event: EventOf<'RecoveryDisputed' | 'RecoveryConflict'>,
  candidates: { secret: EventOf<'SecretRecovered'>['secret']; dispute: RecoveryDispute }[],
): Secret {
  // Decoded before the request is taken, as in `SecretRecovered`.
  const snapshots = candidates.map(c => snapshotFromEvent(c.secret))
  const pending = ctx.rounds.takeRecovery()
  const version = pending?.version ?? event.version
  const first = candidates[0]?.dispute
  const description =
    event.type === 'RecoveryConflict'
      ? `Recovery of v${version} reconstructed ${candidates.length} different secrets — the owner must choose`
      : `Recovery of v${version} is disputed: ${listNames(first?.supportedBy ?? [])} against ` +
        `${listNames(first?.disputedBy ?? [])} — the owner must confirm`
  ctx.log({
    role: 'owner',
    flow: 'recovery',
    step: event.type,
    description,
    payload: {
      secretId: pending?.secretId,
      version,
      candidates: candidates.map(c => ({
        supportedBy: c.dispute.supportedBy.map(h => h.channelId),
        disputedBy: c.dispute.disputedBy.map(h => h.channelId),
      })),
    },
  })
  if (!pending) return current

  ctx.notify.error(
    event.type === 'RecoveryConflict'
      ? `Helpers returned ${candidates.length} different secrets for v${version}. Compare them on the ` +
          'Recovery tab and restore only the one you recognise — the helpers behind the others may be ' +
          'compromised.'
      : `Helpers disagree about v${version}: ${listNames(first?.disputedBy ?? [])} hold shares of a ` +
          'different secret. Check what the recovered secret holds on the Recovery tab before restoring it.',
  )
  const entries: RecoveredSecret[] = candidates.map((c, i) => ({
    secretId: pending.secretId,
    version: pending.version,
    label: pending.label,
    snapshot: snapshots[i],
    dispute: c.dispute,
  }))
  return {
    ...current,
    recoveryProgress: null,
    recoveryFailures: removeRecoveryFailure(current.recoveryFailures, pending.secretId, pending.version),
    recoveredSecrets: [
      // A second attempt at the same version replaces the first's candidates.
      ...(current.recoveredSecrets ?? []).filter(
        r => !(r.secretId === pending.secretId && r.version === pending.version),
      ),
      ...entries,
    ],
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

    return { ...current, recoveryProgress: next }
  },

  // A helper answered with a refusal instead of a share — typically
  // `UNKNOWN_SHARE_VERSION`, a helper that never held, or has since dropped,
  // the version asked for. Not a share, so it never counts towards the
  // threshold, but it is that helper's answer, shown on the progress. Whether
  // every answer is in is the library's call (SDK 0.0.11): it decides once.
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
    return {
      ...current,
      recoveryProgress: { ...progress, refusals: [...(progress.refusals ?? []), { channelId, status, memo }] },
    }
  },

  // A helper answered with a share that cannot be part of the secret. Beyond
  // setting the share aside — which the library has done — the owner is told
  // which helper and why, and offered to unpair it (see `CORRUPTION_ADVICE`
  // for the one reason an honest helper can cause). `Forged` arrives with the
  // recovery's decision, which has already closed the progress.
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
        `count towards the recovery. ${CORRUPTION_ADVICE[reason]}`,
      undefined,
      { channelId, version, reason },
    )

    const reports = current.corruptShareReports ?? []
    const known = reports.some(
      r => r.channelId === channelId && r.version === version && r.reason === reason,
    )
    let next: Secret = known
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
      progress &&
      progress.version === version &&
      !(progress.corrupted ?? []).some(c => c.channelId === channelId)
    ) {
      next = { ...next, recoveryProgress: { ...progress, corrupted: [...(progress.corrupted ?? []), { channelId, reason }] } }
    }
    return next
  },

  // From `start`, a request that could not be dispatched. From `tick`
  // (SDK 0.0.11), a helper that did not answer within the share-response
  // timeout: the library decides on the shares in hand next, so that one is
  // only noted on the progress.
  RecoverSecretFailed: (current, event, ctx) => {
    const progress = current.recoveryProgress
    if (event.error !== 'timeout' || !progress || progress.version !== event.version) {
      return dispatchFailed(current, event, ctx)
    }
    ctx.log({
      role: 'owner',
      flow: 'recovery',
      step: 'RecoverSecretFailed',
      description: `${helperName(current, event.channel_id)} did not answer the share request for v${event.version} in time`,
      payload: { channelId: event.channel_id, version: event.version, error: event.error },
    })
    if ((progress.timedOut ?? []).includes(event.channel_id)) return current
    return {
      ...current,
      recoveryProgress: { ...progress, timedOut: [...(progress.timedOut ?? []), event.channel_id] },
    }
  },

  // Every helper asked has answered, or the rest timed out, and nothing
  // reconstructs. The library has closed the recovery.
  RecoveryIncomplete: (current, event, ctx) => {
    const pending = ctx.rounds.takeRecovery()
    const progress = current.recoveryProgress
    const error = incompleteReason(progress, event.shares_received)
    ctx.log({
      role: 'owner',
      flow: 'recovery',
      step: 'RecoveryIncomplete',
      description: `Recovery of v${event.version} closed without a secret: ${error}`,
      payload: { version: event.version, sharesReceived: event.shares_received },
    })
    const secretId = pending?.secretId ?? progress?.secretId
    if (secretId === undefined) return current
    ctx.notify.outcome(`Recovery failed: ${error}`)
    // A terminal failure goes on the per-version list, so it survives later
    // Recover clicks on other versions.
    return {
      ...current,
      recoveryProgress:
        progress && progress.version === event.version
          ? { ...progress, sharesReceived: event.shares_received, error }
          : progress,
      recoveryFailures: upsertRecoveryFailure(current.recoveryFailures, secretId, event.version, error),
    }
  },

  RecoveryDisputed: (current, event, ctx) => {
    const supportedBy = event.supported_by.map(h => helperRef(current, h))
    const disputedBy = event.disputed_by.map(h => helperRef(current, h))
    return closeWithDispute(current, ctx, event, [
      { secret: event.secret, dispute: { kind: 'disputed', supportedBy, disputedBy } },
    ])
  },

  RecoveryConflict: (current, event, ctx) => {
    const backers = event.candidates.map(c => c.supported_by.map(h => helperRef(current, h)))
    const outside = event.disputed_by.map(h => helperRef(current, h))
    return closeWithDispute(
      current,
      ctx,
      event,
      event.candidates.map((candidate, i) => ({
        secret: candidate.secret,
        dispute: {
          kind: 'conflict',
          supportedBy: backers[i],
          disputedBy: [...backers.filter((_, j) => j !== i).flat(), ...outside],
          candidate: i + 1,
          candidates: event.candidates.length,
        },
      })),
    )
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
        secretCount: snapshot.items.length,
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
