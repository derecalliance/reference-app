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
 * Set one mode's count and rebalance the others so the mix still sums to
 * `total`.
 *
 * Raising a mode takes from the largest of the other two — taking from the
 * smallest would empty it first and make the mix lopsided for no reason.
 * Lowering one gives back to `http`, the mode that needs no listener.
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
  if (drift < 0) next.http -= drift

  return next
}
