/**
 * A device's stable replica identity.
 *
 * The DeRec protocol carries a per-device `u64` under the reserved
 * `derec.replica_id` key; any replica-mode flow on a protocol built without
 * one fails with `ReplicaIdNotConfigured`. Both sides of a replica pair need
 * one — the Owner is the `ReplicaSource`.
 *
 * Keyed per owner, because an owner is what plays the part of a device here: a
 * second tab is a second logical device, and two of them sharing one replica id
 * would present themselves to a peer as the same device. This is why the id
 * cannot be a single origin-wide value.
 *
 * The key sits outside the `derec:owner:{ownerId}:` partition on purpose.
 * Adoption wipes that partition to take on another device's vault; the device's
 * own identity must survive that, or it would silently become a different peer.
 */

const STORAGE_PREFIX = 'derec:replica-id:'

function storageKey(ownerId: string): string {
  return `${STORAGE_PREFIX}${ownerId}`
}

function mint(): bigint {
  const buf = new BigUint64Array(1)
  crypto.getRandomValues(buf)
  return buf[0]
}

/** This owner's replica id, minting and persisting one on first use. */
export function getOrCreateReplicaId(ownerId: string): bigint {
  const key = storageKey(ownerId)
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
export function resetReplicaId(ownerId: string): void {
  localStorage.removeItem(storageKey(ownerId))
}
