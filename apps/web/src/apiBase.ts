/**
 * Where the backend lives, from this page's point of view.
 *
 * Three cases, in precedence order:
 *
 * 1. `VITE_API_URL` — an explicit address wins over everything.
 * 2. `VITE_API_SAME_ORIGIN` — the API is served by whatever served this page,
 *    on the same origin. This is what the Docker image builds with: the backend
 *    serves both the UI and the API, so a page opened at `http://host:8080`
 *    must call `http://host:8080`.
 * 3. Otherwise port 5000 of **whatever host served this page**, which is what
 *    makes opening the app from a phone on the same network work with no
 *    configuration: the page comes from `http://192.168.0.28:5173`, so the API
 *    is `http://192.168.0.28:5000`.
 *
 * Case 3 alone is wrong the moment the image is published on any other host
 * port — a page served at `:8080` would call `:5000` and find nothing — which
 * is why case 2 exists rather than changing the default.
 *
 * A hardcoded `localhost` cannot do any of this. On a phone `localhost` is the
 * phone, so every request would fail against nothing, and the first symptom is
 * a setup wizard that hangs rather than anything naming the cause.
 */
export function resolveApiBase(): string {
  const configured = import.meta.env.VITE_API_URL as string | undefined
  if (configured) return configured.replace(/\/$/, '')

  // No `window` under Vitest's default environment for pure-module tests.
  if (typeof window === 'undefined') return 'http://localhost:5000'

  if (import.meta.env.VITE_API_SAME_ORIGIN) return window.location.origin

  return `${window.location.protocol}//${window.location.hostname}:5000`
}

export const API_BASE = resolveApiBase()
