import { describe, expect, it } from 'vitest'
import { fitTransportsTo, rebalance, totalOf } from './transportMix'

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

/**
 * The pool size and its transport breakdown are configured in different places,
 * so they can disagree. The backend rejects a breakdown that does not sum to
 * the count, which makes this reconciliation load-bearing rather than cosmetic.
 */
describe('fitTransportsTo', () => {
  it('leaves a mix that already fits alone', () => {
    const mix = { http: 2, grpc: 1, both: 1 }

    expect(fitTransportsTo(mix, 4)).toEqual(mix)
  })

  it('grows http to reach the total', () => {
    expect(fitTransportsTo({ http: 1, grpc: 1, both: 0 }, 5)).toEqual({ http: 4, grpc: 1, both: 0 })
  })

  it('shrinks http first when the total falls', () => {
    expect(fitTransportsTo({ http: 6, grpc: 1, both: 0 }, 3)).toEqual({ http: 2, grpc: 1, both: 0 })
  })

  it('cuts both before grpc when the named modes alone exceed the total', () => {
    // An endpoint advertising one transport is the more conservative thing to
    // keep, so `both` gives way first.
    expect(fitTransportsTo({ http: 0, grpc: 2, both: 2 }, 3)).toEqual({ http: 0, grpc: 2, both: 1 })
  })

  it('clamps to the total when grpc alone exceeds it', () => {
    expect(fitTransportsTo({ http: 0, grpc: 9, both: 4 }, 2)).toEqual({ http: 0, grpc: 2, both: 0 })
  })

  it('always produces a mix that sums to the total', () => {
    for (const total of [0, 1, 3, 7]) {
      for (const mix of [
        { http: 0, grpc: 0, both: 0 },
        { http: 9, grpc: 9, both: 9 },
        { http: 1, grpc: 2, both: 3 },
      ]) {
        expect(totalOf(fitTransportsTo(mix, total))).toBe(total)
      }
    }
  })

  it('never returns a negative count', () => {
    const fitted = fitTransportsTo({ http: 5, grpc: 5, both: 5 }, 0)

    expect(fitted).toEqual({ http: 0, grpc: 0, both: 0 })
  })
})
