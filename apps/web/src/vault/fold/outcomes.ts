// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { IgnoreReason } from '@derec-alliance/web'

import type { Vault } from '../../types'
import type { EventHandlers, EventOf, FoldContext } from './context'

type DispatchStarted =
  | 'PairingStarted'
  | 'DiscoveryStarted'
  | 'ProtectSecretStarted'
  | 'VerifySharesStarted'
  | 'RecoverSecretStarted'
  | 'UnpairStarted'
  | 'UpdateChannelInfoStarted'

type DispatchFailed =
  | 'DiscoveryFailed'
  | 'ProtectSecretFailed'
  | 'VerifySharesFailed'
  | 'RecoverSecretFailed'
  | 'UpdateChannelInfoFailed'

/** Why the library dropped a message, as the Console panel says it. */
const IGNORE_REASON_TEXT: Record<IgnoreReason, string> = {
  PendingVerification: "this device has not confirmed the channel's fingerprint yet",
  Expired: 'older than the protocol timeout',
  // A 0.0.8 peer stamps its replies' envelope and inner message separately,
  // so this is what talking to an SDK older than 0.0.9 looks like.
  TimestampMismatch: "its envelope and inner timestamps differ (a peer on an SDK older than 0.0.9?)",
  StaleResponse: 'it answers a verification challenge a newer one replaced',
}

// `start()` reports a result per target it dispatched to. A `*Started` is real
// progress, so it refreshes the watchdog rather than letting it time out a flow
// that is in fact advancing.
function dispatchStarted(current: Vault, _event: EventOf<DispatchStarted>, ctx: FoldContext): Vault {
  ctx.flowProgressed()
  return current
}

// A `*Failed` names the channel that could not be reached, instead of the flow
// failing silently.
function dispatchFailed(current: Vault, event: EventOf<DispatchFailed>, ctx: FoldContext): Vault {
  ctx.log({
    role: 'owner',
    flow: 'protocol',
    step: event.type,
    description: `${event.type} on channel ${event.channel_id}: ${event.error}`,
    payload: { channelId: event.channel_id, error: event.error },
  })
  ctx.notify.error(`A protocol request could not be dispatched (${event.type})`, event.error, {
    channelId: event.channel_id,
  })
  return current
}

/** Dispatch results of `start()`, and the library's reports on its own handling. */
export const outcomeHandlers = {
  PairingStarted: dispatchStarted,
  DiscoveryStarted: dispatchStarted,
  ProtectSecretStarted: dispatchStarted,
  VerifySharesStarted: dispatchStarted,
  RecoverSecretStarted: dispatchStarted,
  UnpairStarted: dispatchStarted,
  UpdateChannelInfoStarted: dispatchStarted,

  // The helper's row says it could not be asked, rather than "Pending" for a
  // reply that cannot come.
  DiscoveryFailed: (current: Vault, event: EventOf<'DiscoveryFailed'>, ctx: FoldContext) => {
    const next = dispatchFailed(current, event, ctx)
    if (!next.participants.some(p => p.channelId === event.channel_id)) return next
    return {
      ...next,
      participants: next.participants.map(p =>
        p.channelId === event.channel_id
          ? { ...p, discoveryComplete: false, discoveryError: `Could not be reached: ${event.error}` }
          : p,
      ),
    }
  },
  ProtectSecretFailed: dispatchFailed,
  VerifySharesFailed: dispatchFailed,
  RecoverSecretFailed: dispatchFailed,
  UpdateChannelInfoFailed: (current: Vault, event: EventOf<'UpdateChannelInfoFailed'>, ctx: FoldContext) => {
    ctx.channelInfoOutcome(event.channel_id, 'failed', event.error)
    return dispatchFailed(current, event, ctx)
  },

  // The library processed a message and deliberately did nothing with it — an
  // acknowledgement, say. Dropped messages are reported as `MessageIgnored`.
  NoOp: (current, _event, ctx) => {
    ctx.log({
      role: 'owner',
      flow: 'protocol',
      step: 'NoOp',
      description: 'A message was processed with no effect',
      payload: {},
    })
    return current
  },

  // A message dropped untouched: nothing was stored and nothing was answered.
  // `PendingVerification` is the one a person can act on — the peer sent it
  // before this device confirmed the channel's fingerprint — so it says so
  // plainly: it is the only visible sign of a copy that never landed.
  MessageIgnored: (current, event, ctx) => {
    ctx.log({
      role: 'owner',
      flow: 'protocol',
      step: 'MessageIgnored',
      description: `Ignored a message on channel ${event.channel_id} — ${IGNORE_REASON_TEXT[event.reason]}`,
      payload: { channelId: event.channel_id, reason: event.reason, traceId: event.trace_id },
    })
    return current
  },

  AutoAccepted: (current, event, ctx) => {
    ctx.log({
      role: 'owner',
      flow: 'protocol',
      step: 'AutoAccepted',
      description: `Auto-accepted an inbound ${event.action_kind} on channel ${event.channel_id}`,
      payload: { channelId: event.channel_id, actionKind: event.action_kind },
    })
    return current
  },

  // Routed before the fold — see `VaultRuntime.processBatch`, which decides
  // whether the owner confirms or the request is accepted automatically. One
  // that reaches the fold anyway has nothing to change.
  ActionRequired: current => current,
} satisfies Partial<EventHandlers>
