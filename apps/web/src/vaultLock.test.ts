// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireVaultLock, heldVaultIds, vaultLockMode } from './vaultLock'

/**
 * A minimal in-process stand-in for the Web Locks API.
 *
 * jsdom has no `navigator.locks`, and the module's real-world behaviour —
 * exclusive grant, release on tab death — is the browser's job to get right.
 * What is worth testing here is this module's own contract: that a busy owner
 * comes back as `null` rather than hanging, that releasing frees it, and that
 * `heldVaultIds` maps lock names back onto vault ids.
 */
function installFakeLocks() {
  const held = new Set<string>()

  const manager = {
    // Mirrors the real contract: the returned promise settles when the lock is
    // *released*, i.e. when the callback's own promise settles. A holder keeps
    // it by returning a promise that only resolves on release, so this must not
    // await anything of its own.
    request(
      name: string,
      options: { ifAvailable?: boolean },
      callback: (lock: unknown) => Promise<void> | void,
    ): Promise<void> {
      if (held.has(name)) {
        if (options.ifAvailable) return Promise.resolve(callback(null)).then(() => {})
        return Promise.reject(new Error('fake locks: blocking acquisition not modelled'))
      }
      held.add(name)
      return Promise.resolve(callback({ name })).finally(() => {
        held.delete(name)
      })
    },
    async query() {
      return { held: [...held].map(name => ({ name })), pending: [] }
    },
  }

  vi.stubGlobal('navigator', { ...globalThis.navigator, locks: manager })
  return held
}

describe('vaultLock', () => {
  beforeEach(() => {
    installFakeLocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('grants the lock for a free vault', async () => {
    const lock = await acquireVaultLock('o1')

    expect(lock?.vaultId).toBe('o1')
  })

  it('refuses a vault another holder already has', async () => {
    // The failure this exists to prevent: two tabs on one vault share a mailbox
    // and a store, and only the newer one keeps receiving.
    await acquireVaultLock('o1')

    expect(await acquireVaultLock('o1')).toBeNull()
  })

  it('does not block on a busy vault', async () => {
    // A waiting acquisition would hang the tab with nothing on screen to say
    // why, so the request is always `ifAvailable`.
    await acquireVaultLock('o1')

    await expect(acquireVaultLock('o1')).resolves.toBeNull()
  })

  it('frees the vault on release', async () => {
    const lock = await acquireVaultLock('o1')
    await lock?.release()

    expect(await acquireVaultLock('o1')).not.toBeNull()
  })

  it('resolves release only once the lock is actually free', async () => {
    // Releasing is not instantaneous. Without an awaitable release, a caller
    // that gave the lock up and immediately re-acquired would be told its own
    // vault was busy.
    const lock = await acquireVaultLock('o1')

    await lock?.release()

    expect(await heldVaultIds()).toEqual(new Set())
  })

  it('tolerates a double release', async () => {
    const lock = await acquireVaultLock('o1')
    await lock?.release()
    await lock?.release()

    expect(await acquireVaultLock('o1')).not.toBeNull()
  })

  it('leaves other vaults free', async () => {
    await acquireVaultLock('o1')

    expect(await acquireVaultLock('o2')).not.toBeNull()
  })

  it('reports held vaults by id, not by lock name', async () => {
    await acquireVaultLock('o1')
    await acquireVaultLock('o2')

    expect(await heldVaultIds()).toEqual(new Set(['o1', 'o2']))
  })

  it('drops a released vault from the held set', async () => {
    const lock = await acquireVaultLock('o1')
    await acquireVaultLock('o2')
    await lock?.release()

    expect(await heldVaultIds()).toEqual(new Set(['o2']))
  })

  it('ignores locks belonging to other code on the origin', async () => {
    // Not awaited: a held lock's request only settles on release. The name is
    // registered synchronously, which is all this assertion needs.
    void navigator.locks.request('someone-elses-lock', {}, () => new Promise<void>(() => {}))

    expect(await heldVaultIds()).toEqual(new Set())
  })

  // ── Without Web Locks ──────────────────────────────────────────────────────

  it('falls back to a storage lock where Web Locks is unavailable', async () => {
    // Plain HTTP on a LAN address has no `navigator.locks`. Granting freely
    // there let two tabs run one vault and split its mailbox.
    vi.stubGlobal('navigator', {})
    localStorage.clear()

    expect(vaultLockMode()).toBe('storage-fallback')
    const lock = await acquireVaultLock('o1')
    expect(lock).not.toBeNull()
    expect(await acquireVaultLock('o1')).toBeNull()
    expect(await heldVaultIds()).toEqual(new Set(['o1']))

    await lock?.release()
    expect(await heldVaultIds()).toEqual(new Set())
    expect(await acquireVaultLock('o1')).not.toBeNull()
  })

  it('reports Web Locks as the mode where it exists', () => {
    expect(vaultLockMode()).toBe('web-locks')
  })

  it('survives a query failure without blocking the vault list', async () => {
    vi.stubGlobal('navigator', {
      locks: {
        query: () => Promise.reject(new Error('nope')),
        request: () => Promise.resolve(),
      },
    })

    expect(await heldVaultIds()).toEqual(new Set())
  })
})
