// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { FlowKind, type ContactMessage } from '@derec-alliance/web'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BEActorWithStatus } from '../api'
import {
  recordConfirmation,
  recordReplicaChannel,
  replicaChannelRowId,
  type RestoreFailure,
} from '../replicaFlows'
import { NodeUnreachableError } from '../derecApi'
import type { PairedParticipant } from '../types'
import { SecretRuntime } from './runtime'
import { deps, stubInstance, secret } from './testSecret'

describe('SecretRuntime.removeItem', () => {
  const items = [
    { id: 'aa', name: 'Seed', data: 'one two' },
    { id: 'bb', name: 'PIN', data: '1234' },
  ]
  const withBag = () =>
    secret({
      itemBag: {
        secretId: '42',
        threshold: 3,
        previousVersions: [],
        currentVersion: {
          version: 2,
          participantIds: [],
          verifiedParticipantIds: [],
          failedParticipantIds: [],
          items,
          rawBytes: '',
          helpers: [],
        },
      },
    })

  it('publishes the current version without that item and reports the new version', async () => {
    const r = new SecretRuntime(withBag(), deps())
    const protect = vi
      .spyOn(r, 'protect')
      .mockResolvedValue({ version: 3, participants: [], replicaTargets: [], threshold: 2 })

    await expect(r.removeItem('aa')).resolves.toEqual({ version: 3, recipientIds: [], threshold: 2 })
    expect(protect).toHaveBeenCalledWith([items[1]], { keep: null })
  })

  it('refuses an item that is not in the current version, publishing nothing', async () => {
    const r = new SecretRuntime(withBag(), deps())
    const protect = vi.spyOn(r, 'protect')

    await expect(r.removeItem('zz')).rejects.toThrow('no longer in the current version')
    expect(protect).not.toHaveBeenCalled()
  })

  it('reports no version when no round was dispatched', async () => {
    const r = new SecretRuntime(withBag(), deps())
    vi.spyOn(r, 'protect').mockResolvedValue(null)

    await expect(r.removeItem('bb')).resolves.toBeNull()
  })
})

describe('SecretRuntime', () => {
  it('reports the secret it was built for before it starts', () => {
    const r = new SecretRuntime(secret(), deps())

    expect(r.localSecretId).toBe('v1')
    expect(r.secretId).toBe('42')
    expect(r.state().status).toBe('idle')
    expect(r.instance()).toBeNull()
  })

  it('notifies subscribers when state changes and stops after unsubscribe', () => {
    const r = new SecretRuntime(secret(), deps())
    const seen: string[] = []
    const off = r.subscribe(s => seen.push(s.status))

    r.setBusy(true)
    const afterFirst = seen.length
    off()
    r.setBusy(false)

    expect(afterFirst).toBeGreaterThan(0)
    expect(seen.length).toBe(afterFirst)
  })

  it('serialises calls through the protocol lock', async () => {
    // WASM borrows &mut self for async calls; two overlapping calls on one
    // instance raise "recursive use of an object".
    const r = new SecretRuntime(secret(), deps())
    const order: string[] = []

    const first = r.withLock(async () => {
      order.push('first-in')
      await new Promise(resolve => setTimeout(resolve, 10))
      order.push('first-out')
    })
    const second = r.withLock(async () => {
      order.push('second-in')
    })

    await Promise.all([first, second])

    expect(order).toEqual(['first-in', 'first-out', 'second-in'])
  })

  it('releases the lock when the guarded call throws', async () => {
    const r = new SecretRuntime(secret(), deps())

    await expect(r.withLock(async () => { throw new Error('boom') })).rejects.toThrow('boom')

    // The control: a lock leaked on failure would hang this forever.
    await expect(r.withLock(async () => 'ok')).resolves.toBe('ok')
  })

  it('reports a failed start without throwing into the caller', async () => {
    // `buildProtocolInstance` throws on an unparseable secret id. A secret that
    // cannot start must be a listed secret with a retry, not an exception that
    // takes down every other runtime in the tab.
    const d = deps()
    const r = new SecretRuntime(secret({ secretId: 'not-a-u64' }), d)

    await r.start()

    expect(r.state().status).toBe('failed')
    expect(r.state().failure).toBeTruthy()
    expect(r.instance()).toBeNull()
    expect(d.notify.error).toHaveBeenCalled()
  })

  it('commits a new secret record to storage and subscribers together', () => {
    // Persisting without emitting would leave the view showing stale state;
    // emitting without persisting would lose it on reload.
    const d = deps()
    const r = new SecretRuntime(secret(), d)
    const seen: string[] = []
    r.subscribe(s => seen.push(s.secret.name))

    r.commit(secret({ name: 'Recovery Codes' }))

    expect(d.onSecretChange).toHaveBeenCalledTimes(1)
    expect(seen.at(-1)).toBe('Recovery Codes')
    expect(r.state().secret.name).toBe('Recovery Codes')
  })

  it('stamps its secret on every console entry it writes', () => {
    // Several secrets log into one console; without this the entries cannot be
    // told apart or filtered.
    const d = deps()
    const r = new SecretRuntime(secret({ id: 'v7' }), d)

    r.addPendingPairing(1n)
    r.raiseAttention({ kind: 'pairing', blocksDrain: true, payload: {} })
    r.applyEvent(r.state().secret, { type: 'NoOp' } as never)
    void r.syncReplicas('manual')

    expect(d.log).toHaveBeenCalled()
    for (const [entry] of (d.log as ReturnType<typeof vi.fn>).mock.calls) {
      expect(entry.localSecretId).toBe('v7')
    }
  })

  describe('draining the mailbox', () => {
    const failure: RestoreFailure = {
      code: 'CONFLICT',
      message: 'boom',
      channelIds: [],
      wipeDidNotTake: false,
      text: 'boom',
    }

    afterEach(() => localStorage.clear())

    function mailbox(...batches: number[][]) {
      const queue = batches.map(batch => batch.map(b => ({ bytes: new Uint8Array([b]) })))
      return { pollMailbox: async () => queue.shift() ?? [] }
    }

    it('feeds every polled message through the protocol in order', async () => {
      const seen: number[] = []
      const r = new SecretRuntime(secret(), deps({ io: mailbox([1, 2]) }))
      stubInstance(r, { process: async (b: Uint8Array) => { seen.push(b[0]); return [] } })

      await r.drainOnce()

      expect(seen).toEqual([1, 2])
    })

    it('does not poll at all while paused', async () => {
      // The backend mailbox is destructive: a poll drains it. Polling while
      // paused would take messages the runtime then has to hold, for nothing.
      let polls = 0
      const r = new SecretRuntime(secret(), deps({ io: { pollMailbox: async () => { polls++; return [] } } }))
      stubInstance(r, { process: async () => [] })

      r.pauseDrain('test')
      await r.drainOnce()
      expect(polls).toBe(0)

      r.resumeDrain('test')
      await r.drainOnce()
      expect(polls).toBe(1)
    })

    it('holds back what follows a confirmation, and replays it first once resolved', async () => {
      // Anything drained but not processed must be kept, or a secret waiting on
      // its owner silently loses protocol traffic.
      const seen: number[] = []
      const asking = secret({ configOverrides: { autoAcceptStoreShareRequests: false } })
      const r = new SecretRuntime(asking, deps({ io: mailbox([1, 2, 3], [4]) }))
      stubInstance(r, {
        process: async (b: Uint8Array) => {
          seen.push(b[0])
          return b[0] === 1
            ? [{ type: 'ActionRequired', action_kind: 'StoreShare', channel_id: '7', action: new Uint8Array([9]) }]
            : []
        },
      })

      await r.drainOnce()
      expect(seen).toEqual([1])
      expect(r.attention()[0].kind).toBe('store-share')

      r.resolveAttention(r.attention()[0].id)
      await r.drainOnce()
      expect(seen).toEqual([1, 2, 3, 4])
    })

    it('surfaces a poll failure without stopping the runtime', async () => {
      const d = deps({ io: { pollMailbox: async () => { throw new Error('offline') } } })
      const r = new SecretRuntime(secret(), d)
      stubInstance(r, { process: async () => [] })

      await r.drainOnce()

      expect(d.notify.error).toHaveBeenCalled()
      expect(r.state().status).not.toBe('failed')
    })

    it('reports a node it cannot reach to whoever folds every secret into one notice, not as its own error', async () => {
      const pollReached = vi.fn()
      const d = deps({
        pollReached,
        io: { pollMailbox: async () => { throw new NodeUnreachableError('down') } },
      })
      const r = new SecretRuntime(secret(), d)
      stubInstance(r, { process: async () => [] })

      await r.drainOnce()

      expect(pollReached).toHaveBeenCalledWith(false)
      expect(d.notify.error).not.toHaveBeenCalled()
    })

    it('still reports an answer about its own mailbox as its own error, and the node as reached', async () => {
      const pollReached = vi.fn()
      const d = deps({ pollReached, io: { pollMailbox: async () => { throw new Error('actor not found') } } })
      const r = new SecretRuntime(secret(), d)
      stubInstance(r, { process: async () => [] })

      await r.drainOnce()

      expect(pollReached).toHaveBeenCalledWith(true)
      expect(d.notify.error).toHaveBeenCalledWith('Mailbox poll failed', expect.any(Error), { localSecretId: 'v1' })
    })

    it('tells the listener the node answered again', async () => {
      const pollReached = vi.fn()
      const r = new SecretRuntime(secret(), deps({ pollReached, io: { pollMailbox: async () => [] } }))
      stubInstance(r, { process: async () => [] })

      await r.drainOnce()

      expect(pollReached).toHaveBeenCalledWith(true)
    })

    it('stops draining once blocked by a failed adoption', async () => {
      // The erased namespace is gone; processing into it would lose messages
      // against state that no longer exists.
      let polls = 0
      const r = new SecretRuntime(secret(), deps({ io: { pollMailbox: async () => { polls++; return [] } } }))
      stubInstance(r, { process: async () => [], tick: async () => [] })

      r.block(failure)
      await r.drainOnce()
      await r.tickOnce()

      expect(polls).toBe(0)
      expect(r.state().status).toBe('blocked')
      expect(r.state().blockedBy).toEqual(failure)
    })

    it('stays blocked across a reload', () => {
      // A reload must not be able to un-block a wiped device.
      new SecretRuntime(secret(), deps()).block(failure)

      const reloaded = new SecretRuntime(secret(), deps())

      expect(reloaded.state().status).toBe('blocked')
      expect(reloaded.state().blockedBy).toEqual(failure)
    })

    it('commits the folded secret once per drain', async () => {
      const d = deps({ io: mailbox([1]) })
      const r = new SecretRuntime(secret(), d)
      stubInstance(r, {
        process: async () => [{ type: 'PairingFailed', channel_id: 'nope', reason: 'x' }],
      })

      await r.drainOnce()

      // An event that changes nothing must not publish a new record.
      expect(d.onSecretChange).not.toHaveBeenCalled()
    })
  })

  describe('advancing protocol time', () => {
    it('ticks and sweeps expired pending channels', async () => {
      const calls: string[] = []
      const r = new SecretRuntime(secret(), deps())
      stubInstance(r, {
        tick: async () => { calls.push('tick'); return [] },
        removeExpiredChannels: async () => { calls.push('sweep'); return [] },
      })

      await r.tickOnce()

      expect(calls).toEqual(['tick', 'sweep'])
    })

    it('does not tick underneath an open confirmation', async () => {
      const calls: string[] = []
      const r = new SecretRuntime(secret(), deps())
      stubInstance(r, { tick: async () => { calls.push('tick'); return [] }, removeExpiredChannels: async () => [] })

      r.raiseAttention({ kind: 'unpair', blocksDrain: true, payload: {} })
      await r.tickOnce()

      expect(calls).toEqual([])
    })
  })

  describe('folding the roster', () => {
    function helper(overrides: Record<string, unknown> = {}): BEActorWithStatus {
      return {
        id: 'h1',
        role: 'helper',
        name: 'Alex',
        transport: { protocol: 'https', uri: 'http://localhost:5000/derec/h1' },
        transports: [{ protocol: 'https', uri: 'http://localhost:5000/derec/h1' }],
        secret_id: '99',
        ...overrides,
      } as unknown as BEActorWithStatus
    }

    it('adopts a newly provisioned helper as an available participant', () => {
      const r = new SecretRuntime(secret({ participants: [] }), deps())

      r.applyRoster([helper()])

      const p = r.state().secret.participants
      expect(p).toHaveLength(1)
      // Always 'available': the backend's channel_id may belong to another
      // secret's pairing, so only PairingCompleted may promote this.
      expect(p[0].connectionStatus).toBe('available')
      expect(p[0].channelId).toBe('')
    })

    it('forgets an unpaired participant the node no longer has', () => {
      const r = new SecretRuntime(secret({ participants: [] }), deps())
      r.applyRoster([helper(), helper({ id: 'gone', name: 'Fixture-1' })])

      r.applyRoster([helper()])

      expect(r.state().secret.participants.map(p => p.id)).toEqual(['h1'])
    })

    it('keeps a paired participant even when the node no longer lists it', () => {
      // A channel is protocol state; losing the roster row must not erase it.
      const paired = {
        id: 'gone',
        name: 'Alex',
        channelId: '900',
        transport: { protocol: 'https' as const, uri: 'http://localhost:5000/derec/gone' },
        connectionStatus: 'paired' as const,
        secretShares: [],
      }
      const r = new SecretRuntime(secret({ participants: [paired] }), deps())

      r.applyRoster([helper()])

      expect(r.state().secret.participants.map(p => p.id)).toEqual(['gone', 'h1'])
    })

    it('does not re-add a participant it already knows', () => {
      const d = deps()
      const r = new SecretRuntime(secret(), d)

      r.applyRoster([helper()])
      r.applyRoster([helper()])

      expect(r.state().secret.participants).toHaveLength(1)
      // The second pass changed nothing, so it must not publish a new record.
      expect(d.onSecretChange).toHaveBeenCalledTimes(1)
    })

    it('follows the node on whether a participant is offline', () => {
      const r = new SecretRuntime(secret(), deps())
      r.applyRoster([helper()])

      r.applyRoster([helper({ disabled: true })])

      expect(r.state().secret.participants[0].offline).toBe(true)
    })

    it('ignores actors that are not helpers', () => {
      const r = new SecretRuntime(secret(), deps())

      r.applyRoster([helper({ role: 'owner' })])

      expect(r.state().secret.participants).toEqual([])
    })
  })

  describe('the view attached to it', () => {
    it('reaches the attached view, and nothing once it detaches', () => {
      const r = new SecretRuntime(secret(), deps())
      const refreshReplicas = vi.fn()
      const removed = { type: 'ReplicaRemoved', replica_id: '7' } as never

      const detach = r.attachView({ refreshReplicas })
      r.applyEvent(r.state().secret, removed)
      detach()
      // A background secret has no view: its effects are no-ops, not errors.
      r.applyEvent(r.state().secret, removed)

      expect(refreshReplicas).toHaveBeenCalledTimes(1)
    })

    it('calls the view that is attached at the time, not one captured at construction', () => {
      const r = new SecretRuntime(secret(), deps())
      const first = vi.fn()
      const second = vi.fn()

      r.attachView({ refreshReplicas: first })
      r.attachView({ refreshReplicas: second })
      r.applyEvent(r.state().secret, {
        type: 'ReplicaRemoved', replica_id: '7',
      } as never)

      expect(first).not.toHaveBeenCalled()
      expect(second).toHaveBeenCalledTimes(1)
    })

    it('ignores a stale detach from a view that was already replaced', () => {
      const r = new SecretRuntime(secret(), deps())
      const second = vi.fn()
      const detachFirst = r.attachView({ refreshReplicas: vi.fn() })
      r.attachView({ refreshReplicas: second })

      detachFirst()
      r.applyEvent(r.state().secret, { type: 'ReplicaRemoved', replica_id: '7' } as never)

      expect(second).toHaveBeenCalledTimes(1)
    })
  })

  describe('replica first sync', () => {
    afterEach(() => localStorage.clear())

    /** Channel 900: this device is the source, and both sides have confirmed. */
    function confirmedDestination(): void {
      recordReplicaChannel('v1', { channelId: '900', role: 'replica_source', establishedAt: 1 })
      recordConfirmation('v1', replicaChannelRowId('900'), { local: true, peer: 'protocol-verified' })
    }

    it('reacts to a newly confirmed destination from the roster, with no page mounted', async () => {
      // The trigger used to live in the page, so a secret off screen never
      // mirrored to a destination that became eligible while nobody watched.
      confirmedDestination()
      const r = new SecretRuntime(secret(), deps())
      stubInstance(r, {})

      r.applyRoster([])

      // An empty secret has nothing to mirror — which the trigger reports, so the
      // user learns the copy did not go out.
      await vi.waitFor(() => expect(r.state().replicaAutoSyncOutcome).toMatchObject({ kind: expect.any(String) }))
    })

    it('clears the reported outcome when dismissed', async () => {
      confirmedDestination()
      const r = new SecretRuntime(secret(), deps())
      stubInstance(r, {})
      r.applyRoster([])
      await vi.waitFor(() => expect(r.state().replicaAutoSyncOutcome).toMatchObject({ kind: expect.any(String) }))

      r.dismissReplicaAutoSyncOutcome()

      expect(r.state().replicaAutoSyncOutcome).toBeNull()
    })

    it('wants the fast cadence only while a flow is in flight', () => {
      const r = new SecretRuntime(secret(), deps())
      expect(r.wantsFastCadence()).toBe(false)

      r.setBusy(true)

      expect(r.wantsFastCadence()).toBe(true)
    })
  })
})


describe('a protect round interrupted by a reload', () => {
  const seed = { id: 'aa', name: 'Seed', data: 'one two' }
  const pin = { id: 'bb', name: 'PIN', data: '1234' }
  const bagAt = (version: number, items: (typeof seed)[]) => ({
    secretId: '42',
    threshold: 2,
    previousVersions: [],
    currentVersion: {
      version,
      participantIds: [],
      verifiedParticipantIds: [],
      failedParticipantIds: [],
      items,
      rawBytes: '',
      helpers: [],
    },
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('persists the staged bag with the record while the round is open', () => {
    vi.useFakeTimers()
    const d = deps()
    const r = new SecretRuntime(secret({ itemBag: bagAt(2, [seed]) }), d)

    r.beginProtectRound({ bag: bagAt(3, [seed, pin]), version: 3, protocolSecretId: '42', channelIds: ['900'] })
    r.commit(r.state().secret)

    const saved = vi.mocked(d.onSecretChange).mock.lastCall?.[0]
    expect(saved?.pendingProtectRounds?.map(round => round.version)).toEqual([3])
    expect(saved?.pendingProtectRounds?.[0].channelIds).toEqual(['900'])
    expect(saved?.pendingProtectRounds?.[0].bag.currentVersion.items).toEqual([seed, pin])
  })

  it('commits the secret when the resumed round completes, instead of re-numbering the old bag', () => {
    vi.useFakeTimers()
    // What a reload leaves: the record says v2 is committed and v3 is in flight.
    const record = secret({
      itemBag: bagAt(2, [seed]),
      pendingProtectRounds: [{ version: 3, protocolSecretId: '42', bag: bagAt(3, [seed, pin]), channelIds: ['900'] }],
    })
    const d = deps()
    const r = new SecretRuntime(record, d)

    r.resumeProtectRound()
    const after = r.applyEvent(r.state().secret, {
      type: 'SharingComplete',
      version: 3,
      confirmed_count: 2,
      failed_count: 0,
      threshold_met: true,
    } as never)
    r.commit(after)

    expect(r.state().secret.itemBag?.currentVersion.version).toBe(3)
    expect(r.state().secret.itemBag?.currentVersion.items).toEqual([seed, pin])
    expect(r.state().secret.pendingProtectRounds).toBeUndefined()
    expect(d.notify.info).toHaveBeenCalledWith(expect.stringContaining('Resumed sharing round v3'))
  })

  it('drops a pending round the record already committed', () => {
    const d = deps()
    const r = new SecretRuntime(
      secret({
        itemBag: bagAt(3, [seed, pin]),
        pendingProtectRounds: [{ version: 3, protocolSecretId: '42', bag: bagAt(3, [seed, pin]), channelIds: [] }],
      }),
      d,
    )

    r.resumeProtectRound()

    expect(r.state().secret.pendingProtectRounds).toBeUndefined()
    expect(d.notify.info).not.toHaveBeenCalled()
  })
})

describe('protecting with the backend down', () => {
  it('says the server is unreachable rather than blaming the participants', async () => {
    const d = deps({ io: { serverReachable: async () => false } })
    const r = new SecretRuntime(secret(), d)
    stubInstance(r, { start: async () => [] })

    await expect(r.protect([{ id: 'aa', name: 'Seed', data: 'x' }])).rejects.toThrow(
      'Cannot reach the DeRec server',
    )
    expect(r.state().busy).toBe(false)
  })
})

describe('the secret’s own address', () => {
  function self(uri: string): BEActorWithStatus {
    return {
      id: 'v1',
      role: 'owner',
      name: 'Crypto Seeds',
      transport: { protocol: 'https', uri },
      transports: [{ protocol: 'https', uri }],
      secret_id: '42',
      browser_managed: true,
    }
  }

  it('follows the node when it re-advertises this secret at a new address, and tells paired peers', async () => {
    const d = deps({ io: { postBrowserContact: async () => {} } })
    const peer = {
      id: 'h1',
      name: 'Alex',
      channelId: '7',
      transport: { protocol: 'https' as const, uri: 'http://localhost:5000/derec/h1' },
      secretShares: [],
      connectionStatus: 'paired' as const,
    }
    const r = new SecretRuntime(secret({ participants: [peer] }), d)
    const setOwnTransports = vi.fn(async () => {})
    const start = vi.fn(async () => [{ type: 'UpdateChannelInfoStarted', channel_id: '7', trace_id: 't' }])
    stubInstance(r, { setOwnTransports, start, createContact: async () => { throw new Error('not modelled') } })

    r.applyRoster([self('http://192.168.0.28:8080/derec/v1')])
    await vi.waitFor(() => expect(r.state().secret.transport.uri).toBe('http://192.168.0.28:8080/derec/v1'))

    expect(setOwnTransports).toHaveBeenCalledWith([
      { uri: 'http://192.168.0.28:8080/derec/v1', protocol: 'https' },
    ])
    // Peers paired at the old address learn the new one rather than replying
    // into the void.
    // Named explicitly, paired channels only — see `announceIdentity`.
    expect(start).toHaveBeenCalledWith(FlowKind.UpdateChannelInfo, {
      target: [7n],
      own_transports: [{ uri: 'http://192.168.0.28:8080/derec/v1', protocol: 'https' }],
    })
    expect(d.log).toHaveBeenCalledWith(expect.objectContaining({ step: 'own_transport_updated' }))
  })

  it('leaves a pinned endpoint alone when the node moves', () => {
    const r = new SecretRuntime(
      secret({ transport: { protocol: 'https', uri: 'https://relay.example/derec/v1' }, ownTransportPinned: true }),
      deps(),
    )
    const setOwnTransports = vi.fn(async () => {})
    stubInstance(r, { setOwnTransports })

    r.applyRoster([self('http://192.168.0.28:8080/derec/v1')])

    expect(setOwnTransports).not.toHaveBeenCalled()
    expect(r.state().secret.transport.uri).toBe('https://relay.example/derec/v1')
    // Still remembered, for "follow the node" in Edit identity.
    expect(r.nodeAdvertisedAddress()).toBe('http://192.168.0.28:8080/derec/v1')
  })

  it('changes nothing while the node agrees', () => {
    const d = deps()
    const r = new SecretRuntime(secret(), d)
    const setOwnTransports = vi.fn(async () => {})
    stubInstance(r, { setOwnTransports })

    r.applyRoster([self('http://localhost:5000/derec/v1')])

    expect(setOwnTransports).not.toHaveBeenCalled()
  })
})

describe('updating this secret\'s identity', () => {
  const alex = {
    id: 'h1',
    name: 'Alex',
    channelId: '7',
    transport: { protocol: 'https' as const, uri: 'http://localhost:5000/derec/h1' },
    secretShares: [],
    connectionStatus: 'paired' as const,
  }

  function running(overrides: Record<string, unknown> = {}) {
    // One queued message, so a drain feeds the peer's acknowledgement through.
    const queue = [[{ bytes: new Uint8Array([1]) }]]
    const d = deps({
      io: { postBrowserContact: async () => {}, pollMailbox: async () => queue.shift() ?? [] },
    })
    const r = new SecretRuntime(secret({ participants: [alex] }), d)
    const protocol = {
      setCommunicationInfo: vi.fn(async () => {}),
      setOwnTransports: vi.fn(async () => {}),
      start: vi.fn(async () => [{ type: 'UpdateChannelInfoStarted', channel_id: '7', trace_id: 't' }]),
      createContact: async () => { throw new Error('not modelled') },
      ...overrides,
    }
    stubInstance(r, protocol)
    return { r, d, protocol }
  }

  it('renames the secret and tells every paired peer, tracking each answer', async () => {
    const { r, protocol } = running()

    const update = await r.updateIdentity({ name: '  Family Secret ', endpoint: null })

    expect(protocol.setCommunicationInfo).toHaveBeenCalledWith({ name: 'Family Secret' })
    expect(protocol.setOwnTransports).not.toHaveBeenCalled()
    expect(protocol.start).toHaveBeenCalledWith(FlowKind.UpdateChannelInfo, {
      target: [7n],
      communication_info: { name: 'Family Secret' },
    })
    expect(r.state().secret.name).toBe('Family Secret')
    expect(update?.channels['7']).toMatchObject({ peerName: 'Alex', outcome: 'pending', detail: null })
  })

  it('pins a typed endpoint and announces it', async () => {
    const { r, protocol } = running()

    await r.updateIdentity({ name: 'Crypto Seeds', endpoint: 'https://relay.example/derec/v1' })

    expect(protocol.setOwnTransports).toHaveBeenCalledWith([
      { uri: 'https://relay.example/derec/v1', protocol: 'https' },
    ])
    expect(protocol.start).toHaveBeenCalledWith(FlowKind.UpdateChannelInfo, {
      target: [7n],
      own_transports: [{ uri: 'https://relay.example/derec/v1', protocol: 'https' }],
    })
    expect(r.state().secret).toMatchObject({
      transport: { uri: 'https://relay.example/derec/v1' },
      ownTransportPinned: true,
    })
  })

  it('tells no one when nothing changed', async () => {
    const { r, protocol } = running()

    await expect(r.updateIdentity({ name: 'Crypto Seeds', endpoint: null })).resolves.toBeNull()
    expect(protocol.start).not.toHaveBeenCalled()
  })

  it('refuses an invalid name or endpoint before touching the protocol', async () => {
    const { r, protocol } = running()

    await expect(r.updateIdentity({ name: ' ', endpoint: null })).rejects.toThrow(/Enter a name/)
    await expect(r.updateIdentity({ name: 'Ok', endpoint: 'grpc://x:1/derec/v1' })).rejects.toThrow(/gRPC/)
    expect(protocol.setCommunicationInfo).not.toHaveBeenCalled()
    expect(protocol.start).not.toHaveBeenCalled()
  })

  it('records the peer\'s answer when its acknowledgement is processed', async () => {
    const { r } = running({
      process: vi.fn(async () => [{ type: 'ChannelInfoUpdated', channel_id: '7' }]),
    })
    await r.updateIdentity({ name: 'Family Secret', endpoint: null })

    await r.drainOnce()

    expect(r.state().identityUpdate?.channels['7'].outcome).toBe('updated')
  })
})

describe('auto-pairing at setup', () => {
  function available(n: number): PairedParticipant {
    return {
      id: `h${n}`,
      name: `Helper ${n}`,
      channelId: '',
      transport: { protocol: 'https', uri: `http://localhost:5000/derec/h${n}` },
      secretShares: [],
      connectionStatus: 'available',
    }
  }

  function pairingRuntime(
    prePairedCount: number,
    contact: (participantId: string) => Promise<ContactMessage> = async () => ({}) as ContactMessage,
  ) {
    let next = 900
    const start = vi.fn(async () => [{ type: 'PairingStarted', channel_id: String(next++) }])
    const r = new SecretRuntime(
      secret({ participants: [available(1), available(2), available(3)], prePairedCount }),
      deps({ io: { participantContact: contact } }),
    )
    stubInstance(r, { start })
    return { r, start }
  }

  it('pairs with as many participants as asked, records the pairings, and holds the fast cadence meanwhile', async () => {
    const { r, start } = pairingRuntime(2)

    await r.autoPair()

    expect(start).toHaveBeenCalledTimes(2)
    expect(r.state().autoPairing).toHaveLength(2)
    expect(r.wantsFastCadence()).toBe(true)
    expect(r.state().secret.prePairedCount).toBe(0)
    expect(r.state().secret.pendingPairings.map(p => p.participantId).sort()).toEqual(
      [...r.state().autoPairing].sort(),
    )
  })

  it('records each pairing as it starts, before reaching for the next participant', async () => {
    // A reply the poll folds before its pending record exists cannot find the
    // participant's placeholder, and lands as a second row for the same helper:
    // pre-pairing all seven of a pool listed five of them twice.
    const recordedWhenAsked: number[] = []
    const { r } = pairingRuntime(3, async () => {
      recordedWhenAsked.push(r.state().secret.pendingPairings.length)
      return {} as ContactMessage
    })

    await r.autoPair()

    expect(recordedWhenAsked).toEqual([0, 1, 2])
    expect(r.state().secret.pendingPairings).toHaveLength(3)
  })

  it('lets the poll slow down once every one of them has paired', async () => {
    const { r } = pairingRuntime(2)
    await r.autoPair()
    const targets = new Set(r.state().autoPairing)

    r.commit({
      ...r.state().secret,
      participants: r.state().secret.participants.map(p =>
        targets.has(p.id) ? { ...p, connectionStatus: 'paired' as const } : p,
      ),
    })

    expect(r.state().autoPairing).toEqual([])
    expect(r.wantsFastCadence()).toBe(false)
  })

  it('stops holding the fast cadence when the secret stops mid-pairing', () => {
    // Leaving the page used to leave the poll fast for good: the page set it
    // and nothing unset it.
    const { r } = pairingRuntime(2)
    void r.autoPair()
    expect(r.wantsFastCadence()).toBe(true)

    r.stop()

    expect(r.state().autoPairing).toEqual([])
    expect(r.wantsFastCadence()).toBe(false)
  })

  it('does not wait on a participant whose pairing could not start', async () => {
    const { r } = pairingRuntime(1, async () => {
      throw new Error('node said no')
    })

    await r.autoPair()

    expect(r.state().autoPairing).toEqual([])
    expect(r.wantsFastCadence()).toBe(false)
    // Nothing started, so the next start tries again.
    expect(r.state().secret.prePairedCount).toBe(1)
  })

  it('runs once per runtime', async () => {
    const { r, start } = pairingRuntime(1)

    await r.autoPair()
    await r.autoPair()

    expect(start).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a secret that asked for no pre-pairing', async () => {
    const { r, start } = pairingRuntime(0)

    await r.autoPair()

    expect(start).not.toHaveBeenCalled()
    expect(r.state().autoPairing).toEqual([])
  })
})
