// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import type { PendingReplicaAdoption } from '../replicaFlows'
import { VaultRuntime } from './runtime'
import { deps, vault } from './testVault'

function offer(version: number): PendingReplicaAdoption {
  return { channelId: '900', fromReplicaId: 'ff01', secretId: '99', version, secret: { helpers: [], secrets: [] }, shares: [] }
}

describe('attention queue', () => {
  it('is empty on a fresh runtime', () => {
    const r = new VaultRuntime(vault(), deps())

    expect(r.attention()).toEqual([])
    expect(r.drainPaused()).toBe(false)
  })

  it('pauses the drain for a blocking item and resumes when resolved', () => {
    const r = new VaultRuntime(vault(), deps())

    const id = r.raiseAttention({ kind: 'pairing', blocksDrain: true, payload: {} })
    expect(r.drainPaused()).toBe(true)

    r.resolveAttention(id)
    expect(r.drainPaused()).toBe(false)
  })

  it('keeps draining for a non-blocking item', () => {
    // Replica adoption stages an offer; stalling the vault until someone decides
    // would be wrong, and a replay cannot regress a staged offer.
    const r = new VaultRuntime(vault(), deps())

    r.raiseAttention({ kind: 'replica-adoption', blocksDrain: false, payload: {} })

    expect(r.attention()).toHaveLength(1)
    expect(r.drainPaused()).toBe(false)
  })

  it('stays paused while any blocking item is still open', () => {
    // The gate is "is anything blocking open", not "was the last one resolved".
    const r = new VaultRuntime(vault(), deps())
    const first = r.raiseAttention({ kind: 'pairing', blocksDrain: true, payload: {} })
    r.raiseAttention({ kind: 'unpair', blocksDrain: true, payload: {} })

    r.resolveAttention(first)

    expect(r.drainPaused()).toBe(true)
  })

  it('publishes attention on the state it emits, so an off-screen vault can badge', () => {
    const r = new VaultRuntime(vault(), deps())
    const seen: number[] = []
    r.subscribe(s => seen.push(s.attention.length))

    r.raiseAttention({ kind: 'unpair', blocksDrain: true, payload: {} })

    expect(seen.at(-1)).toBe(1)
    expect(r.attention()[0].kind).toBe('unpair')
  })

  it('resolving an unknown id is a no-op rather than a throw', () => {
    // The view can race a resolve against a runtime that already cleared it —
    // on a vault teardown, say — and that must not take the page down.
    const r = new VaultRuntime(vault(), deps())

    expect(() => r.resolveAttention('nope')).not.toThrow()
  })

  it('gives every item a distinct id', () => {
    // Ids are how the view resolves the right one; two items sharing one would
    // let a decision about a pairing dismiss an unpair request.
    const r = new VaultRuntime(vault(), deps())

    const a = r.raiseAttention({ kind: 'pairing', blocksDrain: true, payload: {} })
    const b = r.raiseAttention({ kind: 'pairing', blocksDrain: true, payload: {} })

    expect(a).not.toBe(b)
  })

  describe('replica adoption offers', () => {
    it('stages one item, never blocking the drain', () => {
      const r = new VaultRuntime(vault(), deps())

      r.stageReplicaAdoption(offer(3))

      expect(r.attention()).toHaveLength(1)
      expect(r.attention()[0]).toMatchObject({ kind: 'replica-adoption', blocksDrain: false })
      expect(r.drainPaused()).toBe(false)
    })

    it('replaces a staged offer with a newer one, in the same item', () => {
      const r = new VaultRuntime(vault(), deps())
      r.stageReplicaAdoption(offer(3))
      const id = r.attention()[0].id

      r.stageReplicaAdoption(offer(4))

      expect(r.attention()).toHaveLength(1)
      expect(r.attention()[0].id).toBe(id)
      expect((r.attention()[0].payload as PendingReplicaAdoption).version).toBe(4)
    })

    it('does not let a replayed stale round regress a fresher staged offer', () => {
      // The mailbox redelivers at least once; the older copy can land second.
      const r = new VaultRuntime(vault(), deps())
      r.stageReplicaAdoption(offer(4))
      const before = r.attention()

      r.stageReplicaAdoption(offer(3))

      expect(r.attention()).toBe(before)
    })
  })
})
