import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireOwnerLock, heldOwnerIds } from './ownerLock'

/**
 * A minimal in-process stand-in for the Web Locks API.
 *
 * jsdom has no `navigator.locks`, and the module's real-world behaviour —
 * exclusive grant, release on tab death — is the browser's job to get right.
 * What is worth testing here is this module's own contract: that a busy owner
 * comes back as `null` rather than hanging, that releasing frees it, and that
 * `heldOwnerIds` maps lock names back onto owner ids.
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

describe('ownerLock', () => {
  beforeEach(() => {
    installFakeLocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('grants the lock for a free owner', async () => {
    const lock = await acquireOwnerLock('o1')

    expect(lock?.ownerId).toBe('o1')
  })

  it('refuses an owner another holder already has', async () => {
    // The failure this exists to prevent: two tabs on one owner share a mailbox
    // and a store, and only the newer one keeps receiving.
    await acquireOwnerLock('o1')

    expect(await acquireOwnerLock('o1')).toBeNull()
  })

  it('does not block on a busy owner', async () => {
    // A waiting acquisition would hang the tab with nothing on screen to say
    // why, so the request is always `ifAvailable`.
    await acquireOwnerLock('o1')

    await expect(acquireOwnerLock('o1')).resolves.toBeNull()
  })

  it('frees the owner on release', async () => {
    const lock = await acquireOwnerLock('o1')
    await lock?.release()

    expect(await acquireOwnerLock('o1')).not.toBeNull()
  })

  it('resolves release only once the lock is actually free', async () => {
    // Releasing is not instantaneous. Without an awaitable release, a caller
    // that gave the lock up and immediately re-acquired would be told its own
    // owner was busy.
    const lock = await acquireOwnerLock('o1')

    await lock?.release()

    expect(await heldOwnerIds()).toEqual(new Set())
  })

  it('tolerates a double release', async () => {
    const lock = await acquireOwnerLock('o1')
    await lock?.release()
    await lock?.release()

    expect(await acquireOwnerLock('o1')).not.toBeNull()
  })

  it('leaves other owners free', async () => {
    await acquireOwnerLock('o1')

    expect(await acquireOwnerLock('o2')).not.toBeNull()
  })

  it('reports held owners by id, not by lock name', async () => {
    await acquireOwnerLock('o1')
    await acquireOwnerLock('o2')

    expect(await heldOwnerIds()).toEqual(new Set(['o1', 'o2']))
  })

  it('drops a released owner from the held set', async () => {
    const lock = await acquireOwnerLock('o1')
    await acquireOwnerLock('o2')
    await lock?.release()

    expect(await heldOwnerIds()).toEqual(new Set(['o2']))
  })

  it('ignores locks belonging to other code on the origin', async () => {
    // Not awaited: a held lock's request only settles on release. The name is
    // registered synchronously, which is all this assertion needs.
    void navigator.locks.request('someone-elses-lock', {}, () => new Promise<void>(() => {}))

    expect(await heldOwnerIds()).toEqual(new Set())
  })

  // ── Degradation ────────────────────────────────────────────────────────────

  it('grants freely where Web Locks is unavailable', async () => {
    // Non-secure origins and jsdom have no `navigator.locks`. The lock guards
    // against a mistake; refusing to run the app without it would be a worse
    // failure than the one being guarded against.
    vi.stubGlobal('navigator', {})

    expect(await acquireOwnerLock('o1')).not.toBeNull()
    expect(await acquireOwnerLock('o1')).not.toBeNull()
  })

  it('reports nothing held where Web Locks is unavailable', async () => {
    vi.stubGlobal('navigator', {})

    expect(await heldOwnerIds()).toEqual(new Set())
  })

  it('survives a query failure without blocking the picker', async () => {
    vi.stubGlobal('navigator', {
      locks: {
        query: () => Promise.reject(new Error('nope')),
        request: () => Promise.resolve(),
      },
    })

    expect(await heldOwnerIds()).toEqual(new Set())
  })
})
