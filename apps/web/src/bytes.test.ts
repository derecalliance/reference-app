import { describe, expect, it } from 'vitest'

import { toBytes } from './bytes'

/**
 * The library's declared `Uint8Array` fields are not always one.
 *
 * This is not hypothetical defensiveness: a replica adoption failed on a real
 * device with "Failed to execute 'decode' on 'TextDecoder': parameter 1 is not
 * of type 'ArrayBuffer'", after the wipe had already run — so the shapes below
 * are the ones that have to be survivable.
 */
describe('toBytes', () => {
  it('passes a Uint8Array through without copying', () => {
    const original = new Uint8Array([1, 2, 3])

    expect(toBytes(original)).toBe(original)
  })

  it('reads a plain number array', () => {
    expect([...toBytes([72, 105])]).toEqual([72, 105])
  })

  it('reads a bare ArrayBuffer', () => {
    const buffer = new Uint8Array([7, 8]).buffer

    expect([...toBytes(buffer)]).toEqual([7, 8])
  })

  it('reads an array-like left by a clone or a JSON round-trip', () => {
    // What a serialised typed array degrades into.
    const arrayLike = { 0: 72, 1: 105, length: 2 } as ArrayLike<number>

    expect([...toBytes(arrayLike)]).toEqual([72, 105])
  })

  it('respects a view onto part of a larger buffer', () => {
    const view = new Uint8Array([1, 2, 3, 4]).subarray(1, 3)

    expect([...toBytes(view)]).toEqual([2, 3])
  })

  it('decodes to the same text a Uint8Array would', () => {
    const text = 'hunter2'
    const bytes = [...new TextEncoder().encode(text)]

    expect(new TextDecoder().decode(toBytes(bytes))).toBe(text)
  })

  it('throws rather than yielding empty bytes for something unreadable', () => {
    // Silently returning an empty array would write a blank secret into the
    // vault as if it were the recovered truth.
    expect(() => toBytes(undefined as never)).toThrow(/expected bytes/)
    expect(() => toBytes(42 as never)).toThrow(/expected bytes/)
  })
})
