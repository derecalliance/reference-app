// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { apiGetActors, type BEActorWithStatus } from '../api'
import type { ServerDefaults } from '../config'
import { isReplicaChannel } from '../ownerPairing'
import { resolveVaultConfig } from '../protocolDefaults'
import { loadReplicaState } from '../replicaFlows'
import type { ToastOrigin } from '../toastBus'
import type { Vault } from '../types'
import { VaultRuntime } from './runtime'
import type { VaultLogger, VaultNotifier, VaultRuntimeDeps, VaultRuntimeState } from './types'

/** Where a vault stands in this tab. */
export type VaultRunState =
  /** Its runtime is being built or started. */
  | 'starting'
  /** Polling, ticking and processing. */
  | 'running'
  /** Released by this tab; its record is kept. Open starts it again. */
  | 'stopped'
  /** Its runtime could not start. Retry is offered; nothing else is affected. */
  | 'failed'
  /** Another tab holds its lock. Claim is offered. */
  | 'elsewhere'
  /** A failed replica adoption erased its stores; it stays stopped. */
  | 'blocked'

/** One row of the vault list. */
export interface VaultEntry {
  id: string
  name: string
  state: VaultRunState
  /** Why `state` is `failed`. */
  failure: string | null
  pairedCount: number
  bagVersion: number | null
  replicaCount: number
  /** Open attention items — what the row's badge counts. */
  attention: number
}

/** An exclusive per-vault lock; `null` from `acquire` means another tab holds it. */
export interface VaultLocks {
  acquire(id: string): Promise<{ release(): Promise<void> } | null>
  /**
   * Ids locked by any tab, this one included. Advisory — it labels rows that
   * another tab claimed or let go; `acquire` remains the decision. Optional:
   * without it, rows still appear and disappear, but keep their state.
   */
  held?(): Promise<Set<string>>
}

/** Where vault records live. */
export interface VaultStorage {
  /** Ids of every stored vault record. */
  list(): string[]
  /** The record, or `null` when missing or unreadable. */
  load(id: string): Vault | null
  /** Save a record. `false` when storage refused it (quota, private mode). */
  persist(vault: Vault): boolean
  remove(id: string): void
}

/**
 * The app's toasts — `reportError` / `reportInfo` in `toastBus.ts`. An origin
 * marks a toast as coming from a vault not on screen.
 */
export interface VaultManagerNotifier {
  error: (message: string, cause?: unknown, context?: Record<string, unknown>, origin?: ToastOrigin) => void
  info: (message: string, origin?: ToastOrigin) => void
  /**
   * The node stopped or resumed answering mailbox polls — one standing notice
   * for every vault, rather than one error per vault per poll. Optional:
   * without it, each vault reports its own failed polls.
   */
  nodeUnreachable?: (unreachable: boolean) => void
}

export interface VaultManagerDeps {
  log: VaultLogger
  notify: VaultManagerNotifier
  getServerDefaults: () => ServerDefaults
  locks: VaultLocks
  storage: VaultStorage
  /** Erase a vault's protocol stores and replica bookkeeping. */
  eraseStores: (vault: Vault) => void
  /** Build a runtime. Injectable so specs need no WASM. */
  createRuntime?: (vault: Vault, deps: VaultRuntimeDeps) => VaultRuntime
  /** Read the node's actor roster. Defaults to `apiGetActors`. */
  fetchActors?: () => Promise<BEActorWithStatus[]>
  /**
   * Tell other tabs this one took or gave up a vault, so their lists follow.
   * Defaults to telling nobody.
   */
  announce?: () => void
}

interface Slot {
  id: string
  /** The last record seen — from storage, then from the runtime. */
  vault: Vault
  state: VaultRunState
  failure: string | null
  attention: number
  runtime: VaultRuntime | null
  lock: { release(): Promise<void> } | null
  unsubscribe: (() => void) | null
  /** A save failed and was reported; cleared by the next that succeeds. */
  saveFailed: boolean
  /** Attention items already seen, so each raises at most one banner. */
  announced: Set<string>
}

/**
 * Every vault this tab runs, and the one place their lifetimes are decided.
 *
 * React-free, like `VaultRuntime`: a vault keeps running whether or not
 * anything renders it, so React only subscribes. The manager owns each vault's
 * runtime, its Web Lock and the persistence of its record; the view attaches to
 * whichever runtime is on screen.
 *
 * Running a vault means holding its lock, because two tabs draining one
 * destructive mailbox would split its messages arbitrarily. So this tab claims
 * every vault it knows about at boot, and one another tab holds is listed as
 * `elsewhere` with an explicit Claim rather than stolen on a timer.
 */
export class VaultManager {
  /** Roster cadence while any vault has a flow in flight or is auto-pairing. */
  static readonly ROSTER_FAST_MS = 500
  /** Roster cadence otherwise. */
  static readonly ROSTER_IDLE_MS = 5000

  private readonly deps: VaultManagerDeps
  private readonly slots = new Map<string, Slot>()
  private readonly listeners = new Set<() => void>()
  private cachedEntries: readonly VaultEntry[] = []
  /** Each slot's last row, kept so an unchanged row stays the same object. */
  private readonly entryCache = new Map<string, VaultEntry>()
  /** Claims in flight, by vault id — a second Open or Claim joins the first. */
  private readonly claims = new Map<string, Promise<boolean>>()
  /** Vaults whose last mailbox poll did not reach the node. */
  private readonly unreachable = new Set<string>()
  private booted = false
  /** The vault the view shows; `null` on the list or the wizard. */
  private onScreen: string | null = null

  // ── The shared roster ──────────────────────────────────────────────────────
  //
  // `apiGetActors()` returns the same node-wide list for every vault, so it is
  // fetched once here and handed to each running vault's fold. This is the one
  // loop that need not multiply with the number of vaults.
  private rosterTimer: ReturnType<typeof setInterval> | null = null
  private lastRosterAt = Number.NEGATIVE_INFINITY
  private fetchingRoster = false
  private latestRoster: readonly BEActorWithStatus[] | null = null
  private readonly rosterListeners = new Set<(actors: readonly BEActorWithStatus[]) => void>()

  constructor(deps: VaultManagerDeps) {
    this.deps = deps
  }

  /**
   * Take up every stored vault: lock it and start it, or list it as held
   * elsewhere. The list is populated before any runtime starts, so it can
   * render at once; the vaults then come up in parallel.
   */
  async boot(): Promise<void> {
    this.startRoster()
    const loaded: Slot[] = []
    for (const id of this.deps.storage.list()) {
      if (this.slots.has(id)) continue
      const vault = this.deps.storage.load(id)
      if (!vault) continue
      const slot = this.newSlot(vault)
      this.slots.set(id, slot)
      loaded.push(slot)
    }
    this.booted = true
    // Notified even with no rows: being booted is itself news to a route that
    // was waiting to tell "still loading" from "missing".
    this.changed({ notify: true })
    await Promise.all(loaded.map(slot => this.claimAndStart(slot)))
  }

  /**
   * Take on a newly set-up vault. `false` — and nothing persisted — when
   * another tab already holds it.
   */
  async create(vault: Vault): Promise<boolean> {
    // Already held here — claiming this browser's own stopped vault, say. Its
    // record is the real one; the wizard's is blank, and saving it would
    // disagree with the stores still under the same id.
    if (this.slots.has(vault.id)) return this.open(vault.id)
    const lock = await this.deps.locks.acquire(vault.id)
    if (!lock) return false
    const slot = this.slots.get(vault.id) ?? this.newSlot(vault)
    slot.vault = vault
    slot.lock = lock
    this.slots.set(vault.id, slot)
    this.persist(slot, vault)
    this.deps.announce?.()
    await this.start(slot)
    return true
  }

  /** Start a stopped vault, or claim one another tab has let go. */
  async open(id: string): Promise<boolean> {
    const slot = this.slots.get(id)
    if (!slot) return false
    if (slot.runtime) return true
    return this.claimAndStart(slot)
  }

  /** Try a vault that failed to start again. */
  async retry(id: string): Promise<void> {
    const slot = this.slots.get(id)
    if (!slot?.runtime || slot.state !== 'failed') return
    await this.startRuntime(slot, slot.runtime)
  }

  /** Stop a vault and free its lock. Its record is kept. */
  async release(id: string): Promise<void> {
    const slot = this.slots.get(id)
    if (!slot) return
    await this.stopAndUnlock(slot)
    slot.state = 'stopped'
    this.changed()
    this.deps.announce?.()
  }

  /**
   * Stop a vault, erase its stores and forget it. The runtime is stopped
   * first: a drain still running over a cleared namespace would write into it.
   */
  async remove(id: string): Promise<void> {
    const slot = this.slots.get(id)
    if (!slot) return
    const runtime = slot.runtime
    runtime?.stop()
    // Stopping clears the timers; a drain or command already inside the
    // protocol lock still finishes, and would write into the erased stores.
    await runtime?.quiesce()
    this.deps.eraseStores(slot.vault)
    await this.stopAndUnlock(slot)
    this.deps.storage.remove(id)
    this.slots.delete(id)
    this.changed()
    this.deps.announce?.()
  }

  /** Release everything this tab holds — `pagehide`. Its rows read stopped. */
  async releaseAll(): Promise<void> {
    this.stopRoster()
    const held = [...this.slots.values()].filter(slot => slot.runtime || slot.lock)
    await Promise.all(held.map(slot => this.stopAndUnlock(slot)))
    for (const slot of held) slot.state = 'stopped'
    this.changed()
    this.deps.announce?.()
  }

  /**
   * Stop every vault and wait until none can write again — before this
   * browser's data is wiped.
   *
   * Stopping alone is not enough: a drain or command already inside a
   * protocol lock runs to its end, and its store writes with it, which is how
   * a reset in another tab used to leave orphan keys behind — written by a
   * vault still running on top of storage that no longer existed. Unlike
   * `remove`, nothing is erased here; the caller does that once this resolves.
   */
  async haltAll(): Promise<void> {
    this.stopRoster()
    const slots = [...this.slots.values()]
    const runtimes = slots.flatMap(slot => (slot.runtime ? [slot.runtime] : []))
    for (const runtime of runtimes) runtime.stop()
    await Promise.all(runtimes.map(runtime => runtime.quiesce()))
    await Promise.all(slots.map(slot => this.stopAndUnlock(slot)))
  }

  /**
   * The node's defaults arrived after vaults had started on the built-in
   * fallback (the node was down when the page loaded).
   *
   * Most of a vault's configuration is read when it is used — the watchdog,
   * the auto-accept answers, every timer's protocol timeout — through
   * `getServerDefaults`, so those follow the node from now on with nothing to
   * do here. Two values are fixed into a protocol instance when it is built:
   * the replay window (`inbound_message_secs`) and the unpair-acknowledgement
   * policy. Rebuilding the instance under a vault that may be mid-round or
   * mid-pairing is not safe, so those keep their fallback values until the
   * vault next starts, and each vault where they differ is named in the
   * console rather than left to disagree silently.
   */
  serverDefaultsArrived(previous: ServerDefaults, next: ServerDefaults): void {
    for (const slot of this.slots.values()) {
      const status = slot.runtime?.state().status
      if (status !== 'running' && status !== 'starting') continue

      const startedWith = resolveVaultConfig(slot.vault.configOverrides, previous)
      const nodeWants = resolveVaultConfig(slot.vault.configOverrides, next)
      const fixed: string[] = []
      if (startedWith.protocolTimeoutSecs !== nodeWants.protocolTimeoutSecs) {
        fixed.push(`replay window ${startedWith.protocolTimeoutSecs}s (node: ${nodeWants.protocolTimeoutSecs}s)`)
      }
      if (startedWith.unpairAck !== nodeWants.unpairAck) {
        fixed.push(`unpair acknowledgement "${startedWith.unpairAck}" (node: "${nodeWants.unpairAck}")`)
      }
      if (fixed.length === 0) continue

      this.deps.log({
        role: 'owner',
        flow: 'setup',
        step: 'server_defaults_late',
        description:
          `"${slot.vault.name}" started before the node's defaults could be fetched. Its timers and ` +
          `auto-accept settings follow the node now, but its running protocol instance keeps ` +
          `${fixed.join(' and ')} until the vault next starts — reload the page to apply them.`,
        payload: {
          vaultId: slot.id,
          startedWith: { protocolTimeoutSecs: startedWith.protocolTimeoutSecs, unpairAck: startedWith.unpairAck },
          node: { protocolTimeoutSecs: nodeWants.protocolTimeoutSecs, unpairAck: nodeWants.unpairAck },
        },
      })
    }
  }

  /**
   * Bring the rows of vaults this tab is not running up to date with what
   * other tabs did: claimed one (now `elsewhere`), let one go (`stopped`),
   * created one (a new row) or removed one (row gone).
   *
   * Without this a tab kept showing "Stopped — Open" for a vault another tab
   * had just claimed, and offered nothing for one it had just created. A
   * vault running *here* is never touched: its lock is this tab's, so no
   * other tab can have changed it.
   */
  async syncWithOtherTabs(): Promise<void> {
    if (!this.booted) return
    const held = this.deps.locks.held ? await this.deps.locks.held() : null
    const stored = new Set(this.deps.storage.list())
    let changed = false

    for (const slot of [...this.slots.values()]) {
      // Running here, or between "lock taken" and "runtime built": ours.
      if (slot.runtime || slot.state === 'starting') continue
      if (!stored.has(slot.id)) {
        this.slots.delete(slot.id)
        changed = true
        continue
      }
      const record = this.deps.storage.load(slot.id)
      if (record) {
        slot.vault = record
        changed = true
      }
      if (held?.has(slot.id) && slot.state !== 'elsewhere') {
        slot.state = 'elsewhere'
        changed = true
      } else if (held && !held.has(slot.id) && slot.state === 'elsewhere') {
        // Free again, but not claimed back automatically: the owner moved it
        // on purpose, and Open is one click.
        slot.state = 'stopped'
        changed = true
      }
    }

    for (const id of stored) {
      if (this.slots.has(id)) continue
      const vault = this.deps.storage.load(id)
      if (!vault) continue
      const slot = this.newSlot(vault)
      slot.state = held?.has(id) ? 'elsewhere' : 'stopped'
      this.slots.set(id, slot)
      changed = true
    }

    if (changed) this.changed()
  }

  /** The last roster read, or `null` before the first lands. */
  roster(): readonly BEActorWithStatus[] | null {
    return this.latestRoster
  }

  /** Called with each roster as it lands. */
  subscribeRoster(listener: (actors: readonly BEActorWithStatus[]) => void): () => void {
    this.rosterListeners.add(listener)
    return () => {
      this.rosterListeners.delete(listener)
    }
  }

  /**
   * Start polling the roster, with a first read at once so the first rows do
   * not wait a whole interval. Idempotent.
   *
   * Ticks at the fast cadence and fetches when due: every tick while any vault
   * wants the fast cadence, otherwise once per idle interval. Checking every
   * tick is what lets a flow that has just started get a fresh roster within
   * half a second, rather than after the rest of an idle wait.
   */
  startRoster(): void {
    if (this.rosterTimer !== null) return
    this.rosterTimer = setInterval(() => this.rosterTick(), VaultManager.ROSTER_FAST_MS)
    void this.refreshRoster()
  }

  stopRoster(): void {
    if (this.rosterTimer !== null) clearInterval(this.rosterTimer)
    this.rosterTimer = null
  }

  /** Read the roster now and hand it out — after an action that changed it. */
  async refreshRoster(): Promise<void> {
    if (this.fetchingRoster) return
    this.fetchingRoster = true
    this.lastRosterAt = Date.now()
    try {
      const actors = await (this.deps.fetchActors ?? apiGetActors)()
      this.latestRoster = actors
      for (const slot of this.slots.values()) slot.runtime?.applyRoster(actors)
      for (const listener of this.rosterListeners) listener(actors)
    } catch {
      // Transient: the next tick retries, and each vault's mailbox poll is what
      // reports the backend being unreachable.
    } finally {
      this.fetchingRoster = false
    }
  }

  private rosterTick(): void {
    const fast = [...this.slots.values()].some(slot => slot.runtime?.wantsFastCadence())
    if (fast || Date.now() - this.lastRosterAt >= VaultManager.ROSTER_IDLE_MS) {
      void this.refreshRoster()
    }
  }

  /**
   * Whether storage has been read. Before this, a vault with no row is still
   * being read rather than gone — a route to it must wait, not give up.
   */
  isBooted(): boolean {
    return this.booted
  }

  /**
   * Which vault the view shows, or `null` for none. Everything a vault off
   * screen says reaches the owner as a banner naming it; the vault on screen
   * speaks through its own view.
   */
  setOnScreen(id: string | null): void {
    this.onScreen = id
  }

  runtime(id: string): VaultRuntime | null {
    return this.slots.get(id)?.runtime ?? null
  }

  /** The list's rows, by name. The same array until something changes. */
  entries(): readonly VaultEntry[] {
    return this.cachedEntries
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private newSlot(vault: Vault): Slot {
    return {
      id: vault.id,
      vault,
      state: 'starting',
      failure: null,
      attention: 0,
      runtime: null,
      lock: null,
      unsubscribe: null,
      saveFailed: false,
      announced: new Set(),
    }
  }

  /**
   * Lock a vault and start it. Idempotent while in flight: a double-click on
   * Claim used to send a second `acquire` while the first still held the lock
   * request, and the second was told — truthfully, and wrongly for the user —
   * that the vault was held elsewhere.
   */
  private claimAndStart(slot: Slot): Promise<boolean> {
    const inFlight = this.claims.get(slot.id)
    if (inFlight) return inFlight
    const claim = this.claim(slot).finally(() => this.claims.delete(slot.id))
    this.claims.set(slot.id, claim)
    return claim
  }

  private async claim(slot: Slot): Promise<boolean> {
    const lock = slot.lock ?? (await this.deps.locks.acquire(slot.id))
    if (!lock) {
      slot.state = 'elsewhere'
      this.changed()
      return false
    }
    slot.lock = lock
    this.deps.announce?.()
    await this.start(slot)
    return true
  }

  private async start(slot: Slot): Promise<void> {
    const runtime = (this.deps.createRuntime ?? ((v, d) => new VaultRuntime(v, d)))(slot.vault, {
      log: this.deps.log,
      notify: this.notifierFor(slot),
      getServerDefaults: this.deps.getServerDefaults,
      // Only while this runtime is still the slot's: a commit landing after the
      // vault was removed or released must not write its record back.
      onVaultChange: next => {
        if (this.slots.get(slot.id) === slot && slot.runtime === runtime) this.persist(slot, next)
      },
      pollReached: this.deps.notify.nodeUnreachable
        ? reached => {
            if (slot.runtime === runtime) this.pollReached(slot.id, reached)
          }
        : undefined,
    })
    slot.runtime = runtime
    slot.unsubscribe = runtime.subscribe(state => this.follow(slot, runtime, state))
    await this.startRuntime(slot, runtime)
  }

  private async startRuntime(slot: Slot, runtime: VaultRuntime): Promise<void> {
    slot.state = 'starting'
    slot.failure = null
    this.changed()
    await runtime.start()
    this.follow(slot, runtime, runtime.state())
  }

  /**
   * A vault's notifier: toasts pass through, tagged with the vault when it is
   * off screen; outcomes become banners only then. Decided per call, since the
   * vault on screen changes while runtimes keep running.
   */
  private notifierFor(slot: Slot): VaultNotifier {
    const notify = this.deps.notify
    return {
      error: (message, cause, context) => notify.error(message, cause, context, this.originOf(slot)),
      info: message => notify.info(message, this.originOf(slot)),
      outcome: message => {
        const origin = this.originOf(slot)
        if (origin) notify.info(message, origin)
      },
    }
  }

  /** The origin to tag a toast with — `undefined` for the vault on screen. */
  private originOf(slot: Slot): ToastOrigin | undefined {
    if (slot.id === this.onScreen) return undefined
    return { vaultId: slot.id, vaultName: slot.vault.name }
  }

  /**
   * One banner per newly raised decision on a vault off screen. The vault on
   * screen asks in its own modal; its items are still marked seen, so leaving
   * it does not replay them as banners.
   */
  private announceAttention(slot: Slot, attention: VaultRuntimeState['attention']): void {
    const origin = this.originOf(slot)
    for (const item of attention) {
      if (slot.announced.has(item.id)) continue
      slot.announced.add(item.id)
      if (origin) this.deps.notify.info('Waiting for your decision', origin)
    }
    const open = new Set(attention.map(item => item.id))
    for (const id of slot.announced) if (!open.has(id)) slot.announced.delete(id)
  }

  /**
   * Mirror a runtime's state into its row — only while that runtime is still
   * the slot's: a stopped one can still emit on its way out, and must not
   * overwrite the row of whatever replaced it.
   */
  private follow(slot: Slot, runtime: VaultRuntime, state: VaultRuntimeState): void {
    if (slot.runtime !== runtime) return
    slot.vault = state.vault
    slot.attention = state.attention.length
    this.announceAttention(slot, state.attention)
    slot.failure = state.failure
    if (state.status === 'failed') slot.state = 'failed'
    else if (state.status === 'blocked') slot.state = 'blocked'
    else if (state.status === 'running') slot.state = 'running'
    this.changed({ only: slot })
  }

  /**
   * Fold one vault's poll into the node-level notice: raised when the first
   * vault stops reaching the node, cleared when the last one reaches it again.
   */
  private pollReached(id: string, reached: boolean): void {
    const wasUnreachable = this.unreachable.size > 0
    if (reached) this.unreachable.delete(id)
    else this.unreachable.add(id)
    const unreachable = this.unreachable.size > 0
    if (unreachable !== wasUnreachable) this.deps.notify.nodeUnreachable?.(unreachable)
  }

  private async stopAndUnlock(slot: Slot): Promise<void> {
    // A vault no longer polling has no say in whether the node is reachable.
    this.pollReached(slot.id, true)
    slot.unsubscribe?.()
    slot.unsubscribe = null
    slot.runtime?.stop()
    slot.runtime = null
    slot.attention = 0
    slot.announced.clear()
    const lock = slot.lock
    slot.lock = null
    await lock?.release()
  }

  /** Save a record, reporting a refusal once rather than on every commit. */
  private persist(slot: Slot, vault: Vault): void {
    if (this.deps.storage.persist(vault)) {
      slot.saveFailed = false
      return
    }
    if (slot.saveFailed) return
    slot.saveFailed = true
    this.deps.notify.error(
      `Could not save "${vault.name}" — browser storage is full or unavailable. Changes to it will be lost on reload.`,
      undefined,
      { vaultId: vault.id },
      this.originOf(slot),
    )
  }

  /**
   * Bring the rows up to date and tell subscribers — only if a row changed.
   *
   * Runtimes emit far more often than their rows change (every busy toggle,
   * every commit), and every notification re-renders the app. So `only`
   * rebuilds just that vault's row, an unchanged row keeps its object, and a
   * list whose rows are all unchanged is not announced at all.
   */
  private changed(options: { only?: Slot; notify?: boolean } = {}): void {
    const rebuild = options.only ? [options.only] : [...this.slots.values()]
    for (const slot of rebuild) {
      const next = this.entry(slot)
      const previous = this.entryCache.get(slot.id)
      if (!previous || !sameEntry(previous, next)) this.entryCache.set(slot.id, next)
    }
    for (const id of this.entryCache.keys()) if (!this.slots.has(id)) this.entryCache.delete(id)

    const entries = [...this.slots.keys()]
      .flatMap(id => {
        const entry = this.entryCache.get(id)
        return entry ? [entry] : []
      })
      .sort((a, b) => a.name.localeCompare(b.name))
    const same =
      entries.length === this.cachedEntries.length &&
      entries.every((entry, i) => entry === this.cachedEntries[i])
    if (same && !options.notify) return
    if (!same) this.cachedEntries = entries
    for (const listener of this.listeners) listener()
  }

  private entry(slot: Slot): VaultEntry {
    const v = slot.vault
    return {
      id: slot.id,
      name: v.name,
      state: slot.state,
      failure: slot.state === 'failed' ? slot.failure : null,
      // Participant channels only: replicas have their own column, and
      // counting them here too listed every replica twice.
      pairedCount: v.participants.filter(p => p.connectionStatus === 'paired' && !isReplicaChannel(p))
        .length,
      bagVersion: v.secretBag?.currentVersion.version ?? null,
      replicaCount: Object.keys(loadReplicaState(v.id).channels).length,
      attention: slot.attention,
    }
  }
}

function sameEntry(a: VaultEntry, b: VaultEntry): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.state === b.state &&
    a.failure === b.failure &&
    a.pairedCount === b.pairedCount &&
    a.bagVersion === b.bagVersion &&
    a.replicaCount === b.replicaCount &&
    a.attention === b.attention
  )
}
