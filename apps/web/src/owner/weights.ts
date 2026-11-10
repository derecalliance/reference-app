// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { PairedParticipant } from '../types'

/**
 * Weighted helpers (SDK 0.0.9).
 *
 * A helper's weight is how many Shamir subshares it receives; the threshold
 * counts subshares, not helpers. Every helper weighs 1 unless a protect round
 * gave it more, and the library keeps the last weights it was given on each
 * helper's channel record. No single helper may reach the threshold alone, so
 * a weight is always below it.
 */

/** The weight of a helper nobody weighted. */
export const DEFAULT_WEIGHT = 1

/** A participant's weight: what the library last reported for it, or 1. */
export function participantWeight(participant: Pick<PairedParticipant, 'weight'>): number {
  const weight = participant.weight
  return weight !== undefined && Number.isInteger(weight) && weight >= DEFAULT_WEIGHT ? weight : DEFAULT_WEIGHT
}

/** The highest weight a helper may have under `threshold`. */
export function maxWeight(threshold: number): number {
  return Math.max(DEFAULT_WEIGHT, threshold - 1)
}

/**
 * Why `weight` is not a valid weight under `threshold`, or `null` if it is.
 * The library's own rule, checked here so the form can say it before a round
 * is attempted: `1 <= weight < threshold`.
 */
export function weightProblem(weight: number, threshold: number): string | null {
  if (!Number.isInteger(weight)) return 'Must be a whole number'
  if (weight < DEFAULT_WEIGHT) return `Must be at least ${DEFAULT_WEIGHT}`
  if (weight >= threshold) {
    return `Must be below the threshold (${threshold}), so no helper can recover alone`
  }
  return null
}
