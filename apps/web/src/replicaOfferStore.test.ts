// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { afterEach, describe, expect, it } from 'vitest'

import type { PendingReplicaAdoption } from './replicaFlows'
import {
  clearPendingReplicaOffer,
  loadPendingReplicaOffer,
  savePendingReplicaOffer,
} from './replicaOfferStore'
import { VaultRuntime } from './vault/runtime'
import { deps, vault } from './vault/testVault'

const offer: PendingReplicaAdoption = {
  channelId: '1234',
  fromReplicaId: '77',
  secretId: '9',
  version: 3,
  secret: {
    helpers: [
      {
        channel_id: '5',
        transports: [{ uri: 'http://n/derec/h', protocol: 0 }],
        shared_key: new Uint8Array([1, 2, 3]),
      },
    ],
    secrets: [{ id: new Uint8Array([0xab]), name: 'seed', data: new Uint8Array([104, 105]) }],
  },
  shares: [{ channel_id: '5', committed_share: new Uint8Array([9, 8, 7]) }],
} as unknown as PendingReplicaAdoption

afterEach(() => localStorage.clear())

describe('the persisted adoption offer', () => {
  it('round-trips, bytes included', () => {
    savePendingReplicaOffer('v1', offer)
    const loaded = loadPendingReplicaOffer('v1')

    expect(loaded).toEqual(offer)
    expect(loaded?.shares[0].committed_share).toBeInstanceOf(Uint8Array)
    expect(loaded?.secret.secrets[0].data).toEqual(new Uint8Array([104, 105]))
  })

  it('is gone once cleared, and unreadable rows read as none', () => {
    savePendingReplicaOffer('v1', offer)
    clearPendingReplicaOffer('v1')
    expect(loadPendingReplicaOffer('v1')).toBeNull()

    localStorage.setItem('derec:replica-offer:v1', '{"nope":1}')
    expect(loadPendingReplicaOffer('v1')).toBeNull()
  })

  it('puts the offer back in front of the owner after a reload', () => {
    savePendingReplicaOffer('v1', offer)

    const r = new VaultRuntime(vault(), deps())

    const item = r.state().attention.find(a => a.kind === 'replica-adoption')
    expect(item?.payload).toEqual(offer)
  })

  it('drops an offer for the secret the vault already runs — it was adopted', () => {
    savePendingReplicaOffer('v1', { ...offer, secretId: '42' })

    const r = new VaultRuntime(vault({ secretId: '42' }), deps())

    expect(r.state().attention).toEqual([])
    expect(loadPendingReplicaOffer('v1')).toBeNull()
  })

  it('stops persisting an offer the owner rejects', async () => {
    const r = new VaultRuntime(vault(), deps())
    r.stageReplicaAdoption(offer)
    expect(loadPendingReplicaOffer('v1')).not.toBeNull()

    const item = r.state().attention.find(a => a.kind === 'replica-adoption')!
    await r.rejectAttention(item.id)

    expect(loadPendingReplicaOffer('v1')).toBeNull()
  })
})
