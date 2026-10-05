// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/** How many helpers of each transport mode the pool should hold. */
export interface TransportMix {
  http: number
  grpc: number
  both: number
}

export type TransportModeKey = keyof TransportMix

export function totalOf(mix: TransportMix): number {
  return mix.http + mix.grpc + mix.both
}

/**
 * Make a mix sum to `total`, keeping the modes that were chosen deliberately.
 *
 * The pool size and its transport breakdown are configured separately — the
 * count can be overridden in Settings while the breakdown still carries the
 * node's own numbers — and the backend rejects a breakdown that does not sum to
 * the count ("transports must sum to total"). Something has to reconcile them,
 * and doing it here means every caller that provisions gets the same answer.
 *
 * `grpc` and `both` are preserved where they fit: those are the deliberate
 * choices, and `http` is the mode that needs no listener, so it absorbs the
 * difference. Only when the two named modes exceed the total are they cut down,
 * `both` first, since an endpoint advertising a single transport is the more
 * conservative thing to keep.
 */
export function fitTransportsTo(mix: TransportMix, total: number): TransportMix {
  const capped = Math.max(0, total)
  const grpc = Math.min(Math.max(0, mix.grpc), capped)
  const both = Math.min(Math.max(0, mix.both), capped - grpc)
  return { http: capped - grpc - both, grpc, both }
}

/**
 * Set one mode's count and rebalance the others so the mix still sums to
 * `total`.
 *
 * The edited mode always keeps the value typed. Raising it takes from the
 * largest of the other two — taking from the smallest would empty it first and
 * make the mix lopsided for no reason. Lowering it gives back to `http`, the
 * mode that needs no listener — unless `http` is the mode being lowered, in
 * which case it goes to `grpc`: handing the difference straight back to the
 * field just edited silently reverted every attempt to lower "HTTP only".
 */
export function rebalance(
  mix: TransportMix,
  mode: TransportModeKey,
  value: number,
  total: number,
): TransportMix {
  const next: TransportMix = { ...mix, [mode]: Math.max(0, Math.min(total, value)) }
  const others = (['http', 'grpc', 'both'] as TransportModeKey[]).filter(k => k !== mode)

  let drift = totalOf(next) - total
  while (drift > 0) {
    const donor = others.reduce((a, b) => (next[a] >= next[b] ? a : b))
    if (next[donor] === 0) break
    next[donor] -= 1
    drift -= 1
  }
  if (drift < 0) next[mode === 'http' ? 'grpc' : 'http'] -= drift

  return next
}
