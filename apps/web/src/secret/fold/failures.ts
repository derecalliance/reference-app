// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { StatusEnum } from '@derec-alliance/web'

import type { Secret } from '../../types'
import type { EventHandlers } from './context'

/**
 * `StatusEnum` by name — `FormatError` reads better in a console than `9`.
 *
 * Built from the entries: the SDK ships `StatusEnum` as a frozen object of
 * name → value, with no reverse mapping to look a name up by.
 */
const STATUS_NAMES = new Map<number, string>(
  Object.entries(StatusEnum).flatMap(([name, value]) => (typeof value === 'number' ? [[value, name]] : [])),
)

function statusName(status: number): string {
  return STATUS_NAMES.get(status) ?? `status ${status}`
}

/** The participant on `channelId` by name, or the channel id itself. */
function peerOn(current: Secret, channelId: string): string {
  return current.participants.find(p => p.channelId === channelId)?.name ?? `channel ${channelId}`
}

/**
 * Requests that failed or were refused, and answers saying a peer could not
 * process what this secret sent.
 *
 * Since SDK 0.0.9 every request on an authenticated channel is answered exactly
 * once, and a failure is an event rather than an error from `process` or
 * `accept`. This secret runs with `auto_respond_on_failure` off, so a failure
 * the library did not answer comes with a token, and the app answers it with
 * the status and memo the library chose — or the peer waits out its own
 * timeout for a reply that never comes.
 */
export const failureHandlers = {
  RequestFailed: (current, event, ctx) => {
    const peer = peerOn(current, event.channel_id)
    const answer = event.responded
      ? 'the library already answered it'
      : event.action
        ? `answered ${statusName(event.status)}`
        : 'no reply target exists, so nothing can be sent'
    ctx.log({
      role: 'owner',
      flow: 'protocol',
      step: 'RequestFailed',
      description: `A ${event.action_kind} request from ${peer} failed (${event.error_code}: ${event.message}) — ${answer}`,
      payload: {
        channelId: event.channel_id,
        actionKind: event.action_kind,
        responded: event.responded,
        status: event.status,
        errorCode: event.error_code,
        message: event.message,
      },
    })
    // `status` and `memo` are exactly what `auto_respond_on_failure` would
    // have sent; `message` is local detail and never goes to the peer.
    if (!event.responded && event.action) {
      ctx.respondToFailure(event.action, event.status, event.memo)
    }
    ctx.notify.error(`A ${event.action_kind} request from ${peer} could not be handled`, event.message, {
      channelId: event.channel_id,
      errorCode: event.error_code,
    })
    return current
  },

  // This secret, as a helper, refused a share the library judged invalid — it
  // does not decode, does not verify, does not fit, or conflicts with one
  // already stored. The owner was sent the same status and memo, and nothing
  // was stored.
  ShareRefused: (current, event, ctx) => {
    const peer = peerOn(current, event.channel_id)
    ctx.log({
      role: 'owner',
      flow: 'sharing',
      step: 'ShareRefused',
      description: `Refused ${peer}'s share of v${event.version} (${statusName(event.status)}: ${event.memo})`,
      payload: { channelId: event.channel_id, version: event.version, status: event.status, memo: event.memo },
    })
    ctx.notify.error(`Refused ${peer}'s share of v${event.version}`, `${statusName(event.status)}: ${event.memo}`, {
      channelId: event.channel_id,
    })
    return current
  },

  // A copy of the secret from another replica that the library refused before
  // writing any of it. The publisher was sent the same status and memo.
  ReplicaSecretRefused: (current, event, ctx) => {
    ctx.log({
      role: 'owner',
      flow: 'sharing',
      step: 'ReplicaSecretRefused',
      description: `Refused replica ${event.from_replica_id}'s copy of v${event.version} (${statusName(event.status)}: ${event.memo})`,
      payload: {
        channelId: event.channel_id,
        fromReplicaId: event.from_replica_id,
        version: event.version,
        status: event.status,
        memo: event.memo,
      },
    })
    ctx.notify.error(
      `Refused a replica's copy of v${event.version}`,
      `${statusName(event.status)}: ${event.memo}`,
      { channelId: event.channel_id },
    )
    return current
  },

  // An inbound pairing this secret refused under a protocol rule — a parameter
  // range that does not overlap, or a replica id already in the group. No
  // channel was created and the requester was told why.
  PairingRefused: (current, event, ctx) => {
    ctx.log({
      role: 'owner',
      flow: 'pairing',
      step: 'PairingRefused',
      description: `Refused an incoming pairing (${event.error_code}): ${event.message}`,
      payload: {
        channelId: event.channel_id,
        status: event.status,
        memo: event.memo,
        errorCode: event.error_code,
        message: event.message,
      },
    })
    ctx.notify.error('Refused an incoming pairing request', event.message, { channelId: event.channel_id })
    return current
  },

  // The peer could not process a message this secret sent — typically one it
  // could not decode. Never answered, by design.
  ErrorResponseReceived: (current, event, ctx) => {
    const peer = peerOn(current, event.channel_id)
    ctx.log({
      role: 'owner',
      flow: 'protocol',
      step: 'ErrorResponseReceived',
      description: `${peer} could not process a message from this secret (${statusName(event.status)}: ${event.memo})`,
      payload: { channelId: event.channel_id, status: event.status, memo: event.memo },
    })
    ctx.notify.error(`${peer} could not process a message from this secret`, `${statusName(event.status)}: ${event.memo}`, {
      channelId: event.channel_id,
    })
    return current
  },
} satisfies Partial<EventHandlers>
