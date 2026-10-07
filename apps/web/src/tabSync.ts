// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * Messages between this app's tabs.
 *
 * Every tab of the origin shares one `localStorage` but runs its own vaults,
 * so a change made in one tab — a vault claimed, released, removed, or the
 * whole browser's data reset — has to be *told* to the others; reading storage
 * again is not enough, because what changed is often a lock or a runtime
 * rather than a stored row.
 *
 * `BroadcastChannel` where it exists, which is every current browser and works
 * on insecure origins too. Where it does not, a write to a dedicated
 * `localStorage` key, whose `storage` event every other tab receives.
 */

export type TabMessage =
  /** Another tab is wiping this browser's data: stop every vault, now. */
  | { kind: 'reset-started' }
  /** A vault was claimed, released, created or removed in another tab. */
  | { kind: 'vaults-changed' }

const CHANNEL_NAME = 'derec:tabs'
/** Outside the `derec:` data prefix, so a reset's own sweep never touches it. */
const FALLBACK_KEY = 'derec-tabs:message'

let channel: BroadcastChannel | null | undefined

function broadcastChannel(): BroadcastChannel | null {
  if (channel === undefined) {
    channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null
  }
  return channel
}

function isTabMessage(value: unknown): value is TabMessage {
  if (typeof value !== 'object' || value === null) return false
  const kind = (value as { kind?: unknown }).kind
  return kind === 'reset-started' || kind === 'vaults-changed'
}

/** Tell every other tab. The sending tab does not hear its own message. */
export function postTabMessage(message: TabMessage): void {
  const bc = broadcastChannel()
  if (bc) {
    bc.postMessage(message)
    return
  }
  try {
    // The nonce makes each write a change, so a repeated message still fires.
    localStorage.setItem(FALLBACK_KEY, JSON.stringify({ ...message, nonce: Math.random() }))
  } catch {
    // Storage refused: the other tabs catch up when they are next focused.
  }
}

/** Hear what other tabs post. Returns the unsubscribe. */
export function onTabMessage(listener: (message: TabMessage) => void): () => void {
  const bc = broadcastChannel()
  if (bc) {
    const handle = (event: MessageEvent<unknown>) => {
      if (isTabMessage(event.data)) listener(event.data)
    }
    bc.addEventListener('message', handle)
    return () => bc.removeEventListener('message', handle)
  }

  const handle = (event: StorageEvent) => {
    if (event.key !== FALLBACK_KEY || event.newValue === null) return
    try {
      const parsed: unknown = JSON.parse(event.newValue)
      if (isTabMessage(parsed)) listener({ kind: parsed.kind })
    } catch {
      // Not one of ours; ignored.
    }
  }
  window.addEventListener('storage', handle)
  return () => window.removeEventListener('storage', handle)
}
