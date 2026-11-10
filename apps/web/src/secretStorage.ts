// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * Where a secret lives in browser storage, and how data saved before the
 * rename is brought forward.
 *
 * The app once called a secret a "vault" and an item a "secret" (DeRec's
 * `UserSecret`). Its storage carried those names: keys under `derec:vault:`,
 * a record envelope `{ type: 'vault', vault }`, and record fields such as
 * `secretBag`. Data written by an older build is migrated once at boot
 * (`migrateLegacyStorageKeys`) and on load (`fromLegacyRecord`); nothing is
 * written under the old names any more.
 */

/** The prefix of everything stored for one secret: its record and its protocol stores. */
export const SECRET_KEY_PREFIX = 'derec:secret:'

const LEGACY_KEY_PREFIX = 'derec:vault:'

/**
 * The namespace a secret's protocol stores use — `stores.ts` keys them under
 * `derec:{namespace}:{secretId}:…`.
 */
export function secretNamespace(localSecretId: string): string {
  return `secret:${localSecretId}`
}

/**
 * Move every key an older build wrote under `derec:vault:` to `derec:secret:`.
 *
 * Idempotent and resumable: each key is copied before the old one is removed,
 * and a key already present under the new name is left as it is, so a run
 * cut short finishes on the next boot. Storage that cannot be read is left
 * alone — the app then simply finds nothing under the new names.
 */
export function migrateLegacyStorageKeys(storage: Storage = localStorage): number {
  let moved = 0
  try {
    const legacy: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key?.startsWith(LEGACY_KEY_PREFIX)) legacy.push(key)
    }
    for (const key of legacy) {
      const value = storage.getItem(key)
      const next = `${SECRET_KEY_PREFIX}${key.slice(LEGACY_KEY_PREFIX.length)}`
      if (value !== null && storage.getItem(next) === null) storage.setItem(next, value)
      storage.removeItem(key)
      moved++
    }
  } catch {
    // Quota or unavailable storage: what moved stays moved, the rest next boot.
  }
  return moved
}

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null

/** `object` with `from` renamed to `to`, when it has `from` and not yet `to`. */
function renamed(object: Json, from: string, to: string): Json {
  if (!(from in object) || to in object) return object
  const { [from]: value, ...rest } = object
  return { ...rest, [to]: value }
}

/** A bag version: its `secrets` are now `items`. */
function bagVersion(version: unknown): unknown {
  return isObject(version) ? renamed(version, 'secrets', 'items') : version
}

/** An item bag, with each of its versions brought forward. */
function itemBag(bag: unknown): unknown {
  if (!isObject(bag)) return bag
  return {
    ...bag,
    currentVersion: bagVersion(bag.currentVersion),
    previousVersions: Array.isArray(bag.previousVersions) ? bag.previousVersions.map(bagVersion) : bag.previousVersions,
  }
}

function withBag<T>(round: T): T {
  return isObject(round) && 'bag' in round ? ({ ...round, bag: itemBag(round.bag) } as T) : round
}

/**
 * A stored secret record, from whichever envelope and field names it was saved
 * with, in today's names. A record already current comes back unchanged.
 */
export function fromLegacyRecord(stored: unknown): unknown {
  if (!isObject(stored)) return stored
  // `{ type: 'vault', vault }` before the rename, `{ type: 'secret', secret }`
  // after; the oldest records had no envelope at all.
  const record = isObject(stored.secret) ? stored.secret : isObject(stored.vault) ? stored.vault : stored
  let next = renamed(record, 'secretBag', 'itemBag')
  next = { ...next, itemBag: itemBag(next.itemBag) }
  if (Array.isArray(next.pendingProtectRounds)) next = { ...next, pendingProtectRounds: next.pendingProtectRounds.map(withBag) }
  if (isObject(next.pendingProtectRound)) next = { ...next, pendingProtectRound: withBag(next.pendingProtectRound) }
  if (Array.isArray(next.recoveredSecrets)) {
    next = {
      ...next,
      recoveredSecrets: next.recoveredSecrets.map(recovered =>
        isObject(recovered) && isObject(recovered.snapshot)
          ? { ...recovered, snapshot: renamed(recovered.snapshot, 'secrets', 'items') }
          : recovered,
      ),
    }
  }
  if (isObject(next.replicaConflict)) next = { ...next, replicaConflict: renamed(next.replicaConflict, 'rivalSecrets', 'rivalItems') }
  if (isObject(next.unsettledRound)) next = { ...next, unsettledRound: renamed(next.unsettledRound, 'secrets', 'items') }
  return next
}
