// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { envelope } from '@derec-alliance/web'

import { errorText } from '../errorText'

/** One remembered envelope id: its hex id → when it may be forgotten, in Unix seconds. */
type IdLog = Record<string, number>

/**
 * Drops a message delivered twice, or delivered back to the device that sent
 * it.
 *
 * From SDK 0.0.11 this is the application's job. `process` handles every copy
 * of a message within the inbound window, and both ends of a channel encrypt
 * under one key, so a message reflected to its sender decrypts there as the
 * peer's. Nothing a copy carries in the clear tells it apart — sequence, trace
 * id and protocol version are unauthenticated, and an envelope can be
 * re-encoded — so copies are recognised by `envelope.message_id`, a hash of
 * the encrypted message alone.
 *
 * The library's contract: keep the id of every envelope sent and of every one
 * `process` accepted until `max(sent or received at, its timestamp) + the
 * inbound window`, and drop an inbound envelope whose id is kept. Ids live in
 * localStorage under the secret's namespace, so a copy replayed after a reload
 * is still recognised, and every instance of the page — one per secret, one
 * per owner it helps — sees what the others sent.
 */
export class ReplayGuard {
  private readonly storageKey: string
  /** The inbound window, `inbound_message_secs`, in seconds. */
  private readonly windowSecs: number
  private readonly nowSecs: () => number

  constructor(namespace: string, windowSecs: number, nowSecs: () => number = () => Math.floor(Date.now() / 1000)) {
    this.storageKey = `${namespace}:seen-message-ids`
    this.windowSecs = windowSecs
    this.nowSecs = nowSecs
  }

  /**
   * Whether `bytes` is a copy of a message this device already sent or
   * accepted. Bytes that are not an envelope are never a copy: `process`
   * refuses them on its own and says why.
   */
  isCopy(bytes: Uint8Array): boolean {
    const id = messageIdOf(bytes)
    if (id === null) return false
    const expiresAt = this.load()[id.hex]
    return expiresAt !== undefined && expiresAt >= this.nowSecs()
  }

  /** Remember `bytes` — sent by this device, or accepted by `process`. */
  remember(bytes: Uint8Array): void {
    const id = messageIdOf(bytes)
    if (id === null) return
    const now = this.nowSecs()
    const log = this.load()
    // Expired ids go on every write, so the log never outgrows one window.
    for (const [hex, expiresAt] of Object.entries(log)) if (expiresAt < now) delete log[hex]
    log[id.hex] = Math.max(now, id.timestamp) + this.windowSecs
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(log))
    } catch (err) {
      // A full storage must not stop a message from being sent or folded; the
      // id is simply not kept, which is how every copy was treated before.
      console.warn(`Could not remember a message id: ${errorText(err)}`)
    }
  }

  private load(): IdLog {
    try {
      const raw = localStorage.getItem(this.storageKey)
      const parsed: unknown = raw ? JSON.parse(raw) : {}
      return parsed && typeof parsed === 'object' ? (parsed as IdLog) : {}
    } catch {
      return {}
    }
  }
}

/** When the envelope in `bytes` says it was sent, in Unix seconds, or `null` when it is not an envelope. */
export function sentAtOf(bytes: Uint8Array): number | null {
  return messageIdOf(bytes)?.timestamp ?? null
}

/** The envelope's identity as a map key, or `null` when the bytes are not an envelope with a timestamp. */
function messageIdOf(bytes: Uint8Array): { hex: string; timestamp: number } | null {
  try {
    const { id, timestamp } = envelope.message_id(bytes)
    return { hex: Array.from(id, b => b.toString(16).padStart(2, '0')).join(''), timestamp: Number(timestamp) }
  } catch {
    return null
  }
}
