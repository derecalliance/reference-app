// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it, vi } from 'vitest'

import { runtimeStateStore, type RuntimeStateSource } from './runtimeStateStore'
import type { VaultRuntimeState } from './types'

/** A runtime stand-in whose `state()` builds a fresh object per call, as the real one does. */
function fakeRuntime() {
  let version = 0
  const listeners = new Set<(state: VaultRuntimeState) => void>()
  const build = () => ({ version }) as unknown as VaultRuntimeState
  const runtime: RuntimeStateSource = {
    state: build,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    runtime,
    listenerCount: () => listeners.size,
    /** Changes the state without telling anyone, as between render and subscribe. */
    changeQuietly: () => {
      version += 1
    },
    emit: () => {
      version += 1
      const state = build()
      listeners.forEach(listener => listener(state))
    },
  }
}

const versionOf = (state: VaultRuntimeState) => (state as unknown as { version: number }).version

describe('runtimeStateStore', () => {
  it('returns the same snapshot until the runtime emits', () => {
    const { runtime } = fakeRuntime()
    const store = runtimeStateStore(runtime)
    expect(store.getSnapshot()).toBe(store.getSnapshot())
  })

  it('follows each emission and notifies the subscriber', () => {
    const fake = fakeRuntime()
    const store = runtimeStateStore(fake.runtime)
    const onChange = vi.fn()
    store.subscribe(onChange)
    onChange.mockClear()

    fake.emit()

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(versionOf(store.getSnapshot())).toBe(1)
    expect(store.getSnapshot()).toBe(store.getSnapshot())
  })

  it('catches a change made between creating the store and subscribing', () => {
    const fake = fakeRuntime()
    const store = runtimeStateStore(fake.runtime)
    fake.changeQuietly()
    const onChange = vi.fn()

    store.subscribe(onChange)

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(versionOf(store.getSnapshot())).toBe(1)
  })

  it('stops listening on unsubscribe', () => {
    const fake = fakeRuntime()
    const store = runtimeStateStore(fake.runtime)
    const unsubscribe = store.subscribe(() => {})
    expect(fake.listenerCount()).toBe(1)

    unsubscribe()

    expect(fake.listenerCount()).toBe(0)
  })
})
