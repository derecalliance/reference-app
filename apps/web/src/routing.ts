// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * Hash routes: which screen of the Owner section is showing.
 *
 * Hash rather than path routing because the app is served from GitHub Pages,
 * where a deep path like `/reference-app/vault/abc` 404s without SPA-fallback
 * configuration — and adding a router dependency to parse three shapes would
 * be more machinery than the job. `BASE_PATH` is untouched.
 *
 * The vault segment is the vault id — the owner-role actor UUID — and never
 * the `secret_id`, so nothing protocol-sensitive lands in the URL.
 */

export type Route =
  | { kind: 'list' }
  | { kind: 'new'; flow: 'setup' | 'claim' }
  | { kind: 'vault'; id: string }

const LIST: Route = { kind: 'list' }

/**
 * Read a `location.hash`. Anything unrecognised is the list: a stale or mistyped
 * link lands somewhere useful rather than on a blank page.
 */
export function parseHash(hash: string): Route {
  if (!hash.startsWith('#/') && hash !== '' && hash !== '#') return LIST
  // One trailing slash is tolerated; empty segments anywhere else are not.
  const path = hash.replace(/^#\/?/, '').replace(/\/$/, '')
  if (path === '') return LIST
  const parts = path.split('/')

  if (parts[0] === 'new') {
    if (parts.length === 1) return { kind: 'new', flow: 'setup' }
    if (parts.length === 2 && parts[1] === 'claim') return { kind: 'new', flow: 'claim' }
    return LIST
  }
  if (parts[0] === 'vault' && parts.length === 2 && parts[1] !== '') {
    try {
      return { kind: 'vault', id: decodeURIComponent(parts[1]) }
    } catch {
      return LIST
    }
  }
  return LIST
}

/** The hash for a route. */
export function formatRoute(route: Route): string {
  switch (route.kind) {
    case 'list':
      return '#/'
    case 'new':
      return route.flow === 'claim' ? '#/new/claim' : '#/new'
    case 'vault':
      return `#/vault/${encodeURIComponent(route.id)}`
  }
}

/** Go to a route. The `hashchange` it causes is what re-renders. */
export function navigate(route: Route): void {
  window.location.hash = formatRoute(route)
}
