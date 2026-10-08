// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { ServerDefaultsResult } from '../api'
import type { ServerDefaults } from '../config'

/**
 * How long to wait before each retry, in order; the last delay repeats.
 *
 * Bounded rather than exponential without end: a node that comes back after
 * an hour should still be picked up within half a minute, and one request
 * every 30 s against a node that stays down is no load at all.
 */
export const SERVER_DEFAULTS_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000]

export interface ServerDefaultsLoaderDeps {
  /** One attempt — `apiGetServerDefaults`, which never rejects. */
  fetch: () => Promise<ServerDefaultsResult>
  /** The node answered with its defaults. Called at most once. */
  onLoaded: (defaults: ServerDefaults) => void
  delaysMs?: readonly number[]
}

export interface ServerDefaultsLoader {
  /**
   * Try again now instead of at the next scheduled attempt — the node was just
   * seen answering. A no-op once loaded, while an attempt is in flight, or
   * after `stop`, so a burst of signals sends one request, not a storm.
   */
  retryNow(): void
  /** Give up: no further attempt, and `onLoaded` is never called. */
  stop(): void
}

/**
 * Fetch the node's defaults, retrying until the first real answer.
 *
 * A tab opened while the node is down otherwise kept the built-in fallback
 * until someone reloaded it. Only an answer the node actually served counts:
 * an unreachable node and a served error status both leave the fallback in
 * place, so both are retried. Once loaded, it stops for good — the defaults
 * are an operator's file read at boot and do not change under a running node.
 */
export function loadServerDefaults(deps: ServerDefaultsLoaderDeps): ServerDefaultsLoader {
  const delays = deps.delaysMs ?? SERVER_DEFAULTS_RETRY_DELAYS_MS
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let finished = false

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const attempt = () => {
    clearTimer()
    if (finished || inFlight) return
    inFlight = true
    void deps.fetch().then(
      result => settle(result.fromServer ? result.defaults : null),
      () => settle(null),
    )
  }

  const settle = (defaults: ServerDefaults | null) => {
    inFlight = false
    if (finished) return
    if (defaults) {
      finished = true
      deps.onLoaded(defaults)
      return
    }
    const delay = delays[Math.min(failures, delays.length - 1)]
    failures += 1
    timer = setTimeout(attempt, delay)
  }

  attempt()

  return {
    retryNow: attempt,
    stop: () => {
      finished = true
      clearTimer()
    },
  }
}
