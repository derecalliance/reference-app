// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STALE_MS, acquireStorageLock, heldStorageLocks } from './storageLock'

const KEY = 'derec-lock:vault-a'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('acquireStorageLock', () => {
  it('refuses a lock another tab refreshed recently', async () => {
    localStorage.setItem(KEY, JSON.stringify({ tab: 'other-tab', at: Date.now() }))

    expect(await acquireStorageLock('vault-a')).toBeNull()
    expect(heldStorageLocks()).toEqual(new Set(['vault-a']))
  })

  it('takes over a lock whose holder stopped refreshing it', async () => {
    // A crashed tab cannot release; its record only stops being fresh.
    localStorage.setItem(KEY, JSON.stringify({ tab: 'crashed', at: Date.now() - STALE_MS - 1 }))

    const lock = await acquireStorageLock('vault-a')

    expect(lock).not.toBeNull()
    await lock?.release()
  })

  it('loses to a tab whose write landed last', async () => {
    // Both saw it free; whoever's record survives the read-back holds it.
    const setItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      setItem.call(this, key, value)
      if (key === KEY) setItem.call(this, KEY, JSON.stringify({ tab: 'faster', at: Date.now() }))
    })

    expect(await acquireStorageLock('vault-a')).toBeNull()
  })

  it('removes its record on release and ignores a second release', async () => {
    const lock = await acquireStorageLock('vault-a')
    await lock?.release()
    await lock?.release()

    expect(localStorage.getItem(KEY)).toBeNull()
    expect(heldStorageLocks()).toEqual(new Set())
  })
})
