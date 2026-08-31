// PendingPairing.channelId is a bigint and can't be JSON-serialized directly.
// We encode it as { __bigint: "<decimal string>" } and decode on the way back.

import type { Owner } from './types'
import {
  DEFAULT_AUTHENTICATION_METHOD,
  DEFAULT_AUTO_ACCEPT_UNPAIR_REQUESTS,
  DEFAULT_PROTOCOL_TIMEOUT_SECS,
  DEFAULT_UNPAIR_ACK,
  normalizeAuthenticationMethod,
  normalizeUnpairAck,
} from './config'

/** Storage envelope. Kept so the stored shape can grow a discriminant later. */
interface StoredOwner {
  type: 'owner'
  owner: Owner
}

/**
 * Which owner *this tab* is driving.
 *
 * `sessionStorage`, not `localStorage`: it is scoped to one tab by definition
 * and survives reload, which is exactly the lifetime this pointer wants. Held
 * in localStorage it was a single global cursor, so a second tab setting up an
 * owner silently moved the first tab's idea of "current".
 *
 * Owner *state* stays in localStorage — it is the same data whichever tab reads
 * it, and every key is already partitioned by owner id.
 */
const ACTIVE_KEY = 'derec:active-owner'

const OWNER_KEY_PREFIX = 'derec:owner:'

function ownerStorageKey(ownerId: string): string {
  return `${OWNER_KEY_PREFIX}${ownerId}`
}

/**
 * Is this an owner envelope, rather than one of the protocol-store rows that
 * share the prefix?
 *
 * `stores.ts` partitions under `derec:owner:{ownerId}:{secretId}:…`, so prefix
 * alone would match hundreds of channel, share and state rows. The envelope is
 * the one key with nothing after the owner id.
 */
function ownerIdFromKey(key: string): string | null {
  if (!key.startsWith(OWNER_KEY_PREFIX)) return null
  const rest = key.slice(OWNER_KEY_PREFIX.length)
  return rest.length > 0 && !rest.includes(':') ? rest : null
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

export function persistOwner(owner: Owner): void {
  try {
    const wrapped: StoredOwner = { type: 'owner', owner }
    localStorage.setItem(ownerStorageKey(owner.ownerId), JSON.stringify(wrapped, replacer))
    sessionStorage.setItem(ACTIVE_KEY, owner.ownerId)
  } catch {
    // Storage quota exceeded or private browsing — silently ignore.
  }
}

/** Forget which owner this tab was driving, leaving its stored state intact. */
export function clearActiveOwner(): void {
  try {
    sessionStorage.removeItem(ACTIVE_KEY)
  } catch {
    // Storage unavailable — nothing to forget.
  }
}

/**
 * Backfill fields that were added after an owner was already persisted.
 * Without this, loading an older record would leave required fields as
 * `undefined`, which breaks runtime code that accesses them directly.
 */
function normalizeOwner(raw: Partial<Owner> & Pick<Owner, 'ownerId'>): Owner {
  return {
    ...raw,
    secretBag: raw.secretBag ?? null,
    pendingPairings: raw.pendingPairings ?? [],
    minParticipants: raw.minParticipants ?? 2,
    recommendedParticipants: raw.recommendedParticipants ?? 5,
    recoveredSecrets: raw.recoveredSecrets ?? [],
    recoveryProgress: raw.recoveryProgress ?? null,
    recoveryFailures: raw.recoveryFailures ?? [],
    heldShares: raw.heldShares ?? [],
    mainChannels: raw.mainChannels ?? [],
    config: {
      protocolTimeoutSecs:
        raw.config?.protocolTimeoutSecs ?? DEFAULT_PROTOCOL_TIMEOUT_SECS,
      authenticationMethod: normalizeAuthenticationMethod(
        raw.config?.authenticationMethod ?? DEFAULT_AUTHENTICATION_METHOD,
      ),
      unpairAck: normalizeUnpairAck(raw.config?.unpairAck ?? DEFAULT_UNPAIR_ACK),
      autoAcceptUnpairRequests:
        raw.config?.autoAcceptUnpairRequests ?? DEFAULT_AUTO_ACCEPT_UNPAIR_REQUESTS,
    },
    participants: (raw.participants ?? []).map(h => ({
      ...h,
      secretShares: h.secretShares ?? [],
      offline: h.offline ?? false,
    })),
  } as Owner
}

export function loadOwnerById(ownerId: string): Owner | null {
  try {
    const raw = localStorage.getItem(ownerStorageKey(ownerId))
    if (!raw) return null
    const parsed = JSON.parse(raw, reviver)
    // Records are wrapped in a `{ type, owner }` envelope.
    const owner =
      parsed && typeof parsed === 'object' && 'owner' in parsed ? parsed.owner : parsed
    if (!owner || !owner.ownerId) return null
    // Records persisted before protocol state was partitioned by secret have no
    // `ownSecretId`, and their stored channels/shares/secrets sit under the old
    // unpartitioned keys — unreadable by the current stores. Treat them as stale
    // so the app offers a fresh setup instead of half-loading state whose
    // protocol keys can never be found.
    if (!owner.ownSecretId) return null
    return normalizeOwner(owner as Owner)
  } catch {
    return null
  }
}

/**
 * The owner *this tab* was last driving, if any.
 *
 * Non-null only after this tab has picked one, so a freshly opened tab starts
 * at the picker rather than adopting whatever another tab happens to be on.
 * A reload keeps it, which is the point: F5 should not re-prompt.
 */
export function loadActiveOwner(): Owner | null {
  try {
    const id = sessionStorage.getItem(ACTIVE_KEY)
    if (!id) return null
    return loadOwnerById(id)
  } catch {
    return null
  }
}

/** Identity and display fields for one saved owner, for the picker. */
export interface OwnerSummary {
  ownerId: string
  ownerName: string
  /** Paired participants, as a rough "how far along is this one" hint. */
  pairedCount: number
}

/**
 * Every owner saved in this browser, newest-looking last.
 *
 * Read straight from storage rather than from a maintained index: an index
 * would be a second source of truth to keep in step with `persistOwner` and
 * `deleteOwner`, and at this scale scanning is free.
 */
export function listOwners(): OwnerSummary[] {
  const summaries: OwnerSummary[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const ownerId = ownerIdFromKey(localStorage.key(i) ?? '')
      if (!ownerId) continue
      const owner = loadOwnerById(ownerId)
      if (!owner) continue
      summaries.push({
        ownerId: owner.ownerId,
        ownerName: owner.ownerName,
        pairedCount: owner.participants.filter(p => p.connectionStatus === 'paired').length,
      })
    }
  } catch {
    // Storage unavailable — report nothing rather than throwing into render.
    return []
  }
  return summaries.sort((a, b) => a.ownerName.localeCompare(b.ownerName))
}

export function deleteOwner(ownerId: string): void {
  localStorage.removeItem(ownerStorageKey(ownerId))
  if (sessionStorage.getItem(ACTIVE_KEY) === ownerId) {
    sessionStorage.removeItem(ACTIVE_KEY)
  }
}
