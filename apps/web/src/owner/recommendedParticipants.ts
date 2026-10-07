// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * How many paired participants to recommend, given how many this vault could
 * pair with at all.
 *
 * The configured recommendation is a node-wide number (default 5) and a pool
 * can be smaller: with three helpers on the node, "Only 2 of 5 recommended
 * participants paired" stayed on screen for good, asking for something no
 * owner on that node could do. So it is capped at the pool — but never below
 * the minimum, which is a hard requirement rather than advice and has its own
 * banner when it cannot be met.
 */
export function effectiveRecommended(
  recommended: number,
  minimum: number,
  poolSize: number,
): number {
  return Math.max(minimum, Math.min(recommended, poolSize))
}
