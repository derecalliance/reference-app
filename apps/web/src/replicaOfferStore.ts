// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { fromBase64Url, toBase64Url } from './derecApi'
import type { PendingReplicaAdoption } from './replicaFlows'

/**
 * The adoption offer a secret has in front of its owner, kept across reloads.
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
 * Stored beside the secret record, in the same browser storage, so it holds
 * nothing the secret record (which carries its own items) does not already
 * expose. Erased with the secret — see `eraseSecretLocalData`.
 */

const KEY_PREFIX = 'derec:replica-offer:'

function storageKey(localSecretId: string): string {
  return `${KEY_PREFIX}${localSecretId}`
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
    typeof offer['payload'] === 'object' &&
    offer['payload'] !== null &&
    Array.isArray(offer['shares'])
  )
}

/**
 * An offer saved before the rename that made "secret" mean what was called a
 * vault: its replica payload sat under `secret`, now `payload`.
 */
function withLegacyPayloadKey(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const offer = value as Record<string, unknown>
  if (!('secret' in offer) || 'payload' in offer) return value
  const { secret, ...rest } = offer
  return { ...rest, payload: secret }
}

/** Keep `offer` as this secret's pending one. Storage failures are tolerated. */
export function savePendingReplicaOffer(localSecretId: string, offer: PendingReplicaAdoption): void {
  try {
    localStorage.setItem(storageKey(localSecretId), JSON.stringify(offer, replacer))
  } catch {
    // Quota or private mode: the offer still stands for this page's life.
  }
}

/** This secret's pending offer, or `null` when there is none or it does not parse. */
export function loadPendingReplicaOffer(localSecretId: string): PendingReplicaAdoption | null {
  try {
    const raw = localStorage.getItem(storageKey(localSecretId))
    if (!raw) return null
    const parsed = withLegacyPayloadKey(JSON.parse(raw, reviver))
    return isOffer(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Drop this secret's pending offer — it was adopted, rejected, or the secret is gone. */
export function clearPendingReplicaOffer(localSecretId: string): void {
  try {
    localStorage.removeItem(storageKey(localSecretId))
  } catch {
    // Storage unavailable — nothing to clear.
  }
}
