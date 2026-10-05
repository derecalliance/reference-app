// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { reportError } from './toastBus'

/** What wasm-bindgen's borrow guard says when two calls overlap on one object. */
const BORROW_FAILURE = 'recursive use of an object detected'

/**
 * Make an overlapping call on one protocol instance impossible to miss.
 *
 * The SDK's async methods take `&mut self`, and wasm-bindgen takes that borrow
 * when the call's future is first polled — on a microtask, not at call time. A
 * second call that overlaps the first fails that borrow *there*, and the throw
 * escapes the microtask as an uncaught error: the call's promise never resolves
 * or rejects. So the flow does not fail, it hangs, and the only trace is a line
 * in devtools.
 *
 * `VaultRuntime`'s per-vault lock prevents this. This exists for the day some
 * path bypasses it. Observed and traced 2026-09-30 against SDK 0.0.5 /
 * wasm-bindgen 0.2.126.
 *
 * Returns a function that removes the listener.
 */
export function installWasmBorrowGuard(
  target: EventTarget = window,
  report: (summary: string, err?: unknown) => void = reportError,
): () => void {
  const onError = (event: Event) => {
    if (!(event instanceof ErrorEvent) || !event.message.includes(BORROW_FAILURE)) return
    report(
      'Two protocol calls overlapped on one vault — the second will never finish. ' +
        "A call bypassed the vault's lock; this is a bug in the app.",
      event.error ?? event.message,
    )
  }
  target.addEventListener('error', onError)
  return () => target.removeEventListener('error', onError)
}
