import { describe, expect, it } from 'vitest'
import { rebalance, totalOf } from './transportMix'

describe('rebalance', () => {
  const total = 3

  it('keeps the mix summing to the participant count', () => {
    const mix = rebalance({ http: 3, grpc: 0, both: 0 }, 'grpc', 1, total)

    expect(totalOf(mix)).toBe(total)
    expect(mix.grpc).toBe(1)
  })

  it('takes from the largest other mode', () => {
    // Taking from the smallest would empty it first and skew the mix.
    const mix = rebalance({ http: 2, grpc: 1, both: 0 }, 'both', 1, total)

    expect(mix).toEqual({ http: 1, grpc: 1, both: 1 })
  })

  it('gives back to http when a mode is lowered', () => {
    const mix = rebalance({ http: 1, grpc: 1, both: 1 }, 'grpc', 0, total)

    expect(mix).toEqual({ http: 2, grpc: 0, both: 1 })
  })

  it('clamps a value beyond the total', () => {
    const mix = rebalance({ http: 3, grpc: 0, both: 0 }, 'grpc', 99, total)

    expect(mix).toEqual({ http: 0, grpc: 3, both: 0 })
  })

  it('never produces a negative count', () => {
    const mix = rebalance({ http: 0, grpc: 3, both: 0 }, 'http', -5, total)

    expect(mix.http).toBeGreaterThanOrEqual(0)
    expect(totalOf(mix)).toBe(total)
  })
})
