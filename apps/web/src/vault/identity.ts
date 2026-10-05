// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * A vault's identity as peers see it — its advertised name and endpoint — and
 * the bookkeeping for telling them when it changes.
 *
 * Pure functions only; `VaultRuntime` drives the protocol. Kept apart because
 * none of this needs the runtime, and the rules are easier to test alone.
 */

import type { DeRecEvent } from '@derec-alliance/web'

import type { PairedParticipant } from '../types'
import type { ChannelInfoOutcome, IdentityUpdate, IdentityUpdateChannel } from './types'

/** Matches the backend's name rule, so a name the node would refuse is never announced. */
export const MAX_VAULT_NAME_LENGTH = 64

/** Why `name` cannot be this vault's name, or `null` if it can. */
export function vaultNameProblem(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return 'Enter a name.'
  if (trimmed.length > MAX_VAULT_NAME_LENGTH) {
    return `Keep it to ${MAX_VAULT_NAME_LENGTH} characters or fewer.`
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return 'Remove the control characters.'
  return null
}

/**
 * Why `uri` cannot be this vault's endpoint, or `null` if it can.
 *
 * HTTP(S) only: a browser receives through the node's mailbox and cannot serve
 * gRPC. A path is required — the node routes `/derec/<actor id>` to a mailbox,
 * so a bare origin is never what was meant.
 */
export function endpointProblem(uri: string): string | null {
  const trimmed = uri.trim()
  if (trimmed === '') return 'Enter an endpoint, or follow the node’s address.'
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return 'Enter a full URL, like http://192.168.0.28:5000/derec/<vault id>.'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Use an http:// or https:// address — a browser vault cannot serve gRPC.'
  }
  if (url.pathname === '/' || url.pathname === '') {
    return 'Include the mailbox path, e.g. /derec/<vault id>.'
  }
  return null
}

/**
 * The bookkeeping for one update, from what `start(UpdateChannelInfo)` returned:
 * a channel per `UpdateChannelInfoStarted` (now waiting on the peer) and per
 * `UpdateChannelInfoFailed` (never reached it).
 */
export function identityUpdateFrom(
  events: readonly DeRecEvent[],
  participants: readonly PairedParticipant[],
  values: IdentityUpdate['values'],
  sentAt: number,
): IdentityUpdate {
  return {
    changed: { name: values.name !== undefined, endpoint: values.endpoint !== undefined },
    values,
    sentAt,
    channels: channelsFrom(events, participants, sentAt),
  }
}

/**
 * `update` with a resend folded in: the channels it went to start waiting
 * again, and every other peer keeps the answer it already gave.
 */
export function withIdentityResend(
  update: IdentityUpdate,
  events: readonly DeRecEvent[],
  participants: readonly PairedParticipant[],
  sentAt: number,
): IdentityUpdate {
  return { ...update, channels: { ...update.channels, ...channelsFrom(events, participants, sentAt) } }
}

function channelsFrom(
  events: readonly DeRecEvent[],
  participants: readonly PairedParticipant[],
  sentAt: number,
): Record<string, IdentityUpdateChannel> {
  const peerName = (channelId: string): string =>
    participants.find(p => p.channelId === channelId)?.name || `Channel ${channelId}`

  const channels: Record<string, IdentityUpdateChannel> = {}
  for (const event of events) {
    if (event.type === 'UpdateChannelInfoStarted') {
      channels[event.channel_id] = {
        peerName: peerName(event.channel_id),
        sentAt,
        outcome: 'pending',
        detail: null,
      }
    } else if (event.type === 'UpdateChannelInfoFailed') {
      channels[event.channel_id] = {
        peerName: peerName(event.channel_id),
        sentAt,
        outcome: 'failed',
        detail: event.error,
      }
    }
  }
  return channels
}

/**
 * `update` with every peer that has stayed silent past `timeoutMs` marked
 * `no-answer`, or the same object when none has.
 *
 * The protocol drops an unanswered flow after its timeout, so waiting longer
 * shows a "waiting" that nothing will ever resolve.
 */
export function withExpiredWaits(
  update: IdentityUpdate | null,
  now: number,
  timeoutMs: number,
): IdentityUpdate | null {
  if (!update) return update
  let changed = false
  const channels: Record<string, IdentityUpdateChannel> = {}
  for (const [channelId, entry] of Object.entries(update.channels)) {
    if (entry.outcome === 'pending' && now - entry.sentAt >= timeoutMs) {
      changed = true
      channels[channelId] = {
        ...entry,
        outcome: 'no-answer',
        detail: `No answer within ${Math.round(timeoutMs / 1000)}s`,
      }
    } else {
      channels[channelId] = entry
    }
  }
  return changed ? { ...update, channels } : update
}

/** The peers an update did not reach: never delivered, or never answered. */
export function undeliveredChannelIds(update: IdentityUpdate | null): string[] {
  if (!update) return []
  return Object.entries(update.channels)
    .filter(([, entry]) => entry.outcome === 'failed' || entry.outcome === 'no-answer')
    .map(([channelId]) => channelId)
}

/** Whether any peer of `update` is still waiting, or was not reached. */
export function hasOutstandingPeers(update: IdentityUpdate | null): boolean {
  if (!update) return false
  return Object.values(update.channels).some(
    entry => entry.outcome === 'pending' || entry.outcome === 'failed' || entry.outcome === 'no-answer',
  )
}

/**
 * Why a pinned endpoint is probably not one peers can answer, or nothing.
 *
 * Warnings, not errors: an operator behind a proxy may legitimately pin an
 * origin the node does not know about. But replies to a vault arrive only
 * through the node's mailbox at `/derec/<vault id>`, so a different path — or
 * another vault's id — means every peer's answer goes somewhere this vault
 * never reads, and the update then sits at "waiting" until it times out.
 */
export function pinnedEndpointWarnings(
  uri: string,
  vaultId: string,
  nodeAddress: string | null,
): string[] {
  let url: URL
  try {
    url = new URL(uri.trim())
  } catch {
    return []
  }
  const warnings: string[] = []
  const expectedPath = `/derec/${vaultId}`
  if (url.pathname.replace(/\/+$/, '') !== expectedPath) {
    warnings.push(
      `The path is not ${expectedPath}. Peers reply to this vault only through that mailbox — anything else and their answers never arrive.`,
    )
  }
  if (nodeAddress) {
    try {
      const node = new URL(nodeAddress)
      if (node.origin !== url.origin) {
        warnings.push(
          `The node lists this vault at ${node.origin}, not ${url.origin}. Unless a proxy forwards ${url.origin} to the node, peers cannot reach it.`,
        )
      }
    } catch {
      // The node's address is not a URL; nothing to compare against.
    }
  }
  return warnings
}

/**
 * `update` with one peer's answer applied, or the same object when it does not
 * apply: a channel the update did not go to (a peer updating *this* vault fires
 * the same events), or one already settled.
 */
export function withChannelOutcome(
  update: IdentityUpdate | null,
  channelId: string,
  outcome: ChannelInfoOutcome,
  detail: string | null,
): IdentityUpdate | null {
  const entry = update?.channels[channelId]
  if (!update || !entry || entry.outcome !== 'pending') return update
  return {
    ...update,
    channels: { ...update.channels, [channelId]: { ...entry, outcome, detail } },
  }
}

/** How many peers are in each state — for a one-line summary. */
export function identityUpdateCounts(update: IdentityUpdate): Record<ChannelInfoOutcome, number> {
  const counts: Record<ChannelInfoOutcome, number> = {
    pending: 0,
    updated: 0,
    rejected: 0,
    failed: 0,
    'no-answer': 0,
  }
  for (const entry of Object.values(update.channels)) counts[entry.outcome] += 1
  return counts
}
