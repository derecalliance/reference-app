import { describe, expect, it, vi } from 'vitest'
import {
  adoptReplicaSecret,
  adoptedVaultState,
  adoptionSourceLabel,
  automaticSyncNeedsAttention,
  canRequestReplicaSync,
  clearReplicaState,
  createReplicaFirstSyncTrigger,
  describeRestoreFailure,
  loadReplicaState,
  markReplicaFirstSyncStarted,
  recordConfirmation,
  recordReplicaChannel,
  replicaChannelRowId,
  acceptFingerprintMatch,
  formatFingerprint,
  type ReplicaProtocol,
  mergeReplicaSecretReceipt,
  mergeReplicaSync,
  nextReplicaStatus,
  replicaChannelExpiry,
  replicasAwaitingFirstSync,
  replicaSyncTargets,
  replicaViews,
  ReplicaAdoptionError,
  REPLICA_EXPIRY_WARNING_SECS,
  REPLICA_PAYLOAD_MIRRORS_RECOVERY,
  type AdoptableInstance,
  type AutomaticReplicaSyncOutcome,
  type ReplicaChannelTiming,
  type PendingReplicaAdoption,
  type ReplicaAdoptionDeps,
  type ReplicaAdoptionInstanceParams,
  type ReplicaAdoptionProtocolConfig,
  type ReplicaFirstSyncTrigger,
  type ReplicaState,
  type ReplicaStatus,
  type ReplicaSyncReason,
  type ReplicaSyncRecord,
  type ReplicaSyncRoundResult,
  type ReplicaView,
} from './replicaFlows'
import { getOrCreateReplicaId } from './replicaIdentity'
import type { BEActorWithStatus } from './api'
import type { DeRecEvent } from '@derec-alliance/web'

describe('nextReplicaStatus', () => {
  // `localConfirmed` is set on — and only on — a `verifyFingerprint` that
  // returned `true`, which is the library's own `Pending → Paired` transition.
  // So these cases read as "what the library says about this channel".

  it('promotes a channel the library has promoted', () => {
    expect(nextReplicaStatus('pending', { localConfirmed: true })).toBe('paired')
  })

  it('leaves a channel the library still holds pending at pending', () => {
    expect(nextReplicaStatus('pending', { localConfirmed: false })).toBe('pending')
  })

  it('lets a channel pair after an earlier mismatch — a mismatch is retryable, not terminal', () => {
    // The falsifiable half of "retryable": an implementation that treats a
    // failed attempt as terminal (blocking promotion, or dropping the channel
    // back to `unpaired`) fails here while still passing the cases above.
    const status: ReplicaStatus = nextReplicaStatus('pending', {
      localConfirmed: true,
      lastAttemptFailed: true,
    })
    expect(status).toBe('paired')
  })

  it('holds an unconfirmed channel at pending after a mismatch', () => {
    expect(
      nextReplicaStatus('pending', { localConfirmed: false, lastAttemptFailed: true }),
    ).toBe('pending')
  })

  it('never promotes a channel that does not exist yet', () => {
    expect(nextReplicaStatus('unpaired', { localConfirmed: true })).toBe('unpaired')
  })

  it('keeps paired terminal — confirmation is not withdrawn', () => {
    expect(nextReplicaStatus('paired', { localConfirmed: false })).toBe('paired')
  })
})

describe('replicaChannelExpiry', () => {
  // `cleanup_expired_channels` removes a channel still `Pending` once
  // `now - created_at > timeout`, measured from the channel's *creation*. Every
  // case here injects `now`: the boundaries are the whole point of the function,
  // and a rule that read the clock itself could only be tested by waiting for it.

  const TIMEOUT = 300
  /** Epoch ms this device recorded for the handshake. */
  const AT = 1_000_000

  function pending(establishedAt: number | null = AT): ReplicaChannelTiming {
    return { status: 'pending', establishedAt }
  }

  it('reports the whole window on a channel established this instant', () => {
    expect(replicaChannelExpiry(pending(), TIMEOUT, AT)).toEqual({
      state: 'ample',
      remainingSecs: TIMEOUT,
      expiresAt: AT + TIMEOUT * 1000,
    })
  })

  it('counts down as the deadline approaches', () => {
    expect(replicaChannelExpiry(pending(), TIMEOUT, AT + 100_000)).toMatchObject({
      state: 'ample',
      remainingSecs: 200,
    })
  })

  it('escalates exactly at the warning threshold and not a moment before', () => {
    const thresholdAt = AT + (TIMEOUT - REPLICA_EXPIRY_WARNING_SECS) * 1000

    expect(replicaChannelExpiry(pending(), TIMEOUT, thresholdAt - 1)?.state).toBe('ample')
    expect(replicaChannelExpiry(pending(), TIMEOUT, thresholdAt)).toMatchObject({
      state: 'expiring-soon',
      remainingSecs: REPLICA_EXPIRY_WARNING_SECS,
    })
  })

  it('still counts a channel with a second left rather than calling it gone', () => {
    expect(replicaChannelExpiry(pending(), TIMEOUT, AT + TIMEOUT * 1000 - 1)).toMatchObject({
      state: 'expiring-soon',
      remainingSecs: 1,
    })
  })

  it('reports expired the moment the window closes', () => {
    expect(replicaChannelExpiry(pending(), TIMEOUT, AT + TIMEOUT * 1000)).toEqual({
      state: 'expired',
      remainingSecs: 0,
      expiresAt: AT + TIMEOUT * 1000,
    })
  })

  it('stays expired well past the deadline, and never counts below zero', () => {
    expect(replicaChannelExpiry(pending(), TIMEOUT, AT + 10 * TIMEOUT * 1000)).toMatchObject({
      state: 'expired',
      remainingSecs: 0,
    })
  })

  it('never reports a paired channel as expiring, however old it is', () => {
    // Only `Pending` channels are cleaned up. A confirmed channel is `Paired` in
    // the library and cleanup skips it, so a deadline on one would be fiction —
    // and would tell the user to re-pair a channel that is working.
    expect(
      replicaChannelExpiry(
        { status: 'paired', establishedAt: AT },
        TIMEOUT,
        AT + 10 * TIMEOUT * 1000,
      ),
    ).toBeNull()
  })

  it('never reports an unpaired row as expiring', () => {
    // No handshake, so there is no channel to lose.
    expect(
      replicaChannelExpiry({ status: 'unpaired', establishedAt: AT }, TIMEOUT, AT + TIMEOUT * 1000),
    ).toBeNull()
  })

  it('says nothing about a channel it holds no stamp for', () => {
    // A record written before stamping existed. Unknown is not expired: an
    // assumed start time would invent a deadline and could condemn a live
    // channel on the strength of a guess.
    expect(replicaChannelExpiry(pending(null), TIMEOUT, AT + 10 * TIMEOUT * 1000)).toBeNull()
  })

  it('says nothing when the timeout is not a usable duration', () => {
    expect(replicaChannelExpiry(pending(), 0, AT)).toBeNull()
    expect(replicaChannelExpiry(pending(), -30, AT)).toBeNull()
    expect(replicaChannelExpiry(pending(), Number.NaN, AT)).toBeNull()
  })

  it('ignores the wall clock entirely', () => {
    // The falsifiable half of "pure": with the system clock ten windows past the
    // deadline, an implementation that reached for `Date.now()` instead of its
    // `now` argument would report this fresh channel as expired.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(AT + 10 * TIMEOUT * 1000))
    try {
      expect(replicaChannelExpiry(pending(), TIMEOUT, AT)).toMatchObject({
        state: 'ample',
        remainingSecs: TIMEOUT,
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('automaticSyncNeedsAttention', () => {
  // The automatic round is marked spent before it runs and is never retried, so
  // anything short of a dispatch is the end of the line unless the user is told.

  it('flags a round that was rejected', () => {
    expect(automaticSyncNeedsAttention({ kind: 'failed', error: new Error('no') })).toBe(true)
  })

  it('flags a round that dispatched nothing', () => {
    expect(automaticSyncNeedsAttention({ kind: 'nothing-to-mirror' })).toBe(true)
  })

  it('stays quiet about a round that went out', () => {
    // The control: without it, "always true" would pass both cases above.
    expect(automaticSyncNeedsAttention({ kind: 'dispatched' })).toBe(false)
  })
})

describe('acceptFingerprintMatch', () => {
  /** Records what the library was asked to verify. */
  function protocolSpy(verdict = true) {
    const seen: Array<{ channelId: bigint; fingerprint: string }> = []
    return {
      seen,
      protocol: {
        start: () => Promise.resolve([]),
        getFingerprint: () => Promise.resolve('9999-9999-9999-9999'),
        verifyFingerprint: (channelId: bigint | number, fingerprint: string) => {
          seen.push({ channelId: BigInt(channelId), fingerprint })
          return Promise.resolve(verdict)
        },
      } as unknown as ReplicaProtocol,
    }
  }

  // The comparison is the operator's, exactly as in Bluetooth numeric
  // comparison: both ends show a code, a person checks they match, each end
  // records its own decision. Nothing is transcribed, so there is no
  // peer-supplied string for the library to re-check — this call verifies the
  // code this device just derived, which is what promotes Pending → Paired.

  it('verifies this device’s own code, not a transcribed one', () => {
    const { seen, protocol } = protocolSpy()

    return acceptFingerprintMatch(protocol, '900', '1111-2222-3333-4444').then(() => {
      expect(seen).toHaveLength(1)
      expect(seen[0].fingerprint).toBe('1111-2222-3333-4444')
      expect(seen[0].channelId).toBe(900n)
    })
  })

  it('normalises separators before verifying', async () => {
    const { seen, protocol } = protocolSpy()

    await acceptFingerprintMatch(protocol, '900', '  1111 2222 3333 4444 ')

    expect(seen[0].fingerprint).toBe('1111-2222-3333-4444')
  })

  it('returns the library’s verdict verbatim', async () => {
    // `false` here is not "the codes differ" — the operator settled that. It
    // means the channel key changed under the comparison, and the caller
    // surfaces it as an anomaly rather than a retry prompt.
    expect(await acceptFingerprintMatch(protocolSpy(true).protocol, '900', 'x')).toBe(true)
    expect(await acceptFingerprintMatch(protocolSpy(false).protocol, '900', 'x')).toBe(false)
  })
})

describe('formatFingerprint', () => {
  it('groups sixteen bare digits into the canonical form', () => {
    expect(formatFingerprint('1234567890123456')).toBe('1234-5678-9012-3456')
  })

  it('leaves an already-grouped code unchanged', () => {
    expect(formatFingerprint('1234-5678-9012-3456')).toBe('1234-5678-9012-3456')
  })

  it('normalises arbitrary separators and surrounding whitespace', () => {
    expect(formatFingerprint('  1234 5678 9012 3456 ')).toBe('1234-5678-9012-3456')
  })

  it('passes anything that is not sixteen digits through trimmed', () => {
    // A wrong-length code is simply a wrong code — it must reach the protocol
    // and be reported as a mismatch, not be reshaped into something plausible.
    expect(formatFingerprint('  12345 ')).toBe('12345')
  })
})

describe('mirrored payload shape (spec risk R1)', () => {
  it('keeps the mirrored secret identical to what recovery produces', () => {
    // The real assertion is the type of `REPLICA_PAYLOAD_MIRRORS_RECOVERY`,
    // which only inhabits `true` when `ReplicaSecretReceived['secret']` and
    // `SecretRecovered['secret']` are exactly the same type. If a WASM rebuild
    // ever diverges them, its declared type becomes `false` and `typecheck`
    // fails at the declaration. This asserts the value so the guard is also
    // reachable from the suite rather than being dead-looking code.
    expect(REPLICA_PAYLOAD_MIRRORS_RECOVERY).toBe(true)
  })
})

describe('mergeReplicaSync', () => {
  const at = (version: number, syncedAt: number): ReplicaSyncRecord => ({ version, syncedAt })

  it('records the first ack for a channel', () => {
    expect(mergeReplicaSync(undefined, at(3, 1_000))).toEqual(at(3, 1_000))
  })

  it('advances to a newer version', () => {
    expect(mergeReplicaSync(at(3, 1_000), at(4, 2_000))).toEqual(at(4, 2_000))
  })

  it('ignores a redelivered ack for an older version', () => {
    // At-least-once mailbox delivery can replay an old ack after a newer one.
    // An implementation that just takes the incoming record walks the version
    // backwards and shows a current destination as stale — it passes both
    // cases above and fails only here.
    expect(mergeReplicaSync(at(4, 2_000), at(3, 9_999))).toEqual(at(4, 2_000))
  })

  it('keeps the original timestamp when the current version is redelivered', () => {
    // The timestamp means "when the destination acknowledged", not "when we
    // last saw a copy of that acknowledgement".
    expect(mergeReplicaSync(at(4, 2_000), at(4, 9_999))).toEqual(at(4, 2_000))
  })
})

describe('mergeReplicaSecretReceipt', () => {
  function pending(version: number, overrides: Partial<PendingReplicaAdoption> = {}): PendingReplicaAdoption {
    return {
      channelId: '900',
      fromReplicaId: 'a1',
      secretId: '42',
      version,
      secret: { helpers: [], secrets: [] },
      shares: [],
      ...overrides,
    }
  }

  it('stages the first receipt for a destination with nothing pending', () => {
    expect(mergeReplicaSecretReceipt(null, pending(3))).toEqual(pending(3))
  })

  it('advances to a newer version', () => {
    expect(mergeReplicaSecretReceipt(pending(3), pending(4))).toEqual(pending(4))
  })

  it('ignores a redelivered receipt for an older version', () => {
    // Same at-least-once mailbox hazard as `mergeReplicaSync`: an
    // implementation that just takes the incoming payload would let a replayed
    // stale round clobber a fresher offer the user has not yet acted on. This
    // passes the two cases above and fails only here.
    const newer = pending(4, { fromReplicaId: 'newer' })
    const staleReplay = pending(3, { fromReplicaId: 'stale' })
    expect(mergeReplicaSecretReceipt(newer, staleReplay)).toEqual(newer)
  })

  it('keeps the staged payload when the current version is redelivered', () => {
    // A redelivery of the version already staged carries no new information —
    // keep what is already there rather than swapping in an identically
    // versioned but distinct object.
    const staged = pending(4, { fromReplicaId: 'first-seen' })
    const replay = pending(4, { fromReplicaId: 'redelivered' })
    expect(mergeReplicaSecretReceipt(staged, replay)).toEqual(staged)
  })
})

describe('adoptionSourceLabel', () => {
  const transport = { protocol: 'https' as const, uri: 'https://example.test/mailbox' }

  function adoption(secretId: string): PendingReplicaAdoption {
    return {
      channelId: '900',
      fromReplicaId: 'ff01',
      secretId,
      version: 1,
      secret: { helpers: [], secrets: [] },
      shares: [],
    }
  }

  it('names the owner whose secret the offer carries', () => {
    expect(
      adoptionSourceLabel(adoption('42'), [
        { id: 'owner-1', role: 'owner', name: 'Alice', transport, secret_id: '42' },
      ]),
    ).toBe('Alice')
  })

  it('does not name an owner that owns a different secret', () => {
    // An implementation that takes "the owner" passes the case above
    // and fails here — naming the wrong person on a destructive prompt.
    expect(
      adoptionSourceLabel(adoption('42'), [
        { id: 'owner-1', role: 'owner', name: 'Alice', transport, secret_id: '7' },
      ]),
    ).toBe('replica source ff01')
  })

  it('does not name a non-owner actor that shares the secret id', () => {
    // This device may act as helper for that owner, which puts a participant
    // row on the roster carrying the very same secret id.
    expect(
      adoptionSourceLabel(adoption('42'), [
        { id: 'participant-1', role: 'participant', name: 'Bob', transport, secret_id: '42' },
      ]),
    ).toBe('replica source ff01')
  })

  it('falls back when the roster has not loaded', () => {
    expect(adoptionSourceLabel(adoption('42'), null)).toBe('replica source ff01')
  })

  it('falls back rather than showing a blank name', () => {
    expect(
      adoptionSourceLabel(adoption('42'), [
        { id: 'owner-1', role: 'owner', name: '   ', transport, secret_id: '42' },
      ]),
    ).toBe('replica source ff01')
  })
})

describe('describeRestoreFailure', () => {
  it('keeps every colliding channel id a CONFLICT carries', () => {
    const failure = describeRestoreFailure({
      code: 'CONFLICT',
      message: 'channels occupy canonical ids',
      channel_ids: ['901', '902'],
    })

    expect(failure.code).toBe('CONFLICT')
    expect(failure.channelIds).toEqual(['901', '902'])
    // Verbatim: an implementation that renders only the code and message — the
    // obvious one — passes on `code` and `message` and fails here, dropping
    // exactly the detail needed to find the surviving channels.
    expect(failure.text).toContain('901')
    expect(failure.text).toContain('902')
    expect(failure.text).toContain('channels occupy canonical ids')
  })

  it('flags ALREADY_RESTORED as the wipe not having taken', () => {
    expect(describeRestoreFailure({ code: 'ALREADY_RESTORED' }).wipeDidNotTake).toBe(true)
  })

  it('flags CONFLICT as the wipe not having taken', () => {
    expect(describeRestoreFailure({ code: 'CONFLICT' }).wipeDidNotTake).toBe(true)
  })

  it('does not flag failures that are unrelated to the wipe', () => {
    // Only the two preconditions `restore` checks before touching a store mean
    // the namespace was not empty. An implementation that marks every failure
    // passes the two cases above and fails here.
    expect(describeRestoreFailure({ code: 'INVARIANT' }).wipeDidNotTake).toBe(false)
    expect(describeRestoreFailure({ code: 'STORAGE' }).wipeDidNotTake).toBe(false)
  })

  it('reads the message off a thrown Error carrying a code', () => {
    const err = Object.assign(new Error('store write failed'), { code: 'STORAGE' })
    const failure = describeRestoreFailure(err)

    expect(failure.code).toBe('STORAGE')
    expect(failure.message).toBe('store write failed')
    expect(failure.text).toBe('STORAGE: store write failed')
  })

  it('passes an unrecognised code through as UNKNOWN without losing the message', () => {
    const failure = describeRestoreFailure({ code: 'SOMETHING_NEW', message: 'brand new failure' })

    expect(failure.code).toBe('UNKNOWN')
    expect(failure.text).toContain('brand new failure')
  })

  it('serialises a structured rejection that carries no message at all', () => {
    // `String(obj)` gives "[object Object]", which loses the entire payload.
    const failure = describeRestoreFailure({ detail: 'store unavailable' })

    expect(failure.text).not.toContain('[object Object]')
    expect(failure.text).toContain('store unavailable')
  })

  it('takes a thrown string verbatim', () => {
    expect(describeRestoreFailure('restore blew up').text).toBe('restore blew up')
  })

  it('still says something when nothing was carried', () => {
    expect(describeRestoreFailure(undefined).text.length).toBeGreaterThan(0)
  })
})

describe('clearReplicaState', () => {
  it('drops this owner’s bookkeeping', () => {
    recordConfirmation('owner-a', 'replica-1', { local: true, peer: 'protocol-verified' })

    clearReplicaState('owner-a')

    expect(loadReplicaState('owner-a')).toEqual({
      replicas: {},
      pendingPairings: {},
      channels: {},
      syncs: {},
    })
  })

  it('leaves other owners alone', () => {
    recordConfirmation('owner-a', 'replica-1', { local: true })
    recordConfirmation('owner-b', 'replica-2', { local: true })

    clearReplicaState('owner-a')

    expect(loadReplicaState('owner-b').replicas['replica-2']).toEqual({
      local: true,
      peer: 'none',
    })
  })

  it('leaves this device’s replica identity intact — adoption must not rotate it', () => {
    recordConfirmation('owner-a', 'replica-1', { local: true })
    const before = getOrCreateReplicaId('owner-a')

    clearReplicaState('owner-a')

    expect(getOrCreateReplicaId('owner-a')).toBe(before)
  })
})

describe('adoptReplicaSecret', () => {
  const NAMESPACE = 'owner:this-device'
  const OWN_REPLICA_ID = 0x1234n

  const config: ReplicaAdoptionProtocolConfig = {
    ownTransportUri: 'https://example.test/mailbox',
    communicationInfo: { name: 'This device' },
    threshold: 2,
    keepVersionsCount: 3,
    timeoutSecs: 300,
    unpairAck: 'required',
  }

  const adoption: PendingReplicaAdoption = {
    channelId: '900',
    fromReplicaId: 'ff01',
    // The *source's* secret id — deliberately not this device's own.
    secretId: '42',
    version: 7,
    secret: { helpers: [], secrets: [] },
    shares: [],
  }

  interface Harness {
    deps: ReplicaAdoptionDeps
    calls: string[]
    /** Namespaces passed to `clearNamespace`, in order. */
    wiped: string[]
    buildParams: ReplicaAdoptionInstanceParams[]
    /** Whether the wipe had already happened when the instance was built. */
    wipedBeforeBuild: boolean
    /** Whether the wipe had already happened when `restore` ran. */
    wipedBeforeRestore: boolean
    restoreCalls: Array<{ secretId: string; version: number }>
    drained: DeRecEvent[]
  }

  function harness(
    restoreOutcome: () => Promise<DeRecEvent[]>,
    onEventImpl?: (event: DeRecEvent) => void,
  ): Harness {
    const state: Harness = {
      deps: {
        clearNamespace: () => {},
        clearReplicaBookkeeping: () => {},
        getReplicaId: () => OWN_REPLICA_ID,
        buildInstance: () => ({ protocol: { restore: async () => [] } }),
        onEvent: () => {},
      },
      calls: [],
      wiped: [],
      buildParams: [],
      wipedBeforeBuild: false,
      wipedBeforeRestore: false,
      restoreCalls: [],
      drained: [],
    }

    const instance: AdoptableInstance = {
      protocol: {
        restore: (_secret, version) => {
          state.calls.push('restore')
          state.wipedBeforeRestore = state.wiped.length > 0
          state.restoreCalls.push({ secretId: state.buildParams.at(-1)?.secretId ?? '', version })
          return restoreOutcome()
        },
      },
    }

    state.deps = {
      clearNamespace: ns => {
        state.calls.push('clearNamespace')
        state.wiped.push(ns)
      },
      clearReplicaBookkeeping: () => {
        state.calls.push('clearReplicaBookkeeping')
      },
      getReplicaId: () => {
        state.calls.push('getReplicaId')
        return OWN_REPLICA_ID
      },
      buildInstance: params => {
        state.calls.push('buildInstance')
        state.wipedBeforeBuild = state.wiped.length > 0
        state.buildParams.push(params)
        return instance
      },
      onEvent: event => {
        state.calls.push(`onEvent:${event.type}`)
        state.drained.push(event)
        onEventImpl?.(event)
      },
    }

    return state
  }

  const unpaired = (channelId: string): DeRecEvent => ({ type: 'Unpaired', channel_id: channelId })

  it('clears the FE replica bookkeeping as part of the wipe, before the instance exists', async () => {
    const h = harness(async () => [])
    await adoptReplicaSecret({ adoption, namespace: NAMESPACE, config, deps: h.deps })

    // `derec:replica-state:<ownerId>` sits outside every `derec:<ns>:`
    // partition, so a wipe that only calls `clearNamespace` leaves
    // confirmations and syncs keyed by channels `restore` has just dropped.
    const bookkeeping = h.calls.indexOf('clearReplicaBookkeeping')
    expect(bookkeeping).toBeGreaterThanOrEqual(0)
    expect(bookkeeping).toBeLessThan(h.calls.indexOf('buildInstance'))
    expect(bookkeeping).toBeLessThan(h.calls.indexOf('restore'))
  })

  it('wipes the namespace before anything else touches it', async () => {
    const h = harness(async () => [])
    await adoptReplicaSecret({ adoption, namespace: NAMESPACE, config, deps: h.deps })

    // An implementation that builds the instance first — the natural way to
    // write this, and the one `restore`'s preconditions punish — fails here.
    expect(h.calls[0]).toBe('clearNamespace')
    expect(h.wiped).toEqual([NAMESPACE])
    expect(h.wipedBeforeBuild).toBe(true)
    expect(h.wipedBeforeRestore).toBe(true)
  })

  it('runs wipe, build and restore in that order, then drains', async () => {
    const h = harness(async () => [unpaired('901'), unpaired('902')])
    await adoptReplicaSecret({ adoption, namespace: NAMESPACE, config, deps: h.deps })

    expect(h.calls).toEqual([
      'clearNamespace',
      'clearReplicaBookkeeping',
      'getReplicaId',
      'buildInstance',
      'restore',
      'onEvent:Unpaired',
      'onEvent:Unpaired',
    ])
    expect(h.drained.map(e => (e.type === 'Unpaired' ? e.channel_id : null))).toEqual(['901', '902'])
  })

  it('binds the new instance to the source’s secret id, not this device’s', async () => {
    const h = harness(async () => [])
    await adoptReplicaSecret({ adoption, namespace: NAMESPACE, config, deps: h.deps })

    expect(h.buildParams).toHaveLength(1)
    expect(h.buildParams[0].secretId).toBe('42')
    expect(h.buildParams[0].namespace).toBe(NAMESPACE)
    expect(h.buildParams[0]).toMatchObject(config)
  })

  it('carries this device’s own replica id across the wipe', async () => {
    const h = harness(async () => [])
    const outcome = await adoptReplicaSecret({
      adoption,
      namespace: NAMESPACE,
      config,
      deps: h.deps,
    })

    // Read *after* the wipe, and unchanged by it: the identity key lives
    // outside every `derec:<ns>:` partition, so the device stays the same peer.
    expect(h.calls.indexOf('getReplicaId')).toBeGreaterThan(h.calls.indexOf('clearNamespace'))
    expect(h.buildParams[0].replicaId).toBe(OWN_REPLICA_ID)
    expect(outcome.replicaId).toBe(OWN_REPLICA_ID)
  })

  it('builds the adopted instance with auto reply-to enabled, so helper responses route to this device rather than the source', async () => {
    const h = harness(async () => [])
    await adoptReplicaSecret({ adoption, namespace: NAMESPACE, config, deps: h.deps })

    expect(h.buildParams).toHaveLength(1)
    expect(h.buildParams[0].autoReplyTo).toBe(true)
  })

  it('reports the adopted secret and version back to the caller', async () => {
    const h = harness(async () => [unpaired('901')])
    const outcome = await adoptReplicaSecret({
      adoption,
      namespace: NAMESPACE,
      config,
      deps: h.deps,
    })

    expect(outcome.secretId).toBe('42')
    expect(outcome.version).toBe(7)
    expect(outcome.events).toEqual([unpaired('901')])
  })

  it('surfaces a CONFLICT verbatim and never retries it', async () => {
    const h = harness(async () => {
      throw { code: 'CONFLICT', message: 'canonical ids occupied', channel_ids: ['901'] }
    })

    await expect(
      adoptReplicaSecret({ adoption, namespace: NAMESPACE, config, deps: h.deps }),
    ).rejects.toBeInstanceOf(ReplicaAdoptionError)

    // A retry loop — the reflex for a transient-looking failure — would restore
    // over partially adopted state. Exactly one attempt, and exactly one wipe.
    expect(h.restoreCalls).toHaveLength(1)
    expect(h.wiped).toHaveLength(1)
  })

  it('attaches the parsed failure to the thrown error', async () => {
    const h = harness(async () => {
      throw { code: 'ALREADY_RESTORED', message: 'snapshot exists' }
    })

    const err = await adoptReplicaSecret({
      adoption,
      namespace: NAMESPACE,
      config,
      deps: h.deps,
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ReplicaAdoptionError)
    const failure = (err as ReplicaAdoptionError).failure
    expect(failure.code).toBe('ALREADY_RESTORED')
    expect(failure.wipeDidNotTake).toBe(true)
    expect((err as ReplicaAdoptionError).message).toContain('snapshot exists')
  })

  it('drains nothing when restore refused', async () => {
    const h = harness(async () => {
      throw { code: 'CONFLICT' }
    })

    await expect(
      adoptReplicaSecret({ adoption, namespace: NAMESPACE, config, deps: h.deps }),
    ).rejects.toBeInstanceOf(ReplicaAdoptionError)

    expect(h.drained).toEqual([])
  })
})

describe('adoptedVaultState', () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
  const helperUri = 'https://example.test/helper-1'

  const adoption: PendingReplicaAdoption = {
    channelId: '900',
    fromReplicaId: 'ff01',
    secretId: '42',
    version: 7,
    secret: {
      helpers: [
        {
          channel_id: '901',
          transport_uri: helperUri,
          shared_key: bytes('key'),
          communication_info: { name: 'Snapshot name' },
        },
      ],
      secrets: [{ id: bytes('id-1'), name: 'Passphrase', data: bytes('hunter2') }],
    },
    shares: [],
  }

  const actors: BEActorWithStatus[] = [
    {
      id: 'helper-actor-1',
      role: 'participant',
      name: 'Richard',
      transport: { protocol: 'https', uri: helperUri },
      secret_id: '42',
    },
  ]

  it('re-identifies an adopted helper against the roster by transport uri', () => {
    const { participants } = adoptedVaultState(adoption, actors, 2)

    // Snapshot records carry only what travelled on the wire; without this the
    // row would be an anonymous placeholder backend polling can never match.
    expect(participants).toHaveLength(1)
    expect(participants[0].id).toBe('helper-actor-1')
    expect(participants[0].name).toBe('Richard')
    expect(participants[0].channelId).toBe('901')
    expect(participants[0].connectionStatus).toBe('paired')
    expect(participants[0].peerRole).toBe('helper')
  })

  it('falls back to the snapshot identity for a helper the roster does not know', () => {
    const { participants } = adoptedVaultState(adoption, [], 2)

    expect(participants[0].id).toBe('peer-901')
    expect(participants[0].name).toBe('Snapshot name')
  })

  it('does not match a roster actor on a different endpoint', () => {
    // An implementation that took "the only actor there is" passes the first
    // case and fails here, mis-attributing another peer's identity.
    const elsewhere: BEActorWithStatus[] = [
      { ...actors[0], transport: { protocol: 'https', uri: 'https://example.test/other' } },
    ]

    expect(adoptedVaultState(adoption, elsewhere, 2).participants[0].id).toBe('peer-901')
  })

  it('keys the adopted bag on the source’s secret id at the offered version', () => {
    const { secretBag } = adoptedVaultState(adoption, actors, 2)

    expect(secretBag.secretId).toBe('42')
    expect(secretBag.currentVersion.version).toBe(7)
    expect(secretBag.previousVersions).toEqual([])
    expect(secretBag.threshold).toBe(2)
  })

  it('decodes the adopted secrets to text', () => {
    const { secretBag } = adoptedVaultState(adoption, actors, 2)

    expect(secretBag.currentVersion.secrets).toEqual([
      { id: expect.any(String), name: 'Passphrase', data: 'hunter2' },
    ])
  })

  it('records each adopted helper as holding the adopted version', () => {
    const { participants, secretBag } = adoptedVaultState(adoption, actors, 2)

    expect(participants[0].secretShares).toEqual([
      { version: 7, status: 'confirmed', verified: false },
    ])
    expect(secretBag.currentVersion.participantIds).toEqual(['helper-actor-1'])
    expect(secretBag.currentVersion.helpers).toEqual([
      { id: 'helper-actor-1', name: 'Richard', channelId: '901' },
    ])
  })
})

/** A replica row as the panel would project it. Paired and eligible by default. */
function replicaView(overrides: Partial<ReplicaView> = {}): ReplicaView {
  return {
    id: 'replica-1',
    name: 'Laptop',
    channelId: '900',
    status: 'paired',
    offline: false,
    peerConfirmation: 'protocol-verified',
    lastSync: null,
    establishedAt: null,
    firstSyncStarted: false,
    provisioned: true,
    direction: 'replica_source',
    peerReplicaId: null,
    ...overrides,
  }
}

describe('replicaSyncTargets', () => {
  const view = replicaView

  it('targets a confirmed destination', () => {
    expect(replicaSyncTargets([view()])).toEqual([
      { replicaId: 'replica-1', name: 'Laptop', channelId: '900' },
    ])
  })

  it('never targets a destination that is only pending confirmation', () => {
    // The whole point of replica fingerprint confirmation: an unconfirmed
    // destination has a channel, so anything gating on `channelId` alone would
    // wrongly include it here.
    expect(replicaSyncTargets([view({ status: 'pending' })])).toEqual([])
  })

  it('never targets an unpaired destination', () => {
    expect(replicaSyncTargets([view({ status: 'unpaired', channelId: null })])).toEqual([])
  })

  it('does not target a destination whose status is paired but has no channel', () => {
    // Defensive: without a channel there is nothing to key an ack against, so
    // such a row must not be reported as a target even if a status bug lets it
    // reach `paired`.
    expect(replicaSyncTargets([view({ channelId: null })])).toEqual([])
  })

  it('still targets a confirmed destination that is offline', () => {
    // `offline` is a backend liveness flag on the actor, not a channel state:
    // the library dispatches to the channel regardless, so filtering it out
    // here would under-report what the round actually reaches.
    expect(replicaSyncTargets([view({ offline: true })])).toHaveLength(1)
  })

  it('never targets a confirmed row on which this device is the destination', () => {
    // The mirror is unidirectional. On a `replica_destination` row the peer is
    // the source — the library's `peer_role` is `ReplicaSource`, which
    // `ProtectSecret` does not select — so a round dispatched from here would
    // push *this* device's vault at a peer that never asked for it, moments
    // before adoption erases the vault it just re-split.
    expect(replicaSyncTargets([view({ direction: 'replica_destination' })])).toEqual([])
  })

  it('keeps only the confirmed destinations out of a mixed roster', () => {
    const targets = replicaSyncTargets([
      view({ id: 'a', channelId: '1' }),
      view({ id: 'b', channelId: '2', status: 'pending' }),
      view({ id: 'c', channelId: '3' }),
      view({ id: 'd', channelId: null, status: 'unpaired' }),
      view({ id: 'e', channelId: '5', direction: 'replica_destination' }),
    ])

    expect(targets.map(t => t.replicaId)).toEqual(['a', 'c'])
  })
})

describe('replicaViews', () => {
  const emptyState: ReplicaState = {
    replicas: {},
    pendingPairings: {},
    channels: {},
    syncs: {},
  }

  const transport = { protocol: 'https' as const, uri: 'https://example.test/mailbox' }

  function replicaActor(
    overrides: Partial<BEActorWithStatus> = {},
  ): BEActorWithStatus {
    return {
      id: 'replica-1',
      role: 'replica',
      name: 'Laptop',
      transport,
      secret_id: '42',
      ...overrides,
    }
  }

  it('ignores every actor that is not a replica', () => {
    const views = replicaViews(
      ([
        { id: 'owner-1', role: 'owner', name: 'Alice', transport, secret_id: '42' },
        { id: 'participant-1', role: 'participant', name: 'Bob', transport, secret_id: '7' },
      ]),
      emptyState,
    )

    expect(views).toEqual([])
  })

  it('reports a replica with no channel as unpaired', () => {
    const [view] = replicaViews(([replicaActor()]), emptyState)

    expect(view.status).toBe('unpaired')
    expect(view.channelId).toBeNull()
    expect(view.peerConfirmation).toBe('none')
  })

  it('reports a paired-but-unconfirmed replica as pending', () => {
    const [view] = replicaViews(([replicaActor({ channel_id: '900' })]), emptyState)

    expect(view.status).toBe('pending')
    expect(view.channelId).toBe('900')
  })

  it('falls back to the locally recorded channel id when the backend has none', () => {
    // This device's own `PairingCompleted` fires before the backend's own
    // protocol instance for the replica has necessarily caught up.
    const [view] = replicaViews(([replicaActor()]), {
      replicas: { 'replica-1': { local: false, peer: 'none', channelId: '901' } },
      pendingPairings: {},
      channels: {},
      syncs: {},
    })

    expect(view.channelId).toBe('901')
    expect(view.status).toBe('pending')
  })

  it('is paired once this device has verified, whatever the peer has done', () => {
    // The library promoted this channel on the local `verifyFingerprint` alone
    // — `handlers/sharing.rs` filters the fan-out on exactly that status — so a
    // row still reading `pending` here would be stricter than the protocol it
    // reports on, and would strand the sync trigger.
    const [view] = replicaViews(([replicaActor({ channel_id: '900' })]), {
      replicas: { 'replica-1': { local: true, peer: 'none' } },
      pendingPairings: {},
      channels: {},
      syncs: {},
    })

    expect(view.status).toBe('paired')
    // Reported, but not as a gate: it says whether a copy sent now would land.
    expect(view.peerConfirmation).toBe('none')
  })

  it('stays pending when the peer confirmed but this device has not', () => {
    // The complement, and the one that must not regress: the peer's verify
    // promotes the peer's channel record, never this device's. Treating it as
    // promotion here would make a channel a share target without anyone on this
    // device ever comparing a code.
    const [view] = replicaViews(
      ([replicaActor({ channel_id: '900', replica_confirmed: true })]),
      {
        replicas: { 'replica-1': { local: false, peer: 'none' } },
        pendingPairings: {},
        channels: {},
        syncs: {},
      },
    )

    expect(view.status).toBe('pending')
    expect(replicaSyncTargets([view])).toEqual([])
    expect(view.peerConfirmation).toBe('protocol-verified')
  })

  it('lets the backend confirmation outrank stale local peer bookkeeping', () => {
    const [view] = replicaViews(
      ([replicaActor({ channel_id: '900', replica_confirmed: true })]),
      {
        replicas: { 'replica-1': { local: true, peer: 'none' } },
        pendingPairings: {},
        channels: {},
        syncs: {},
      },
    )

    expect(view.status).toBe('paired')
    expect(view.peerConfirmation).toBe('protocol-verified')
  })

  it('projects the sync recorded against the replica’s channel', () => {
    const [view] = replicaViews(([replicaActor({ channel_id: '900', replica_confirmed: true })]), {
      replicas: { 'replica-1': { local: true, peer: 'protocol-verified' } },
      pendingPairings: {},
      channels: {},
      syncs: { '900': { version: 5, syncedAt: 1_700_000_000_000 } },
    })

    expect(view.lastSync).toEqual({ version: 5, syncedAt: 1_700_000_000_000 })
  })

  it('carries the recorded establishment stamp onto a provisioned row', () => {
    // Without this the row has no deadline to count down, and a pending channel
    // expires with no warning at all.
    const [view] = replicaViews(([replicaActor({ channel_id: '900' })]), {
      replicas: {},
      pendingPairings: {},
      channels: {
        '900': { channelId: '900', role: 'replica_source', establishedAt: 1_700_000 },
      },
      syncs: {},
    })

    expect(view.establishedAt).toBe(1_700_000)
    expect(replicaChannelExpiry(view, 300, 1_700_000 + 299_000)).toMatchObject({
      state: 'expiring-soon',
      remainingSecs: 1,
    })
  })

  it('reports no stamp when the channel record carries none', () => {
    // The control: a row with no stamp must report `null`, not a fabricated
    // "now", or every unstamped channel would show a full fresh countdown.
    const [view] = replicaViews(([replicaActor({ channel_id: '900' })]), {
      replicas: {},
      pendingPairings: {},
      channels: { '900': { channelId: '900', role: 'replica_source' } },
      syncs: {},
    })

    expect(view.establishedAt).toBeNull()
    expect(replicaChannelExpiry(view, 300, Date.now())).toBeNull()
  })

  it('does not attribute another channel’s sync to this replica', () => {
    // Syncs are keyed by channel; an implementation that took "the only sync
    // there is" would pass the case above and fail here.
    const [view] = replicaViews(([replicaActor({ channel_id: '900' })]), {
      replicas: {},
      pendingPairings: {},
      channels: {},
      syncs: { '901': { version: 5, syncedAt: 1_700_000_000_000 } },
    })

    expect(view.lastSync).toBeNull()
  })

  it('reports no sync for a replica that has no channel yet', () => {
    const [view] = replicaViews(([replicaActor()]), emptyState)

    expect(view.lastSync).toBeNull()
  })

  it('surfaces a disabled replica as offline', () => {
    const [view] = replicaViews(
      ([replicaActor({ channel_id: '900', disabled: true })]),
      emptyState,
    )

    expect(view.offline).toBe(true)
  })

  // ── Browser replicas ───────────────────────────────────────────────────────
  //
  // A browser replica registers as an ordinary *owner* actor, so the
  // roster says nothing about it. Its row can only come from the channel record
  // written when the replica pairing completed.

  /** A roster of only ordinary owner actors — no replica actor at all. */
  const browserRoster: BEActorWithStatus[] = [
    { id: 'owner-1', role: 'owner', name: 'Alice', transport, secret_id: '42' },
    { id: 'owner-2', role: 'owner', name: 'Bob', transport, secret_id: '7' },
  ]

  function withChannels(
    channels: ReplicaState['channels'],
    rest: Partial<ReplicaState> = {},
  ): ReplicaState {
    return { ...emptyState, ...rest, channels }
  }

  it('emits a row for a browser-initiated replica channel with no replica actor', () => {
    // The Task 15 defect: rows came only from `role === 'replica'`, so this
    // pairing produced nothing and the fingerprint dialog was unreachable.
    const views = replicaViews(
      browserRoster,
      withChannels({
        '900': { channelId: '900', role: 'replica_source', peerName: 'Bob’s laptop' },
      }),
    )

    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({
      id: replicaChannelRowId('900'),
      name: 'Bob’s laptop',
      channelId: '900',
      status: 'pending',
      provisioned: false,
      direction: 'replica_source',
    })
  })

  it('carries the establishment stamp onto a browser row', () => {
    // The row a browser replica is *only* visible on, so it is also the only
    // place its deadline can be shown.
    const views = replicaViews(
      browserRoster,
      withChannels({
        '900': { channelId: '900', role: 'replica_source', establishedAt: 1_700_000 },
      }),
    )

    expect(views[0].establishedAt).toBe(1_700_000)
    expect(replicaChannelExpiry(views[0], 300, 1_700_000 + 300_000)).toMatchObject({
      state: 'expired',
      remainingSecs: 0,
    })
  })

  it('emits a row for the destination direction too', () => {
    // A destination with no row could never confirm its fingerprint, so the
    // source's channel would never be answered and adoption would never be
    // offered — the direction that matters most is the one that erases.
    const views = replicaViews(
      browserRoster,
      withChannels({
        '901': { channelId: '901', role: 'replica_destination', peerName: 'Alice’s phone' },
      }),
    )

    expect(views).toHaveLength(1)
    expect(views[0].direction).toBe('replica_destination')
    expect(views[0].channelId).toBe('901')
  })

  it('emits a row per direction when this device is on both sides of two channels', () => {
    const views = replicaViews(
      browserRoster,
      withChannels({
        '900': { channelId: '900', role: 'replica_source' },
        '901': { channelId: '901', role: 'replica_destination' },
      }),
    )

    expect(views.map(v => v.direction).sort()).toEqual(['replica_destination', 'replica_source'])
  })

  it('names an unnamed peer by the side it is on, not by ours', () => {
    const [asSource] = replicaViews(
      browserRoster,
      withChannels({ '900': { channelId: '900', role: 'replica_source' } }),
    )
    const [asDestination] = replicaViews(
      browserRoster,
      withChannels({ '901': { channelId: '901', role: 'replica_destination' } }),
    )

    expect(asSource.name).toBe('Replica destination')
    expect(asDestination.name).toBe('Replica source')
  })

  it('produces no row for a channel that is not a replica channel', () => {
    // Only replica pairings are recorded — an owner/helper pairing leaves
    // `channels` empty, and the roster has no replica actor either. The control
    // for every case above: an implementation that emitted a row per *known
    // channel* rather than per replica channel would pass those and fail here.
    expect(replicaViews(browserRoster, emptyState)).toEqual([])
  })

  it('carries a browser row through the confirmation machine', () => {
    const rowId = replicaChannelRowId('900')
    const channels: ReplicaState['channels'] = {
      '900': { channelId: '900', role: 'replica_source' },
    }

    const unconfirmed = replicaViews(browserRoster, withChannels(channels))
    const confirmed = replicaViews(
      browserRoster,
      withChannels(channels, { replicas: { [rowId]: { local: true, peer: 'none' } } }),
    )

    expect(unconfirmed[0].status).toBe('pending')
    // The Task 18 defect: nothing on this device can ever observe the other
    // browser's verify, so `peer` stays `'none'` forever. A row that required it
    // would be stuck `pending` for the whole life of the channel — never a sync
    // target, and never a trigger for the automatic first sync — even though the
    // library has this channel `Paired` and would mirror to it.
    expect(confirmed[0].status).toBe('paired')
    expect(confirmed[0].peerConfirmation).toBe('none')
    expect(replicaSyncTargets(confirmed)).toEqual([
      { replicaId: rowId, name: 'Replica destination', channelId: '900' },
    ])
  })

  it('keeps an unconfirmed browser channel out of the sync targets', () => {
    const views = replicaViews(
      browserRoster,
      withChannels({ '900': { channelId: '900', role: 'replica_source' } }),
    )

    expect(replicaSyncTargets(views)).toEqual([])
  })

  it('projects the sync recorded against a browser channel', () => {
    const rowId = replicaChannelRowId('900')
    const [view] = replicaViews(
      browserRoster,
      withChannels(
        { '900': { channelId: '900', role: 'replica_source' } },
        {
          replicas: { [rowId]: { local: true, peer: 'protocol-verified' } },
          syncs: { '900': { version: 5, syncedAt: 1_700_000_000_000 } },
        },
      ),
    )

    expect(view.lastSync).toEqual({ version: 5, syncedAt: 1_700_000_000_000 })
  })

  it('shows a provisioned replica exactly once when its channel is also recorded locally', () => {
    // Both sources describe the same channel: the roster knows the actor, and
    // the `PairingCompleted` fold recorded the channel without knowing what kind
    // of peer it had paired with. Merging on anything but the channel id would
    // show this replica twice.
    const views = replicaViews(
      ([replicaActor({ channel_id: '900' })]),
      withChannels({ '900': { channelId: '900', role: 'replica_source' } }),
    )

    expect(views).toHaveLength(1)
    expect(views[0].id).toBe('replica-1')
    expect(views[0].provisioned).toBe(true)
  })

  it('de-duplicates against a channel the backend has not caught up to yet', () => {
    // The backend learns `channel_id` only once its own instance for the replica
    // observes the completion. Until then the provisioned row's channel comes
    // from local bookkeeping — and must still suppress the channel-sourced row.
    const views = replicaViews(
      ([replicaActor()]),
      withChannels(
        { '900': { channelId: '900', role: 'replica_source' } },
        { replicas: { 'replica-1': { local: false, peer: 'none', channelId: '900' } } },
      ),
    )

    expect(views).toHaveLength(1)
    expect(views[0].id).toBe('replica-1')
  })

  it('still shows a browser channel alongside an unrelated provisioned replica', () => {
    // The dedupe must be per channel, not "any provisioned row suppresses every
    // local one".
    const views = replicaViews(
      ([replicaActor({ channel_id: '900' })]),
      withChannels({ '901': { channelId: '901', role: 'replica_destination' } }),
    )

    expect(views.map(v => v.id)).toEqual(['replica-1', replicaChannelRowId('901')])
  })
})

describe('recordReplicaChannel', () => {
  it('persists the channel, the direction and the peer’s name', () => {
    recordReplicaChannel('chan-a', {
      channelId: '900',
      role: 'replica_destination',
      peerName: 'Alice’s phone',
    })

    expect(loadReplicaState('chan-a').channels).toEqual({
      '900': { channelId: '900', role: 'replica_destination', peerName: 'Alice’s phone' },
    })
  })

  it('keeps the recorded name when a redelivered completion carries none', () => {
    // The mailbox delivers at least once. A repeat that omits
    // `communication_info` must not blank a name already on file.
    recordReplicaChannel('chan-b', { channelId: '900', role: 'replica_source', peerName: 'Bob' })
    recordReplicaChannel('chan-b', { channelId: '900', role: 'replica_source' })

    expect(loadReplicaState('chan-b').channels['900']?.peerName).toBe('Bob')
  })

  it('stamps when the channel was established, so a deadline can be derived from it', () => {
    // The library's `created_at` is not exposed to the frontend, so this stamp
    // is the only thing an expiry warning can be built on.
    recordReplicaChannel('chan-stamp', {
      channelId: '900',
      role: 'replica_source',
      establishedAt: 1_700_000,
    })

    expect(loadReplicaState('chan-stamp').channels['900']?.establishedAt).toBe(1_700_000)
  })

  it('keeps the first stamp when a redelivered completion arrives later', () => {
    // The expiry clock runs from the channel's creation and the mailbox delivers
    // at least once. Letting a redelivery refresh the stamp would extend a
    // countdown the library is not extending, promising time the channel does
    // not have.
    recordReplicaChannel('chan-restamp', {
      channelId: '900',
      role: 'replica_source',
      establishedAt: 1_000,
    })
    recordReplicaChannel('chan-restamp', {
      channelId: '900',
      role: 'replica_source',
      establishedAt: 999_000,
    })

    expect(loadReplicaState('chan-restamp').channels['900']?.establishedAt).toBe(1_000)
  })

  it('keeps channels of different owners apart', () => {
    recordReplicaChannel('chan-c', { channelId: '900', role: 'replica_source' })
    recordReplicaChannel('chan-d', { channelId: '901', role: 'replica_destination' })

    expect(Object.keys(loadReplicaState('chan-c').channels)).toEqual(['900'])
    expect(Object.keys(loadReplicaState('chan-d').channels)).toEqual(['901'])
  })

  it('is dropped by the adoption wipe, like the rest of the bookkeeping', () => {
    // Adoption replaces the vault and the library drops every channel with it;
    // a surviving record would keep rendering a row for a channel that is gone.
    recordReplicaChannel('chan-e', { channelId: '900', role: 'replica_destination' })

    clearReplicaState('chan-e')

    expect(loadReplicaState('chan-e').channels).toEqual({})
  })
})

describe('markReplicaFirstSyncStarted', () => {
  it('marks a destination without disturbing its confirmation record', () => {
    recordConfirmation('sync-mark-a', 'replica-1', {
      local: true,
      peer: 'protocol-verified',
      channelId: '900',
    })

    markReplicaFirstSyncStarted('sync-mark-a', ['replica-1'])

    expect(loadReplicaState('sync-mark-a').replicas['replica-1']).toEqual({
      local: true,
      peer: 'protocol-verified',
      channelId: '900',
      firstSyncStarted: true,
    })
  })

  it('marks every destination a single round covers, and leaves the rest alone', () => {
    recordConfirmation('sync-mark-b', 'replica-1', { local: true })
    recordConfirmation('sync-mark-b', 'replica-2', { local: true })
    recordConfirmation('sync-mark-b', 'replica-3', { local: true })

    markReplicaFirstSyncStarted('sync-mark-b', ['replica-1', 'replica-3'])

    const { replicas } = loadReplicaState('sync-mark-b')
    expect(replicas['replica-1']?.firstSyncStarted).toBe(true)
    expect(replicas['replica-2']?.firstSyncStarted).toBeUndefined()
    expect(replicas['replica-3']?.firstSyncStarted).toBe(true)
  })

  it('survives a reload — the marker is read back from storage, not memory', () => {
    markReplicaFirstSyncStarted('sync-mark-c', ['replica-1'])

    // `loadReplicaState` is the only path a fresh page load has.
    expect(loadReplicaState('sync-mark-c').replicas['replica-1']?.firstSyncStarted).toBe(true)
  })

  it('is dropped by the adoption wipe, like the rest of the bookkeeping', () => {
    markReplicaFirstSyncStarted('sync-mark-d', ['replica-1'])

    clearReplicaState('sync-mark-d')

    expect(loadReplicaState('sync-mark-d').replicas['replica-1']).toBeUndefined()
  })

  it('is reflected in the projected row', () => {
    markReplicaFirstSyncStarted('sync-mark-e', ['replica-1'])

    const [view] = replicaViews(
      [
        {
          id: 'replica-1',
          role: 'replica',
          name: 'Laptop',
          transport: { protocol: 'https', uri: 'https://example.test/mailbox' },
          secret_id: '42',
          channel_id: '900',
          replica_confirmed: true,
        },
      ],
      loadReplicaState('sync-mark-e'),
    )

    expect(view.firstSyncStarted).toBe(true)
  })
})

describe('replicasAwaitingFirstSync', () => {
  // ── Only dispatch automatically to a peer known to be listening ────────────
  //
  // A destination whose channel is still `Pending` drops an incoming round in
  // silence, and the round it drops pins the owner's single in-flight-flow slot
  // until the protocol timeout — disabling the "Sync now" that is the documented
  // way to recover. Worse, it is redundant: the library already publishes the
  // mirror itself when `verify_fingerprint` moves the channel Pending→Paired.
  //
  // So the automatic round waits for positive evidence the peer will accept.
  // The manual one deliberately does not — see `canRequestReplicaSync`.

  it('does not auto-dispatch to a peer whose confirmation cannot be seen', () => {
    // A browser replica confirms on its own screen against its own instance.
    // This device has no way to observe it, so it must not assume.
    expect(
      replicasAwaitingFirstSync([
        replicaView({ provisioned: false, peerConfirmation: 'none' }),
      ]),
    ).toEqual([])
  })

  it('auto-dispatches once the peer is known to have confirmed', () => {
    expect(
      replicasAwaitingFirstSync([replicaView({ peerConfirmation: 'protocol-verified' })]),
    ).toHaveLength(1)
  })

  it('leaves the manual sync available on exactly the row it will not auto-send to', () => {
    // The recovery path has to stay open precisely where the automatic one
    // steps back, or a browser replica could never be mirrored at all.
    const view = replicaView({ provisioned: false, peerConfirmation: 'none' })

    expect(replicasAwaitingFirstSync([view])).toEqual([])
    expect(canRequestReplicaSync(view)).toBe(true)
  })


  it('lists a destination that has just become eligible', () => {
    expect(replicasAwaitingFirstSync([replicaView()])).toEqual([
      { replicaId: 'replica-1', name: 'Laptop', channelId: '900' },
    ])
  })

  it('drops a destination that has already had its round', () => {
    expect(replicasAwaitingFirstSync([replicaView({ firstSyncStarted: true })])).toEqual([])
  })

  it('never lists a destination that is only pending confirmation', () => {
    // The gate that matters: `ProtectSecret` selects `Paired` channels only, so
    // an implementation that fired on "has a channel" would ship the mirrored
    // vault at a device whose fingerprint nobody has checked.
    expect(replicasAwaitingFirstSync([replicaView({ status: 'pending' })])).toEqual([])
  })

  it('never lists an unpaired destination', () => {
    expect(
      replicasAwaitingFirstSync([replicaView({ status: 'unpaired', channelId: null })]),
    ).toEqual([])
  })

  it('never lists a paired destination with no channel', () => {
    expect(replicasAwaitingFirstSync([replicaView({ channelId: null })])).toEqual([])
  })

  it('never lists a confirmed row on which this device is the destination', () => {
    // The automatic path runs on *both* devices: the destination confirms the
    // fingerprint too, and its own row reaches `paired` the same way. Without
    // the direction gate that confirmation dispatches a `ProtectSecret` round
    // here — bumping this device's vault version and re-splitting its shares to
    // its own helpers seconds before adoption erases all of it.
    expect(
      replicasAwaitingFirstSync([replicaView({ direction: 'replica_destination' })]),
    ).toEqual([])
  })
})

describe('createReplicaFirstSyncTrigger', () => {
  interface Recorder {
    /** Rounds actually started. */
    starts: number
    /** Rounds that have run to completion. */
    finishes: number
    marked: string[][]
    errors: unknown[]
    /** Every automatic outcome reported, in order — what the panel would show. */
    outcomes: AutomaticReplicaSyncOutcome[]
    /** The reason each round was dispatched under, in order. */
    reasons: ReplicaSyncReason[]
  }

  interface Harness {
    trigger: ReplicaFirstSyncTrigger
    recorder: Recorder
    /** Release the in-flight round, when `defer` is set. */
    release: () => void
    setCanProtect: (value: boolean) => void
  }

  function harness(
    options: {
      defer?: boolean
      fail?: unknown
      canProtect?: boolean
      result?: ReplicaSyncRoundResult
    } = {},
  ): Harness {
    const recorder: Recorder = {
      starts: 0,
      finishes: 0,
      marked: [],
      errors: [],
      outcomes: [],
      reasons: [],
    }
    let canProtect = options.canProtect ?? true
    let release: () => void = () => {}
    const gate = options.defer
      ? new Promise<void>(resolve => {
          release = resolve
        })
      : Promise.resolve()

    const trigger = createReplicaFirstSyncTrigger({
      canProtect: () => canProtect,
      markStarted: replicaIds => {
        recorder.marked.push([...replicaIds])
      },
      runProtectRound: async reason => {
        recorder.starts += 1
        recorder.reasons.push(reason)
        await gate
        if ('fail' in options) throw options.fail
        recorder.finishes += 1
        return options.result ?? 'dispatched'
      },
      onOutcome: outcome => {
        recorder.outcomes.push(outcome)
        if (outcome.kind === 'failed') recorder.errors.push(outcome.error)
      },
    })

    return {
      trigger,
      recorder,
      release: () => release(),
      setCanProtect: value => {
        canProtect = value
      },
    }
  }

  it('starts exactly one round when a destination reaches paired', async () => {
    const { trigger, recorder } = harness()

    await trigger.observe([replicaView()])

    expect(recorder.starts).toBe(1)
    expect(recorder.finishes).toBe(1)
    expect(recorder.marked).toEqual([['replica-1']])
  })

  it('starts one round for several destinations confirmed together', async () => {
    // The library fans out from its own channel table, so one round covers
    // every eligible destination — firing per destination would mean a
    // redundant version bump for each.
    const { trigger, recorder } = harness()

    await trigger.observe([
      replicaView({ id: 'a', channelId: '1' }),
      replicaView({ id: 'b', channelId: '2' }),
    ])

    expect(recorder.starts).toBe(1)
    expect(recorder.marked).toEqual([['a', 'b']])
  })

  it('does not start a second round when the same confirmation is observed again', async () => {
    // The projection is unchanged between observations — the persisted marker
    // has not made it back into `views` yet — so only the trigger's own
    // bookkeeping stands between a redelivered confirmation and a second round.
    const { trigger, recorder } = harness()
    const views = [replicaView()]

    await trigger.observe(views)
    await trigger.observe(views)
    await trigger.observe(views)

    expect(recorder.starts).toBe(1)
  })

  it('does not start a second round while the first is still in flight', async () => {
    const { trigger, recorder, release } = harness({ defer: true })
    const views = [replicaView()]

    const first = trigger.observe(views)
    const second = trigger.observe(views)

    expect(recorder.starts).toBe(1)
    expect(recorder.finishes).toBe(0)

    release()
    await Promise.all([first, second])

    expect(recorder.starts).toBe(1)
    expect(recorder.finishes).toBe(1)
  })

  it('does not start an overlapping round when a destination is confirmed mid-round', async () => {
    // The case the per-destination bookkeeping alone does not cover: a second
    // destination becomes eligible while the first round is still going out.
    // Starting a round for it now would put two rounds in flight at once, each
    // staging its own pending bag.
    const { trigger, recorder, release } = harness({ defer: true })
    const alone = [replicaView({ id: 'a', channelId: '1' })]
    const both = [replicaView({ id: 'a', channelId: '1' }), replicaView({ id: 'b', channelId: '2' })]

    const first = trigger.observe(alone)
    const second = trigger.observe(both)

    expect(recorder.starts).toBe(1)
    // Left unmarked, so the deferral costs nothing: 'b' is still due.
    expect(recorder.marked).toEqual([['a']])

    release()
    await Promise.all([first, second])

    await trigger.observe(both)

    expect(recorder.starts).toBe(2)
    expect(recorder.marked).toEqual([['a'], ['b']])
  })

  it('does not re-arm on a destination whose marker came back persisted', async () => {
    // A fresh trigger (page reload, panel remount) has no memory of the round;
    // the persisted marker is what keeps it from firing another one.
    const { trigger, recorder } = harness()

    await trigger.observe([replicaView({ firstSyncStarted: true })])

    expect(recorder.starts).toBe(0)
    expect(recorder.marked).toEqual([])
  })

  it('starts nothing for a destination that is only pending confirmation', async () => {
    const { trigger, recorder } = harness()

    await trigger.observe([replicaView({ status: 'pending' })])

    expect(recorder.starts).toBe(0)
    expect(recorder.marked).toEqual([])
  })

  it('starts nothing for an unpaired destination', async () => {
    const { trigger, recorder } = harness()

    await trigger.observe([replicaView({ status: 'unpaired', channelId: null })])

    expect(recorder.starts).toBe(0)
  })

  it('starts nothing when there are no replicas at all', async () => {
    const { trigger, recorder } = harness()

    await trigger.observe([])

    expect(recorder.starts).toBe(0)
  })

  it('starts one round once a destination is promoted, and none before', async () => {
    const { trigger, recorder } = harness()

    await trigger.observe([replicaView({ status: 'pending' })])
    expect(recorder.starts).toBe(0)

    await trigger.observe([replicaView()])
    expect(recorder.starts).toBe(1)
  })

  it('defers while another flow is in flight, and marks nothing until it runs', async () => {
    const h = harness({ canProtect: false })

    await h.trigger.observe([replicaView()])

    expect(h.recorder.starts).toBe(0)
    // Marking here would strand the destination: it would never be dispatched
    // for, and the deferral is "not now", not "never".
    expect(h.recorder.marked).toEqual([])

    h.setCanProtect(true)
    await h.trigger.observe([replicaView()])

    expect(h.recorder.starts).toBe(1)
  })

  it('reports a failed round and does not retry it', async () => {
    const failure = new Error('protocol rejected the round')
    const { trigger, recorder } = harness({ fail: failure })
    const views = [replicaView()]

    await trigger.observe(views)
    await trigger.observe(views)

    expect(recorder.errors).toEqual([failure])
    expect(recorder.starts).toBe(1)
    // Marked before the round ran, which is what stops the failure looping.
    expect(recorder.marked).toEqual([['replica-1']])
  })

  it('still covers a destination confirmed after a failed round', async () => {
    const { trigger, recorder } = harness({ fail: new Error('nope') })

    await trigger.observe([replicaView({ id: 'a', channelId: '1' })])
    await trigger.observe([
      replicaView({ id: 'a', channelId: '1' }),
      replicaView({ id: 'b', channelId: '2' }),
    ])

    expect(recorder.starts).toBe(2)
    expect(recorder.marked).toEqual([['a'], ['b']])
  })

  // ── Telling the user what an unattended round did ──────────────────────────

  it('reports a rejected automatic round as an outcome that can be shown', async () => {
    // Before this, the only trace of a failed automatic round was a log line.
    const failure = new Error('protocol rejected the round')
    const { trigger, recorder } = harness({ fail: failure })

    await trigger.observe([replicaView()])

    expect(recorder.outcomes).toEqual([{ kind: 'failed', error: failure }])
    expect(automaticSyncNeedsAttention(recorder.outcomes[0])).toBe(true)
  })

  it('reports an automatic round that dispatched nothing', async () => {
    // Sending nothing is as invisible to the user as throwing, and leaves the
    // destination just as empty.
    const { trigger, recorder } = harness({ result: 'nothing-to-mirror' })

    await trigger.observe([replicaView()])

    expect(recorder.outcomes).toEqual([{ kind: 'nothing-to-mirror' }])
    expect(automaticSyncNeedsAttention(recorder.outcomes[0])).toBe(true)
  })

  it('reports a round that went out, which needs no notice', async () => {
    const { trigger, recorder } = harness()

    await trigger.observe([replicaView()])

    expect(recorder.outcomes).toEqual([{ kind: 'dispatched' }])
    expect(automaticSyncNeedsAttention(recorder.outcomes[0])).toBe(false)
  })

  it('leaves the manual action available, and working, after a failed automatic round', async () => {
    // The recovery the notice points at. `canRequestReplicaSync` asks only
    // whether the library would mirror to this row — which a failed round did
    // not change — and the shared in-flight guard releases once the automatic
    // round settles, so the user's own round really does dispatch.
    const failure = new Error('protocol rejected the round')
    const { trigger, recorder } = harness({ fail: failure })
    const view = replicaView()

    await trigger.observe([view])

    expect(recorder.outcomes).toEqual([{ kind: 'failed', error: failure }])
    // `firstSyncStarted` is what the marker writes back onto the row: the
    // automatic path is spent, and the button must survive that.
    expect(canRequestReplicaSync({ ...view, firstSyncStarted: true })).toBe(true)
    await expect(trigger.syncNow()).resolves.toEqual({ kind: 'failed', error: failure })
    expect(recorder.starts).toBe(2)
  })

  it('dispatches the automatic round under the first-sync reason', () => {
    // `reason` is log context only — it must never be mistaken for target
    // selection, and the two paths must remain distinguishable in the console.
    const { trigger, recorder } = harness()

    return trigger.observe([replicaView()]).then(() => {
      expect(recorder.reasons).toEqual(['first-sync'])
    })
  })

  // ── The user's explicit "Sync now" ─────────────────────────────────────────

  describe('syncNow', () => {
    it('dispatches a round and reports that it went out', async () => {
      const { trigger, recorder } = harness()

      await expect(trigger.syncNow()).resolves.toEqual({ kind: 'dispatched' })
      expect(recorder.starts).toBe(1)
      expect(recorder.reasons).toEqual(['manual'])
    })

    it('does not mark any destination as having had its first sync', async () => {
      // A manual round is not the automatic one: marking here would disarm the
      // trigger for a destination it was never dispatched for.
      const { trigger, recorder } = harness()

      await trigger.syncNow()

      expect(recorder.marked).toEqual([])
    })

    it('reports an empty vault rather than claiming a copy was sent', async () => {
      const { trigger } = harness({ result: 'nothing-to-mirror' })

      await expect(trigger.syncNow()).resolves.toEqual({ kind: 'nothing-to-mirror' })
    })

    it('returns a rejected round instead of throwing, so the caller can show it', async () => {
      const failure = new Error('protocol rejected the round')
      const { trigger, recorder } = harness({ fail: failure })

      await expect(trigger.syncNow()).resolves.toEqual({ kind: 'failed', error: failure })
      // Not routed to `onError`: the user is standing in front of this one and
      // the console is not where the answer belongs.
      expect(recorder.errors).toEqual([])
    })

    it('refuses to overlap an automatic round already in flight', async () => {
      const { trigger, recorder, release } = harness({ defer: true })

      const automatic = trigger.observe([replicaView()])
      expect(recorder.starts).toBe(1)

      // The click lands mid-round. A second round here would stage a second
      // pending bag on top of the first.
      await expect(trigger.syncNow()).resolves.toEqual({ kind: 'busy' })
      expect(recorder.starts).toBe(1)

      release()
      await automatic
      expect(recorder.finishes).toBe(1)
    })

    it('refuses to let an automatic round overlap a manual one in flight', async () => {
      // The other order, which a guard held only by the automatic path would
      // miss entirely.
      const { trigger, recorder, release } = harness({ defer: true })

      const manual = trigger.syncNow()
      expect(recorder.starts).toBe(1)

      await trigger.observe([replicaView()])
      expect(recorder.starts).toBe(1)
      expect(recorder.marked).toEqual([])

      release()
      await manual
      expect(recorder.finishes).toBe(1)
    })

    it('refuses to overlap another manual round', async () => {
      const { trigger, recorder, release } = harness({ defer: true })

      const first = trigger.syncNow()
      const second = trigger.syncNow()

      expect(recorder.starts).toBe(1)
      await expect(second).resolves.toEqual({ kind: 'busy' })

      release()
      await expect(first).resolves.toEqual({ kind: 'dispatched' })
    })

    it('reports busy rather than dispatching while another flow holds the protocol', async () => {
      const h = harness({ canProtect: false })

      await expect(h.trigger.syncNow()).resolves.toEqual({ kind: 'busy' })
      expect(h.recorder.starts).toBe(0)
    })

    it('runs again once the previous round has finished', async () => {
      // The guard is a gate, not a latch: a failed or completed round must leave
      // the action usable — which is the entire point of it being manual.
      const { trigger, recorder } = harness()

      await trigger.syncNow()
      await trigger.syncNow()

      expect(recorder.starts).toBe(2)
    })

    it('stays usable after a round that threw', async () => {
      const { trigger } = harness({ fail: new Error('nope') })

      await trigger.syncNow()

      await expect(trigger.syncNow()).resolves.toEqual({ kind: 'failed', error: expect.any(Error) })
    })
  })
})

describe('canRequestReplicaSync', () => {
  it('offers the action on a paired channel this device sources', () => {
    expect(canRequestReplicaSync(replicaView())).toBe(true)
  })

  it('does not offer it on a channel that is only pending confirmation', () => {
    // A round dispatched here would not reach this destination at all — the
    // library filters its fan-out on `Paired` — so the button would be a lie.
    expect(canRequestReplicaSync(replicaView({ status: 'pending' }))).toBe(false)
  })

  it('does not offer it on an unpaired row', () => {
    expect(canRequestReplicaSync(replicaView({ status: 'unpaired', channelId: null }))).toBe(false)
  })

  it('does not offer it on a destination row', () => {
    // The mirror runs the other way here. A round dispatched from a destination
    // row would push *this* device's vault at a peer that never asked for it.
    expect(canRequestReplicaSync(replicaView({ direction: 'replica_destination' }))).toBe(false)
  })

  it('does not offer it on a paired row with no channel', () => {
    expect(canRequestReplicaSync(replicaView({ channelId: null }))).toBe(false)
  })

  it('still offers it on an offline destination', () => {
    // `offline` is backend liveness, not channel state: the round still goes
    // out, and re-sending to a destination that was away is a reason to use the
    // action, not to hide it.
    expect(canRequestReplicaSync(replicaView({ offline: true }))).toBe(true)
  })

  it('offers it whether or not the peer has confirmed', () => {
    // The case the action exists for: this device confirmed first, the copy it
    // auto-published was dropped on the destination's still-pending channel,
    // and nothing retried. Hiding the action until `peerConfirmation` caught up
    // would withhold the recovery for a browser peer permanently, since that
    // signal never arrives.
    expect(canRequestReplicaSync(replicaView({ peerConfirmation: 'none' }))).toBe(true)
  })
})
