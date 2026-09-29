import { DeRecProtocol, DeRecProtocolBuilder, type DeRecEvent } from '@derec-alliance/web'

import { relayMessage, sendMessage } from '../derecApi'
import {
  makeChannelStore,
  makeSecretStore,
  makeShareStore,
  makeStateStore,
  makeTransport,
  makeUserSecretStore,
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
 * different content, and the round has to be resolved and republished at a new
 * version. Identical bytes are accepted as idempotent, so this only ever means
 * a genuine divergence.
 */
export const VERSION_CONFLICT_STATUS = 13

/** A protocol instance plus the stores the app reads directly. */
export interface ProtocolInstance {
  /** u64 decimal string — the registry key. */
  secretId: string
  protocol: DeRecProtocol
  channelStore: ReturnType<typeof makeChannelStore>
  shareStore: ReturnType<typeof makeShareStore>
}

interface BuildProtocolOptions {
  namespace: string
  secretId: string
  ownTransportUri: string
  communicationInfo: Record<string, string>
  threshold: number
  keepVersionsCount: number
  timeoutSecs: number
  unpairAck: 'required' | 'not_required'
  replicaId: bigint
  /**
   * When `true`, every outbound request from this instance stamps
   * `replyTo = ownTransport`, overriding the channel's stored peer endpoint
   * for that exchange. Needed only by a replica destination that has just
   * adopted a source's vault: the helpers it drives still have the
   * *source's* endpoint on file, and without this every response would be
   * delivered there instead of here. Default `false` — the ordinary owner
   * and helper instances pair directly with their peers, whose stored
   * endpoint is already correct, so forcing this on for them would be an
   * unrequested change to the wire format of every request they send.
   */
  autoReplyTo?: boolean
}

export function buildProtocolInstance(opts: BuildProtocolOptions): ProtocolInstance {
  const channelStore = makeChannelStore(opts.namespace)
  const shareStore = makeShareStore(opts.namespace)

  const builder = new DeRecProtocolBuilder(BigInt(opts.secretId))
    .withChannelStore(channelStore)
    .withShareStore(shareStore)
    .withSecretStore(makeSecretStore(opts.namespace))
    .withUserSecretStore(makeUserSecretStore(opts.namespace))
    .withStateStore(makeStateStore(opts.namespace))
    .withTransport(makeTransport(sendMessage, relayMessage))
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
    .withKeepVersionsCount(opts.keepVersionsCount)
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
  }
}

/**
 * The version the library assigned to the round this `start(ProtectSecret)`
 * call just dispatched.
 *
 * Version progression is anchored to the library's own user-secret snapshot,
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
