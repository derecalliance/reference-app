// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

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
import { eraseVaultLocalData } from '../localData'
import { reportError, reportInfo } from '../toastBus'
import { followReset } from '../browserReset'
import { onTabMessage, postTabMessage } from '../tabSync'
import { acquireVaultLock, heldVaultIds, vaultLockMode } from '../vaultLock'
import { deleteVault, listVaultIds, loadVaultById, persistVault } from '../vaultPersistence'
import { VaultManager, type VaultEntry } from './manager'

const ManagerContext = createContext<VaultManager | null>(null)

/**
 * Builds the tab's one `VaultManager`, boots it, and releases every lock when
 * the page goes away.
 *
 * Built once and never rebuilt: it owns WASM instances and Web Locks, so a
 * re-render must not replace it. What it reads later — the server defaults —
 * it reads through a holder filled in once they are fetched.
 */
export function VaultManagerProvider({ children }: { children: ReactNode }) {
  // Stable for the provider's life — `ConsoleProvider` memoises it.
  const { log } = useConsole()
  // The node's own defaults, the bottom tier of every vault's config. A plain
  // holder, filled in once fetched; the runtimes read it when they need it.
  const [serverDefaults] = useState<{ value: ServerDefaults }>(() => ({
    value: FALLBACK_SERVER_DEFAULTS,
  }))

  const [manager] = useState(
    () =>
      new VaultManager({
        log,
        notify: { error: reportError, info: reportInfo },
        getServerDefaults: () => serverDefaults.value,
        locks: { acquire: acquireVaultLock, held: heldVaultIds },
        announce: () => postTabMessage({ kind: 'vaults-changed' }),
        storage: {
          list: listVaultIds,
          load: loadVaultById,
          persist: persistVault,
          remove: deleteVault,
        },
        eraseStores: vault => eraseVaultLocalData(vault.id),
      }),
  )

  useEffect(() => {
    let cancelled = false
    void apiGetServerDefaults()
      .then(({ defaults }) => {
        if (!cancelled) serverDefaults.value = defaults
      })
      .catch(() => {
        // The fallback stands in; a vault must still run with the backend down.
      })
    void manager.boot()

    // Released on unload as well: the browser frees Web Locks when the tab dies,
    // but releasing explicitly makes the vaults claimable in another open tab at
    // once rather than whenever the browser gets to it.
    const release = () => void manager.releaseAll()
    window.addEventListener('pagehide', release)
    return () => {
      cancelled = true
      window.removeEventListener('pagehide', release)
    }
  }, [manager, serverDefaults])

  useFollowOtherTabs(manager)

  // Without Web Locks (plain HTTP on a LAN address) one-tab-per-vault rests on
  // a weaker fallback. Said once, in the console, and on the vault list — see
  // `VaultLockNotice`.
  useEffect(() => {
    if (vaultLockMode() === 'web-locks') return
    log({
      role: 'owner',
      flow: 'setup',
      step: 'vault_lock_fallback',
      description:
        'Web Locks is unavailable here (not a secure context), so one tab per vault is ' +
        'enforced by a best-effort localStorage lock. Avoid opening the same vault in two tabs.',
      payload: { origin: window.location.origin, isSecureContext: window.isSecureContext },
    })
  }, [log])

  return <ManagerContext.Provider value={manager}>{children}</ManagerContext.Provider>
}

/** How long to let a burst of storage writes from another tab settle before re-reading. */
const SYNC_DEBOUNCE_MS = 250

/**
 * Keep this tab's list in step with what the others do.
 *
 * Three signals, because none covers everything: other tabs announce claims
 * and releases (a lock changes no stored row); a vault record written or
 * removed elsewhere fires `storage`; and coming back to the tab re-checks
 * anyway, since a tab that crashed announced nothing. A reset started
 * elsewhere is followed at once — this tab stops, clears and reloads.
 */
function useFollowOtherTabs(manager: VaultManager): void {
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
      if (event.key === null || isVaultRecordKey(event.key)) sync()
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

/** A vault's own record — `derec:vault:<id>` — rather than one of its store rows. */
function isVaultRecordKey(key: string): boolean {
  const prefix = 'derec:vault:'
  return key.startsWith(prefix) && !key.slice(prefix.length).includes(':')
}

// eslint-disable-next-line react-refresh/only-export-components
export function useVaultManager(): VaultManager {
  const manager = useContext(ManagerContext)
  if (!manager) throw new Error('useVaultManager must be used within a VaultManagerProvider')
  return manager
}

/** The list's rows, re-rendering when any vault's row changes. */
// eslint-disable-next-line react-refresh/only-export-components
export function useVaultEntries(): readonly VaultEntry[] {
  const manager = useVaultManager()
  return useSyncExternalStore(
    listener => manager.subscribe(listener),
    () => manager.entries(),
  )
}
