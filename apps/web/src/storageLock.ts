// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { randomId } from './randomId'

/**
 * A best-effort exclusive lock kept in `localStorage`, for when Web Locks is
 * unavailable.
 *
 * Web Locks exists only in a secure context, so a page served over plain HTTP
 * from a LAN address — how a phone on the same network reaches a developer's
 * node — has none, and one-tab-per-vault silently stopped being enforced
 * there. Two tabs then drain one destructive mailbox and split its messages.
 *
 * `localStorage` is shared by every tab of the origin, secure or not, so a
 * record per lock — which tab holds it and when it last said so — gets most of
 * the way back:
 *
 * - **Heartbeat, not ownership.** A tab that crashes cannot release, so a record
 *   counts only while it is fresh. The holder rewrites it every
 *   `HEARTBEAT_MS`; one older than `STALE_MS` is free. The window is wide
 *   because browsers throttle timers in background tabs — to once a minute
 *   after a while in Chrome — and a holder that merely went to the background
 *   must not lose its lock. The cost is that a crashed tab's vaults stay
 *   "open in another tab" for about a minute.
 * - **Write, then read back.** Two tabs can both see a lock free and both
 *   write. `localStorage` writes are not atomic across tabs, so after writing,
 *   the acquirer waits a beat and reads again; whoever's record survived holds
 *   it. Not airtight — this is a guard against a mistake, not a mutex — but it
 *   closes the ordinary race of two tabs opening at once.
 *
 * Keys use a `derec-lock:` prefix, outside the `derec:` data prefix, so a
 * lock is never counted as stored data or mistaken for a vault record.
 */

const KEY_PREFIX = 'derec-lock:'
/** How often a holder refreshes its record. */
export const HEARTBEAT_MS = 10_000
/** How old a record may get before it no longer holds the lock. */
export const STALE_MS = 75_000
/** How long an acquirer waits before reading its write back. */
const CONFIRM_DELAY_MS = 40

/** This page load. A reload is a new holder, as it is for Web Locks. */
const TAB_ID = randomId()

interface LockRecord {
  tab: string
  at: number
}

/** Locks this page holds, so a second request from the same page is refused too. */
const heldHere = new Map<string, ReturnType<typeof setInterval>>()

function readRecord(key: string): LockRecord | null {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { tab, at } = parsed as Partial<LockRecord>
    return typeof tab === 'string' && typeof at === 'number' ? { tab, at } : null
  } catch {
    return null
  }
}

function writeRecord(key: string): void {
  localStorage.setItem(key, JSON.stringify({ tab: TAB_ID, at: Date.now() } satisfies LockRecord))
}

function isFresh(record: LockRecord | null, now = Date.now()): record is LockRecord {
  return record !== null && now - record.at < STALE_MS
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** A held storage lock; `release` is idempotent. */
export interface StorageLock {
  release: () => Promise<void>
}

/**
 * Take `name` if no other holder has a fresh record of it. Never waits for
 * the lock; `null` means held.
 */
export async function acquireStorageLock(name: string): Promise<StorageLock | null> {
  const key = `${KEY_PREFIX}${name}`
  if (heldHere.has(key)) return null

  try {
    const existing = readRecord(key)
    if (isFresh(existing) && existing.tab !== TAB_ID) return null

    writeRecord(key)
    await wait(CONFIRM_DELAY_MS)
    if (readRecord(key)?.tab !== TAB_ID) return null
    // A same-page request that raced this one through the wait.
    if (heldHere.has(key)) return null
  } catch {
    // Storage refused (private mode, quota). The lock is advisory; failing to
    // take it must not stop the vault from running.
    return { release: async () => {} }
  }

  const heartbeat = setInterval(() => {
    try {
      // Only while still ours: another tab may have taken over a record that
      // went stale while this one was suspended.
      if (readRecord(key)?.tab === TAB_ID) writeRecord(key)
    } catch {
      // Storage refused this beat; the next one tries again.
    }
  }, HEARTBEAT_MS)
  heldHere.set(key, heartbeat)

  let released = false
  return {
    release: async () => {
      if (released) return
      released = true
      clearInterval(heartbeat)
      heldHere.delete(key)
      try {
        if (readRecord(key)?.tab === TAB_ID) localStorage.removeItem(key)
      } catch {
        // Unreadable storage: the record goes stale on its own.
      }
    },
  }
}

/** Names with a fresh record — held by some tab, including this one. */
export function heldStorageLocks(): Set<string> {
  const names = new Set<string>()
  try {
    const now = Date.now()
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(KEY_PREFIX)) continue
      if (isFresh(readRecord(key), now)) names.add(key.slice(KEY_PREFIX.length))
    }
  } catch {
    return new Set()
  }
  return names
}
