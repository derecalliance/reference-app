// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ServerDefaultsResult } from '../api'
import { FALLBACK_SERVER_DEFAULTS, type ServerDefaults } from '../config'
import { loadServerDefaults, SERVER_DEFAULTS_RETRY_DELAYS_MS } from './serverDefaultsLoader'

const NODE_DEFAULTS: ServerDefaults = { ...FALLBACK_SERVER_DEFAULTS, protocolTimeoutSecs: 42 }

const down: ServerDefaultsResult = { defaults: FALLBACK_SERVER_DEFAULTS, reachable: false, fromServer: false }
const served: ServerDefaultsResult = { defaults: NODE_DEFAULTS, reachable: true, fromServer: true }
const servedError: ServerDefaultsResult = { defaults: FALLBACK_SERVER_DEFAULTS, reachable: true, fromServer: false }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** Let the attempt's promise settle. */
const flush = () => vi.advanceTimersByTimeAsync(0)

describe('loadServerDefaults', () => {
  it('loads once and stops when the node answers first time', async () => {
    const fetch = vi.fn(async () => served)
    const onLoaded = vi.fn()
    loadServerDefaults({ fetch, onLoaded })
    await flush()

    expect(onLoaded).toHaveBeenCalledWith(NODE_DEFAULTS)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('retries with growing delays until the node answers, then stops', async () => {
    const answers = [down, servedError, down, served]
    const fetch = vi.fn(async () => answers.shift() ?? served)
    const onLoaded = vi.fn()
    loadServerDefaults({ fetch, onLoaded })
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(SERVER_DEFAULTS_RETRY_DELAYS_MS[0] - 1)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(2)

    // A served error status leaves the fallback in place too, so it is retried.
    await vi.advanceTimersByTimeAsync(SERVER_DEFAULTS_RETRY_DELAYS_MS[1])
    expect(fetch).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(SERVER_DEFAULTS_RETRY_DELAYS_MS[2])
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(onLoaded).toHaveBeenCalledExactlyOnceWith(NODE_DEFAULTS)

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('settles at the longest delay while the node stays down', async () => {
    const fetch = vi.fn(async () => down)
    loadServerDefaults({ fetch, onLoaded: vi.fn() })

    // Ten minutes down: the schedule ramps up, then one request per 30 s.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const ramp = SERVER_DEFAULTS_RETRY_DELAYS_MS.slice(0, -1).reduce((a, b) => a + b, 0)
    const cap = SERVER_DEFAULTS_RETRY_DELAYS_MS.at(-1) ?? 0
    const expected = 1 + (SERVER_DEFAULTS_RETRY_DELAYS_MS.length - 1) + Math.floor((10 * 60_000 - ramp) / cap)
    expect(fetch).toHaveBeenCalledTimes(expected)
    expect(fetch.mock.calls.length).toBeLessThan(30)
  })

  it('retries at once when told the node is back, without doubling up', async () => {
    let answer = down
    const fetch = vi.fn(async () => answer)
    const onLoaded = vi.fn()
    const loader = loadServerDefaults({ fetch, onLoaded })
    await flush()
    await vi.advanceTimersByTimeAsync(30_000)
    const before = fetch.mock.calls.length

    answer = served
    loader.retryNow()
    loader.retryNow() // still in flight: joined, not repeated
    await flush()
    expect(fetch).toHaveBeenCalledTimes(before + 1)
    expect(onLoaded).toHaveBeenCalledExactlyOnceWith(NODE_DEFAULTS)

    loader.retryNow()
    await flush()
    expect(fetch).toHaveBeenCalledTimes(before + 1)
  })

  it('does nothing more once stopped, even if an attempt lands afterwards', async () => {
    let answer: (result: ServerDefaultsResult) => void = () => {}
    const fetch = vi.fn(() => new Promise<ServerDefaultsResult>(resolve => (answer = resolve)))
    const onLoaded = vi.fn()
    const loader = loadServerDefaults({ fetch, onLoaded })

    loader.stop()
    answer(served)
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(onLoaded).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
