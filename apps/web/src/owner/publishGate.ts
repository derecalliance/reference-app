// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { PairedParticipant } from '../types'
import { totalWeight } from './weights'

/**
 * The fewest helpers any publish can use: the threshold is at least 2 and no
 * helper may reach it alone, so two helpers of weight 1 at threshold 2 is the
 * smallest valid round.
 */
export const MIN_PUBLISH_TARGETS = 2

export interface PublishReadiness {
  /** Why no publish could succeed with these helpers, or `null`. */
  blocked: string | null
  /**
   * Why the vault's defaults would not, though a publish dialog could
   * (by lowering the threshold or raising weights), or `null`.
   */
  shortOfDefault: string | null
}

/**
 * Whether the helpers that would receive a share (`targets`) can carry a
 * publish. Only what the publish dialog cannot fix blocks it; a shortfall
 * against the default threshold is a warning, since the dialog lets the owner
 * change both the threshold and the weights.
 */
export function publishReadiness(
  targets: readonly Pick<PairedParticipant, 'weight'>[],
  defaultThreshold: number,
): PublishReadiness {
  const count = targets.length
  const blocked =
    count < MIN_PUBLISH_TARGETS
      ? `Need at least ${MIN_PUBLISH_TARGETS} paired participants (currently ${count})`
      : null
  const weight = totalWeight(targets)
  const shortOfDefault =
    blocked === null && weight < defaultThreshold
      ? `Paired participants hold ${weight} of the ${defaultThreshold} subshares the default threshold needs — lower the threshold or raise weights when you publish.`
      : null
  return { blocked, shortOfDefault }
}
