// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { updateBagVerified, updateBagVersion } from '../../owner/bag'
import type { SecretShareRef, Vault } from '../../types'
import { UNANSWERED_MEMO, commitRoundVersion, settleUnansweredShares } from '../rounds'
import type { EventHandlers, FoldContext } from './context'


/** Share distribution and verification events, from the owner's side. */
export const sharingHandlers = {
  ShareStored: (current, event) => {
    const channelId = event.channel_id
    if (!channelId) return current
    const version = event.version ?? 1
    const existing = current.heldShares ?? []
    if (existing.some(s => s.channelId === channelId && s.version === version)) return current
    return {
      ...current,
      heldShares: [...existing, { channelId, secretId: '', version, description: '' }],
    }
  },

  ShareConfirmed: (current, event, ctx) => {
    const channelId = event.channel_id
    if (!channelId) return current
    const version = event.version ?? 1

    ctx.log({
      role: 'owner',
      flow: 'sharing',
      step: 'ShareConfirmed',
      description: `Share confirmed by participant on channel ${channelId}`,
      payload: { channelId, version },
    })

    if (!ctx.rounds.isAwaitingShare(channelId, version)) return current

    const participant = current.participants.find(h => h.channelId === channelId)
    if (!participant) return current

    // The staged bag is not committed to the vault until the round completes.
    ctx.rounds.recordShareConfirmed(version, participant.id, channelId)

    const shareRef: SecretShareRef = { version, status: 'confirmed', verified: false }
    return commitOnceHelpersAnswered(
      {
        ...current,
        participants: current.participants.map(h =>
          h.id === participant.id
            ? { ...h, secretShares: [...h.secretShares.filter(s => s.version !== version), shareRef] }
            : h,
        ),
      },
      version,
      ctx,
    )
  },

  ShareRejected: (current, event, ctx) => {
    const channelId = event.channel_id
    if (!channelId) return current
    const version = event.version ?? 1
    const status = event.status ?? 0
    const memo = event.memo ?? ''

    ctx.log({
      role: 'owner',
      flow: 'sharing',
      step: 'ShareRejected',
      description: `Share rejected by participant on channel ${channelId} (status=${status}, memo=${memo})`,
      payload: { channelId, version, status, memo },
    })

    ctx.rounds.dropShare(channelId, version)

    const participant = current.participants.find(h => h.channelId === channelId)
    if (!participant) return current

    // Recorded on the staged bag, which is not committed to the vault yet.
    ctx.rounds.recordShareFailed(version, { id: participant.id, status, memo })

    const rejectedRef: SecretShareRef = {
      version,
      status: 'rejected',
      verified: false,
      failure: { status, memo },
    }
    return commitOnceHelpersAnswered(
      {
        ...current,
        participants: current.participants.map(h =>
          h.id === participant.id
            ? { ...h, secretShares: [...h.secretShares.filter(s => s.version !== version), rejectedRef] }
            : h,
        ),
      },
      version,
      ctx,
    )
  },

  SharingComplete: (current, event, ctx) => {
    const version = event.version ?? 1
    const confirmedCount = event.confirmed_count ?? 0
    const failedCount = event.failed_count ?? 0
    const thresholdMet = event.threshold_met ?? false

    ctx.log({
      role: 'owner',
      flow: 'sharing',
      step: 'SharingComplete',
      description: `Sharing round v${version} complete: ${confirmedCount} confirmed, ${failedCount} failed${thresholdMet ? '' : ' — threshold NOT met'}`,
      payload: { version, confirmedCount, failedCount, thresholdMet },
    })

    ctx.notify.outcome(
      thresholdMet
        ? `Sharing round v${version} complete`
        : `Sharing round v${version} did not reach its threshold`,
    )

    // Consumed only if the staged bag is *this* round's — see `completeRound`.
    const staged = ctx.rounds.completeRound(version)
    // The protocol resolved the round — after it left the tracker, so the
    // watchdog can tell whether another round still needs it.
    ctx.roundResolved()

    // The round is closed: whoever has not answered never will. Settled as
    // refused so the progress view resolves — to the rolled-back banner below
    // threshold, or to "published, but N failed" above it — instead of leaving
    // those rows spinning.
    const unanswered = staged
      ? current.participants.filter(p =>
          p.secretShares.some(s => s.version === version && s.status === 'pending'),
        )
      : []
    const settled = staged
      ? { ...current, participants: settleUnansweredShares(current.participants, version) }
      : current

    // The share store derives `latestVersion` from the versions it actually
    // holds, so there is no separate counter to advance or roll back here.
    if (thresholdMet && staged) {
      const stagedBag = updateBagVersion(staged.bag, version, v => ({
        ...v,
        failedParticipantIds: [
          ...(v.failedParticipantIds ?? []),
          ...unanswered
            .filter(p => !(v.failedParticipantIds ?? []).some(f => f.id === p.id))
            .map(p => ({ id: p.id, status: 0, memo: UNANSWERED_MEMO })),
        ],
      }))
      return { ...settled, secretBag: commitRoundVersion(current.secretBag, stagedBag) }
    }
    if (staged) return settled

    // A round this device did not stage, but which the helpers accepted.
    // Pairing a replica publishes one, and so does the promotion inside
    // `verifyFingerprint` — neither goes through `protect`, so there is no
    // staged bag to consume. Ignoring it left the screen showing a version the
    // helpers had already moved past.
    //
    // The secrets are unchanged — an auto-publish re-shares what is already in
    // the bag — so the current version is carried forward under the new number,
    // and only the verification state resets, because those confirmations were
    // for the bytes of the previous round. It is a fresh publish, so the
    // library holds tracking shares for it even when the version it re-shares
    // was restored from recovery.
    const bag = current.secretBag
    if (thresholdMet && bag && version > bag.currentVersion.version) {
      return {
        ...current,
        secretBag: {
          ...bag,
          currentVersion: {
            ...bag.currentVersion,
            version,
            verifiedParticipantIds: [],
            failedParticipantIds: [],
            restoredFromRecovery: undefined,
          },
          previousVersions: [bag.currentVersion, ...bag.previousVersions],
        },
      }
    }

    return current
  },

  ShareVerified: (current, event, ctx) => {
    const channelId = event.channel_id
    if (!channelId) return current
    const version = event.version ?? 1

    ctx.log({
      role: 'owner',
      flow: 'verification',
      step: 'ShareVerified',
      description: `Share verified for channel ${channelId}`,
      payload: { channelId, version },
    })

    // The challenge is persisted with the vault, so an answer that lands after
    // a reload is still matched — see `Vault.pendingVerifications`.
    if (!ctx.rounds.isAwaitingVerification(channelId, version)) return current
    ctx.rounds.endVerification(channelId)

    const participant = current.participants.find(h => h.channelId === channelId)
    if (!participant) return current

    const bag = current.secretBag
    return {
      ...current,
      participants: current.participants.map(h =>
        h.id === participant.id
          ? {
              ...h,
              secretShares: h.secretShares.map(s => (s.version === version ? { ...s, verified: true } : s)),
            }
          : h,
      ),
      secretBag: bag ? updateBagVerified(bag, version, participant.id) : null,
    }
  },
} satisfies Partial<EventHandlers>

/**
 * Commit round `version` as soon as every helper it went to has answered and
 * enough confirmed, without waiting for `SharingComplete`.
 *
 * The library withholds `SharingComplete` until the round's replica leg also
 * resolves, and one replica whose tab is closed holds it back for up to the
 * round timeout — a minute in which the bag still read the old version and
 * Verify Shares stayed disabled for a publish that had, in every way that
 * matters, already succeeded. Replicas are best-effort and never decide the
 * outcome, so the helpers' answers are the whole verdict. A round below
 * threshold is left for the library to close and roll back as before.
 *
 * When `SharingComplete` does arrive, the round is no longer staged and the
 * version is no newer than the bag's, so it commits nothing a second time.
 */
function commitOnceHelpersAnswered(current: Vault, version: number, ctx: FoldContext): Vault {
  if (!ctx.rounds.helpersAnswered(version)) return current
  const confirmed = ctx.rounds.confirmedCount(version)
  if (confirmed < current.minParticipants) return current

  const staged = ctx.rounds.completeRound(version)
  if (!staged) return current
  ctx.roundResolved()
  ctx.log({
    role: 'owner',
    flow: 'sharing',
    step: 'sharing_round_helpers_done',
    description:
      `Sharing round v${version}: every helper answered and ${confirmed} confirmed — committed now. ` +
      'Any replica still being mirrored to is best-effort and does not hold the version back.',
    payload: { version, confirmed, threshold: current.minParticipants },
  })
  return { ...current, secretBag: commitRoundVersion(current.secretBag, staged.bag) }
}
