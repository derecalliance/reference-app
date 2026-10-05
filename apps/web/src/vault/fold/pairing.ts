// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { updateBagVersion } from '../../owner/bag'
import { applyPairingCompleted } from '../../ownerPairing'
import type { StoredChannelInfo } from '../../stores'
import type { PairedParticipant, Transport, Vault } from '../../types'
import type { EventHandlers } from './context'

/** Pairing, unpairing and channel-info events. */
export const pairingHandlers = {
  PairingCompleted: (current, event, ctx) => {
    const pairedChannelId = event.channel_id
    if (!pairedChannelId) return current
    const next = applyPairingCompleted(current, event, {
      log: ctx.log,
      getVault: ctx.getVault,
      commit: ctx.commit,
      readChannelInfo: ctx.readChannelInfo,
      // Both sides of a replica handshake get this event, so both raise the
      // comparison. Nothing here is destructive and nothing is committed by
      // opening it — it is a modal precisely because verification buried
      // behind a control is verification nobody performs.
      onReplicaChannelEstablished: channelId => {
        ctx.effects.refreshReplicas()
        ctx.effects.openFingerprint(channelId)
      },
    })
    // Only on the transition to paired: a redelivered event changes nothing.
    const isPaired = (p: PairedParticipant) => p.channelId === pairedChannelId && p.connectionStatus === 'paired'
    const wasPaired = current.participants.some(isPaired)
    const peer = next.participants.find(isPaired)
    if (peer && !wasPaired) ctx.notify.outcome(`Paired with ${peer.name}`)
    return next
  },

  Unpaired: (current, event, ctx) => {
    const channelId = event.channel_id
    if (!channelId) return current

    ctx.log({
      role: 'owner',
      flow: 'unpairing',
      step: 'unpaired',
      description: `Channel ${channelId} torn down (unpair flow complete)`,
      payload: { channelId },
    })

    // Drop every local trace of the channel. The library already removed
    // channel-store and share-store entries via the trait callbacks during
    // accept().
    const participantHit = current.participants.find(p => p.channelId === channelId)
    ctx.notify.info(`${participantHit?.name ?? 'Peer'} unpaired (channel ${channelId})`)
    return withoutChannel(current, channelId)
  },

  UnpairRejected: (current, event, ctx) => {
    const channelId = event.channel_id
    if (!channelId) return current
    const peer = current.participants.find(p => p.channelId === channelId)

    ctx.log({
      role: 'owner',
      flow: 'unpairing',
      step: 'unpair_rejected',
      description: `Peer rejected unpair on channel ${channelId} (status ${event.status ?? '?'}): ${event.memo ?? ''}`,
      payload: { channelId, status: event.status, memo: event.memo },
    })
    ctx.notify.error(`${peer?.name ?? 'Peer'} rejected unpair`, event.memo || `status ${event.status ?? '?'}`, {
      channelId,
      status: event.status,
      memo: event.memo,
    })
    return current
  },

  UnpairFailed: (current, event, ctx) => {
    // A teardown the peer never received. `restore` emits these for recovery
    // channels whose helper has gone away — local state is dropped regardless,
    // so this is informational, not a failure to act on.
    ctx.log({
      role: 'owner',
      flow: 'unpairing',
      step: 'UnpairFailed',
      description: `Unpair could not be delivered on channel ${event.channel_id} — local state dropped anyway`,
      payload: { channelId: event.channel_id, error: event.error },
    })
    return current
  },

  // Emitted on both sides of `start(UpdateChannelInfo)`, and the event alone
  // cannot say which: the initiator sees its own update echo back once the peer
  // accepts, and the receiver sees the peer's. So both are handled — the
  // outcome is ignored unless this vault's own update went to this channel, and
  // re-reading the peer's record is a no-op unless the peer changed it.
  // Fires on both sides: as the peer's answer to *this* vault's update, and as
  // a peer's own announcement arriving here. Which one it is comes from the
  // update bookkeeping, asked before the answer is recorded — not from whether
  // this vault's row for the peer changed, which an echo or an unchanged
  // re-announcement also leaves untouched.
  ChannelInfoUpdated: (current, event, ctx) => {
    const answeringOurs = ctx.awaitingIdentityAnswer(event.channel_id)
    ctx.channelInfoOutcome(event.channel_id, 'updated', null)

    const next = withPeerInfo(current, event.channel_id, ctx.readChannelInfo(event.channel_id))
    ctx.log({
      role: 'owner',
      flow: 'pairing',
      step: 'ChannelInfoUpdated',
      description: answeringOurs
        ? `The peer on channel ${event.channel_id} accepted this vault's name/endpoint update`
        : next === current
          ? `The peer on channel ${event.channel_id} re-announced its name/endpoint; nothing changed here`
          : `The peer on channel ${event.channel_id} announced a new name or endpoint`,
      payload: { channelId: event.channel_id, answeringOurs },
    })
    return next
  },

  ChannelInfoUpdateRejected: (current, event, ctx) => {
    ctx.log({
      role: 'owner',
      flow: 'pairing',
      step: 'ChannelInfoUpdateRejected',
      description: `Channel ${event.channel_id} rejected the endpoint update: ${event.memo}`,
      payload: { channelId: event.channel_id, status: event.status, memo: event.memo },
    })
    ctx.notify.error('A peer rejected the channel endpoint update', event.memo, {
      channelId: event.channel_id,
    })
    ctx.channelInfoOutcome(event.channel_id, 'rejected', event.memo || null)
    return current
  },

  PrePairRejected: (current, event, ctx) => {
    ctx.notify.error('A peer refused the pre-pair key exchange', event.memo, {
      channelId: event.channel_id,
    })
    return current
  },
} satisfies Partial<EventHandlers>

/**
 * Bring the participant row(s) on `channelId` in line with what the peer last
 * announced: its name, and its endpoints in preference order.
 *
 * The same record when nothing differs, so an unchanged echo commits nothing.
 */
function withPeerInfo(current: Vault, channelId: string, info: StoredChannelInfo | null): Vault {
  if (!info) return current

  let changed = false
  const participants = current.participants.map(p => {
    if (p.channelId !== channelId) return p
    const name = info.name ?? p.name
    // A row may carry only `transport`; its effective list is that one entry.
    const known = p.transports ?? [p.transport]
    const transports = info.transports.length > 0 ? info.transports : known
    const same = name === p.name && sameTransports(transports, known)
    if (same) return p
    changed = true
    return { ...p, name, transport: transports[0], transports }
  })

  return changed ? { ...current, participants } : current
}

function sameTransports(a: readonly Transport[], b: readonly Transport[]): boolean {
  return a.length === b.length && a.every((t, i) => t.uri === b[i].uri && t.protocol === b[i].protocol)
}

/**
 * The record with every local trace of `channelId` gone: its participant row,
 * held shares, pending pairing, main-channel mark, and its place in the current
 * bag version's participant lists. What an unpair leaves behind — and what
 * forgetting a channel locally does without one.
 */
export function withoutChannel(current: Vault, channelId: string): Vault {
  const participantHit = current.participants.find(p => p.channelId === channelId)

  let updated: Vault = {
    ...current,
    participants: current.participants.filter(p => p.channelId !== channelId),
    heldShares: (current.heldShares ?? []).filter(s => s.channelId !== channelId),
    pendingPairings: current.pendingPairings.filter(p => p.channelId.toString() !== channelId),
    mainChannels: (current.mainChannels ?? []).filter(c => c !== channelId),
  }

  if (updated.secretBag && participantHit) {
    updated = {
      ...updated,
      secretBag: updateBagVersion(updated.secretBag, updated.secretBag.currentVersion.version, v => ({
        ...v,
        participantIds: v.participantIds.filter(id => id !== participantHit.id),
        verifiedParticipantIds: v.verifiedParticipantIds.filter(id => id !== participantHit.id),
        failedParticipantIds: v.failedParticipantIds.filter(f => f.id !== participantHit.id),
      })),
    }
  }
  return updated
}
