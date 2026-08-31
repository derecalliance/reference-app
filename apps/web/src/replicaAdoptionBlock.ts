/**
 * Persistence for the terminal "wipe-and-adopt failed" block.
 *
 * `adoptReplicaSecret` clears this device's namespace before `restore` can
 * reject, so a rejection leaves the device holding nothing while the *owner
 * envelope* — helpers, participants, secret bag — is still on disk and still
 * loads. Holding the block in React state alone therefore made a reload
 * un-block a wiped device: the guards read a fresh `null`, the persisted roster
 * listed helpers whose stores no longer existed, and the user could add a secret
 * and protect against them.
 *
 * So the block is written to storage the moment it is raised and read back on
 * mount. It is deliberately sticky:
 *
 *  - nothing here retries `restore` or repairs anything;
 *  - nothing here clears the record on load, on success, or on a timer.
 *
 * The only thing that removes it is the user: the header's "Reset browser data"
 * action sweeps the whole `derec:` prefix, which is why this key carries it.
 *
 * Keyed per owner. It used to be a single key carrying the owner id inside the
 * record, on the grounds that a wipe erases the device's protocol storage so at
 * most one owner could be blocked at a time. That stopped being true once two
 * tabs could each drive their own owner: a block raised in one tab would
 * overwrite a block raised in the other, and the overwritten one would silently
 * un-block on reload — exactly the failure this record exists to prevent.
 */

import type { RestoreFailure, RestoreFailureCode } from './replicaFlows'

const STORAGE_PREFIX = 'derec:replica-adoption-block:'

function storageKey(ownerId: string): string {
  return `${STORAGE_PREFIX}${ownerId}`
}

const RESTORE_FAILURE_CODES: readonly RestoreFailureCode[] = [
  'ALREADY_RESTORED',
  'CONFLICT',
  'INVARIANT',
  'STORAGE',
  'UNKNOWN',
]

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const ids: string[] = []
  for (const item of value as readonly unknown[]) {
    if (typeof item !== 'string') return null
    ids.push(item)
  }
  return ids
}

/**
 * Rebuild a `RestoreFailure` from storage, or `null` if the record is not one.
 *
 * Every field is checked rather than cast: this drives a screen the user cannot
 * leave, and a half-parsed record would render `undefined` where the library's
 * own words are supposed to be.
 */
function parseFailure(value: unknown): RestoreFailure | null {
  const record = asRecord(value)
  if (!record) return null

  const code = RESTORE_FAILURE_CODES.find(c => c === record['code'])
  const message = record['message']
  const wipeDidNotTake = record['wipeDidNotTake']
  const text = record['text']
  const channelIds = asStringArray(record['channelIds'])

  if (code === undefined) return null
  if (typeof message !== 'string') return null
  if (typeof text !== 'string') return null
  if (typeof wipeDidNotTake !== 'boolean') return null
  if (channelIds === null) return null

  return { code, message, channelIds, wipeDidNotTake, text }
}

/**
 * Record that adoption erased this device and then failed.
 *
 * Best-effort: storage being unavailable must not turn a blocked device into a
 * thrown error on top of the block. The in-memory state still blocks *this*
 * page load either way.
 */
export function saveReplicaAdoptionBlock(ownerId: string, failure: RestoreFailure): void {
  try {
    localStorage.setItem(storageKey(ownerId), JSON.stringify(failure))
  } catch {
    // Storage quota exceeded or unavailable — the live block still holds.
  }
}

/** The block raised for this owner on a previous page load, if any. */
export function loadReplicaAdoptionBlock(ownerId: string): RestoreFailure | null {
  try {
    const raw = localStorage.getItem(storageKey(ownerId))
    if (!raw) return null
    return parseFailure(JSON.parse(raw))
  } catch {
    // Corrupt or unavailable storage. Reporting "not blocked" is the only
    // honest answer: there is no failure detail left to show, and inventing one
    // would put the user on a terminal screen with nothing to act on.
    return null
  }
}
