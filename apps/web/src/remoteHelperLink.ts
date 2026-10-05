// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { ProvisionedChannel } from './api'
import { API_BASE } from './apiBase'
import { responseError } from './httpError'
import type { PairedParticipant } from './types'

/**
 * Linking a recovery channel on a helper that lives on **another node**.
 *
 * A recovering owner pairs afresh with each old helper, and the helper then has
 * to be told the new channel belongs to an owner it already holds shares for —
 * the operator "Link" step. For this node's pool that goes through this node's
 * `/helpers/:id/link`. A helper on another node is driven through *that*
 * node's same endpoint, which its mailbox URL names: a helper's HTTPS endpoint
 * is `<node base>/derec/<actor id>`.
 */

/** Where a helper's operator endpoints live: its node and its actor id. */
export interface HelperLocation {
  baseUrl: string
  actorId: string
}

const MAILBOX = /^(https?:\/\/.+?)\/derec\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i

/** A helper's node and actor id from its mailbox URL, or `null` when it is not one. */
export function parseHelperMailbox(url: string): HelperLocation | null {
  const match = MAILBOX.exec(url.trim())
  return match ? { baseUrl: match[1], actorId: match[2] } : null
}

/** The first HTTPS mailbox a channel row advertises, parsed. */
export function helperLocationOf(h: PairedParticipant): HelperLocation | null {
  const endpoints = h.transports?.length ? h.transports : [h.transport]
  for (const t of endpoints) {
    const location = parseHelperMailbox(t.uri)
    if (location) return location
  }
  return null
}

/** Whether `baseUrl` is this app's own node. */
export function isThisNode(baseUrl: string, apiBase: string = API_BASE): boolean {
  const strip = (u: string) => u.replace(/\/+$/, '')
  return strip(baseUrl) === strip(apiBase)
}

/**
 * Whether a channel row should offer linking on the helper's own node.
 *
 * Only where this vault is the owner — a helper links channels of owners it
 * helps — and only for a peer this node's side panel cannot already link: one
 * whose mailbox is on another node, or whose endpoint is not known as a
 * mailbox at all (gRPC-only), where the URL can be typed in. A browser helper
 * links for itself, from its own pairing prompt.
 */
export function offersRemoteLink(h: PairedParticipant, apiBase: string = API_BASE): boolean {
  if (h.peerRole !== undefined && h.peerRole !== 'helper') return false
  if (h.browserManaged) return false
  const location = helperLocationOf(h)
  return location === null || !isThisNode(location.baseUrl, apiBase)
}

async function remoteRequest(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (cause) {
    throw new Error(`Cannot reach the helper’s node at ${new URL(url).origin}.`, { cause })
  }
}

/** The channels the helper holds, as its node lists them. */
export async function apiListRemoteHelperChannels({
  baseUrl,
  actorId,
}: HelperLocation): Promise<ProvisionedChannel[]> {
  const res = await remoteRequest(`${baseUrl}/helpers/${encodeURIComponent(actorId)}/channels`)
  if (!res.ok) throw await responseError(res, 'Could not list the helper’s channels on its node')
  const body = (await res.json()) as { channels: ProvisionedChannel[] }
  return body.channels
}

/** Link two of the helper's channels on its node — the same call as for this node's pool. */
export async function apiLinkRemoteHelperChannels(
  { baseUrl, actorId }: HelperLocation,
  channelId: string,
  linkToChannelId: string,
): Promise<void> {
  const res = await remoteRequest(`${baseUrl}/helpers/${encodeURIComponent(actorId)}/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel_id: channelId, link_to_channel_id: linkToChannelId }),
  })
  if (!res.ok) throw await responseError(res, 'Could not link the channels on the helper’s node')
}
