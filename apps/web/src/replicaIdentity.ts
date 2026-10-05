// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * A device's stable replica identity.
 *
 * The DeRec protocol carries a per-device `u64` under the reserved
 * `derec.replica_id` key; any replica-mode flow on a protocol built without
 * one fails with `ReplicaIdNotConfigured`. Both sides of a replica pair need
 * one — the Owner is the `ReplicaSource`.
 *
 * Keyed per vault, because a vault is what plays the part of a device here: each
 * vault is an independent owner, and two of them sharing one replica id would
 * present themselves to a peer as the same device. This is why the id cannot be
 * a single origin-wide value.
 *
 * The key sits outside the `derec:vault:{vaultId}:` partition on purpose.
 * Adoption wipes that partition to take on another device's vault; the device's
 * own identity must survive that, or it would silently become a different peer.
 */

const STORAGE_PREFIX = 'derec:replica-id:'

function storageKey(vaultId: string): string {
  return `${STORAGE_PREFIX}${vaultId}`
}

function mint(): bigint {
  const buf = new BigUint64Array(1)
  crypto.getRandomValues(buf)
  return buf[0]
}

/**
 * This vault's replica id, if it has one — never minting.
 *
 * For render paths. Rendering must not write: during a browser-data reset a
 * re-render lands *after* storage is cleared and before the reload navigates
 * away, and a minting read there wrote a fresh id back into the wiped storage.
 * The runtime mints the id when the vault starts, before its page can render.
 */
export function readReplicaId(vaultId: string): bigint | null {
  const stored = localStorage.getItem(storageKey(vaultId))
  if (stored === null) return null
  try {
    return BigInt(stored)
  } catch {
    return null
  }
}

/** This vault's replica id, minting and persisting one on first use. */
export function getOrCreateReplicaId(vaultId: string): bigint {
  const key = storageKey(vaultId)
  const stored = localStorage.getItem(key)
  if (stored !== null) {
    try {
      return BigInt(stored)
    } catch {
      // Corrupt value — fall through and mint a fresh one.
    }
  }
  const id = mint()
  localStorage.setItem(key, id.toString())
  return id
}

/** Drops the stored identity. Only for explicit "reset this device" actions. */
export function resetReplicaId(vaultId: string): void {
  localStorage.removeItem(storageKey(vaultId))
}
