// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { SECRET_KEY_PREFIX } from '../secretStorage'
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'

import { apiGetServerDefaults } from '../api'
import { FALLBACK_SERVER_DEFAULTS, type ServerDefaults } from '../config'
import { useConsole } from '../ConsoleContext'
import { eraseSecretLocalData } from '../localData'
import { clearNotice, reportAlert, reportError, reportInfo, showNotice } from '../toastBus'
import { followReset } from '../browserReset'
import { onTabMessage, postTabMessage } from '../tabSync'
import { acquireSecretLock, heldLocalSecretIds, secretLockMode } from '../secretLock'
import { deleteSecret, listLocalSecretIds, loadSecretById, persistSecret } from '../secretPersistence'
import { SecretManager, type SecretEntry } from './manager'
import { loadServerDefaults } from './serverDefaultsLoader'

const ManagerContext = createContext<SecretManager | null>(null)
const ServerDefaultsContext = createContext<ServerDefaults>(FALLBACK_SERVER_DEFAULTS)

/** The standing notice shown while no secret's mailbox poll reaches the node. */
const NODE_UNREACHABLE_NOTICE = 'node-unreachable'
const NODE_UNREACHABLE_MESSAGE =
  'Cannot reach the DeRec node — no secret is receiving messages. Retrying automatically.'
/** Raised on `nodeAnswering` when the mailbox polls reach the node again. */
const NODE_ANSWERING_EVENT = 'node-answering'

/**
 * Builds the tab's one `SecretManager`, boots it, and releases every lock when
 * the page goes away.
 *
 * Built once and never rebuilt: it owns WASM instances and Web Locks, so a
 * re-render must not replace it. What it reads later — the server defaults —
 * it reads through a holder filled in once they are fetched.
 */
export function SecretManagerProvider({ children }: { children: ReactNode }) {
  // Stable for the provider's life — `ConsoleProvider` memoises it.
  const { log } = useConsole()
  // The node's own defaults — what it runs (gRPC, the relay) and its helper
  // pool — fetched for the tab until the node first answers; see
  // `loadServerDefaults`. A secret's protocol settings do not come from here.
  const [serverDefaults, setServerDefaults] = useState<ServerDefaults>(FALLBACK_SERVER_DEFAULTS)
  // Fired when the secrets' mailbox polls reach the node again, so the defaults
  // are retried at once rather than at the next backoff step.
  const [nodeAnswering] = useState(() => new EventTarget())

  const [manager] = useState(
    () =>
      new SecretManager({
        log,
        notify: {
          error: reportError,
          info: reportInfo,
          alert: reportAlert,
          nodeUnreachable: unreachable => {
            if (unreachable) {
              showNotice(NODE_UNREACHABLE_NOTICE, 'error', NODE_UNREACHABLE_MESSAGE)
              return
            }
            clearNotice(NODE_UNREACHABLE_NOTICE)
            nodeAnswering.dispatchEvent(new Event(NODE_ANSWERING_EVENT))
          },
        },
        locks: { acquire: acquireSecretLock, held: heldLocalSecretIds },
        announce: () => postTabMessage({ kind: 'secrets-changed' }),
        storage: {
          list: listLocalSecretIds,
          load: loadSecretById,
          persist: persistSecret,
          remove: deleteSecret,
        },
        eraseStores: secret => eraseSecretLocalData(secret.id),
      }),
  )

  useEffect(() => {
    // The fallback stands in until the node answers — a secret must still run
    // with the backend down — and is replaced the first time it does.
    const loader = loadServerDefaults({
      fetch: apiGetServerDefaults,
      onLoaded: setServerDefaults,
    })
    const retryDefaults = () => loader.retryNow()
    void manager.boot()

    // Released on unload as well: the browser frees Web Locks when the tab dies,
    // but releasing explicitly makes the secrets claimable in another open tab at
    // once rather than whenever the browser gets to it.
    const release = () => void manager.releaseAll()
    // A page that went into the back/forward cache comes back with every secret
    // released — runtimes stopped, locks given up — and the world moved on
    // while it was frozen: another tab may have claimed a secret, created or
    // removed one, or reset the browser's data. Reloading takes everything up
    // again through the one path that already handles all of that, boot,
    // rather than a second resume path that would have to reconcile it.
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload()
    }
    window.addEventListener('pagehide', release)
    window.addEventListener('pageshow', restore)
    window.addEventListener('online', retryDefaults)
    nodeAnswering.addEventListener(NODE_ANSWERING_EVENT, retryDefaults)
    return () => {
      loader.stop()
      nodeAnswering.removeEventListener(NODE_ANSWERING_EVENT, retryDefaults)
      window.removeEventListener('pagehide', release)
      window.removeEventListener('pageshow', restore)
      window.removeEventListener('online', retryDefaults)
    }
  }, [manager, nodeAnswering])

  useFollowOtherTabs(manager)

  // Without Web Locks (plain HTTP on a LAN address) one-tab-per-secret rests on
  // a weaker fallback. Said once, in the console, and on the secret list — see
  // `LOCK_WARNING` in `App.tsx`.
  useEffect(() => {
    if (secretLockMode() === 'web-locks') return
    log({
      role: 'owner',
      flow: 'setup',
      step: 'secret_lock_fallback',
      description:
        'Web Locks is unavailable here (not a secure context), so one tab per secret is ' +
        'enforced by a best-effort localStorage lock. Avoid opening the same secret in two tabs.',
      payload: { origin: window.location.origin, isSecureContext: window.isSecureContext },
    })
  }, [log])

  return (
    <ManagerContext.Provider value={manager}>
      <ServerDefaultsContext.Provider value={serverDefaults}>{children}</ServerDefaultsContext.Provider>
    </ManagerContext.Provider>
  )
}

/** How long to let a burst of storage writes from another tab settle before re-reading. */
const SYNC_DEBOUNCE_MS = 250

/**
 * Keep this tab's list in step with what the others do.
 *
 * Three signals, because none covers everything: other tabs announce claims
 * and releases (a lock changes no stored row); a secret record written or
 * removed elsewhere fires `storage`; and coming back to the tab re-checks
 * anyway, since a tab that crashed announced nothing. A reset started
 * elsewhere is followed at once — this tab stops, clears and reloads.
 */
function useFollowOtherTabs(manager: SecretManager): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const sync = () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void manager.syncWithOtherTabs()
      }, SYNC_DEBOUNCE_MS)
    }

    const unsubscribe = onTabMessage(message => {
      if (message.kind === 'reset-started') void followReset(manager)
      else sync()
    })
    const onStorage = (event: StorageEvent) => {
      // `null` key: another tab cleared storage wholesale.
      if (event.key === null || isSecretRecordKey(event.key)) sync()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') sync()
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('focus', sync)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      if (timer !== null) clearTimeout(timer)
      unsubscribe()
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('focus', sync)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [manager])
}

/** A secret's own record — `derec:secret:<id>` — rather than one of its store rows. */
function isSecretRecordKey(key: string): boolean {
  return key.startsWith(SECRET_KEY_PREFIX) && !key.slice(SECRET_KEY_PREFIX.length).includes(':')
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSecretManager(): SecretManager {
  const manager = useContext(ManagerContext)
  if (!manager) throw new Error('useSecretManager must be used within a SecretManagerProvider')
  return manager
}

/**
 * The node's own defaults — the fallback until the node first answers, which
 * is retried with a bounded backoff. The same values every runtime resolves
 * its configuration against.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useServerDefaults(): ServerDefaults {
  return useContext(ServerDefaultsContext)
}

/** The list's rows, re-rendering when any secret's row changes. */
// eslint-disable-next-line react-refresh/only-export-components
export function useSecretEntries(): readonly SecretEntry[] {
  const manager = useSecretManager()
  return useSyncExternalStore(
    listener => manager.subscribe(listener),
    () => manager.entries(),
  )
}
