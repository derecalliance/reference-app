// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { VerifyFailureReason } from '@derec-alliance/web'

import type { BagVersion, PendingProtectRound } from '../types'

/** What dispatching one verification round reported, per channel. */
export interface VerifyDispatch {
  /** Channels the challenge could not be sent on — they will never answer. */
  failedChannelIds: string[]
}

/** Why a version restored from a recovered bag cannot be verified, and the way out. */
export function restoredVersionReason(version: number): string {
  return (
    `v${version} was restored from a recovered bag. Restoring keeps no proof material for ` +
    'the shares the helpers hold, so this version cannot be verified. Publish a new version ' +
    '— add or remove a secret — and verify that one.'
  )
}

/**
 * Why a version whose verification copies are gone cannot be verified. The
 * library deletes this device's copies of a version it tells helpers to drop
 * (SDK 0.0.9), and Clean up deletes them by hand or automatically.
 */
export function deletedCopiesReason(version: number): string {
  return (
    `This device holds no verification copies for v${version}: they were deleted, either when helpers ` +
    'were told to stop keeping it or by Clean up. Recovery is not affected; verify a newer version.'
  )
}

/**
 * A channel's `VerifySharesFailed`, in words the owner can act on where the
 * library's are not. `NoProof` means this device holds nothing to check the
 * helper's answer against: a version restored from a recovered bag never had
 * copies here, and any other version had them deleted.
 */
export function describeVerifyFailure(
  failure: { reason: VerifyFailureReason; error: string },
  version: Pick<BagVersion, 'version' | 'restoredFromRecovery'>,
): string {
  if (failure.reason !== 'NoProof') return failure.error
  return version.restoredFromRecovery ? restoredVersionReason(version.version) : deletedCopiesReason(version.version)
}

/**
 * Why Verify Shares is unavailable for `version` right now, or `null` when it
 * is available.
 *
 * Verification while a publish is open challenges a version the round is
 * about to supersede, and a restored version has nothing to check proofs
 * against — both used to leave the dialog waiting forever.
 */
export function verifyBlockedReason(
  version: BagVersion,
  pendingRounds: readonly PendingProtectRound[],
): string | null {
  if (version.restoredFromRecovery) return restoredVersionReason(version.version)
  const open = pendingRounds[pendingRounds.length - 1]
  if (open) {
    return `Publishing v${open.version} is still in progress — verify once it completes.`
  }
  return null
}

/** Where one participant stands in a verification round. */
export type VerifyRowState = 'verified' | 'rejected' | 'invalid' | 'failed' | 'timed-out' | 'waiting'

export interface VerifyRow {
  id: string
  name: string
  state: VerifyRowState
  /** The helper's own words for a refusal — its memo, or its status code. */
  detail: string | null
}

export interface VerifyProgress {
  rows: VerifyRow[]
  verifiedCount: number
  /** Refused by the helper itself (`ShareVerifyRejected`). */
  rejectedCount: number
  /** Answered with a proof that does not match (`ShareVerifyInvalid`). */
  invalidCount: number
  /**
   * Not verified, never answered and never going to be in this round — not
   * sent, or timed out. Never counts a verified, rejected or invalid row.
   */
  failedCount: number
  allDone: boolean
  /** Share of rows resolved, 0–100. */
  percent: number
}

/**
 * Read a verification round's progress.
 *
 * A pure function of what is known *now*, so nothing can close over a stale
 * list: the old modal decided who timed out from the verified ids it captured
 * when the round began — none — and so marked everyone timed out, verified or
 * not, which read "3 of 4 verified · 4 failed" with the bar at 175%.
 *
 * A refusal is an answer: the row resolves to "Rejected" and counts as done,
 * rather than spinning until the deadline as it did before SDK 0.0.7 reported
 * one.
 */
export function verifyProgress(input: {
  participants: readonly { id: string; name: string; channelId: string }[]
  verifiedParticipantIds: readonly string[]
  /** This version's refusals — see `BagVersion.verifyRejections`. */
  rejections?: readonly { id: string; status: number; memo: string }[]
  /** This version's invalid proofs — see `BagVersion.invalidProofParticipantIds`. */
  invalidProofParticipantIds?: readonly string[]
  /** Channels the challenge never reached — or every channel, if none did. */
  failedChannelIds: ReadonlySet<string>
  /** The round's deadline has passed. */
  deadlinePassed: boolean
}): VerifyProgress {
  const { participants, verifiedParticipantIds, failedChannelIds, deadlinePassed } = input
  const rejections = new Map((input.rejections ?? []).map(r => [r.id, r]))
  const invalidProof = new Set(input.invalidProofParticipantIds ?? [])
  const rows = participants.map((p): VerifyRow => {
    const rejection = rejections.get(p.id)
    const state: VerifyRowState = verifiedParticipantIds.includes(p.id)
      ? 'verified'
      : rejection
        ? 'rejected'
        : invalidProof.has(p.id)
          ? 'invalid'
          : failedChannelIds.has(p.channelId)
            ? 'failed'
            : deadlinePassed
              ? 'timed-out'
              : 'waiting'
    const detail =
      state === 'rejected' && rejection ? rejection.memo || `status ${rejection.status}` : null
    return { id: p.id, name: p.name, state, detail }
  })
  const verifiedCount = rows.filter(r => r.state === 'verified').length
  const rejectedCount = rows.filter(r => r.state === 'rejected').length
  const invalidCount = rows.filter(r => r.state === 'invalid').length
  const failedCount = rows.filter(r => r.state === 'failed' || r.state === 'timed-out').length
  const resolved = verifiedCount + rejectedCount + invalidCount + failedCount
  return {
    rows,
    verifiedCount,
    rejectedCount,
    invalidCount,
    failedCount,
    allDone: rows.length > 0 && resolved === rows.length,
    percent: rows.length > 0 ? Math.min(100, Math.round((resolved / rows.length) * 100)) : 0,
  }
}
