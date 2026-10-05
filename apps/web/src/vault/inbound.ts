// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { DeRecEvent, PendingActionKind } from '@derec-alliance/web'

import { classifyInboundPairing } from '../inboundPairing'
import type { Vault, VaultConfig } from '../types'
import type { Attention, StoreShareRequest, VaultLogger, VerifyShareRequest } from './types'

type ActionRequired = Extract<DeRecEvent, { type: 'ActionRequired' }>

/** What handling an inbound request did. */
export interface InboundOutcome {
  vault: Vault
  /**
   * A confirmation was raised: the batch must stop here and keep the rest of
   * its messages until the owner decides. The mailbox is destructive, so they
   * cannot simply be dropped.
   */
  holdBack: boolean
}

/** Everything routing an inbound request may reach. */
export interface InboundContext {
  readonly log: VaultLogger
  raiseAttention(item: Omit<Attention, 'id' | 'raisedAt'>): string
  /** What this vault runs with — read per request, so a Settings change applies at once. */
  config(): VaultConfig
  /** Accept `action` and fold what it produces. Reports rather than throws. */
  acceptAndFold(
    action: Uint8Array,
    current: Vault,
    failure: string,
    context: Record<string, unknown>,
  ): Promise<Vault>
  /**
   * Accept a share-storage request and fold it, recording the share with the
   * secret id and description the bare fold would not. Reports rather than throws.
   */
  acceptStoreShare(request: StoreShareRequest, current: Vault): Promise<Vault>
}

type InboundHandler = (
  event: ActionRequired,
  current: Vault,
  ctx: InboundContext,
) => InboundOutcome | Promise<InboundOutcome>

/** The name of the paired participant on `channelId`, for prompts and logs. */
function peerNameOn(current: Vault, channelId: string): string {
  return current.participants.find(h => h.channelId === channelId)?.name || 'Unknown peer'
}

/** A request the protocol can answer without asking anyone. */
const acceptAutomatically: InboundHandler = async (event, current, ctx) => ({
  vault: await ctx.acceptAndFold(
    event.action,
    current,
    `Failed to auto-accept ${event.action_kind ?? 'a protocol'} request`,
    { channelId: event.channel_id },
  ),
  holdBack: false,
})

/**
 * How each kind of inbound request is handled: raised for the owner to decide,
 * or accepted automatically. Store-share, verify-share and unpair are decided by
 * the vault's configuration.
 *
 * Exhaustive over `PendingActionKind`, so a new kind from an SDK upgrade fails to
 * compile here until someone decides whether it needs the owner — rather than
 * falling into "accept" unexamined.
 */
const INBOUND: Record<PendingActionKind, InboundHandler> = {
  Pairing: (event, current, ctx) => {
    // An inbound pairing is always from a browser peer — this vault initiates
    // with provisioned actors itself. Which confirmation it needs depends on the
    // kind the initiator declared: a replica pairing cannot be linked and, on
    // the destination side, commits this device's vault.
    const channelId = event.channel_id
    const peerName = event.peer_communication_info?.name || 'Unknown peer'
    const confirmation = classifyInboundPairing(
      { peerName, channelId, action: event.action },
      event.sender_kind,
    )
    ctx.raiseAttention({ kind: 'pairing', blocksDrain: true, payload: confirmation })
    ctx.log({
      role: 'owner',
      flow: 'pairing',
      step: confirmation.replica ? 'replica_pairing_confirmation_pending' : 'pairing_confirmation_pending',
      description: confirmation.replica
        ? `Replica pairing request from "${peerName}" — this device would be the ${confirmation.replica.localRole} — waiting for user confirmation`
        : `Pairing request from "${peerName}" — waiting for user confirmation`,
      payload: { channelId, senderKind: event.sender_kind, localRole: confirmation.replica?.localRole ?? null },
    })
    return { vault: current, holdBack: true }
  },

  StoreShare: async (event, current, ctx) => {
    const channelId = event.channel_id
    const peerName = peerNameOn(current, channelId)
    const request: StoreShareRequest = {
      peerName,
      channelId,
      secretId: event.share_secret_id ?? '0',
      version: event.version ?? 0,
      description: event.share_description || '',
      action: event.action,
    }

    if (ctx.config().autoAcceptStoreShareRequests) {
      ctx.log({
        role: 'owner',
        flow: 'sharing',
        step: 'store_share_auto_accepted',
        description: `Share storage request from "${peerName}" (version ${request.version}) — auto-accepting`,
        payload: { channelId, version: request.version },
      })
      return { vault: await ctx.acceptStoreShare(request, current), holdBack: false }
    }

    ctx.raiseAttention({ kind: 'store-share', blocksDrain: true, payload: request })
    ctx.log({
      role: 'owner',
      flow: 'sharing',
      step: 'store_share_confirmation_pending',
      description: `Share storage request from "${peerName}" — waiting for confirmation`,
      payload: { channelId, version: event.version },
    })
    return { vault: current, holdBack: true }
  },

  VerifyShare: async (event, current, ctx) => {
    const channelId = event.channel_id
    const peerName = peerNameOn(current, channelId)
    const request: VerifyShareRequest = {
      peerName,
      channelId,
      version: event.version ?? 0,
      secretId: event.share_secret_id ?? '0',
      action: event.action,
    }

    if (ctx.config().autoAcceptVerifyShareRequests) {
      ctx.log({
        role: 'owner',
        flow: 'verification',
        step: 'verify_share_auto_accepted',
        description: `Verification request from "${peerName}" (version ${request.version}) — auto-accepting`,
        payload: { channelId, version: request.version },
      })
      return {
        vault: await ctx.acceptAndFold(event.action, current, 'Failed to auto-accept verification request', {
          channelId,
          version: request.version,
        }),
        holdBack: false,
      }
    }

    ctx.raiseAttention({ kind: 'verify-share', blocksDrain: true, payload: request })
    ctx.log({
      role: 'owner',
      flow: 'verification',
      step: 'verify_share_confirmation_pending',
      description: `Verification request from "${peerName}" — waiting for confirmation`,
      payload: { channelId, version: event.version },
    })
    return { vault: current, holdBack: true }
  },

  Unpair: async (event, current, ctx) => {
    // Configuration decides whether a peer-initiated unpair is accepted outright
    // or shown to the owner first.
    const channelId = event.channel_id
    const peerName = peerNameOn(current, channelId)
    const autoAccept = ctx.config().autoAcceptUnpairRequests
    ctx.log({
      role: 'owner',
      flow: 'unpairing',
      step: 'unpair_action_required',
      description: `Incoming Unpair from "${peerName}" — ${autoAccept ? 'auto-accepting' : 'showing modal'}`,
      payload: { channelId, autoAcceptUnpairRequests: autoAccept },
    })

    if (autoAccept) {
      return {
        vault: await ctx.acceptAndFold(event.action, current, 'Failed to auto-accept incoming unpair request', {
          channelId,
        }),
        holdBack: false,
      }
    }

    ctx.raiseAttention({ kind: 'unpair', blocksDrain: true, payload: { peerName, channelId, action: event.action } })
    ctx.log({
      role: 'owner',
      flow: 'unpairing',
      step: 'unpair_confirmation_pending',
      description: `Unpair request from "${peerName}" — waiting for confirmation`,
      payload: { channelId },
    })
    return { vault: current, holdBack: true }
  },

  PrePair: acceptAutomatically,
  Discovery: acceptAutomatically,
  GetShare: acceptAutomatically,
  UpdateChannelInfo: acceptAutomatically,
}

/**
 * Decide what an inbound request needs: the owner's confirmation, or an
 * automatic accept.
 */
export function routeActionRequired(
  event: ActionRequired,
  current: Vault,
  ctx: InboundContext,
): Promise<InboundOutcome> {
  // Unknown to this build — a newer library. Accepting is what the previous
  // `default` branch did, and what the protocol expects of a request it sent.
  const handler = INBOUND[event.action_kind] ?? acceptAutomatically
  return Promise.resolve(handler(event, current, ctx))
}
