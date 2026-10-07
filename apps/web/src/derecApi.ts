// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

// ── Config ────────────────────────────────────────────────────────────────────

import { API_BASE } from './apiBase'
import { type ApiRequestError, responseError } from './httpError'

// ── Polled mailbox message ────────────────────────────────────────────────────

export interface MailboxMessage {
  /** Raw DeRec wire bytes to feed to DeRecProtocol.process(). */
  bytes: Uint8Array
}

// ── Binary transport ──────────────────────────────────────────────────────────

/**
 * A message that did not reach its endpoint.
 *
 * `transient` separates "the endpoint could not be reached right now" — the
 * node is down, restarting, or a proxy in front of it timed out — from "the
 * endpoint answered no" (an unknown actor, a malformed request). Only the
 * first is worth sending again; see `makeTransport`.
 */
export class DeliveryError extends Error {
  readonly transient: boolean

  constructor(message: string, transient: boolean, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DeliveryError'
    this.transient = transient
  }
}

/** Statuses that mean "not now" rather than "no": worth one more attempt. */
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

/** POST `init` to `url`, turning every failure into a `DeliveryError`. */
async function deliver(url: string, init: RequestInit, action: string): Promise<void> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (err) {
    // `fetch` rejects only when no response came back at all: the node is
    // down, the port is closed, or the network dropped.
    throw new DeliveryError(
      `${action}: the endpoint could not be reached (${err instanceof Error ? err.message : String(err)})`,
      true,
      { cause: err },
    )
  }
  if (!res.ok) {
    const error = await responseError(res, action)
    // A switched-off relay answers 503 too, and no resend turns it on.
    const transient = isTransientStatus(res.status) && !isRelayDisabled(error)
    throw new DeliveryError(error.message, transient)
  }
}

/**
 * The relay is switched off on the node — by its code, or, from a node that
 * predates the error envelope, by the wording it answered with.
 */
function isRelayDisabled(error: ApiRequestError): boolean {
  if (error.code !== undefined) return error.code === 'RELAY_DISABLED'
  return /disabled/i.test(error.message)
}

/**
 * Delivers a raw protobuf-encoded DeRec wire message to an actor's transport URI.
 * This is the implementation used by the DeRecProtocolWasm Transport adapter.
 */
export function sendMessage(uri: string, message: Uint8Array): Promise<void> {
  return deliver(
    uri,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: message as unknown as BodyInit,
    },
    `Could not deliver a message to ${uri}`,
  )
}

/**
 * Ask the backend to deliver a message to an endpoint this browser cannot
 * dial. A browser has no HTTP/2 trailer access and so cannot speak gRPC.
 *
 * `actorId` is the owner actor the relay acts for — the vault's own id — and
 * attributes the request in the node's debug events. The node's refusal is
 * passed on in its own words: 403 a target outside the allowed hosts, 409 gRPC
 * off, 400 a malformed target, 413 too large, 502 the delivery itself failed,
 * 503 the relay switched off (`RELAY_DISABLED`, final) or the recipient's
 * mailbox full (`MAILBOX_FULL`, worth a retry).
 */
export function relayMessage(uri: string, message: Uint8Array, actorId?: string): Promise<void> {
  return deliver(
    `${API_BASE}/derec/relay`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri, data: toBase64Url(message), ...(actorId ? { actor_id: actorId } : {}) }),
    },
    `Could not relay a message to ${uri}`,
  )
}

/**
 * A request that never reached the node: `fetch` rejected, or a proxy in front
 * of the node answered for it because the node did not.
 *
 * Distinct from the node answering "no" (an unknown actor, say), which is about
 * one vault. This is about every vault at once — they all poll the same node —
 * so the manager reports it once for the node rather than once per vault.
 */
export class NodeUnreachableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'NodeUnreachableError'
  }
}

/** What a proxy answers with when the node behind it is down or not ready. */
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])

/**
 * Polls an actor's mailbox and returns all pending wire messages, draining the
 * queue.  Each message's `bytes` field is ready to pass to
 * `DeRecProtocolWasm.process()`.
 */
export async function pollMailbox(actorId: string): Promise<MailboxMessage[]> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}/derec/${actorId}/mailbox`)
  } catch (err) {
    throw new NodeUnreachableError(
      `Could not poll the mailbox: the node could not be reached (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    )
  }

  if (!res.ok) {
    const error = await responseError(res, 'Could not poll the mailbox')
    if (GATEWAY_STATUSES.has(res.status)) throw new NodeUnreachableError(error.message)
    throw error
  }

  const body = (await res.json()) as { messages: { data: string }[] }
  return body.messages.map(m => ({ bytes: fromBase64Url(m.data) }))
}

// ── Encoding helpers ──────────────────────────────────────────────────────────

export function fromBase64Url(encoded: string): Uint8Array {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
