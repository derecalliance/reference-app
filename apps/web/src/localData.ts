// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * Wholesale reset of the app's browser storage.
 *
 * The app's persistent state lives under two prefixes:
 *
 * - `derec:` — the vault records written by `vaultPersistence.ts`, the
 *   protocol stores (channels, contacts, secrets, shares, state) written by
 *   `stores.ts`, and the per-vault replica bookkeeping beside them.
 * - `derec.` — browser-wide preferences: this browser's Settings overrides
 *   (`derec.protocolDefaults`) and the last section shown (`derec.section`).
 *
 * Both are swept: the reset dialog promises a start from scratch, and leaving
 * the Settings overrides behind meant the next vault quietly inherited them.
 * Keys owned by anything else on the origin are left alone — and so are the
 * coordination keys (`derec-lock:`, `derec-tabs:`), which hold no data and
 * belong to tabs that are still running.
 */

import { clearReplicaState } from './replicaFlows'
import { resetReplicaId } from './replicaIdentity'
import { clearPendingReplicaOffer } from './replicaOfferStore'
import { clearNamespace } from './stores'

const STORAGE_PREFIXES = ['derec:', 'derec.'] as const

function appKeys(): string[] {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && STORAGE_PREFIXES.some(prefix => key.startsWith(prefix))) keys.push(key)
  }
  return keys
}

/** Number of app-owned entries currently held in localStorage. */
export function countLocalDataEntries(): number {
  try {
    return appKeys().length
  } catch {
    return 0
  }
}

/** Removes every app-owned entry. Returns how many were removed. */
export function clearAllLocalData(): number {
  try {
    const keys = appKeys()
    for (const key of keys) localStorage.removeItem(key)
    return keys.length
  } catch {
    return 0
  }
}

/**
 * Erase everything one vault left in this browser — "Remove from browser".
 *
 * The vault's protocol stores sit under its namespace, but three records sit
 * beside it on purpose, keyed by vault id so they survive an adoption that
 * wipes the namespace: the replica bookkeeping, the pending adoption offer and
 * the vault's replica identity. Removal is not adoption — the vault is gone —
 * so all three go too. Left behind, `derec:replica-id:<vaultId>` outlived the
 * vault it identified.
 */
export function eraseVaultLocalData(vaultId: string): void {
  clearNamespace(`vault:${vaultId}`)
  clearReplicaState(vaultId)
  clearPendingReplicaOffer(vaultId)
  try {
    resetReplicaId(vaultId)
  } catch {
    // Storage unavailable — nothing to remove.
  }
}
