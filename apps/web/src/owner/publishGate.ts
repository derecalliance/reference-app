// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { PairedParticipant } from '../types'
import type { PublishPolicy } from './publishPolicy'
import { sharingProblems, sharingProblemSummary } from './sharingSettings'

/**
 * The fewest helpers any publish can use: the threshold is at least 2 and no
 * helper may reach it alone, so two helpers of weight 1 at threshold 2 is the
 * smallest valid round.
 */
export const MIN_PUBLISH_TARGETS = 2

export interface PublishReadiness {
  /** Why no publish could succeed with these helpers and settings, or `null`. */
  blocked: string | null
}

/**
 * Whether the helpers that would receive a share (`targets`) can carry a
 * publish under the secret's threshold and weights. Publish dialogs cannot
 * change either any more — they are set on the Channels tab — so anything
 * wrong with them blocks every publish until it is fixed there.
 */
export function publishReadiness(targets: readonly PairedParticipant[], policy: PublishPolicy): PublishReadiness {
  const count = targets.length
  if (count < MIN_PUBLISH_TARGETS) {
    return { blocked: `Need at least ${MIN_PUBLISH_TARGETS} paired participants (currently ${count})` }
  }
  return { blocked: sharingProblemSummary(sharingProblems(targets, policy)) }
}
