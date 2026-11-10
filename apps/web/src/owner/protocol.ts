// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { DeRecProtocol, DeRecProtocolBuilder, type DeRecEvent } from '@derec-alliance/web'

import { relayMessage, sendMessage } from '../derecApi'
import { ChannelUpdateClock } from '../secret/channelUpdates'
import { ReplayGuard } from '../secret/replayGuard'
import {
  makeChannelStore,
  makeSecretStore,
  makeShareStore,
  makeStateStore,
  makeTransport,
  makeUserSecretStore,
  type KeepVersionSource,
} from '../stores'

// ── Protocol instance registry ───────────────────────────────────────────────
//
// A DeRecProtocol instance is bound to exactly one `secret_id`, and both ends
// of a relationship must bind to the same one. This node therefore runs
// several instances at once: one for the secret it owns, plus one per owner it
// acts as Helper for. They share a localStorage namespace because every store
// is internally partitioned by secret id.

/**
 * How often the page advances time-driven protocol state.
 *
 * `process()` is the only other thing that moves protocol time forward, so a
 * publishing round whose helpers all go quiet has nothing left to close it —
 * no `SharingComplete` is ever emitted and the flow watchdog fires instead of
 * the real result. Must stay well below the configured protocol timeout.
 */
export const TICK_INTERVAL_MS = 15_000

/**
 * How long a publishing round waits on a helper or replica that has not
 * answered before closing without it — the library's own default, set
 * explicitly so the app's backstop below is derived from the real number
 * rather than a remembered one.
 */
export const SHARING_ROUND_SECS = 60

/**
 * How long the app waits on a protect round before stepping in itself.
 *
 * The library always closes a round: within `SHARING_ROUND_SECS` of the last
 * helper going quiet, noticed on the next tick, and later still when the
 * replica leg has to time out as well. The app's watchdog used to fire on the
 * general protocol timeout, which could be shorter — so it reported a round
 * as failed and erased its progress, and the library then committed it anyway.
 * Twice the round budget plus two ticks keeps it strictly behind the library.
 */
export const PROTECT_ROUND_BACKSTOP_MS = 2 * SHARING_ROUND_SECS * 1000 + 2 * TICK_INTERVAL_MS

/**
 * How long a recovery waits on a helper that has not answered its share
 * request (SDK 0.0.11). The library decides only once every helper asked has
 * answered or this has passed, reporting each silent one as
 * `RecoverSecretFailed` with error `"timeout"`. Its default is five minutes;
 * this app matches the publishing round's budget instead, for the same reason
 * — a Recovering… row that sits for five minutes on one offline helper looks
 * hung. It also bounds a replica version check.
 */
export const GET_SHARE_RESPONSE_SECS = 60

/**
 * The recovery watchdog: the library decides on its tick after
 * `GET_SHARE_RESPONSE_SECS`, so the app only steps in two ticks after that.
 */
export const RECOVERY_BACKSTOP_MS = GET_SHARE_RESPONSE_SECS * 1000 + 2 * TICK_INTERVAL_MS

/**
 * How long a pairing stays possible (SDK 0.0.11): how old a contact may be
 * when it is scanned or answered, and how old a pairing request may be when it
 * is accepted. The library's default is 30 seconds, which a person copying a
 * contact between two browser windows, or confirming an incoming request by
 * hand, does not make. Half an hour keeps it well inside
 * `PENDING_CHANNEL_TTL_SECS`, as the library requires of a scanner's sweep.
 * The contact a secret publishes for browser peers is re-minted before it
 * gets this old — see `CONTACT_REFRESH_MS`.
 */
export const PAIRING_LIFETIME_SECS = 1800

/** How old the published browser contact may get before it is re-minted: half its lifetime. */
export const CONTACT_REFRESH_MS = (PAIRING_LIFETIME_SECS * 1000) / 2

/**
 * How long a `Pending` channel may wait for out-of-band confirmation.
 *
 * The library's automatic sweep is disabled in favour of this. Its default (5
 * minutes) is also the budget a *human* gets to compare a fingerprint out of
 * band — every `NoKeys` pairing and every replica pairing waits in `Pending`
 * for exactly that — and five minutes is far too short for someone reading
 * codes between two browser windows.
 */
export const PENDING_CHANNEL_TTL_SECS = 3600

/**
 * `StatusEnum.VERSION_CONFLICT` — two members published the same version with
 * different content. The device must not publish again until the owner has
 * merged the two copies; see `Secret.replicaConflict`. An identical copy is
 * accepted as a re-send — from SDK 0.0.7 even when the held one records no
 * author — so this only ever means a genuine divergence.
 */
export const VERSION_CONFLICT_STATUS = 13

/** A protocol instance plus the stores the app reads directly. */
export interface ProtocolInstance {
  /** u64 decimal string — the registry key. */
  secretId: string
  protocol: DeRecProtocol
  channelStore: ReturnType<typeof makeChannelStore>
  shareStore: ReturnType<typeof makeShareStore>
  /** Recognises copies of messages this device sent or already accepted. */
  replayGuard: ReplayGuard
  /** The newest contact update accepted on each of this instance's channels. */
  channelUpdates: ChannelUpdateClock
}

interface BuildProtocolOptions {
  namespace: string
  secretId: string
  ownTransportUri: string
  communicationInfo: Record<string, string>
  threshold: number
  /**
   * Which earlier version helpers keep after each round — the owner's
   * `keepVersion`. Required, so no instance that can act as an owner is built
   * without a retention policy. See `secret/keepVersion.ts`.
   */
  keepVersion: KeepVersionSource
  timeoutSecs: number
  unpairAck: 'required' | 'not_required'
  replicaId: bigint
  /**
   * The owner actor this instance acts for — the secret's local id — sent with
   * every relayed message so the node can attribute it. Omitted, the relay
   * still works, unattributed.
   */
  relayActorId?: string
  /**
   * When `true`, every outbound request from this instance stamps
   * `replyTo = ownTransport`, overriding the channel's stored peer endpoint
   * for that exchange, so answers come back to wherever this instance is now.
   *
   * On for every secret instance (runtime, restore, adoption). An adopted
   * replica needs it outright — its helpers still have the *source's*
   * endpoint on file — and since SDK 0.0.7 it is also the documented way to
   * announce a new endpoint: `setOwnTransports` first, then a publish whose
   * requests carry the new address as `reply_to`, so helpers that still hold
   * the old one answer on the new (there is no per-round `reply_to` on
   * `ProtectSecret`). While the endpoint is unchanged, `reply_to` names the
   * same address the helper already has, so nothing else changes.
   * Default `false` for any other caller.
   */
  autoReplyTo?: boolean
}

export function buildProtocolInstance(opts: BuildProtocolOptions): ProtocolInstance {
  const channelStore = makeChannelStore(opts.namespace)
  const shareStore = makeShareStore(opts.namespace, { keepVersion: opts.keepVersion })
  const replayGuard = new ReplayGuard(opts.namespace, opts.timeoutSecs)

  const builder = new DeRecProtocolBuilder(BigInt(opts.secretId))
    .withChannelStore(channelStore)
    .withShareStore(shareStore)
    .withSecretStore(makeSecretStore(opts.namespace))
    .withUserSecretStore(makeUserSecretStore(opts.namespace))
    .withStateStore(makeStateStore(opts.namespace))
    .withTransport(
      makeTransport(sendMessage, (uri, message) => relayMessage(uri, message, opts.relayActorId), {
        onSend: message => replayGuard.remember(message),
      }),
    )
    // A list, even though this app serves exactly one endpoint: the singular
    // setter is deprecated, and the whole list is what gets advertised in
    // `supportedTransports` at pairing.
    .withOwnTransports([{ uri: opts.ownTransportUri, protocol: 'https' }])
    // Derived, not hardcoded: the guardrail comes back on its own the moment
    // this app is served over https.
    //
    // Loopback is *not* enough to skip it. The library exempts plaintext
    // loopback only for the endpoint a device configures for **itself**; a
    // peer's endpoint may never be plaintext by default, and every peer here
    // is `http://localhost:5000/derec/...`. Pairing fails without this with a
    // message naming the flag.
    .withUnsafeConnection(!opts.ownTransportUri.startsWith('https://'))
    .withThreshold(opts.threshold)
    .withTimeouts({
      // The wizard's single "protocol timeout" is the replay window, which is
      // the meaning it has always carried: how stale an inbound envelope may
      // be and still be accepted.
      //
      // The liveness budgets — how long to keep hoping a silent peer answers —
      // deliberately keep the library's defaults rather than inheriting that
      // number. They answer a different question, and a five-minute wait on one
      // unreachable replica is five minutes of a modal that looks hung: a
      // publishing round is not reported complete until the replica leg
      // resolves too.
      inbound_message_secs: opts.timeoutSecs,
      sharing_round_secs: SHARING_ROUND_SECS,
      get_share_response_secs: GET_SHARE_RESPONSE_SECS,
      pairing_secs: PAIRING_LIFETIME_SECS,
      // Cleanup is driven from this page's own tick instead — see
      // `PENDING_CHANNEL_TTL_SECS`.
      expired_channels: { enabled: false, timeout_in_secs: PENDING_CHANNEL_TTL_SECS },
    })
    .withCommunicationInfo(opts.communicationInfo)
    .withUnpairAck(opts.unpairAck)
    .withReplicaId(opts.replicaId)
    .withAutoReplyTo(opts.autoReplyTo ?? false)

  return {
    secretId: opts.secretId,
    protocol: builder.build(),
    channelStore,
    shareStore,
    replayGuard,
    channelUpdates: new ChannelUpdateClock(opts.namespace, opts.secretId),
  }
}

/**
 * The version the library assigned to the round this `start(ProtectSecret)`
 * call just dispatched.
 *
 * Version progression is anchored to the library's own snapshot of the items,
 * which also bumps on pair-completion auto-publish — so the app cannot derive
 * it from its own bag history without drifting out of step. Read it back from
 * the dispatch events instead.
 *
 * `ProtectSecretStarted` is checked across **all** the events before falling
 * back to `SharingComplete`, and the order matters. Rounds are keyed by version
 * and run concurrently, so this call's result can also carry the completion of
 * an *older* round that happened to finish in the same batch — a replica
 * pairing's auto-publish, typically. Taking whichever came first would then
 * attribute the previous round's version to this one, and every subsequent
 * `ShareConfirmed` would be filed against a round the user is not watching:
 * the progress dialog sits at "0 of N confirmed" while the round underneath it
 * completes normally.
 *
 * `SharingComplete` remains a fallback for the case where a round resolves
 * without dispatching anything.
 */
export function protectVersionFrom(events: DeRecEvent[]): number | null {
  const started = events.find(e => e.type === 'ProtectSecretStarted')
  if (started) return started.version

  const completed = events.find(e => e.type === 'SharingComplete')
  return completed ? completed.version : null
}

/**
 * Pull the pairing channel id out of a `start(Pairing)` result.
 *
 * `start` no longer returns the channel id — it reports the dispatched
 * handshake as a `PairingStarted` event. This is the *transient* id that
 * travelled on the ContactMessage; the handshake atomically rotates to a
 * long-term id that arrives later on `PairingCompleted`.
 */
export function pairingChannelIdFrom(events: DeRecEvent[]): bigint {
  const started = events.find(e => e.type === 'PairingStarted')
  if (!started) throw new Error('pairing dispatched no PairingStarted event')
  return BigInt(started.channel_id)
}
