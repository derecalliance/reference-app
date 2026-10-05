// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { FlowKind, type DeRecEvent } from '@derec-alliance/web'

import { recordConfirmation, recordReplicaChannel, replicaChannelRowId } from '../replicaFlows'
import { VaultRuntime } from './runtime'
import { deps, stubInstance, vault } from './testVault'
import type { PairedParticipant } from '../types'

/**
 * Unit coverage for the event fold, which had none while it lived inside
 * `OwnerPage` — there was no way to reach it without rendering the page.
 *
 * Every assertion here was written by reading the handler it covers, not by
 * recording current behaviour. Rounds whose preconditions are established by the
 * commands (`pendingShares`, `pendingBag`) are covered once those commands move
 * onto the runtime; seeding private state through a test-only door would test
 * the door rather than the flow.
 */

function participant(overrides: Partial<PairedParticipant> = {}): PairedParticipant {
  return {
    id: 'h1',
    name: 'Alex',
    channelId: '900',
    transport: { protocol: 'https', uri: 'http://localhost:5000/derec/h1' },
    secretShares: [],
    connectionStatus: 'paired',
    ...overrides,
  }
}

function event(e: Record<string, unknown>): DeRecEvent {
  return e as unknown as DeRecEvent
}

describe('applyEvent', () => {
  it('returns the vault unchanged for an event it does not handle', () => {
    const r = new VaultRuntime(vault(), deps())
    const before = vault()

    expect(r.applyEvent(before, event({ type: 'NotAThing' }))).toBe(before)
  })

  it('does not mutate the vault it was given', () => {
    // A reducer: the drain loop threads the result forward and relies on the
    // input surviving untouched if a later event in the batch throws.
    const r = new VaultRuntime(vault(), deps())
    const before = vault({ participants: [participant()] })
    const snapshot = JSON.stringify(before)

    r.applyEvent(before, event({ type: 'SecretsDiscovered', channel_id: '900', secrets: [] }))

    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('logs through the injected logger, not a module singleton', () => {
    // A background vault has no console context of its own to reach for.
    const d = deps()
    const r = new VaultRuntime(vault({ participants: [participant()] }), d)

    r.applyEvent(
      vault({ participants: [participant()] }),
      event({ type: 'SecretsDiscovered', channel_id: '900', secrets: [] }),
    )

    expect(d.log).toHaveBeenCalled()
  })

  describe('SecretsDiscovered', () => {
    it('records the versions a helper reported against that participant', () => {
      const r = new VaultRuntime(vault(), deps())
      const before = vault({ participants: [participant()] })

      const after = r.applyEvent(
        before,
        event({
          type: 'SecretsDiscovered',
          channel_id: '900',
          secrets: [{ secret_id: 42n, versions: [{ version: 3, description: 'v3' }] }],
        }),
      )

      expect(after.participants[0].discoveryComplete).toBe(true)
      expect(after.participants[0].discoveredVersions).toEqual([
        { secretId: '42', version: 3, description: 'v3' },
      ])
    })

    it('marks discovery complete even when the helper holds nothing', () => {
      // Not a race: Discovery fires only after PairingCompleted. Leaving this
      // participant incomplete makes the recovery retry loop fan out Discovery
      // every few seconds forever.
      const r = new VaultRuntime(vault(), deps())

      const after = r.applyEvent(
        vault({ participants: [participant()] }),
        event({ type: 'SecretsDiscovered', channel_id: '900', secrets: [] }),
      )

      expect(after.participants[0].discoveryComplete).toBe(true)
      expect(after.participants[0].discoveredVersions).toEqual([])
    })

    it('ignores a channel no participant holds', () => {
      const r = new VaultRuntime(vault(), deps())
      const before = vault({ participants: [participant()] })

      expect(
        r.applyEvent(before, event({ type: 'SecretsDiscovered', channel_id: '999', secrets: [] })),
      ).toBe(before)
    })
  })

  describe('Unpaired', () => {
    it('drops every local trace of the torn-down channel', () => {
      const r = new VaultRuntime(vault(), deps())
      const before = vault({
        participants: [participant(), participant({ id: 'h2', channelId: '901' })],
        heldShares: [
          { channelId: '900', secretId: '7', version: 1, description: 'gone' },
          { channelId: '901', secretId: '8', version: 1, description: 'stays' },
        ],
        pendingPairings: [{ channelId: 900n }, { channelId: 901n }],
      })

      const after = r.applyEvent(before, event({ type: 'Unpaired', channel_id: '900' }))

      expect(after.participants.map(p => p.channelId)).toEqual(['901'])
      expect(after.heldShares.map(s => s.channelId)).toEqual(['901'])
      expect(after.pendingPairings.map(p => p.channelId)).toEqual([901n])
    })
  })

  describe('ReplicaSecretReceived', () => {
    const offer = {
      type: 'ReplicaSecretReceived',
      channel_id: '900',
      from_replica_id: 'ff01',
      version: 4,
      secret: { id: 'x', name: 'n', data: 'd' },
      shares: [],
    }

    it('treats a mirror of the vault this device already runs as an update', () => {
      // The distinction that matters: an update must not offer to wipe and
      // restore the vault the device is already running, on every sync.
      const d = deps({ effects: { openAdoption: vi.fn() } })
      const r = new VaultRuntime(vault({ secretId: '42' }), d)

      r.applyEvent(vault({ secretId: '42' }), event({ ...offer, secret_id: '42' }))

      expect(r.attention()).toEqual([])
      expect(d.effects?.openAdoption).not.toHaveBeenCalled()
    })

    afterEach(() => localStorage.clear())

    /** This device compared and confirmed the fingerprint of channel 900. */
    function confirmChannel900(): void {
      recordConfirmation('v1', replicaChannelRowId('900'), { local: true })
    }

    it('stages a mirror of a different secret as a takeover offer', () => {
      confirmChannel900()
      const d = deps({ effects: { openAdoption: vi.fn() } })
      const r = new VaultRuntime(vault({ secretId: '42' }), d)

      r.applyEvent(vault({ secretId: '42' }), event({ ...offer, secret_id: '99' }))

      const staged = r.attention()
      expect(staged).toHaveLength(1)
      expect(staged[0]).toMatchObject({ kind: 'replica-adoption', blocksDrain: false })
      expect(staged[0].payload).toMatchObject({
        secretId: '99',
        version: 4,
        fromReplicaId: 'ff01',
      })
      expect(d.effects?.openAdoption).toHaveBeenCalledTimes(1)
    })

    it('holds a takeover offer back until this device confirms the channel', () => {
      // The fingerprint is what proves the channel is not a man in the middle.
      // Offering to replace this vault with whatever arrived over an unverified
      // channel would put a destructive prompt in front of the owner on the
      // strength of a key nobody has checked.
      const d = deps({ effects: { openAdoption: vi.fn() } })
      const r = new VaultRuntime(vault({ secretId: '42' }), d)

      r.applyEvent(vault({ secretId: '42' }), event({ ...offer, secret_id: '99' }))

      expect(r.attention()).toEqual([])
      expect(d.effects?.openAdoption).not.toHaveBeenCalled()
    })

    it('offers the held copy the moment this device confirms the channel', () => {
      const d = deps({ effects: { openAdoption: vi.fn() } })
      const r = new VaultRuntime(vault({ secretId: '42' }), d)
      r.applyEvent(vault({ secretId: '42' }), event({ ...offer, secret_id: '99' }))

      confirmChannel900()
      r.replicaChannelConfirmed('900')

      expect(r.attention()).toHaveLength(1)
      expect(r.attention()[0].payload).toMatchObject({ secretId: '99', version: 4 })
      expect(d.effects?.openAdoption).toHaveBeenCalledTimes(1)
    })

    it('keeps the newest of several copies held for one channel', () => {
      // The mailbox redelivers at least once; a stale round must not replace a
      // fresher held copy.
      const r = new VaultRuntime(vault({ secretId: '42' }), deps())
      r.applyEvent(vault({ secretId: '42' }), event({ ...offer, secret_id: '99', version: 5 }))
      r.applyEvent(vault({ secretId: '42' }), event({ ...offer, secret_id: '99', version: 4 }))

      confirmChannel900()
      r.replicaChannelConfirmed('900')

      expect(r.attention()[0].payload).toMatchObject({ version: 5 })
    })

    it('pulls the copy once a destination confirms the channel', async () => {
      // SDK 0.0.6 drops a push that arrives before this device confirms and
      // does not replay it, so the destination has to ask for the copy itself.
      recordReplicaChannel('v1', { channelId: '900', role: 'replica_destination', establishedAt: 1 })
      confirmChannel900()
      const start = vi.fn<(flowKind: FlowKind, params?: unknown) => Promise<never[]>>(async () => [])
      const r = new VaultRuntime(vault(), deps())
      stubInstance(r, { start })

      r.replicaChannelConfirmed('900')
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1))

      expect(start.mock.calls[0][0]).toBe(FlowKind.ReplicaDiscovery)
      r.stop()
    })

    it('shows the channel as syncing until the copy lands', async () => {
      recordReplicaChannel('v1', { channelId: '900', role: 'replica_destination', establishedAt: 1 })
      confirmChannel900()
      const r = new VaultRuntime(vault({ secretId: '42' }), deps())
      stubInstance(r, { start: vi.fn(async () => []) })

      r.replicaChannelConfirmed('900')
      await vi.waitFor(() => expect(r.state().replicaSyncing).toEqual(['900']))

      r.applyEvent(r.state().vault, event({ ...offer, type: 'ReplicaSecretInstalled', secret_id: '99' }))

      expect(r.state().replicaSyncing).toEqual([])
      expect(r.attention()[0]).toMatchObject({ kind: 'replica-adoption' })
    })

    it('does not pull when this device is the source of the channel', async () => {
      // A source already holds the vault; it is the one that pushes.
      recordReplicaChannel('v1', { channelId: '900', role: 'replica_source', establishedAt: 1 })
      const start = vi.fn<(flowKind: FlowKind, params?: unknown) => Promise<never[]>>(async () => [])
      const r = new VaultRuntime(vault(), deps())
      stubInstance(r, { start })

      r.replicaChannelConfirmed('900')
      await Promise.resolve()

      expect(start).not.toHaveBeenCalled()
    })

    it('does nothing on confirmation when no copy is held', () => {
      const d = deps({ effects: { openAdoption: vi.fn() } })
      const r = new VaultRuntime(vault(), d)

      r.replicaChannelConfirmed('900')

      expect(r.attention()).toEqual([])
      expect(d.effects?.openAdoption).not.toHaveBeenCalled()
    })
  })
})
