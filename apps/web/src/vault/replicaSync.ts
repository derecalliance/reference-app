// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { DeRecEvent } from '@derec-alliance/web'

import type { VaultLogger } from './types'

/** What catching up needs from the vault it runs in. */
export interface ReplicaCatchUpDeps {
  /**
   * Ask the replica group for its newest copy, folding what `start` returns.
   * Resolves with those same events, so an immediate answer can be read.
   */
  discover(): Promise<readonly DeRecEvent[]>
  /**
   * Whether `channelId` is still a channel this device should pull over: still
   * recorded, still this device's destination side, still confirmed here.
   */
  isEligible(channelId: string): boolean
  log: VaultLogger
  /** The set of syncing channels changed. */
  onChange(): void
}

interface Attempt {
  /** 1-based count of discoveries sent for this channel. */
  attempt: number
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * A replica destination fetching its source's copy, until it lands.
 *
 * Confirming a fingerprint is done by people, so the two devices confirm
 * minutes apart and in either order. A copy pushed before this device confirmed
 * is dropped (`MessageIgnored`, SDK 0.0.6) and not replayed, so once this device
 * confirms it asks the group for the copy itself. The source may not have
 * confirmed yet, in which case it ignores the question — and the library never
 * times out a discovery nobody answers. So this keeps asking, with backoff,
 * until the copy arrives or the group answers that it has nothing newer.
 *
 * One discovery is group-wide, so an answer resolves every channel waiting on
 * it; the copy itself names its channel.
 */
export class ReplicaCatchUp {
  /** How long one attempt waits for an answer before asking again. */
  static readonly ATTEMPT_TIMEOUT_MS = 30_000
  /** Pause before each retry; the last repeats. */
  static readonly RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 20_000, 40_000, 60_000]

  /** The pause before retry number `n` (1-based), capped at the last delay. */
  static retryDelay(n: number): number {
    const delays = ReplicaCatchUp.RETRY_DELAYS_MS
    return delays[Math.min(n, delays.length) - 1]
  }

  private readonly channels = new Map<string, Attempt>()
  /**
   * A discovery's own `start` is in flight. Its events are folded as they come
   * back — a "nobody reachable" completion among them — and that must not be
   * read as the group answering.
   */
  private starting = false

  private readonly deps: ReplicaCatchUpDeps

  constructor(deps: ReplicaCatchUpDeps) {
    this.deps = deps
  }

  /** Channels currently fetching, in the order they started. */
  syncing(): string[] {
    return [...this.channels.keys()]
  }

  /** Begin fetching over `channelId`. Already fetching: nothing changes. */
  start(channelId: string): void {
    if (this.channels.has(channelId)) return
    this.channels.set(channelId, { attempt: 0, timer: null })
    this.deps.onChange()
    void this.attempt(channelId)
  }

  /** Watch every folded event for the outcome of an attempt. */
  observe(event: DeRecEvent): void {
    if (this.channels.size === 0) return

    if (
      (event.type === 'ReplicaSecretInstalled' || event.type === 'ReplicaSecretReceived') &&
      this.channels.has(event.channel_id)
    ) {
      this.finish(event.channel_id, 'the copy arrived')
      return
    }

    if (event.type === 'ReplicaDiscoveryComplete' && !this.starting) {
      if (event.fetched_from === undefined) {
        // Every member answered and none is ahead of this device.
        for (const channelId of this.syncing()) this.finish(channelId, 'the group has nothing newer')
      } else {
        // A fetch is under way; give it a full attempt's time to land.
        for (const channelId of this.syncing()) this.waitForAnswer(channelId)
      }
    }
  }

  /** Stop everything — the vault stopped, or was blocked. */
  stopAll(): void {
    for (const { timer } of this.channels.values()) {
      if (timer !== null) clearTimeout(timer)
    }
    const hadAny = this.channels.size > 0
    this.channels.clear()
    if (hadAny) this.deps.onChange()
  }

  private async attempt(channelId: string): Promise<void> {
    const state = this.channels.get(channelId)
    if (!state) return
    if (!this.deps.isEligible(channelId)) {
      this.finish(channelId, 'the channel is no longer a confirmed destination here')
      return
    }

    state.attempt += 1
    this.deps.log({
      role: 'owner',
      flow: 'sharing',
      step: 'replica_catch_up_attempt',
      description: `Asking the replica group for its copy (attempt ${state.attempt})`,
      payload: { channelId, attempt: state.attempt },
    })

    let events: readonly DeRecEvent[]
    this.starting = true
    try {
      events = await this.deps.discover()
    } catch {
      this.retryLater(channelId)
      return
    } finally {
      this.starting = false
    }
    if (!this.channels.has(channelId)) return

    // A completion straight out of `start` means no member could be reached:
    // nothing was asked, so there is nothing to wait for.
    if (events.some(e => e.type === 'ReplicaDiscoveryComplete')) {
      this.retryLater(channelId)
      return
    }
    this.waitForAnswer(channelId)
  }

  /** Give the current attempt `ATTEMPT_TIMEOUT_MS` to be answered. */
  private waitForAnswer(channelId: string): void {
    this.arm(channelId, ReplicaCatchUp.ATTEMPT_TIMEOUT_MS, () => this.retryLater(channelId))
  }

  private retryLater(channelId: string): void {
    const state = this.channels.get(channelId)
    if (!state) return
    this.arm(channelId, ReplicaCatchUp.retryDelay(state.attempt), () => void this.attempt(channelId))
  }

  private arm(channelId: string, delayMs: number, then: () => void): void {
    const state = this.channels.get(channelId)
    if (!state) return
    if (state.timer !== null) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = null
      then()
    }, delayMs)
  }

  private finish(channelId: string, why: string): void {
    const state = this.channels.get(channelId)
    if (!state) return
    if (state.timer !== null) clearTimeout(state.timer)
    this.channels.delete(channelId)
    this.deps.log({
      role: 'owner',
      flow: 'sharing',
      step: 'replica_catch_up_done',
      description: `Stopped asking the replica group for its copy — ${why}`,
      payload: { channelId, attempts: state.attempt },
    })
    this.deps.onChange()
  }
}
