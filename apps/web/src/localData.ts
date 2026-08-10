/**
 * Wholesale reset of the app's browser storage.
 *
 * Every piece of persistent app state shares one `derec:` prefix: the session
 * envelopes and active-session pointer from `sessionPersistence.ts`, and the
 * protocol stores (channels, contacts, secrets, shares, state) written by
 * `stores.ts` and `prePairing.ts`. A prefix sweep is therefore a complete
 * reset, while leaving keys owned by anything else on the origin untouched.
 */

const STORAGE_PREFIX = 'derec:'

function appKeys(): string[] {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(STORAGE_PREFIX)) keys.push(key)
  }
  return keys
}

/** Number of app-owned entries currently held in localStorage. */
export function countLocalDataEntries(): number {
  try {
    return appKeys().length
  } catch {
    // Storage disabled (private browsing, blocked cookies) — nothing to report.
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
