// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * Hash routes: which screen of the Owner section is showing.
 *
 * Hash rather than path routing because the app is served from GitHub Pages,
 * where a deep path like `/reference-app/secret/abc` 404s without SPA-fallback
 * configuration — and adding a router dependency to parse three shapes would
 * be more machinery than the job. `BASE_PATH` is untouched.
 *
 * The secret segment is the local secret id — the owner-role actor UUID — and never
 * the `secret_id`, so nothing protocol-sensitive lands in the URL.
 */

export type Route =
  | { kind: 'list' }
  | { kind: 'new'; flow: 'setup' | 'claim' }
  /** `tab` opens one of the secret page's tabs — what the notification bell links to. */
  | { kind: 'secret'; id: string; tab?: SecretRouteTab }

/** The secret page tabs a route can open. */
export type SecretRouteTab = 'notifications'

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
  // `#/vault/…` is the same page under its name before the rename, kept so
  // links and bookmarks from then still open it.
  if ((parts[0] === 'secret' || parts[0] === 'vault') && parts[1] !== '' && (parts.length === 2 || (parts.length === 3 && parts[2] === 'notifications'))) {
    try {
      const id = decodeURIComponent(parts[1])
      return parts.length === 3 ? { kind: 'secret', id, tab: 'notifications' } : { kind: 'secret', id }
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
    case 'secret':
      return `#/secret/${encodeURIComponent(route.id)}${route.tab ? `/${route.tab}` : ''}`
  }
}

/** Go to a route. The `hashchange` it causes is what re-renders. */
export function navigate(route: Route): void {
  window.location.hash = formatRoute(route)
}

/** Go to `route` in place of the current history entry. */
export function replaceRoute(route: Route): void {
  window.location.replace(formatRoute(route))
}
