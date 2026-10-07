// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * Turn anything thrown into something a human can act on.
 *
 * `String(err)` is the usual shorthand and it is wrong here. The DeRec WASM
 * bindings reject with **plain objects** rather than `Error`s — typically
 * `{ code, message }` — and a plain object stringifies to the literal
 * `"[object Object]"`. Every protocol failure in this app used to surface that
 * way: a dialog saying nothing, with the real cause sitting one property deep.
 *
 * This is a debugging tool, so the error is often the entire product.
 */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err === null || err === undefined) return 'unknown error'

  if (typeof err === 'object') {
    const record = err as Record<string, unknown>

    // The bindings' own shape. `code` is a stable identifier worth keeping
    // beside the prose — it is what you search the SDK for.
    const message = firstString(record, ['message', 'error', 'detail', 'description'])
    const code = firstString(record, ['code', 'kind', 'name'])

    if (message && code) return `${message} (${code})`
    if (message) return message
    if (code) return code

    // Nothing recognisable, but the object still holds the answer — show it
    // rather than the useless default.
    try {
      const json = JSON.stringify(err)
      if (json && json !== '{}') return json
    } catch {
      // Circular or otherwise unserialisable; fall through.
    }
  }

  return String(err)
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}
