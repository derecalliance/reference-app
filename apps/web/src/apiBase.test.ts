import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveApiBase } from './apiBase'

/**
 * `resolveApiBase` decides where every request goes, and each of its three
 * cases exists for a deployment that breaks under the others:
 *
 * - the derived `:5000` is what makes a phone on the LAN work unconfigured;
 * - same-origin is what makes the published image work on any host port;
 * - an explicit URL is the escape hatch for anything else.
 *
 * Getting the precedence wrong is not a visible error — it is a setup wizard
 * that hangs against an address nothing is listening on.
 */
describe('resolveApiBase', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  /** Pretend the page was served from `origin`. */
  function servedFrom(origin: string) {
    const url = new URL(origin)
    vi.stubGlobal('window', {
      location: {
        origin: url.origin,
        protocol: url.protocol,
        hostname: url.hostname,
      },
    })
  }

  it('derives port 5000 of the serving host when nothing is set', () => {
    // The LAN case: the page came from the laptop, so the API is on the
    // laptop — not on the phone's own localhost.
    servedFrom('http://192.168.0.28:5173')

    expect(resolveApiBase()).toBe('http://192.168.0.28:5000')
  })

  it('uses the page origin under VITE_API_SAME_ORIGIN', () => {
    // The image case: one process serves both, so a page on :8080 must call
    // :8080. The derived default would call :5000 and find nothing.
    vi.stubEnv('VITE_API_SAME_ORIGIN', '1')
    servedFrom('http://example.test:8080')

    expect(resolveApiBase()).toBe('http://example.test:8080')
  })

  it('lets an explicit VITE_API_URL win over same-origin', () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.test')
    vi.stubEnv('VITE_API_SAME_ORIGIN', '1')
    servedFrom('http://example.test:8080')

    expect(resolveApiBase()).toBe('https://api.example.test')
  })

  it('strips a trailing slash from an explicit URL', () => {
    // Otherwise every request path would carry a double slash.
    vi.stubEnv('VITE_API_URL', 'https://api.example.test/')
    servedFrom('http://example.test:8080')

    expect(resolveApiBase()).toBe('https://api.example.test')
  })
})
