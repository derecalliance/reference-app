// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { BagVersion, PendingProtectRound } from '../types'

/** What dispatching one verification round reported, per channel. */
export interface VerifyDispatch {
  /** Channels the challenge could not be sent on — they will never answer. */
  failedChannelIds: string[]
}

/**
 * The library's own words for "there is nothing to check this proof against".
 * Matched loosely: it reaches the app as a thrown error or a per-channel
 * `VerifySharesFailed`, wrapped differently on each path.
 */
const NO_TRACKING_SHARE = /no committed share stored|cannot verify proof/i

/** Why a version restored from a recovered bag cannot be verified, and the way out. */
export function restoredVersionReason(version: number): string {
  return (
    `v${version} was restored from a recovered bag. Restoring keeps no proof material for ` +
    'the shares the helpers hold, so this version cannot be verified. Publish a new version ' +
    '— add or remove a secret — and verify that one.'
  )
}

/** A verification failure, in words the owner can act on where the library's are not. */
export function describeVerifyFailure(error: string, version: number): string {
  return NO_TRACKING_SHARE.test(error) ? restoredVersionReason(version) : error
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
export type VerifyRowState = 'verified' | 'failed' | 'timed-out' | 'waiting'

export interface VerifyProgress {
  rows: { id: string; name: string; state: VerifyRowState }[]
  verifiedCount: number
  /** Not verified, and never going to be in this round. Never counts a verified row. */
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
 */
export function verifyProgress(input: {
  participants: readonly { id: string; name: string; channelId: string }[]
  verifiedParticipantIds: readonly string[]
  /** Channels the challenge never reached — or every channel, if none did. */
  failedChannelIds: ReadonlySet<string>
  /** The round's deadline has passed. */
  deadlinePassed: boolean
}): VerifyProgress {
  const { participants, verifiedParticipantIds, failedChannelIds, deadlinePassed } = input
  const rows = participants.map(p => {
    const state: VerifyRowState = verifiedParticipantIds.includes(p.id)
      ? 'verified'
      : failedChannelIds.has(p.channelId)
        ? 'failed'
        : deadlinePassed
          ? 'timed-out'
          : 'waiting'
    return { id: p.id, name: p.name, state }
  })
  const verifiedCount = rows.filter(r => r.state === 'verified').length
  const failedCount = rows.filter(r => r.state === 'failed' || r.state === 'timed-out').length
  const resolved = verifiedCount + failedCount
  return {
    rows,
    verifiedCount,
    failedCount,
    allDone: rows.length > 0 && resolved === rows.length,
    percent: rows.length > 0 ? Math.min(100, Math.round((resolved / rows.length) * 100)) : 0,
  }
}
