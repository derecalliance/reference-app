// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { VaultEntry } from './vault/manager'

/** What `#/vault/{id}` shows. */
export type VaultScreen =
  | { kind: 'page' }
  | { kind: 'loading' }
  | { kind: 'elsewhere' }
  | { kind: 'failed'; failure: string | null }
  | { kind: 'stopped' }
  | { kind: 'missing' }

/**
 * Decide what a vault route shows, from the vault's row and whether this tab
 * has a runtime for it.
 *
 * The page is mounted only for a vault this tab runs: one another tab holds
 * gets a Claim instead, because two runtimes over one set of stores would split
 * its destructive mailbox between them. Before the manager has booted, a vault
 * with no row is still being read, not gone.
 */
export function vaultScreen(entry: VaultEntry | null, hasRuntime: boolean, booted: boolean): VaultScreen {
  if (!entry) return booted ? { kind: 'missing' } : { kind: 'loading' }
  switch (entry.state) {
    case 'elsewhere':
      return { kind: 'elsewhere' }
    case 'failed':
      return { kind: 'failed', failure: entry.failure }
    case 'stopped':
      return { kind: 'stopped' }
    case 'starting':
      return { kind: 'loading' }
    case 'running':
    case 'blocked':
      return hasRuntime ? { kind: 'page' } : { kind: 'loading' }
  }
}
