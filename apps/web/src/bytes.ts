// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * Coercing the library's binary fields into real `Uint8Array`s.
 *
 * The SDK's types declare these as `Uint8Array`, but what actually arrives on an
 * event is not always one: depending on the build and the path a payload took,
 * a field can be a plain `number[]`, a bare `ArrayBuffer`, or an array-like
 * object. Handing any of those to `TextDecoder.decode` or back into the WASM
 * boundary fails with "parameter 1 is not of type 'ArrayBuffer'" — which is how
 * a replica adoption managed to erase a device's vault and then fall over
 * decoding the very payload it had just cleared the way for.
 *
 * So nothing trusts the declared type. Everything that reads these fields goes
 * through here first.
 */

/** Anything the library has been observed to hand back for a bytes field. */
export type ByteSource = Uint8Array | ArrayBuffer | number[] | ArrayLike<number>

/**
 * A real `Uint8Array` over `value`, copying only when it has to.
 *
 * Throws rather than returning empty on something genuinely unusable: a silent
 * zero-length secret would be written into the vault as if it were the truth.
 */
export function toBytes(value: ByteSource): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  }
  if (Array.isArray(value)) return Uint8Array.from(value)

  // Array-like: `{0: 72, 1: 105, length: 2}`, which is what a structured clone
  // or a JSON round-trip of a typed array leaves behind.
  if (typeof value === 'object' && value !== null && typeof value.length === 'number') {
    return Uint8Array.from(value as ArrayLike<number>)
  }

  throw new TypeError(
    `expected bytes, got ${value === null ? 'null' : typeof value} — ` +
      'the library returned a shape this app cannot read as binary',
  )
}

/**
 * Lower-case hex, as the app writes user-secret ids everywhere it mints them.
 *
 * Restored and adopted secrets arrive as bytes; writing them as hex too keeps
 * one id spelling across the app, so the same secret shows the same id on the
 * source and on a replica that adopted it.
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}
