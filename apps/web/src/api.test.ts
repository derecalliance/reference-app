import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiGetServerDefaults, apiRegisterOwner } from './api'
import { FALLBACK_SERVER_DEFAULTS } from './config'

/** What `fetch` throws when it cannot open a connection at all. */
function connectionRefused() {
  return Promise.reject(new TypeError('Failed to fetch'))
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

describe('api — unreachable backend', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(connectionRefused))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // "Failed to fetch" is the browser's words and names nothing the reader can
  // act on. The one thing they need is which address is unreachable.
  it('names the unreachable server instead of surfacing "Failed to fetch"', async () => {
    await expect(apiRegisterOwner('Alice')).rejects.toThrow(/localhost:5000/)
    await expect(apiRegisterOwner('Alice')).rejects.not.toThrow(/^Failed to fetch$/)
  })

  it('keeps the original failure as the cause', async () => {
    // The friendly message replaces the browser's, so the original has to stay
    // reachable or the actual network error is lost.
    const err = await apiRegisterOwner('Alice').catch((e: unknown) => e)

    expect((err as Error).cause).toBeInstanceOf(TypeError)
  })

  it('reports the server as unreachable when defaults cannot be fetched', async () => {
    // The wizard needs this to warn *before* the user fills in three steps.
    const result = await apiGetServerDefaults()

    expect(result.reachable).toBe(false)
    expect(result.defaults).toEqual(FALLBACK_SERVER_DEFAULTS)
  })
})

describe('api — reachable backend', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports the server as reachable and uses its defaults', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse({ participant_count: 4, protocol_timeout_secs: 99 })),
    )

    const result = await apiGetServerDefaults()

    expect(result.reachable).toBe(true)
    expect(result.defaults.participantCount).toBe(4)
    expect(result.defaults.protocolTimeoutSecs).toBe(99)
  })

  it('treats a served error status as reachable, falling back on the values', async () => {
    // A 500 from /config means the server is up but could not answer. The
    // wizard should not claim it is unreachable — that would send the user
    // hunting for a process that is running fine.
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({ error: 'boom' }, 500)))

    const result = await apiGetServerDefaults()

    expect(result.reachable).toBe(true)
    expect(result.defaults).toEqual(FALLBACK_SERVER_DEFAULTS)
  })

  it('surfaces the server’s own error message for a failed request', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({ error: 'claim_actor_id not found' }, 404)))

    await expect(apiRegisterOwner('Alice', 'nope')).rejects.toThrow('claim_actor_id not found')
  })
})
