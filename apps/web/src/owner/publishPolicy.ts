// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { Secret } from '../types'
import { DEFAULT_WEIGHT } from './weights'

/**
 * The owner's standing choices for publishing (SDK 0.0.9 made each of these an
 * application decision). Per device: a replica group shares weights and the
 * threshold through the roster, but not these preferences.
 */

/** How many verification copies "keep only the N newest" starts from. */
export const DEFAULT_RETAINED_VERSIONS = 3

/**
 * How the threshold is set: as a percentage of the subshares the helpers hold
 * between them, worked out at each publish from who is paired, or as a fixed
 * number.
 */
export type ThresholdMode = 'percent' | 'fixed'

/** A threshold as the owner sets it on the Channels tab. */
export type ThresholdSetting = { mode: 'percent'; percent: number } | { mode: 'fixed'; value: number }

/** The percentage a new secret's threshold starts at. */
export const DEFAULT_THRESHOLD_PERCENT = 50

/**
 * Which earlier version helpers are told to keep (the protocol's
 * `keepVersion`, SDK 0.0.10): a helper holds at most that one and the version
 * being shared.
 */
export type HelperRetention =
  /** The newest committed version. */
  | { mode: 'latestCommitted' }
  /** The owner picks the version at each publish. */
  | { mode: 'select' }

/** When this device deletes its old verification copies. */
export type ProofCleanup =
  /** Never automatically; the owner cleans up from the Verification Copies tab. */
  | { mode: 'manual' }
  /** After each version: keep only the versions helpers were told to keep. */
  | { mode: 'auto'; criterion: 'retention' }
  /** After each version: keep only the N newest. */
  | { mode: 'auto'; criterion: 'lastN'; n: number }

export interface PublishPolicy {
  /**
   * Whether the threshold is a percentage (`thresholdPercent`) or a fixed
   * number (`defaultThreshold`) — see `sharingThreshold`. Absent means fixed:
   * secrets saved before percentages existed keep the number they had.
   */
  thresholdMode?: ThresholdMode
  /**
   * The percentage of the helpers' subshares needed to recover, when
   * `thresholdMode` is `percent`. Kept while the mode is fixed, so switching
   * back restores it; absent means `DEFAULT_THRESHOLD_PERCENT`.
   */
  thresholdPercent?: number
  /**
   * The fixed threshold, used when `thresholdMode` is `fixed`; set on the
   * Channels tab. (Named for when a publish dialog could override it.)
   */
  defaultThreshold: number
  /**
   * Each helper's weight for every publish, by channel id, set on the
   * Channels tab; absent falls back to the weight the library last published.
   */
  defaultWeights: Record<string, number>
  helperRetention: HelperRetention
  proofCleanup: ProofCleanup
}

/**
 * The secret's policy, or today's behaviour for a secret saved before it existed.
 *
 * A policy saved before SDK 0.0.10 may say "keep the last N versions"
 * (`{ mode: 'lastN', n }`), which a single `keepVersion` cannot express; it
 * reads as "keep the newest committed version", the closest rule left.
 */
export function resolvePublishPolicy(secret: Pick<Secret, 'publishPolicy' | 'minParticipants'>): PublishPolicy {
  const policy = secret.publishPolicy
  if (!policy) {
    return {
      defaultThreshold: secret.minParticipants,
      defaultWeights: {},
      helperRetention: { mode: 'latestCommitted' },
      proofCleanup: { mode: 'manual' },
    }
  }
  return policy.helperRetention.mode === 'select'
    ? policy
    : { ...policy, helperRetention: { mode: 'latestCommitted' } }
}

/**
 * The secret's policy once it joins a group whose roster carries `threshold`
 * (a restore or a replica adoption): publish dialogs start from the threshold
 * the library will reuse. `undefined` — keep the secret's own — when the roster
 * carries none.
 */
export function withGroupThreshold(
  secret: Pick<Secret, 'publishPolicy' | 'minParticipants'>,
  threshold: number | undefined,
): PublishPolicy | undefined {
  if (threshold === undefined) return secret.publishPolicy
  // The group's number, as it is: a percentage would turn into a different
  // one as soon as this device's helpers differ from the publisher's.
  return { ...resolvePublishPolicy(secret), thresholdMode: 'fixed', defaultThreshold: threshold }
}

/**
 * The policy a secret set up from scratch starts with: the threshold at
 * `DEFAULT_THRESHOLD_PERCENT` of the subshares, and `fixedThreshold` (the
 * node's starting threshold) ready should the owner switch to a fixed number.
 */
export function newSecretPublishPolicy(fixedThreshold: number): PublishPolicy {
  return {
    thresholdMode: 'percent',
    thresholdPercent: DEFAULT_THRESHOLD_PERCENT,
    defaultThreshold: fixedThreshold,
    defaultWeights: {},
    helperRetention: { mode: 'latestCommitted' },
    proofCleanup: { mode: 'manual' },
  }
}

/** `policy`'s threshold mode, fixed when it predates the choice. */
export function thresholdModeOf(policy: PublishPolicy): ThresholdMode {
  return policy.thresholdMode ?? 'fixed'
}

/** `policy`'s threshold percentage, whether or not it is in force. */
export function thresholdPercentOf(policy: PublishPolicy): number {
  return policy.thresholdPercent ?? DEFAULT_THRESHOLD_PERCENT
}

/**
 * A helper's default weight under `policy`: the one the owner set, or else the
 * weight the library last published for it (`lastPublished`, 1 when unknown).
 *
 * Falling back to the last published weight matters after a restore, a join
 * or on a secret saved before defaults existed: the library holds the roster's
 * weights, the secret has set none, and pre-filling 1 would make the next
 * publish reset every helper.
 */
export function defaultWeightFor(policy: PublishPolicy, channelId: string, lastPublished = DEFAULT_WEIGHT): number {
  return policy.defaultWeights[channelId] ?? lastPublished
}

/** What is wrong with `policy`, by field; empty when it is valid. */
export function publishPolicyProblems(
  policy: PublishPolicy,
): Partial<Record<'cleanupN', string>> {
  const problems: Partial<Record<'cleanupN', string>> = {}
  if (policy.proofCleanup.mode === 'auto' && policy.proofCleanup.criterion === 'lastN' && !atLeastOne(policy.proofCleanup.n)) {
    problems.cleanupN = 'Keep at least 1 version'
  }
  return problems
}

function atLeastOne(n: number): boolean {
  return Number.isInteger(n) && n >= 1
}
