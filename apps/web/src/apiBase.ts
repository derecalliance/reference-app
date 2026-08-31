/**
 * Where the backend lives, from this page's point of view.
 *
 * `VITE_API_URL` wins when set. Otherwise the backend is assumed to be on port
 * 5000 of **whatever host served this page** — which is what makes opening the
 * app from a phone on the same network work with no configuration: the page
 * comes from `http://192.168.0.28:5173`, so the API is
 * `http://192.168.0.28:5000`.
 *
 * A hardcoded `localhost` cannot do that. On a phone `localhost` is the phone,
 * so every request would fail against nothing, and the first symptom is a setup
 * wizard that hangs rather than anything naming the cause.
 */
export function resolveApiBase(): string {
  const configured = import.meta.env.VITE_API_URL as string | undefined
  if (configured) return configured.replace(/\/$/, '')

  // No `window` under Vitest's default environment for pure-module tests.
  if (typeof window === 'undefined') return 'http://localhost:5000'

  return `${window.location.protocol}//${window.location.hostname}:5000`
}

export const API_BASE = resolveApiBase()
