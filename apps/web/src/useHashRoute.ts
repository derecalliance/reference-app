// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useSyncExternalStore } from 'react'

import { parseHash, type Route } from './routing'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

/** The hash is the snapshot: a string, so React's equality check is exact. */
function snapshot(): string {
  return window.location.hash
}

/** The current route, re-rendering on every `hashchange`. */
export function useHashRoute(): Route {
  return parseHash(useSyncExternalStore(subscribe, snapshot))
}
