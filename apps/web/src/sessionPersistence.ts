// PendingPairing.channelId is a bigint and can't be JSON-serialized directly.
// We encode it as { __bigint: "<decimal string>" } and decode on the way back.

import type { OwnerSession, ParticipantSession } from './types'

type AnySession =
  | { type: 'owner'; session: OwnerSession }
  | { type: 'participant'; session: ParticipantSession }

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
    const wrapped: AnySession = { type: 'owner', session }
    const key = sessionStorageKey(session.sessionId)
    localStorage.setItem(key, JSON.stringify(wrapped, replacer))
    localStorage.setItem(ACTIVE_KEY, session.sessionId)
  } catch {
    // Storage quota exceeded or private browsing — silently ignore.
  }
}

export function persistParticipantSession(session: ParticipantSession): void {
  try {
    const wrapped: AnySession = { type: 'participant', session }
    // Use a distinct key so participant and owner sessions for the same session ID don't collide.
    const key = `derec:participant-session:${session.sessionId}:${session.participantId}`
    localStorage.setItem(key, JSON.stringify(wrapped, replacer))
    localStorage.setItem(ACTIVE_KEY, session.sessionId)
  } catch {
    // Storage quota exceeded or private browsing — silently ignore.
  }
}

/**
 * Backfill fields that were added after sessions were already persisted.
 * Without this, loading an older session would leave required fields as
 * `undefined`, which breaks runtime code that accesses them directly.
 */
function normalizeSession(raw: Partial<OwnerSession> & Pick<OwnerSession, 'sessionId'>): OwnerSession {
  return {
    ...raw,
    secretBag: raw.secretBag ?? null,
    pendingPairings: raw.pendingPairings ?? [],
    minParticipants: raw.minParticipants ?? 2,
    recommendedParticipants: raw.recommendedParticipants ?? 5,
    recoveredSecrets: raw.recoveredSecrets ?? [],
    recoveryProgress: raw.recoveryProgress ?? null,
    replicas: raw.replicas ?? [],
    heldShares: raw.heldShares ?? [],
    recoveryChannelLinks: raw.recoveryChannelLinks ?? [],
    participants: (raw.participants ?? []).map(h => ({
      ...h,
      secretShares: h.secretShares ?? [],
      offline: h.offline ?? false,
    })),
  } as OwnerSession
}

export function loadSessionById(sessionId: string): OwnerSession | null {
  try {
    const raw = localStorage.getItem(sessionStorageKey(sessionId))
    if (!raw) return null
    const parsed = JSON.parse(raw, reviver)
    // Sessions are wrapped in an AnySession envelope: { type, session }.
    const session = parsed && typeof parsed === 'object' && 'session' in parsed
      ? parsed.session
      : parsed
    if (!session || !session.sessionId) return null
    return normalizeSession(session as OwnerSession)
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

export function deleteSession(sessionId: string): void {
  localStorage.removeItem(sessionStorageKey(sessionId))
  if (localStorage.getItem(ACTIVE_KEY) === sessionId) {
    localStorage.removeItem(ACTIVE_KEY)
  }
}

export function deleteParticipantSession(sessionId: string, participantId: string): void {
  const key = `derec:participant-session:${sessionId}:${participantId}`
  localStorage.removeItem(key)
  if (localStorage.getItem(ACTIVE_KEY) === sessionId) {
    localStorage.removeItem(ACTIVE_KEY)
  }
}
