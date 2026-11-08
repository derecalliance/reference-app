// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { FlowKind, type ContactMessage, type DeRecEvent } from '@derec-alliance/web'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { recordConfirmation, recordReplicaChannel, replicaChannelRowId, type PendingReplicaAdoption } from '../replicaFlows'
import { makeChannelStore } from '../stores'
import type { PairedParticipant, ReplicaConflict, ItemBag } from '../types'
import { SecretRuntime } from './runtime'
import { deps, stubInstance, secret } from './testSecret'

/**
 * What the runtime does differently for SDK 0.0.7: the events a failed
 * `process()` carries, the pause on a diverged replica secret, adoption agreed
 * before the fingerprint is confirmed, and an identity change reaching the
 * replica group.
 */

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

function helper(n: number): PairedParticipant {
  return {
    id: `h${n}`,
    name: `Helper ${n}`,
    channelId: String(n),
    transport: { protocol: 'https', uri: `http://localhost:5000/derec/h${n}` },
    connectionStatus: 'paired',
    peerRole: 'helper',
    secretShares: [],
  }
}

function bag(version: number, previous: number[] = []): ItemBag {
  const at = (v: number) => ({
    version: v,
    participantIds: ['h7', 'h8'],
    verifiedParticipantIds: [],
    failedParticipantIds: [],
    items: [{ id: 'aa', name: 'Seed', data: 'one two' }],
    rawBytes: '',
    helpers: [],
  })
  return { secretId: '42', threshold: 2, currentVersion: at(version), previousVersions: previous.map(at) }
}

const conflict: ReplicaConflict = {
  version: 6,
  detectedVia: 'ReplicaVersionConflict',
  rivalReplicaId: '22',
  rivalItems: [{ id: 'dd', name: 'FromDest', data: 'y' }],
  detectedAt: 0,
}

describe('a failed process()', () => {
  it('folds the events it settled before failing, then reports the error', async () => {
    const d = deps({ io: { pollMailbox: async () => [{ bytes: new Uint8Array([1]) }] } })
    const r = new SecretRuntime(
      secret({ participants: [helper(7), helper(8)], itemBag: bag(1), minParticipants: 2 }),
      d,
    )
    r.beginProtectRound({ bag: bag(2, [1]), version: 2, protocolSecretId: '42', channelIds: ['7', '8'] })
    const settled: DeRecEvent = {
      type: 'SharingComplete',
      version: 2,
      confirmed_count: 2,
      failed_count: 0,
      threshold_met: true,
    }
    stubInstance(r, {
      process: async () => {
        throw { category: 'protocol', code: 'invalid_input', message: 'bad envelope', events: [settled] }
      },
    })

    await r.drainOnce()

    // The round the failing call timed out is closed and committed, not left
    // open forever.
    expect(r.hasPendingRound(2)).toBe(false)
    expect(r.state().secret.itemBag?.currentVersion.version).toBe(2)
    expect(d.notify.error).toHaveBeenCalledWith('Failed to process an incoming message', expect.anything(), expect.anything())
  })

  it('treats a failure that carries no events exactly as before', async () => {
    const d = deps({ io: { pollMailbox: async () => [{ bytes: new Uint8Array([1]) }] } })
    const r = new SecretRuntime(secret(), d)
    stubInstance(r, {
      process: async () => {
        throw { category: 'protocol', code: 'invalid_input', message: 'unknown channel_id 9', channel_id: '9' }
      },
    })

    await r.drainOnce()

    expect(d.notify.error).not.toHaveBeenCalled()
    expect(d.log).toHaveBeenCalledWith(expect.objectContaining({ step: 'unknown_channel_ignored' }))
  })
})

describe('a secret diverged from its replica group', () => {
  it('refuses to publish, saying why, and sends nothing', async () => {
    const r = new SecretRuntime(secret({ itemBag: bag(6), replicaConflict: conflict }), deps())
    const start = vi.fn()
    stubInstance(r, { start })

    await expect(r.addItem('New', 'value')).rejects.toThrow(/copy of v6 differs from its replica group's/)
    await expect(r.syncReplicas('manual')).rejects.toThrow(/Publishing is paused/)
    expect(start).not.toHaveBeenCalled()
  })

  it('refuses the flows that make the library publish on its own', async () => {
    const r = new SecretRuntime(secret({ itemBag: bag(6), replicaConflict: conflict }), deps())
    const start = vi.fn()
    const verifyFingerprint = vi.fn()
    stubInstance(r, { start, verifyFingerprint })

    await expect(r.startPairing({} as ContactMessage, 'owner')).rejects.toThrow(/Pairing would publish this secret/)
    await expect(r.replicaProtocol.verifyFingerprint(1n, '1234')).rejects.toThrow(/Confirming would publish/)
    expect(start).not.toHaveBeenCalled()
    expect(verifyFingerprint).not.toHaveBeenCalled()
  })

  it('publishes the owner’s resolution once, and is no longer diverged', async () => {
    const r = new SecretRuntime(secret({ itemBag: bag(6), replicaConflict: conflict }), deps())
    const protect = vi
      .spyOn(r, 'protect')
      .mockResolvedValue({ version: 7, participants: [], replicaTargets: [], threshold: 2 })
    const merged = [
      { id: 'aa', name: 'Seed', data: 'one two' },
      { id: 'dd', name: 'FromDest', data: 'y' },
    ]

    await expect(r.resolveReplicaConflict(merged)).resolves.toBe(7)

    expect(protect).toHaveBeenCalledTimes(1)
    expect(protect).toHaveBeenCalledWith(merged, { resolvesReplicaConflict: true })
    expect(r.state().secret.replicaConflict).toBeUndefined()
  })

  it('stays diverged when the resolution does not go out', async () => {
    const r = new SecretRuntime(secret({ itemBag: bag(6), replicaConflict: conflict }), deps())
    vi.spyOn(r, 'protect').mockRejectedValue(new Error('server down'))

    await expect(r.resolveReplicaConflict([{ id: 'aa', name: 'Seed', data: 'x' }])).rejects.toThrow('server down')
    expect(r.state().secret.replicaConflict).toEqual(conflict)
  })

  it('asks the group for its copy when only the refusal is known', async () => {
    const r = new SecretRuntime(
      secret({ itemBag: bag(6), replicaConflict: { ...conflict, rivalItems: null } }),
      deps(),
    )
    const start = vi.fn(async () => [])
    stubInstance(r, { start })

    await r.fetchReplicaConflictRival()

    expect(start).toHaveBeenCalledWith(FlowKind.ReplicaDiscovery)
  })
})

describe('a mirrored secret arriving on a destination', () => {
  const offer: PendingReplicaAdoption = {
    channelId: '100',
    fromReplicaId: '77',
    secretId: '9',
    version: 3,
    payload: { helpers: [], secrets: [] },
    shares: [],
  }

  function destination(consented: boolean) {
    recordReplicaChannel('v1', { channelId: '100', role: 'replica_destination', peerReplicaId: '77' })
    recordConfirmation('v1', replicaChannelRowId('100'), {
      local: true,
      ...(consented ? { adoptionConsented: true } : {}),
    })
    const openAdoption = vi.fn()
    const r = new SecretRuntime(secret(), deps({ effects: { openAdoption } }))
    const adopt = vi.spyOn(r, 'adoptReplica').mockResolvedValue()
    return { r, adopt, openAdoption }
  }

  it('is adopted without asking again when the person agreed before confirming', async () => {
    const { r, adopt, openAdoption } = destination(true)

    r.offerReplicaAdoption(offer)

    await vi.waitFor(() => expect(adopt).toHaveBeenCalledWith(offer))
    expect(openAdoption).not.toHaveBeenCalled()
    expect(r.attention()).toHaveLength(0)
  })

  it('still asks on a channel confirmed before the app asked up front', () => {
    const { r, adopt, openAdoption } = destination(false)

    r.offerReplicaAdoption(offer)

    expect(adopt).not.toHaveBeenCalled()
    expect(openAdoption).toHaveBeenCalledTimes(1)
    expect(r.attention().map(a => a.kind)).toEqual(['replica-adoption'])
  })
})

describe('an identity change on a secret in a replica group', () => {
  function inGroup() {
    // This device's own row and one other member.
    const store = makeChannelStore('secret:v1')
    const member = (replicaId: string, role: string) =>
      new TextEncoder().encode(
        `{"Replica":{"channel_id":100,"replica_id":${replicaId},"transports":[],"communication_info":{},"role":"${role}","status":"Paired","created_at":1}}`,
      )
    void store.save('42', '100', '22', member('22', 'Destination'))
    const order: string[] = []
    const r = new SecretRuntime(
      secret({ participants: [helper(7)], itemBag: bag(4) }),
      deps({ io: { postBrowserContact: async () => {}, renameOwner: async () => ({ kind: 'unsupported' }) } }),
    )
    const protocol = {
      setCommunicationInfo: vi.fn(async () => {
        order.push('setCommunicationInfo')
      }),
      setOwnTransports: vi.fn(async () => {}),
      start: vi.fn(async (flow: FlowKind) => {
        order.push(flow === FlowKind.UpdateChannelInfo ? 'UpdateChannelInfo' : String(flow))
        return [{ type: 'UpdateChannelInfoStarted', channel_id: '7', trace_id: 't' }]
      }),
      createContact: async () => {
        throw new Error('not modelled')
      },
    }
    stubInstance(r, protocol)
    const protect = vi.spyOn(r, 'protect').mockImplementation(async () => {
      order.push('publish')
      return { version: 5, participants: [], replicaTargets: [], threshold: 2 }
    })
    return { r, protect, order }
  }

  it('publishes a new version first, so the roster carries it, then tells the helpers', async () => {
    const { r, protect, order } = inGroup()

    await r.updateIdentity({ name: 'Family Secret', endpoint: null })

    expect(protect).toHaveBeenCalledWith([{ id: 'aa', name: 'Seed', data: 'one two' }])
    expect(order.indexOf('setCommunicationInfo')).toBeLessThan(order.indexOf('publish'))
    expect(order.indexOf('publish')).toBeLessThan(order.indexOf('UpdateChannelInfo'))
  })

  it('does not publish while diverged, but still tells the helpers', async () => {
    const { r, protect, order } = inGroup()
    r.commit({ ...r.state().secret, replicaConflict: conflict })

    await r.updateIdentity({ name: 'Family Secret', endpoint: null })

    expect(protect).not.toHaveBeenCalled()
    expect(order).toContain('UpdateChannelInfo')
  })

  it('publishes nothing for a secret in no group', async () => {
    localStorage.clear()
    const r = new SecretRuntime(
      secret({ participants: [helper(7)], itemBag: bag(4) }),
      deps({ io: { postBrowserContact: async () => {}, renameOwner: async () => ({ kind: 'unsupported' }) } }),
    )
    stubInstance(r, {
      setCommunicationInfo: vi.fn(async () => {}),
      setOwnTransports: vi.fn(async () => {}),
      start: vi.fn(async () => [{ type: 'UpdateChannelInfoStarted', channel_id: '7', trace_id: 't' }]),
      createContact: async () => {
        throw new Error('not modelled')
      },
    })
    const protect = vi.spyOn(r, 'protect')

    await r.updateIdentity({ name: 'Family Secret', endpoint: null })

    expect(protect).not.toHaveBeenCalled()
  })
})

describe('a fingerprint mismatch (SDK 0.0.10)', () => {
  it('reads the library\'s rejection as a mismatch, and passes any other failure on', async () => {
    const r = new SecretRuntime(secret(), deps())
    const verifyFingerprint = vi
      .fn()
      .mockRejectedValueOnce({ code: 'fingerprint_mismatch', message: 'fingerprint mismatch' })
      .mockRejectedValueOnce({ code: 'channel_store', message: 'unavailable' })
      .mockResolvedValueOnce(undefined)
    stubInstance(r, { verifyFingerprint })

    await expect(r.replicaProtocol.verifyFingerprint(1n, '1234')).resolves.toBe(false)
    await expect(r.replicaProtocol.verifyFingerprint(1n, '1234')).rejects.toMatchObject({ code: 'channel_store' })
    await expect(r.replicaProtocol.verifyFingerprint(1n, '1234')).resolves.toBe(true)
  })
})
