// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { SecretBag, SecretShareRef } from '../types'

/**
 * The bag versions that were actually committed — the current one and those
 * kept behind it. A version whose round was rolled back is in neither.
 */
export function committedVersionsOf(bag: SecretBag | null | undefined): Set<number> {
  if (!bag) return new Set()
  return new Set([bag.currentVersion.version, ...bag.previousVersions.map(v => v.version)])
}

/**
 * How many shares a participant actually holds: confirmed, and of a version
 * that was committed.
 *
 * Not `secretShares.length`, which also counts what was refused, never
 * answered, or confirmed for a round that was rolled back — a helper that
 * timed out on three rounds read as holding three shares. `committed` is
 * optional only for a caller that cannot say; then every confirmed share
 * counts.
 */
export function heldShareCount(
  shares: readonly SecretShareRef[],
  committed?: ReadonlySet<number>,
): number {
  return shares.filter(
    s => s.status === 'confirmed' && (committed === undefined || committed.has(s.version)),
  ).length
}
