// ── Session persistence ───────────────────────────────────────────────────────
//
// Saves and restores OwnerSession to/from localStorage.
//
// The only non-JSON-serializable field is PendingPairing.channelId (bigint).
// We encode it as { __bigint: "<decimal string>" } and decode on the way back.

import type { OwnerSession } from './types'

const ACTIVE_KEY = 'derec:active-session'

function sessionStorageKey(sessionId: string): string {
  return `derec:session:${sessionId}`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function replacer(_: string, value: any): any {
  if (typeof value === 'bigint') return { __bigint: value.toString() }
  return value
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reviver(_: string, value: any): any {
  if (value && typeof value === 'object' && '__bigint' in value) {
    return BigInt(value.__bigint as string)
  }
  return value
}

export function persistSession(session: OwnerSession): void {
  try {
    const key = sessionStorageKey(session.sessionId)
    localStorage.setItem(key, JSON.stringify(session, replacer))
    localStorage.setItem(ACTIVE_KEY, session.sessionId)
  } catch {
    // Storage quota exceeded or private browsing — silently ignore.
  }
}

export function loadSessionById(sessionId: string): OwnerSession | null {
  try {
    const raw = localStorage.getItem(sessionStorageKey(sessionId))
    if (!raw) return null
    return JSON.parse(raw, reviver) as OwnerSession
  } catch {
    return null
  }
}

export function loadLastSession(): OwnerSession | null {
  try {
    const id = localStorage.getItem(ACTIVE_KEY)
    if (!id) return null
    return loadSessionById(id)
  } catch {
    return null
  }
}

export function clearActiveSession(): void {
  localStorage.removeItem(ACTIVE_KEY)
}
