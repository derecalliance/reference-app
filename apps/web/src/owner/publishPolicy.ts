// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { Vault } from '../types'
import { DEFAULT_WEIGHT } from './weights'

/**
 * The owner's standing choices for publishing (SDK 0.0.9 made each of these an
 * application decision). Per device: a replica group shares weights and the
 * threshold through the roster, but not these preferences.
 */

/** How many committed versions helpers keep, unless the owner picks per publish. */
export const DEFAULT_RETAINED_VERSIONS = 3

/** Which versions helpers are told to keep (the protocol's `keepList`). */
export type HelperRetention =
  /** The N newest committed versions, plus any round still open. */
  | { mode: 'lastN'; n: number }
  /** No standing rule: the owner picks the versions at each publish. */
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
  /** The threshold a publish dialog starts from. */
  defaultThreshold: number
  /** Each helper's default weight, by channel id; absent is 1. */
  defaultWeights: Record<string, number>
  helperRetention: HelperRetention
  proofCleanup: ProofCleanup
}

/** The vault's policy, or today's behaviour for a vault saved before it existed. */
export function resolvePublishPolicy(vault: Pick<Vault, 'publishPolicy' | 'minParticipants'>): PublishPolicy {
  return (
    vault.publishPolicy ?? {
      defaultThreshold: vault.minParticipants,
      defaultWeights: {},
      helperRetention: { mode: 'lastN', n: DEFAULT_RETAINED_VERSIONS },
      proofCleanup: { mode: 'manual' },
    }
  )
}

/**
 * The vault's policy once it joins a group whose roster carries `threshold`
 * (a restore or a replica adoption): publish dialogs start from the threshold
 * the library will reuse. `undefined` — keep the vault's own — when the roster
 * carries none.
 */
export function withGroupThreshold(
  vault: Pick<Vault, 'publishPolicy' | 'minParticipants'>,
  threshold: number | undefined,
): PublishPolicy | undefined {
  if (threshold === undefined) return vault.publishPolicy
  return { ...resolvePublishPolicy(vault), defaultThreshold: threshold }
}

/**
 * A helper's default weight under `policy`: the one the owner set, or else the
 * weight the library last published for it (`lastPublished`, 1 when unknown).
 *
 * Falling back to the last published weight matters after a restore, a join
 * or on a vault saved before defaults existed: the library holds the roster's
 * weights, the vault has set none, and pre-filling 1 would make the next
 * publish reset every helper.
 */
export function defaultWeightFor(policy: PublishPolicy, channelId: string, lastPublished = DEFAULT_WEIGHT): number {
  return policy.defaultWeights[channelId] ?? lastPublished
}

/** What is wrong with `policy`, by field; empty when it is valid. */
export function publishPolicyProblems(
  policy: PublishPolicy,
): Partial<Record<'defaultThreshold' | 'retentionN' | 'cleanupN', string>> {
  const problems: Partial<Record<'defaultThreshold' | 'retentionN' | 'cleanupN', string>> = {}
  if (!Number.isInteger(policy.defaultThreshold) || policy.defaultThreshold < 2) {
    problems.defaultThreshold = 'Must be a whole number, at least 2 — one helper must never recover alone'
  }
  if (policy.helperRetention.mode === 'lastN' && !atLeastOne(policy.helperRetention.n)) {
    problems.retentionN = 'Keep at least 1 version'
  }
  if (policy.proofCleanup.mode === 'auto' && policy.proofCleanup.criterion === 'lastN' && !atLeastOne(policy.proofCleanup.n)) {
    problems.cleanupN = 'Keep at least 1 version'
  }
  return problems
}

function atLeastOne(n: number): boolean {
  return Number.isInteger(n) && n >= 1
}
