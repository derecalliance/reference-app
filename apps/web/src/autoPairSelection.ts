/**
 * Choosing which provisioned participants a device auto-pairs with on setup.
 *
 * Provisioned participants are a pool shared by every owner on the server, so
 * taking the first N — which is what a plain `slice` does — hands every browser
 * context the same few. Two owners with three pre-pairs each would both land on
 * participants 1–3, leaving the rest idle and never exercising the case this
 * app exists to test: one helper serving several owners on separate channels.
 *
 * Shuffling first spreads the load and varies the overlap between runs.
 */

import type { ParticipantConnectionStatus } from './types'

/** The fields selection reads. Narrower than `PairedParticipant` so tests can
 *  build candidates without inventing a whole roster row. */
export interface AutoPairCandidate {
  id: string
  connectionStatus: ParticipantConnectionStatus
  /** Browser-run peers drive their own pairing, so they are never auto-paired. */
  browserManaged?: boolean
}

/** Eligible = provisioned, and not already paired with *this* owner. */
function isEligible(participant: AutoPairCandidate): boolean {
  return participant.connectionStatus === 'available' && !participant.browserManaged
}

/**
 * Pick up to `count` participants to auto-pair with, chosen at random from the
 * eligible ones.
 *
 * `random` is injectable so the shuffle can be asserted rather than sampled.
 * Returns fewer than `count` when the pool is smaller, and never returns the
 * same participant twice.
 */
export function selectAutoPairTargets<T extends AutoPairCandidate>(
  participants: readonly T[],
  count: number,
  random: () => number = Math.random,
): T[] {
  const wanted = Number.isFinite(count) ? Math.floor(count) : 0
  if (wanted <= 0) return []

  const pool = participants.filter(isEligible)

  // Fisher-Yates. `Math.min` guards the index: `Math.random` never reaches 1,
  // but an injected generator can, and that would index past the end.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(random() * (i + 1)))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }

  return pool.slice(0, wanted)
}
