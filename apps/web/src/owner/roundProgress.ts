// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { PairedParticipant } from '../types'
import { shareFailureKind, type ShareFailureKind } from './shareFailure'

/** Where one participant stands in a protect round. */
export type ParticipantOutcome = 'waiting' | 'confirmed' | ShareFailureKind

/** One participant's answer to a protect round. */
interface ParticipantProgress {
  id: string
  name: string
  outcome: ParticipantOutcome
}

/** Where a protect round stands, as read from the participants' share records. */
export interface RoundProgress {
  rows: ParticipantProgress[]
  confirmedCount: number
  /** Participants that will not hold this version: refused, silent, or unreachable. */
  failedCount: number
  /** Every participant has confirmed or failed. */
  allResolved: boolean
}

/**
 * Read a round's progress for `participantIds` at `version`.
 *
 * Keyed by the version the library assigned, never a guessed `bag.version + 1`:
 * pair-completion auto-publish also advances it, so a guess files every
 * `ShareConfirmed` against a round nobody is watching.
 */
export function roundProgress(
  participants: readonly PairedParticipant[],
  participantIds: readonly string[],
  version: number,
): RoundProgress {
  const rows = participantIds.map((id): ParticipantProgress => {
    const participant = participants.find(h => h.id === id)
    const share = participant?.secretShares.find(s => s.version === version)
    const outcome: ParticipantOutcome =
      share?.status === 'confirmed' ? 'confirmed' : shareFailureKind(share) ?? 'waiting'
    return { id, name: participant?.name ?? id, outcome }
  })
  const confirmedCount = rows.filter(r => r.outcome === 'confirmed').length
  const waitingCount = rows.filter(r => r.outcome === 'waiting').length
  return {
    rows,
    confirmedCount,
    failedCount: rows.length - confirmedCount - waitingCount,
    allResolved: waitingCount === 0,
  }
}
