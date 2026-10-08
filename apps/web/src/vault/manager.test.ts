// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BEActorWithStatus } from '../api'

import { FALLBACK_SERVER_DEFAULTS } from '../config'
import type { Vault } from '../types'
import { VaultManager, type VaultLocks, type VaultManagerDeps, type VaultStorage } from './manager'
import type { VaultRuntime } from './runtime'
import { vault } from './testVault'
import type { VaultRuntimeDeps, VaultRuntimeState, VaultStatus } from './types'

/** A runtime with no WASM: `start` lands on `outcome`. */
function fakeRuntime(v: Vault, deps: VaultRuntimeDeps, outcome: VaultStatus = 'running') {
  const listeners = new Set<(s: VaultRuntimeState) => void>()
  let state: VaultRuntimeState = {
    vault: v,
    status: 'idle',
    busy: false,
    attention: [],
    failure: null,
    blockedBy: null,
    replicaSyncing: [],
    replicaAutoSyncOutcome: null,
    identityUpdate: null,
    autoPairing: [],
  }
  const set = (patch: Partial<VaultRuntimeState>) => {
    state = { ...state, ...patch }
    for (const l of listeners) l(state)
  }
  return {
    vaultId: v.id,
    start: vi.fn(async () => set({ status: outcome, failure: outcome === 'failed' ? 'boom' : null })),
    stop: vi.fn(() => set({ status: 'idle' })),
    state: () => state,
    subscribe: (l: (s: VaultRuntimeState) => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    commit: (next: Vault) => {
      set({ vault: next })
      deps.onVaultChange(next)
    },
    raise: (id = 'a') =>
      set({ attention: [...state.attention, { id, kind: 'pairing', blocksDrain: true, raisedAt: 0, payload: {} }] }),
    /** The deps the manager built it with — its notifier, in particular. */
    deps,
    applyRoster: vi.fn(),
    /** Resolves when work already under way has finished. */
    quiesce: vi.fn(async () => {}),
    fast: false,
    wantsFastCadence(): boolean {
      return this.fast
    },
  }
}
type FakeRuntime = ReturnType<typeof fakeRuntime>

function memoryStorage(vaults: Vault[]): VaultStorage & { records: Map<string, Vault> } {
  const records = new Map(vaults.map(v => [v.id, v]))
  return {
    records,
    list: () => [...records.keys()],
    load: id => records.get(id) ?? null,
    persist: v => {
      records.set(v.id, v)
      return true
    },
    remove: id => {
      records.delete(id)
    },
  }
}

/**
 * Locks every id except those in `busy`, and remembers what it released.
 * `busy` is live: a test can claim or free an id "in another tab" by editing it.
 */
function fakeLocks(busy: string[] = []): VaultLocks & { released: string[]; holding: Set<string> } {
  const held = new Set<string>()
  const released: string[] = []
  return {
    holding: held,
    released,
    held: async () => new Set([...held, ...busy]),
    acquire: async id => {
      if (busy.includes(id) || held.has(id)) return null
      held.add(id)
      return {
        release: async () => {
          held.delete(id)
          released.push(id)
        },
      }
    },
  }
}

/** Every manager a test builds, so its roster poller can be stopped afterwards. */
const built: VaultManager[] = []
afterEach(() => {
  for (const m of built.splice(0)) m.stopRoster()
})

function setup(
  vaults: Vault[],
  overrides: Partial<VaultManagerDeps> = {},
  outcomes: Record<string, VaultStatus> = {},
) {
  const runtimes = new Map<string, FakeRuntime>()
  const deps: VaultManagerDeps = {
    log: vi.fn(),
    notify: { error: vi.fn(), info: vi.fn() },
    getServerDefaults: () => FALLBACK_SERVER_DEFAULTS,
    locks: fakeLocks(),
    storage: memoryStorage(vaults),
    eraseStores: vi.fn(),
    fetchActors: vi.fn(async () => []),
    createRuntime: (v, runtimeDeps) => {
      const r = fakeRuntime(v, runtimeDeps, outcomes[v.id])
      runtimes.set(v.id, r)
      return r as unknown as VaultRuntime
    },
    ...overrides,
  }
  const manager = new VaultManager(deps)
  built.push(manager)
  return { manager, deps, runtimes }
}

const alpha = vault({ id: 'alpha', name: 'Alpha' })
const beta = vault({ id: 'beta', name: 'Beta' })

describe('VaultManager', () => {
  it('counts participant channels as paired, and replica channels only as replicas', () => {
    const paired = (channelId: string, peerRole: 'helper' | 'replica_destination') => ({
      id: `p-${channelId}`,
      name: channelId,
      channelId,
      transport: { protocol: 'https' as const, uri: '' },
      connectionStatus: 'paired' as const,
      peerRole,
      secretShares: [],
    })
    const { manager } = setup([
      vault({
        id: 'alpha',
        name: 'Alpha',
        participants: [paired('1', 'helper'), paired('2', 'helper'), paired('3', 'replica_destination')],
      }),
    ])

    void manager.boot()

    expect(manager.entries()[0].pairedCount).toBe(2)
  })

  it('lists stored vaults before any of them has started', () => {
    // The list renders from storage at once; rows flip to running as they come up.
    const { manager } = setup([alpha, beta])

    void manager.boot()

    expect(manager.entries().map(e => [e.name, e.state])).toEqual([
      ['Alpha', 'starting'],
      ['Beta', 'starting'],
    ])
  })

  it('is booted once it has read storage, before any vault has started', () => {
    // Until then, a vault with no row is still being read — not gone.
    const { manager } = setup([alpha])
    expect(manager.isBooted()).toBe(false)

    void manager.boot()

    expect(manager.isBooted()).toBe(true)
  })

  it('starts every stored vault it can lock', async () => {
    const { manager, runtimes } = setup([alpha, beta])

    await manager.boot()

    expect(manager.entries().map(e => e.state)).toEqual(['running', 'running'])
    expect(runtimes.get('alpha')?.start).toHaveBeenCalledTimes(1)
    expect(manager.runtime('beta')).not.toBeNull()
  })

  it('lists a vault another tab holds, without starting it', async () => {
    const { manager, runtimes } = setup([alpha, beta], { locks: fakeLocks(['beta']) })

    await manager.boot()

    expect(manager.entries().find(e => e.id === 'beta')?.state).toBe('elsewhere')
    expect(runtimes.has('beta')).toBe(false)
    expect(manager.runtime('beta')).toBeNull()
  })

  it('isolates a vault that fails to start', async () => {
    const { manager } = setup([alpha, beta], {}, { alpha: 'failed' })

    await manager.boot()

    const byId = Object.fromEntries(manager.entries().map(e => [e.id, e]))
    expect(byId.alpha).toMatchObject({ state: 'failed', failure: 'boom' })
    expect(byId.beta.state).toBe('running')
  })

  it('does not list a record storage cannot read', async () => {
    const storage = memoryStorage([alpha])
    const { manager } = setup([], { storage: { ...storage, list: () => ['alpha', 'broken'] } })

    await manager.boot()

    expect(manager.entries().map(e => e.id)).toEqual(['alpha'])
  })

  it('creates a vault: persists it and starts it', async () => {
    const { manager, deps } = setup([])

    expect(await manager.create(alpha)).toBe(true)

    expect(deps.storage.load('alpha')).not.toBeNull()
    expect(manager.entries()[0]).toMatchObject({ id: 'alpha', state: 'running' })
  })

  it('refuses to create a vault another tab holds, and persists nothing', async () => {
    const { manager, deps } = setup([], { locks: fakeLocks(['alpha']) })

    expect(await manager.create(alpha)).toBe(false)

    expect(deps.storage.load('alpha')).toBeNull()
  })

  it('stops a released vault and frees its lock; opening it starts it again', async () => {
    const locks = fakeLocks()
    const { manager, runtimes } = setup([alpha], { locks })
    await manager.boot()

    await manager.release('alpha')

    expect(runtimes.get('alpha')?.stop).toHaveBeenCalled()
    expect(locks.released).toEqual(['alpha'])
    expect(manager.entries()[0].state).toBe('stopped')
    expect(manager.runtime('alpha')).toBeNull()

    expect(await manager.open('alpha')).toBe(true)
    expect(manager.entries()[0].state).toBe('running')
  })

  it('claims a vault once the other tab lets it go', async () => {
    const locks = fakeLocks(['alpha'])
    const { manager } = setup([alpha], { locks })
    await manager.boot()
    expect(await manager.open('alpha')).toBe(false)
    expect(manager.entries()[0].state).toBe('elsewhere')

    locks.acquire = fakeLocks().acquire
    expect(await manager.open('alpha')).toBe(true)
    expect(manager.entries()[0].state).toBe('running')
  })

  it('retries a vault that failed to start', async () => {
    const { manager, runtimes } = setup([alpha], {}, { alpha: 'failed' })
    await manager.boot()

    await manager.retry('alpha')

    expect(runtimes.get('alpha')?.start).toHaveBeenCalledTimes(2)
  })

  it('stops a vault before erasing its stores when removing it', async () => {
    // A drain still running over a cleared namespace would write into it.
    const order: string[] = []
    const { manager, runtimes } = setup([alpha], {
      eraseStores: vi.fn(() => {
        order.push(runtimes.get('alpha')?.stop.mock.calls.length ? 'erase-after-stop' : 'erase-before-stop')
      }),
    })
    await manager.boot()

    await manager.remove('alpha')

    expect(order).toEqual(['erase-after-stop'])
    expect(manager.entries()).toEqual([])
  })

  it('persists what a runtime commits', async () => {
    const { manager, runtimes, deps } = setup([alpha])
    await manager.boot()

    runtimes.get('alpha')?.commit({ ...alpha, name: 'Alpha Prime' })

    expect(deps.storage.load('alpha')?.name).toBe('Alpha Prime')
    expect(manager.entries()[0].name).toBe('Alpha Prime')
  })

  it('reports a failed save once, not on every commit', async () => {
    // Swallowing it was defensible with one vault and is data loss with ten.
    const storage = memoryStorage([alpha])
    const { manager, runtimes, deps } = setup([], { storage: { ...storage, persist: () => false } })
    await manager.boot()

    runtimes.get('alpha')?.commit({ ...alpha, name: 'A2' })
    runtimes.get('alpha')?.commit({ ...alpha, name: 'A3' })

    expect(deps.notify.error).toHaveBeenCalledTimes(1)
  })

  describe('notifications from vaults not on screen', () => {
    const offScreen = { vaultId: 'beta', vaultName: 'Beta' }

    it('drops an outcome from the vault on screen — its own view shows it', async () => {
      const { manager, runtimes, deps } = setup([alpha, beta])
      await manager.boot()
      manager.setOnScreen('alpha')

      runtimes.get('alpha')?.deps.notify.outcome('Secret recovered')

      expect(deps.notify.info).not.toHaveBeenCalled()
    })

    it('turns an outcome from a vault off screen into a banner naming it', async () => {
      const { manager, runtimes, deps } = setup([alpha, beta])
      await manager.boot()
      manager.setOnScreen('alpha')

      runtimes.get('beta')?.deps.notify.outcome('Secret recovered')

      expect(deps.notify.info).toHaveBeenCalledTimes(1)
      expect(deps.notify.info).toHaveBeenCalledWith('Secret recovered', offScreen)
    })

    it('carries the origin on an error from a vault off screen, and not on one from the vault on screen', async () => {
      const { manager, runtimes, deps } = setup([alpha, beta])
      await manager.boot()
      manager.setOnScreen('alpha')

      runtimes.get('beta')?.deps.notify.error('Mailbox poll failed', 'boom', { x: 1 })
      runtimes.get('alpha')?.deps.notify.error('Mailbox poll failed', 'boom', { x: 1 })

      expect(deps.notify.error).toHaveBeenNthCalledWith(1, 'Mailbox poll failed', 'boom', { x: 1 }, offScreen)
      expect(deps.notify.error).toHaveBeenNthCalledWith(2, 'Mailbox poll failed', 'boom', { x: 1 }, undefined)
    })

    it('treats every vault as off screen while the list is shown', async () => {
      const { manager, runtimes, deps } = setup([alpha, beta])
      await manager.boot()
      manager.setOnScreen(null)

      runtimes.get('beta')?.deps.notify.info('Caught up')

      expect(deps.notify.info).toHaveBeenCalledWith('Caught up', offScreen)
    })

    it('raises one banner per decision a vault off screen is waiting on', async () => {
      const { manager, runtimes, deps } = setup([alpha, beta])
      await manager.boot()
      manager.setOnScreen('alpha')

      runtimes.get('beta')?.raise('p1')
      runtimes.get('beta')?.raise('p2')
      // An unrelated state change must not repeat the banners already shown.
      runtimes.get('beta')?.commit({ ...beta, name: 'Beta' })

      expect(deps.notify.info).toHaveBeenCalledTimes(2)
      expect(deps.notify.info).toHaveBeenCalledWith('Waiting for your decision', offScreen)
    })

    it('raises no banner for a decision on the vault on screen — its modal asks', async () => {
      const { manager, runtimes, deps } = setup([alpha, beta])
      await manager.boot()
      manager.setOnScreen('beta')

      runtimes.get('beta')?.raise('p1')

      expect(deps.notify.info).not.toHaveBeenCalled()
    })
  })

  describe('removing a vault with work still in flight', () => {
    it('waits for that work before erasing its stores', async () => {
      const { manager, runtimes, deps } = setup([alpha])
      await manager.boot()
      let finish = () => {}
      runtimes.get('alpha')!.quiesce.mockImplementation(() => new Promise<void>(r => (finish = r)))

      const removing = manager.remove('alpha')
      await Promise.resolve()
      expect(deps.eraseStores).not.toHaveBeenCalled()

      finish()
      await removing
      expect(deps.eraseStores).toHaveBeenCalledTimes(1)
    })

    it('does not bring the record back when a late commit lands after removal', async () => {
      const storage = memoryStorage([alpha])
      const { manager, runtimes } = setup([], { storage })
      await manager.boot()
      const runtime = runtimes.get('alpha')!

      await manager.remove('alpha')
      runtime.commit({ ...alpha, name: 'Resurrected' })

      expect(storage.records.has('alpha')).toBe(false)
    })
  })

  it('opens an existing vault rather than overwriting it when set up again under its id', async () => {
    // Claiming an actor this browser already holds as a stopped vault.
    const storage = memoryStorage([alpha])
    const { manager } = setup([], { storage })
    await manager.boot()
    await manager.release('alpha')

    expect(await manager.create({ ...alpha, name: 'Blank', secretBag: null })).toBe(true)

    expect(storage.records.get('alpha')?.name).toBe('Alpha')
    expect(manager.entries()[0]).toMatchObject({ name: 'Alpha', state: 'running' })
  })

  it('counts open attention per vault for the badge', async () => {
    const { manager, runtimes } = setup([alpha])
    await manager.boot()

    runtimes.get('alpha')?.raise()

    expect(manager.entries()[0].attention).toBe(1)
  })

  it('tells subscribers when entries change, and stops after unsubscribe', async () => {
    const { manager } = setup([alpha])
    const seen = vi.fn()
    const off = manager.subscribe(seen)

    await manager.boot()
    const calls = seen.mock.calls.length
    off()
    await manager.release('alpha')

    expect(calls).toBeGreaterThan(0)
    expect(seen.mock.calls.length).toBe(calls)
  })

  it('keeps the entries array stable between changes', async () => {
    // React compares snapshots by identity; a fresh array every read would loop.
    const { manager } = setup([alpha])
    await manager.boot()

    expect(manager.entries()).toBe(manager.entries())
  })

  it('releases every lock on releaseAll, and its rows read stopped', async () => {
    // Left "running" with no runtime, a row restored from the back/forward
    // cache offered nothing to click and showed nothing when opened.
    const locks = fakeLocks()
    const { manager } = setup([alpha, beta], { locks })
    await manager.boot()

    await manager.releaseAll()

    expect(locks.released.sort()).toEqual(['alpha', 'beta'])
    expect(manager.entries().map(e => e.state)).toEqual(['stopped', 'stopped'])
  })

  it('ignores a replaced runtime that still emits', async () => {
    // A stopped runtime can emit on its way out; its row now belongs to the
    // runtime that replaced it.
    const { manager, runtimes } = setup([alpha])
    await manager.boot()
    const old = runtimes.get('alpha')!
    await manager.release('alpha')
    await manager.open('alpha')

    old.raise('stale')
    old.commit({ ...alpha, name: 'Stale' })

    expect(manager.entries()[0]).toMatchObject({ name: 'Alpha', attention: 0, state: 'running' })
  })

  it('claims once when Open or Claim is pressed twice in a row', async () => {
    // The second press used to send its own `acquire` while the first held the
    // lock, and was told the vault was open in another tab.
    const locks = fakeLocks()
    const acquire = vi.spyOn(locks, 'acquire')
    const { manager } = setup([alpha], { locks })
    await manager.boot()
    await manager.release('alpha')
    acquire.mockClear()

    const [first, second] = await Promise.all([manager.open('alpha'), manager.open('alpha')])

    expect([first, second]).toEqual([true, true])
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(manager.entries()[0].state).toBe('running')
  })

  it('tells subscribers only when a row changes, and keeps unchanged rows as they were', async () => {
    // Runtimes emit on every busy toggle and commit; each notification
    // re-renders the app, so one that changes no row must not be sent.
    const { manager, runtimes } = setup([alpha, beta])
    await manager.boot()
    const before = manager.entries()
    const seen = vi.fn()
    manager.subscribe(seen)

    runtimes.get('alpha')?.commit({ ...alpha })
    expect(seen).not.toHaveBeenCalled()
    expect(manager.entries()).toBe(before)

    runtimes.get('alpha')?.raise()
    expect(seen).toHaveBeenCalledTimes(1)
    const after = manager.entries()
    expect(after.find(e => e.id === 'alpha')?.attention).toBe(1)
    expect(after.find(e => e.id === 'beta')).toBe(before.find(e => e.id === 'beta'))
  })

  describe('an unreachable node', () => {
    function withNodeNotice() {
      const nodeUnreachable = vi.fn()
      const env = setup([alpha, beta], {
        notify: { error: vi.fn(), info: vi.fn(), nodeUnreachable },
      })
      return { ...env, nodeUnreachable }
    }

    it('raises one notice for every vault, and clears it once the last one gets through', async () => {
      const { manager, runtimes, nodeUnreachable } = withNodeNotice()
      await manager.boot()
      const alphaPoll = runtimes.get('alpha')!.deps.pollReached!
      const betaPoll = runtimes.get('beta')!.deps.pollReached!

      alphaPoll(false)
      betaPoll(false)
      alphaPoll(false)
      expect(nodeUnreachable.mock.calls).toEqual([[true]])

      alphaPoll(true)
      expect(nodeUnreachable.mock.calls).toEqual([[true]])

      betaPoll(true)
      expect(nodeUnreachable.mock.calls).toEqual([[true], [false]])
    })

    it('clears the notice when the only vault that could not reach the node stops', async () => {
      const { manager, runtimes, nodeUnreachable } = withNodeNotice()
      await manager.boot()

      runtimes.get('alpha')!.deps.pollReached!(false)
      await manager.release('alpha')

      expect(nodeUnreachable.mock.calls).toEqual([[true], [false]])
    })

    it('leaves each vault to report its own failed polls when nothing shows a node notice', async () => {
      const { manager, runtimes } = setup([alpha])
      await manager.boot()

      expect(runtimes.get('alpha')!.deps.pollReached).toBeUndefined()
    })
  })

  describe('the shared roster', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    const helper = { id: 'h1', role: 'helper', name: 'Alex' } as unknown as BEActorWithStatus

    it('fetches the roster once per tick and fans it out to every running vault', async () => {
      // `apiGetActors()` returns the same node-wide list for every vault, so the
      // fetch must not multiply with vault count.
      const fetchActors = vi.fn(async () => [helper])
      const { manager, runtimes } = setup([alpha, beta], { fetchActors })
      await manager.boot()
      fetchActors.mockClear()

      await vi.advanceTimersByTimeAsync(VaultManager.ROSTER_IDLE_MS)

      expect(fetchActors).toHaveBeenCalledTimes(1)
      expect(runtimes.get('alpha')?.applyRoster).toHaveBeenCalledWith([helper])
      expect(runtimes.get('beta')?.applyRoster).toHaveBeenCalledWith([helper])
      expect(manager.roster()).toEqual([helper])
      manager.stopRoster()
    })

    it('fetches at boot, so the first rows do not wait a whole interval', async () => {
      const fetchActors = vi.fn(async () => [helper])
      const { manager } = setup([alpha], { fetchActors })

      await manager.boot()
      await vi.advanceTimersByTimeAsync(0)

      expect(fetchActors).toHaveBeenCalledTimes(1)
      manager.stopRoster()
    })

    it('does not hand the roster to a stopped vault', async () => {
      const fetchActors = vi.fn(async () => [helper])
      const { manager, runtimes } = setup([alpha], { fetchActors })
      await manager.boot()
      const alphaRuntime = runtimes.get('alpha')
      await manager.release('alpha')
      alphaRuntime?.applyRoster.mockClear()

      await vi.advanceTimersByTimeAsync(VaultManager.ROSTER_IDLE_MS)

      expect(alphaRuntime?.applyRoster).not.toHaveBeenCalled()
      manager.stopRoster()
    })

    it('polls fast while any vault wants the fast cadence', async () => {
      const fetchActors = vi.fn(async () => [helper])
      const { manager, runtimes } = setup([alpha], { fetchActors })
      await manager.boot()
      await vi.advanceTimersByTimeAsync(0)
      fetchActors.mockClear()
      runtimes.get('alpha')!.fast = true

      await vi.advanceTimersByTimeAsync(VaultManager.ROSTER_FAST_MS * 3)

      expect(fetchActors.mock.calls.length).toBeGreaterThanOrEqual(2)
      manager.stopRoster()
    })

    it('keeps polling after a failed fetch', async () => {
      const fetchActors = vi.fn(async () => {
        throw new Error('offline')
      })
      const { manager } = setup([alpha], { fetchActors })
      await manager.boot()
      await vi.advanceTimersByTimeAsync(VaultManager.ROSTER_IDLE_MS * 2)

      expect(fetchActors.mock.calls.length).toBeGreaterThanOrEqual(2)
      manager.stopRoster()
    })

    it('tells roster subscribers each time it lands', async () => {
      const fetchActors = vi.fn(async () => [helper])
      const { manager } = setup([alpha], { fetchActors })
      const seen = vi.fn()
      manager.subscribeRoster(seen)

      await manager.boot()
      await vi.advanceTimersByTimeAsync(0)

      expect(seen).toHaveBeenCalledWith([helper])
      manager.stopRoster()
    })
  })
})


describe('VaultManager — other tabs', () => {
  it('shows a vault another tab claimed as held elsewhere', async () => {
    const busy: string[] = []
    const { manager } = setup([alpha], { locks: fakeLocks(busy) })
    await manager.boot()
    await manager.release('alpha')

    busy.push('alpha')
    await manager.syncWithOtherTabs()

    expect(manager.entries()[0].state).toBe('elsewhere')
  })

  it('offers a vault back once the other tab lets it go, without claiming it', async () => {
    const busy = ['alpha']
    const { manager, runtimes } = setup([alpha], { locks: fakeLocks(busy) })
    await manager.boot()
    expect(manager.entries()[0].state).toBe('elsewhere')

    busy.splice(0)
    await manager.syncWithOtherTabs()

    expect(manager.entries()[0].state).toBe('stopped')
    expect(runtimes.has('alpha')).toBe(false)
  })

  it('lists a vault created in another tab and drops one removed there', async () => {
    const busy: string[] = []
    const storage = memoryStorage([alpha])
    const { manager } = setup([alpha], { storage, locks: fakeLocks(busy) })
    await manager.boot()
    await manager.release('alpha')

    storage.records.set('beta', beta)
    busy.push('beta')
    storage.records.delete('alpha')
    await manager.syncWithOtherTabs()

    expect(manager.entries().map(e => [e.name, e.state])).toEqual([['Beta', 'elsewhere']])
  })

  it('never touches a vault running here', async () => {
    const { manager } = setup([alpha])
    await manager.boot()

    await manager.syncWithOtherTabs()

    expect(manager.entries()[0].state).toBe('running')
  })

  it('announces claims and releases to other tabs', async () => {
    const announce = vi.fn()
    const { manager } = setup([alpha], { announce })
    await manager.boot()
    expect(announce).toHaveBeenCalledTimes(1)

    await manager.release('alpha')
    expect(announce).toHaveBeenCalledTimes(2)
  })
})

describe('VaultManager — halting for a reset', () => {
  it('stops every vault and waits for its last write before resolving', async () => {
    const { manager, runtimes, deps } = setup([alpha, beta])
    await manager.boot()

    await manager.haltAll()

    for (const runtime of runtimes.values()) {
      expect(runtime.stop).toHaveBeenCalled()
      expect(runtime.quiesce).toHaveBeenCalled()
    }
    expect(manager.runtime('alpha')).toBeNull()
    // Nothing erased: the reset clears storage itself, once this resolves.
    expect(deps.eraseStores).not.toHaveBeenCalled()
  })
})

describe('VaultManager when the node defaults arrive late', () => {
  const nodeDefaults = { ...FALLBACK_SERVER_DEFAULTS, protocolTimeoutSecs: 60, unpairAck: 'not_required' as const }

  it('names each running vault whose protocol instance keeps the fallback values', async () => {
    const pinned = vault({ id: 'pinned', name: 'Pinned', configOverrides: { protocolTimeoutSecs: 120, unpairAck: 'required' } })
    const { manager, deps } = setup([alpha, pinned], {}, { pinned: 'running' })
    await manager.boot()

    manager.serverDefaultsArrived(FALLBACK_SERVER_DEFAULTS, nodeDefaults)

    // Alpha resolves both fixed values from the node tier, so they moved; the
    // vault that overrides both is unaffected and not mentioned.
    const late = vi.mocked(deps.log).mock.calls.map(([entry]) => entry).filter(e => e.step === 'server_defaults_late')
    expect(late).toHaveLength(1)
    expect(late[0].description).toContain('"Alpha"')
    expect(late[0].description).toContain('replay window 300s (node: 60s)')
    expect(late[0].description).toContain('unpair acknowledgement "required" (node: "not_required")')
  })

  it('says nothing when the node agrees with the fallback, or no vault is running', async () => {
    const { manager, deps } = setup([alpha], {}, { alpha: 'failed' })
    await manager.boot()

    manager.serverDefaultsArrived(FALLBACK_SERVER_DEFAULTS, nodeDefaults)
    manager.serverDefaultsArrived(FALLBACK_SERVER_DEFAULTS, FALLBACK_SERVER_DEFAULTS)

    expect(vi.mocked(deps.log).mock.calls.some(([e]) => e.step === 'server_defaults_late')).toBe(false)
  })
})
