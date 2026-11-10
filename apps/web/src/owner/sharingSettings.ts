// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { PairedParticipant } from '../types'
import { defaultWeightFor, thresholdModeOf, thresholdPercentOf, type PublishPolicy } from './publishPolicy'
import { DEFAULT_WEIGHT, participantWeight, weightProblem } from './weights'

/**
 * The threshold and helper weights every publish uses, set on the Channels
 * tab. Publish dialogs no longer change them: a publish takes them as they are,
 * so they are checked here — the rules the SDK enforces — before any round is
 * attempted.
 */

/** The lowest threshold there is: one helper must never recover alone. */
export const MIN_THRESHOLD = 2

/**
 * The highest weight the Channels tab offers under a percentage threshold,
 * which otherwise sets no ceiling: it rises to stay above any weight.
 */
export const MAX_OFFERED_WEIGHT = 100

/** What is wrong with the secret's threshold and weights for `helpers`. */
export interface SharingProblems {
  threshold?: string
  /** By channel id. */
  weights: Record<string, string>
  /** The weights together fall short of the threshold. */
  total?: string
}

/** Each helper's weight for the next publish, by channel id. */
export function sharingWeights(
  helpers: readonly PairedParticipant[],
  policy: PublishPolicy,
): Map<string, number> {
  return new Map(helpers.map(h => [h.channelId, defaultWeightFor(policy, h.channelId, participantWeight(h))]))
}

/** The subshares `helpers` hold between them under `policy`. */
export function sharingTotal(helpers: readonly PairedParticipant[], policy: PublishPolicy): number {
  return [...sharingWeights(helpers, policy).values()].reduce((sum, w) => sum + w, 0)
}

/**
 * `percent` of `totalSubshares`, rounded up, and never below `MIN_THRESHOLD`.
 * Whole-number arithmetic, so 60% of 5 is exactly 3.
 */
export function thresholdFromPercent(percent: number, totalSubshares: number): number {
  return Math.max(MIN_THRESHOLD, Math.floor((percent * totalSubshares + 99) / 100))
}

/**
 * The threshold a publish uses when the helpers hold `weights`: the fixed
 * number, or — as a percentage — *at least* that share of their subshares,
 * raised when needed to one more than the heaviest helper, so no helper can
 * ever recover alone.
 */
export function thresholdFor(policy: PublishPolicy, weights: readonly number[]): number {
  if (thresholdModeOf(policy) === 'fixed') return policy.defaultThreshold
  const total = weights.reduce((sum, w) => sum + w, 0)
  const heaviest = weights.reduce((max, w) => Math.max(max, w), 0)
  return Math.max(thresholdFromPercent(thresholdPercentOf(policy), total), heaviest + 1)
}

/** The threshold the next publish to `helpers` uses under `policy`. */
export function sharingThreshold(helpers: readonly PairedParticipant[], policy: PublishPolicy): number {
  return thresholdFor(policy, [...sharingWeights(helpers, policy).values()])
}

/** How the threshold for `helpers` came about — what the owner is shown. */
export interface ThresholdOutcome {
  threshold: number
  /** The percentage in force, or `null` for a fixed threshold. */
  percent: number | null
  /**
   * Why the threshold is above what the percentage alone gives — the heaviest
   * helper would otherwise recover alone — or `null` when it is not.
   */
  raised: { byPercent: number; helper: string; weight: number } | null
}

export function thresholdOutcome(helpers: readonly PairedParticipant[], policy: PublishPolicy): ThresholdOutcome {
  const threshold = sharingThreshold(helpers, policy)
  if (thresholdModeOf(policy) === 'fixed') return { threshold, percent: null, raised: null }
  const percent = thresholdPercentOf(policy)
  const weights = sharingWeights(helpers, policy)
  const byPercent = thresholdFromPercent(percent, sharingTotal(helpers, policy))
  if (threshold === byPercent) return { threshold, percent, raised: null }
  const heaviest = helpers.reduce<PairedParticipant | null>(
    (top, h) => (top === null || (weights.get(h.channelId) ?? 0) > (weights.get(top.channelId) ?? 0) ? h : top),
    null,
  )
  return {
    threshold,
    percent,
    raised: heaviest && { byPercent, helper: heaviest.name, weight: weights.get(heaviest.channelId) ?? DEFAULT_WEIGHT },
  }
}

/** The tooltip for a raised threshold, or `null` when it was not raised. */
export function thresholdRaisedText(outcome: ThresholdOutcome, totalSubshares: number): string | null {
  const { raised, percent, threshold } = outcome
  if (!raised || percent === null) return null
  return (
    `${percent}% of ${totalSubshares} subshares would be ${raised.byPercent}, but ${raised.helper} holds ` +
    `${raised.weight} and could then recover alone. The threshold is raised to ${threshold}, one more than ` +
    `the heaviest helper: at least ${percent}%, never letting one helper recover alone.`
  )
}

/**
 * The highest weight `channelId` may have under `policy`, the other helpers'
 * weights as they are. A fixed threshold caps it just below the threshold. A
 * percentage rises with the heaviest weight, so any weight goes as long as
 * someone else holds a subshare too — the threshold can never exceed what
 * the helpers hold between them otherwise.
 */
export function maxWeightFor(
  helpers: readonly PairedParticipant[],
  policy: PublishPolicy,
  channelId: string,
): number {
  if (thresholdModeOf(policy) === 'fixed') return Math.max(DEFAULT_WEIGHT, policy.defaultThreshold - 1)
  const othersHoldSome = [...sharingWeights(helpers, policy)].some(([id, w]) => id !== channelId && w > 0)
  return othersHoldSome ? MAX_OFFERED_WEIGHT : DEFAULT_WEIGHT
}

/** What is wrong with `policy`'s threshold and weights for `helpers`; no field set when nothing is. */
export function sharingProblems(helpers: readonly PairedParticipant[], policy: PublishPolicy): SharingProblems {
  const problems: SharingProblems = { weights: {} }
  const thresholdProblem = thresholdSettingProblem(policy)
  if (thresholdProblem) {
    problems.threshold = thresholdProblem
    return problems
  }
  const threshold = sharingThreshold(helpers, policy)
  for (const [channelId, weight] of sharingWeights(helpers, policy)) {
    const problem = weightProblem(weight, threshold)
    if (problem) problems.weights[channelId] = problem
  }
  const total = sharingTotal(helpers, policy)
  if (Object.keys(problems.weights).length === 0 && helpers.length > 0 && total < threshold) {
    problems.total = `The helpers hold ${total} subshares between them, below the threshold of ${threshold}: no version could be published.`
  }
  return problems
}

/** Why `policy`'s threshold setting itself is invalid, or `null`. */
export function thresholdSettingProblem(policy: PublishPolicy): string | null {
  if (thresholdModeOf(policy) === 'percent') {
    const percent = thresholdPercentOf(policy)
    return isThresholdPercent(percent) ? null : 'Must be a whole percentage from 1 to 100'
  }
  return isFixedThreshold(policy.defaultThreshold)
    ? null
    : `Must be a whole number, at least ${MIN_THRESHOLD} — one helper must never recover alone`
}

/** Whether `value` can be a fixed threshold. */
export function isFixedThreshold(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_THRESHOLD
}

/** Whether `value` can be a threshold percentage. */
export function isThresholdPercent(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 100
}

/** Whether `problems` lets a publish go ahead. */
export function hasNoSharingProblems(problems: SharingProblems): boolean {
  return problems.threshold === undefined && problems.total === undefined && Object.keys(problems.weights).length === 0
}

/** One sentence for a disabled control or banner, or `null` when nothing is wrong. */
export function sharingProblemSummary(problems: SharingProblems): string | null {
  if (problems.threshold) return `Threshold: ${problems.threshold}. Fix it on the Channels tab`
  if (problems.total) return `${problems.total} Change the threshold or weights on the Channels tab`
  const weights = Object.keys(problems.weights).length
  if (weights > 0) {
    return `${weights} helper weight${weights === 1 ? ' is' : 's are'} not valid under the threshold. Fix ${weights === 1 ? 'it' : 'them'} on the Channels tab`
  }
  return null
}
