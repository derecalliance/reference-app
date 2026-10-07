// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { fromBase64Url, toBase64Url } from './derecApi'
import type { PendingReplicaAdoption } from './replicaFlows'

/**
 * The adoption offer a vault has in front of its owner, kept across reloads.
 *
 * The offer used to live in memory only, on the theory that losing it was the
 * safe direction because the source re-offers on its next sync. In practice
 * the source publishes only when *it* has something new, so a reload silently
 * dropped the offer — the owner was asked once, reloaded, and was never asked
 * again. Persisting it puts the "Review…" banner back after a reload.
 *
 * Only an offer that was actually put in front of the owner is stored — one
 * that arrived over a confirmed channel. An offer held back for an unconfirmed
 * channel stays in memory: nothing proves where it came from yet, and the
 * destination's own catch-up re-requests it once the channel is confirmed.
 *
 * Stored beside the vault record, in the same browser storage, so it holds
 * nothing the vault record (which carries its own secrets) does not already
 * expose. Erased with the vault — see `eraseVaultLocalData`.
 */

const KEY_PREFIX = 'derec:replica-offer:'

function storageKey(vaultId: string): string {
  return `${KEY_PREFIX}${vaultId}`
}

/** Tag for a `Uint8Array` in the JSON form — the payload carries keys and shares as bytes. */
interface EncodedBytes {
  __bytes: string
}

function isEncodedBytes(value: unknown): value is EncodedBytes {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['__bytes'] === 'string'
  )
}

function replacer(_key: string, value: unknown): unknown {
  return value instanceof Uint8Array ? { __bytes: toBase64Url(value) } : value
}

function reviver(_key: string, value: unknown): unknown {
  return isEncodedBytes(value) ? fromBase64Url(value.__bytes) : value
}

/** The minimum an offer must carry to be put back in front of anyone. */
function isOffer(value: unknown): value is PendingReplicaAdoption {
  if (typeof value !== 'object' || value === null) return false
  const offer = value as Record<string, unknown>
  return (
    typeof offer['channelId'] === 'string' &&
    typeof offer['fromReplicaId'] === 'string' &&
    typeof offer['secretId'] === 'string' &&
    typeof offer['version'] === 'number' &&
    typeof offer['secret'] === 'object' &&
    offer['secret'] !== null &&
    Array.isArray(offer['shares'])
  )
}

/** Keep `offer` as this vault's pending one. Storage failures are tolerated. */
export function savePendingReplicaOffer(vaultId: string, offer: PendingReplicaAdoption): void {
  try {
    localStorage.setItem(storageKey(vaultId), JSON.stringify(offer, replacer))
  } catch {
    // Quota or private mode: the offer still stands for this page's life.
  }
}

/** This vault's pending offer, or `null` when there is none or it does not parse. */
export function loadPendingReplicaOffer(vaultId: string): PendingReplicaAdoption | null {
  try {
    const raw = localStorage.getItem(storageKey(vaultId))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw, reviver)
    return isOffer(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Drop this vault's pending offer — it was adopted, rejected, or the vault is gone. */
export function clearPendingReplicaOffer(vaultId: string): void {
  try {
    localStorage.removeItem(storageKey(vaultId))
  } catch {
    // Storage unavailable — nothing to clear.
  }
}
