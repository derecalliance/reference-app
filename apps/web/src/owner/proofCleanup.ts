// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { ProofVersionUsage } from '../stores'

/**
 * Which of an owner's verification copies to delete (SDK 0.0.9 leaves this to
 * the application on a replica, and lets it go further on the publishing
 * device). Deleting a copy never affects recovery; that version just can no
 * longer be verified from this device.
 */
export type CleanupCriterion =
  /** Keep only the versions the latest round told helpers to keep; `null` keep-list keeps all. */
  | { kind: 'retention'; keep: readonly number[] | null }
  /** Keep only the N newest versions. */
  | { kind: 'lastN'; n: number }

/** What must survive whatever the criterion says. */
export interface CleanupFloor {
  /** The latest committed version: its copies are what verifies the current secret. */
  latest: number
  /** Versions still being published: a copy there is part of an open round. */
  open: readonly number[]
}

/** The versions whose copies `criterion` would delete, newest first. */
export function cleanupCandidates(
  usage: readonly ProofVersionUsage[],
  floor: CleanupFloor,
  criterion: CleanupCriterion,
): number[] {
  const versions = usage.map(u => u.version).sort((a, b) => b - a)
  let kept: Set<number>
  if (criterion.kind === 'retention') {
    if (criterion.keep === null) return []
    kept = new Set(criterion.keep)
  } else {
    kept = new Set(versions.slice(0, criterion.n))
  }
  kept.add(floor.latest)
  for (const v of floor.open) kept.add(v)
  return versions.filter(v => !kept.has(v))
}
