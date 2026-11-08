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
 * Keyed per secret, because a secret is what plays the part of a device here: each
 * secret is an independent owner, and two of them sharing one replica id would
 * present themselves to a peer as the same device. This is why the id cannot be
 * a single origin-wide value.
 *
 * The key sits outside the `derec:secret:{localSecretId}:` partition on purpose.
 * Adoption wipes that partition to take on another device's secret; the device's
 * own identity must survive that, or it would silently become a different peer.
 */

const STORAGE_PREFIX = 'derec:replica-id:'

function storageKey(localSecretId: string): string {
  return `${STORAGE_PREFIX}${localSecretId}`
}

function mint(): bigint {
  const buf = new BigUint64Array(1)
  crypto.getRandomValues(buf)
  return buf[0]
}

/**
 * This secret's replica id, if it has one — never minting.
 *
 * For render paths. Rendering must not write: during a browser-data reset a
 * re-render lands *after* storage is cleared and before the reload navigates
 * away, and a minting read there wrote a fresh id back into the wiped storage.
 * The runtime mints the id when the secret starts, before its page can render.
 */
export function readReplicaId(localSecretId: string): bigint | null {
  const stored = localStorage.getItem(storageKey(localSecretId))
  if (stored === null) return null
  try {
    return BigInt(stored)
  } catch {
    return null
  }
}

/** This secret's replica id, minting and persisting one on first use. */
export function getOrCreateReplicaId(localSecretId: string): bigint {
  const key = storageKey(localSecretId)
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

/**
 * Replace this secret's replica id with `id`.
 *
 * For one case only: restoring a secret whose replica group does not name this
 * device's current id, where the device takes over the identity the group
 * knows the secret by — see `restoredReplicaIdentity`. Persisted so every later
 * instance of this secret is built with the same id.
 */
export function setReplicaId(localSecretId: string, id: bigint): void {
  localStorage.setItem(storageKey(localSecretId), id.toString())
}

/** Drops the stored identity. Only for explicit "reset this device" actions. */
export function resetReplicaId(localSecretId: string): void {
  localStorage.removeItem(storageKey(localSecretId))
}
