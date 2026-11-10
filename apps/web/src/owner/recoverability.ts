// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { BagVersion } from '../types'

/** Whether a version can be rebuilt from the helpers that proved they hold it. */
export interface Recoverability {
  /**
   * `recoverable`: the verified helpers hold at least the threshold between
   * them. `short`: they do not — other helpers may still. `unknown`: a count
   * or the threshold was not recorded (a version published before SDK 0.0.9
   * recorded them), so the sum would be a guess.
   */
  kind: 'recoverable' | 'short' | 'unknown'
  /** Subshares the verified helpers hold, counting only recorded ones. */
  verified: number
  threshold: number | null
}

/**
 * Judge `version`'s recoverability from its verification answers, as the SDK
 * defines it: sum `ShareVerified.subshares` over the verified helpers and
 * compare with `ShareVerified.threshold`. `null` before any helper verified.
 */
export function recoverability(version: BagVersion): Recoverability | null {
  if (version.verifiedParticipantIds.length === 0) return null
  const counts = version.verifiedParticipantIds.map(id => version.verifiedSubshares?.[id] ?? null)
  const verified = counts.reduce<number>((sum, n) => sum + (n ?? 0), 0)
  const threshold = version.verifiedThreshold ?? null
  if (threshold === null || counts.some(n => n === null)) return { kind: 'unknown', verified, threshold }
  return { kind: verified >= threshold ? 'recoverable' : 'short', verified, threshold }
}
