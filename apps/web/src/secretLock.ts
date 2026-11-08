// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * One tab per secret, enforced.
 *
 * Two tabs driving the same secret is not merely untidy — it fails silently.
 * `POST /api/v1/owners` rebinds that actor's backend mailbox to the caller, so the
 * *older* tab keeps polling a receiver nothing writes to any more and simply
 * goes deaf, while both tabs run protocol instances over one set of
 * `derec:secret:{id}:…` stores.
 *
 * The Web Locks API is the right primitive: an exclusive lock is released
 * automatically when its tab closes or crashes, so there are no stale locks to
 * expire and no heartbeat to run. `query()` additionally lets the secret list
 * label the secrets another tab is running before anyone tries to open one.
 *
 * A held lock is represented by a promise that never settles on its own; the
 * lock is released by resolving it, which is what [`SecretLock.release`] does.
 */

import { acquireStorageLock, heldStorageLocks } from './storageLock'

/** Lock name for one secret. Namespaced so it cannot collide with other apps. */
function lockName(localSecretId: string): string {
  return `derec:secret-lock:${localSecretId}`
}

/** A held exclusive lock. Releasing is idempotent. */
export interface SecretLock {
  localSecretId: string
  /**
   * Give the lock up. Resolves once it is actually free.
   *
   * Awaitable because releasing is not instantaneous: the underlying request
   * settles a tick later, so a caller that released and immediately re-acquired
   * without waiting would be told its own secret was busy.
   */
  release: () => Promise<void>
}

/**
 * Web Locks is unavailable in some contexts — notably non-secure origins other
 * than localhost (plain HTTP on a LAN address, which is how a phone reaches a
 * developer's node), and jsdom under test.
 *
 * Where it is missing this module falls back to a heartbeat record in
 * `localStorage` — see `storageLock.ts`. That is weaker: a crashed tab's secrets
 * stay held for about a minute, and two tabs opening the same secret in the
 * same instant can, rarely, both win. So the app says so on screen (see
 * `secretLockMode`) rather than quietly enforcing less than it claims. Refusing
 * to run instead would be a worse failure than the one being guarded against:
 * the lock is a guard against a mistake, not a security boundary.
 */
function locks(): LockManager | null {
  return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null
}

/**
 * How one-tab-per-secret is enforced here: by the browser's Web Locks, or by
 * the best-effort `localStorage` fallback.
 */
export type SecretLockMode = 'web-locks' | 'storage-fallback'

export function secretLockMode(): SecretLockMode {
  return locks() ? 'web-locks' : 'storage-fallback'
}

/**
 * Take the exclusive lock for `localSecretId`, or report that another tab holds it.
 *
 * Never waits: a caller that blocked would hang until the other tab closed,
 * with nothing on screen to explain why. `null` means busy, and the secret list
 * shows that secret as open in another tab, with a Claim.
 */
export async function acquireSecretLock(localSecretId: string): Promise<SecretLock | null> {
  const manager = locks()
  if (!manager) {
    const lock = await acquireStorageLock(lockName(localSecretId))
    return lock ? { localSecretId, release: lock.release } : null
  }

  let settle!: (lock: SecretLock | null) => void
  let fail!: (reason: unknown) => void
  const granted = new Promise<SecretLock | null>((res, rej) => {
    settle = res
    fail = rej
  })

  // `request` resolves when the callback's promise resolves — i.e. when the
  // lock is given up. Holding it means returning a promise that only settles on
  // `release`, so the *granted* signal has to come out through `settle` while
  // the *released* signal is this returned promise.
  let released = false
  const finished: Promise<void> = manager
    .request(lockName(localSecretId), { ifAvailable: true }, lock => {
      if (!lock) {
        settle(null)
        return
      }
      return new Promise<void>(giveUp => {
        settle({
          localSecretId,
          release: () => {
            if (!released) {
              released = true
              giveUp()
            }
            return finished
          },
        })
      })
    })
    .catch(fail)
    .then(() => {})

  return granted
}

/**
 * Local secret ids currently locked by *some* tab, including this one.
 *
 * Advisory and inherently racy — a secret can be taken between this call and
 * the click it informs — so the secret list uses it to label rows (see
 * `SecretManager.syncWithOtherTabs`), and [`acquireSecretLock`] remains the
 * actual decision.
 */
export async function heldLocalSecretIds(): Promise<Set<string>> {
  const prefix = lockName('')
  const manager = locks()
  if (!manager) {
    return new Set(
      [...heldStorageLocks()]
        .filter(name => name.startsWith(prefix))
        .map(name => name.slice(prefix.length)),
    )
  }

  try {
    const state = await manager.query()
    const names = [...(state.held ?? []), ...(state.pending ?? [])]
      .map(entry => entry.name)
      .filter((name): name is string => typeof name === 'string')

    return new Set(
      names.filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length)),
    )
  } catch {
    // Query is a convenience; failing it must not block the secret list.
    return new Set()
  }
}
