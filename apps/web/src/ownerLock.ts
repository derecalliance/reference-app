/**
 * One tab per owner, enforced.
 *
 * Two tabs driving the same owner is not merely untidy — it fails silently.
 * `POST /owners` rebinds that actor's backend mailbox to the caller, so the
 * *older* tab keeps polling a receiver nothing writes to any more and simply
 * goes deaf, while both tabs run protocol instances over one set of
 * `derec:owner:{id}:…` stores.
 *
 * The Web Locks API is the right primitive: an exclusive lock is released
 * automatically when its tab closes or crashes, so there are no stale locks to
 * expire and no heartbeat to run. `query()` additionally lets the picker show
 * which owners are already in use *before* one is chosen.
 *
 * A held lock is represented by a promise that never settles on its own; the
 * lock is released by resolving it, which is what [`OwnerLock.release`] does.
 */

/** Lock name for one owner. Namespaced so it cannot collide with other apps. */
function lockName(ownerId: string): string {
  return `derec:owner-lock:${ownerId}`
}

/** A held exclusive lock. Releasing is idempotent. */
export interface OwnerLock {
  ownerId: string
  /**
   * Give the lock up. Resolves once it is actually free.
   *
   * Awaitable because releasing is not instantaneous: the underlying request
   * settles a tick later, so a caller that released and immediately re-acquired
   * without waiting would be told its own owner was busy.
   */
  release: () => Promise<void>
}

/**
 * Web Locks is unavailable in some contexts — notably non-secure origins other
 * than localhost, and jsdom under test.
 *
 * Where it is missing this module degrades to "no locking": every acquisition
 * succeeds and nothing is ever reported busy. That is deliberate. The lock is a
 * guard against a mistake, not a security boundary, and refusing to run the app
 * because an advisory lock is unavailable would be a worse failure than the one
 * being guarded against.
 */
function locks(): LockManager | null {
  return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null
}

/**
 * Take the exclusive lock for `ownerId`, or report that another tab holds it.
 *
 * Never waits: a caller that blocked would hang until the other tab closed,
 * with nothing on screen to explain why. `null` means busy, and the caller
 * shows that in the picker.
 */
export async function acquireOwnerLock(ownerId: string): Promise<OwnerLock | null> {
  const manager = locks()
  if (!manager) return { ownerId, release: async () => {} }

  let settle!: (lock: OwnerLock | null) => void
  let fail!: (reason: unknown) => void
  const granted = new Promise<OwnerLock | null>((res, rej) => {
    settle = res
    fail = rej
  })

  // `request` resolves when the callback's promise resolves — i.e. when the
  // lock is given up. Holding it means returning a promise that only settles on
  // `release`, so the *granted* signal has to come out through `settle` while
  // the *released* signal is this returned promise.
  let released = false
  const finished: Promise<void> = manager
    .request(lockName(ownerId), { ifAvailable: true }, lock => {
      if (!lock) {
        settle(null)
        return
      }
      return new Promise<void>(giveUp => {
        settle({
          ownerId,
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
 * Owner ids currently locked by *some* tab, including this one.
 *
 * Advisory and inherently racy — an owner can be taken between this call and
 * the click it informs — so the picker uses it to label rows, and
 * [`acquireOwnerLock`] remains the actual decision.
 */
export async function heldOwnerIds(): Promise<Set<string>> {
  const manager = locks()
  if (!manager) return new Set()

  try {
    const state = await manager.query()
    const names = [...(state.held ?? []), ...(state.pending ?? [])]
      .map(entry => entry.name)
      .filter((name): name is string => typeof name === 'string')

    const prefix = lockName('')
    return new Set(
      names.filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length)),
    )
  } catch {
    // Query is a convenience; failing it must not block the picker.
    return new Set()
  }
}
