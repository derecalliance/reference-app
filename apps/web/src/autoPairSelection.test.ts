import { describe, expect, it } from 'vitest'
import { selectAutoPairTargets, type AutoPairCandidate } from './autoPairSelection'

function pool(size: number, overrides: Partial<AutoPairCandidate> = {}): AutoPairCandidate[] {
  return Array.from({ length: size }, (_, i) => ({
    id: `p${i}`,
    connectionStatus: 'available' as const,
    ...overrides,
  }))
}

const ids = (picked: AutoPairCandidate[]) => picked.map(p => p.id)

/** Always returns 0, so Fisher-Yates makes the most-reversing swap it can. */
const alwaysZero = () => 0

/** Seeded PRNG, so distribution assertions are exact instead of flaky. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let x = Math.imul(t ^ (t >>> 15), 1 | t)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

describe('selectAutoPairTargets', () => {
  // ── The behaviour this exists for ──────────────────────────────────────────

  it('does not always pick the first participants', () => {
    // The defect: a plain `slice(0, n)` over a pool shared by every owner hands
    // each browser context the same few and leaves the rest idle. Sampled over
    // many draws, every participant should eventually be picked.
    const seen = new Set<string>()
    for (let run = 0; run < 200; run++) {
      for (const p of selectAutoPairTargets(pool(7), 3)) seen.add(p.id)
    }

    expect(seen.size).toBe(7)
  })

  it('does not always produce the same selection', () => {
    const selections = new Set<string>()
    for (let run = 0; run < 200; run++) {
      selections.add(ids(selectAutoPairTargets(pool(7), 3)).sort().join(','))
    }

    expect(selections.size).toBeGreaterThan(1)
  })

  it('shuffles rather than returning source order', () => {
    // With a generator pinned to 0 the shuffle is deterministic, so this asserts
    // the reordering actually happens instead of sampling for it.
    const picked = ids(selectAutoPairTargets(pool(5), 5, alwaysZero))

    expect(picked).not.toEqual(['p0', 'p1', 'p2', 'p3', 'p4'])
    expect([...picked].sort()).toEqual(['p0', 'p1', 'p2', 'p3', 'p4'])
  })

  it('spreads picks evenly across the pool', () => {
    // "Everyone gets picked eventually" is too weak: the classic Fisher-Yates
    // slip — drawing from the whole range instead of `0..=i` — still touches
    // every element while favouring some. A seeded generator keeps this exact
    // rather than sampled, so it cannot flake.
    const random = mulberry32(0x5eed)
    const runs = 7000
    const counts = new Map<string, number>()

    for (let run = 0; run < runs; run++) {
      for (const p of selectAutoPairTargets(pool(7), 3, random)) {
        counts.set(p.id, (counts.get(p.id) ?? 0) + 1)
      }
    }

    // Each of 7 participants should appear in 3/7 of draws.
    const expected = (runs * 3) / 7
    for (const [id, seen] of counts) {
      const drift = Math.abs(seen - expected) / expected
      expect(drift, `${id} drifted ${(drift * 100).toFixed(1)}% from even`).toBeLessThan(0.06)
    }
    expect(counts.size).toBe(7)
  })

  // ── Eligibility ────────────────────────────────────────────────────────────

  it('skips participants already paired with this owner', () => {
    const candidates: AutoPairCandidate[] = [
      { id: 'paired', connectionStatus: 'paired' },
      { id: 'free', connectionStatus: 'available' },
    ]

    expect(ids(selectAutoPairTargets(candidates, 2))).toEqual(['free'])
  })

  it('skips browser-run peers, which drive their own pairing', () => {
    const candidates: AutoPairCandidate[] = [
      { id: 'browser', connectionStatus: 'available', browserManaged: true },
      { id: 'provisioned', connectionStatus: 'available' },
    ]

    expect(ids(selectAutoPairTargets(candidates, 2))).toEqual(['provisioned'])
  })

  // ── Counts ─────────────────────────────────────────────────────────────────

  it('returns exactly the requested number when the pool is big enough', () => {
    expect(selectAutoPairTargets(pool(7), 3)).toHaveLength(3)
  })

  it('returns the whole pool when asked for more than exists', () => {
    expect(selectAutoPairTargets(pool(2), 5)).toHaveLength(2)
  })

  it('never repeats a participant', () => {
    const picked = ids(selectAutoPairTargets(pool(6), 6))

    expect(new Set(picked).size).toBe(picked.length)
  })

  it.each([0, -1, Number.NaN])('returns nothing for a count of %s', count => {
    expect(selectAutoPairTargets(pool(5), count)).toEqual([])
  })

  it('handles an empty pool', () => {
    expect(selectAutoPairTargets([], 3)).toEqual([])
  })

  it('leaves the caller’s array untouched', () => {
    // The roster it is handed is owner state; shuffling in place would reorder
    // the rendered participant list as a side effect.
    const candidates = pool(5)
    const before = ids(candidates)

    selectAutoPairTargets(candidates, 5, alwaysZero)

    expect(ids(candidates)).toEqual(before)
  })

  it('tolerates a generator that returns 1', () => {
    // Math.random never does, but an injected one can, and an unguarded index
    // would run past the end of the pool and yield undefined entries.
    const picked = selectAutoPairTargets(pool(4), 4, () => 1)

    expect(picked).toHaveLength(4)
    expect(picked.every(Boolean)).toBe(true)
  })
})
