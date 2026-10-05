// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { UserSecret } from '../types'

/**
 * The most a vault's secrets may add up to, in bytes of UTF-8.
 *
 * Set by the browser, not the protocol. Everything here lives in localStorage,
 * which holds about 5 MB per origin, and one version of the bag is stored many
 * times over: one share per helper, kept for the last three versions, plus the
 * library's own copy, the vault record's history and — while recovering — the
 * shares being reassembled. A 700 KB secret protected and verified fine and
 * then could not be recovered; at 1.2 MB the shares reached the helpers and
 * the local copy did not fit, so the helpers held a version this vault never
 * recorded. 32 KB leaves room for several vaults with a handful of helpers
 * each, and still holds any password, seed phrase or key many times over.
 */
export const MAX_BAG_BYTES = 32 * 1024

/** `MAX_BAG_BYTES` as people read it. */
export const MAX_BAG_SIZE_LABEL = '32 KB'

/** The bytes a set of secrets occupies in the bag: each name and value, as UTF-8. */
export function bagBytes(secrets: readonly Pick<UserSecret, 'name' | 'data'>[]): number {
  const encoder = new TextEncoder()
  return secrets.reduce((total, s) => total + encoder.encode(s.name).length + encoder.encode(s.data).length, 0)
}

/**
 * Why `secrets` cannot be published as one bag, or `null` when they can.
 * Checked before anything is dispatched, so an oversized bag never leaves
 * this device.
 */
export function bagSizeProblem(secrets: readonly Pick<UserSecret, 'name' | 'data'>[]): string | null {
  const bytes = bagBytes(secrets)
  if (bytes <= MAX_BAG_BYTES) return null
  return (
    `The vault's secrets would total ${formatBytes(bytes)}, over the ${MAX_BAG_SIZE_LABEL} this ` +
    'browser can keep safely — every helper share and every kept version is stored here. ' +
    'Use a smaller secret, or remove one first.'
  )
}

/** A byte count as people read it: "812 B", "40.2 KB", "1.3 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
