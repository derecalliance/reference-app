// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { VaultRuntime } from './runtime'
import type { VaultRuntimeState } from './types'

/** The part of a runtime a view follows. */
export type RuntimeStateSource = Pick<VaultRuntime, 'state' | 'subscribe'>

/** A runtime's state in the shape `useSyncExternalStore` takes. */
export interface RuntimeStateStore {
  subscribe: (onChange: () => void) => () => void
  getSnapshot: () => VaultRuntimeState
}

/**
 * Adapts a runtime to `useSyncExternalStore`.
 *
 * `runtime.state()` builds a fresh object on every call, so it cannot be the
 * snapshot getter directly — React would see a change on every read and render
 * forever. The store caches the state each emission hands its listeners, and
 * re-reads it once on subscribing so nothing emitted between the first render
 * and the subscription is missed.
 */
export function runtimeStateStore(runtime: RuntimeStateSource): RuntimeStateStore {
  let snapshot = runtime.state()
  return {
    subscribe(onChange) {
      const unsubscribe = runtime.subscribe(next => {
        snapshot = next
        onChange()
      })
      snapshot = runtime.state()
      onChange()
      return unsubscribe
    },
    getSnapshot: () => snapshot,
  }
}
