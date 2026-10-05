// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

// PendingPairing.channelId is a bigint and can't be JSON-serialized directly.
// We encode it as { __bigint: "<decimal string>" } and decode on the way back.

import type { PendingProtectRound, Vault, RecoveredSecret, RecoveredSecretTransport } from './types'
import { protocolName } from './contactDto'

/** Storage envelope. Kept so the stored shape can grow a discriminant later. */
interface StoredVault {
  type: 'vault'
  vault: Vault
}

const VAULT_KEY_PREFIX = 'derec:vault:'

function vaultStorageKey(vaultId: string): string {
  return `${VAULT_KEY_PREFIX}${vaultId}`
}

/**
 * Is this a vault envelope, rather than one of the protocol-store rows that
 * share the prefix?
 *
 * `stores.ts` partitions under `derec:vault:{vaultId}:{secretId}:…`, so prefix
 * alone would match hundreds of channel, share and state rows. The envelope is
 * the one key with nothing after the vault id.
 */
function vaultIdFromKey(key: string): string | null {
  if (!key.startsWith(VAULT_KEY_PREFIX)) return null
  const rest = key.slice(VAULT_KEY_PREFIX.length)
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

/**
 * Save a vault record. Returns `false` when storage refused it — quota
 * exceeded or private browsing — so the caller can say so: swallowing it was
 * defensible with one vault and is silent data loss with ten.
 */
export function persistVault(vault: Vault): boolean {
  try {
    const wrapped: StoredVault = { type: 'vault', vault }
    localStorage.setItem(vaultStorageKey(vault.id), JSON.stringify(wrapped, replacer))
    return true
  } catch {
    return false
  }
}

/** Ids of every stored vault record — the envelopes, not the store rows. */
export function listVaultIds(): string[] {
  const ids: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const id = vaultIdFromKey(localStorage.key(i) ?? '')
      if (id) ids.push(id)
    }
  } catch {
    return []
  }
  return ids
}

/**
 * Lift a roster entry persisted before SDK 0.0.3 onto the endpoint *list*.
 *
 * Recoverable-payload v3 gives every roster entry `transports` — each endpoint
 * with its protocol discriminant — where v2 carried one bare `transport_uri`.
 * The library still decodes a v2 payload off the wire; this is the same
 * lift for a snapshot this app had already written to localStorage, and
 * without it a restore would hand `protocol.restore` entries with no endpoint.
 *
 * v2 stored no discriminant, so the protocol is derived from the scheme —
 * which is exactly the reconstruction v3 exists to retire, and is why nothing
 * new is ever written in this shape.
 */
function normalizeRosterTransports<T extends { transports?: RecoveredSecretTransport[] }>(
  entry: T & { transportUri?: string },
): T {
  // v3, saved before SDK 0.0.6 named protocols, holds `0`/`1`: name them, so
  // `restore` (which now takes names) gets what it expects.
  if (entry.transports) {
    return {
      ...entry,
      transports: entry.transports.map(t => ({ uri: t.uri, protocol: protocolName(t.protocol) })),
    }
  }

  const { transportUri, ...rest } = entry
  const protocol: RecoveredSecretTransport['protocol'] = transportUri?.startsWith('grpc')
    ? 'grpc'
    : 'https'
  return {
    ...rest,
    transports: transportUri ? [{ uri: transportUri, protocol }] : [],
  } as T
}

function normalizeRecoveredSecret(secret: RecoveredSecret): RecoveredSecret {
  const snapshot = secret.snapshot
  if (!snapshot) return secret
  return {
    ...secret,
    snapshot: {
      ...snapshot,
      helpers: (snapshot.helpers ?? []).map(h => normalizeRosterTransports(h)),
      replicas: snapshot.replicas
        ? {
            ...snapshot.replicas,
            members: (snapshot.replicas.members ?? []).map(m => normalizeRosterTransports(m)),
          }
        : undefined,
    },
  }
}

/** Fields older records carry that the current `Vault` shape replaced. */
interface LegacyVaultFields {
  /** Superseded by `pendingProtectRounds` once rounds could overlap. */
  pendingProtectRound?: PendingProtectRound
}

/**
 * Backfill fields that were added after a vault was already persisted.
 * Without this, loading an older record would leave required fields as
 * `undefined`, which breaks runtime code that accesses them directly.
 */
function normalizeVault(raw: LegacyVaultFields & Partial<Vault> & Pick<Vault, 'id'>): Vault {
  const { pendingProtectRound: legacyRound, ...rest } = raw
  return {
    ...rest,
    // Records saved before rounds could overlap held at most one.
    pendingProtectRounds:
      raw.pendingProtectRounds ?? (legacyRound ? [legacyRound] : undefined),
    secretBag: raw.secretBag ?? null,
    pendingPairings: raw.pendingPairings ?? [],
    minParticipants: raw.minParticipants ?? 2,
    recommendedParticipants: raw.recommendedParticipants ?? 5,
    recoveredSecrets: (raw.recoveredSecrets ?? []).map(normalizeRecoveredSecret),
    recoveryProgress: raw.recoveryProgress ?? null,
    recoveryFailures: raw.recoveryFailures ?? [],
    heldShares: raw.heldShares ?? [],
    mainChannels: raw.mainChannels ?? [],
    // Only what this vault overrides. An absent key is not a missing value —
    // it means "follow the browser and server defaults", which is why nothing
    // is backfilled here. Resolve with `resolveVaultConfig`.
    configOverrides: raw.configOverrides ?? {},
    participants: (raw.participants ?? []).map(h => ({
      ...h,
      secretShares: h.secretShares ?? [],
      offline: h.offline ?? false,
    })),
  } as Vault
}

/**
 * The fields nothing can backfill. A record missing one is unreadable: loading
 * it half-way used to throw while the vault list rendered, taking every other
 * vault down with it.
 */
function hasRequiredShape(raw: Record<string, unknown>): boolean {
  const transport = raw.transport as { uri?: unknown } | undefined
  const bag = raw.secretBag as { currentVersion?: { version?: unknown } } | null | undefined
  return (
    typeof raw.name === 'string' &&
    typeof transport?.uri === 'string' &&
    (bag == null || typeof bag.currentVersion?.version === 'number')
  )
}

export function loadVaultById(vaultId: string): Vault | null {
  try {
    const raw = localStorage.getItem(vaultStorageKey(vaultId))
    if (!raw) return null
    const parsed = JSON.parse(raw, reviver)
    // Records are wrapped in a `{ type, vault }` envelope.
    const vault =
      parsed && typeof parsed === 'object' && 'vault' in parsed ? parsed.vault : parsed
    if (!vault || !vault.id) return null
    // Records persisted before protocol state was partitioned by secret have no
    // `secretId`, and their stored channels/shares/secrets sit under keys the
    // current stores cannot read. Treat them as stale so the app offers a fresh
    // setup instead of half-loading state whose protocol keys can never be
    // found.
    if (!vault.secretId) return null
    if (!hasRequiredShape(vault)) return null
    return normalizeVault(vault as Vault & LegacyVaultFields)
  } catch {
    return null
  }
}

/** Remove a vault's record. Its protocol stores are the caller's to erase. */
export function deleteVault(vaultId: string): void {
  localStorage.removeItem(vaultStorageKey(vaultId))
}
