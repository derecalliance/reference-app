// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReplicaChannelRow, type ReplicaChannelRowProps } from './ReplicaChannelRow'
import type { ReplicaStatus, ReplicaView } from './replicaFlows'

/**
 * What the row has to guarantee once the fingerprint modal became dismissible.
 *
 * Dismissing the modal is only safe because this row survives it: the channel
 * stays pending, the way back in stays on screen, and the deadline keeps
 * counting down where the user can see it. If any of those three stops being
 * true, dismissing silently strands a channel that the protocol will drop.
 *
 * The row is also where a replica declares itself in a list of channels that
 * otherwise all hold shares, so the role badge is asserted as text — a colour
 * cannot say "this one is not a helper".
 */

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function view(overrides: Partial<ReplicaView> = {}): ReplicaView {
  return {
    id: 'replica-channel:1234',
    name: 'Laptop',
    channelId: '1234',
    status: 'pending' as ReplicaStatus,
    offline: false,
    peerConfirmation: 'none',
    lastSync: null,
    establishedAt: Date.now(),
    firstSyncStarted: false,
    direction: 'replica_source',
    peerReplicaId: null,
    helperActorId: null,
    refused: false,
    ...overrides,
  }
}

const BASE: ReplicaChannelRowProps = {
  name: 'Laptop',
  channelId: '1234',
  peerRole: 'replica_destination',
  view: view(),
  protocolTimeoutSecs: 300,
  syncing: false,
  syncBlocked: false,
  syncNotice: null,
  onDismissSyncNotice: () => {},
  onOpenFingerprint: () => {},
  onSyncNow: () => {},
  onForget: () => {},
  canRemoveFromGroup: false,
  removingFromGroup: false,
  onRemoveFromGroup: () => {},
  canToggleOffline: false,
  offline: false,
  onToggleOffline: () => {},
}

function render(overrides: Partial<ReplicaChannelRowProps> = {}): void {
  act(() => {
    root.render(<ReplicaChannelRow {...BASE} {...overrides} />)
  })
}

function text(): string {
  return host.textContent ?? ''
}

function buttonLabelled(match: RegExp): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll('button')).find(b =>
    match.test(b.textContent ?? ''),
  )
  if (!button) throw new Error(`no button matching ${match} — rendered: ${text()}`)
  return button
}

describe('how a replica channel declares itself', () => {
  it('names the peer role in words, not only in colour', () => {
    render()
    expect(text()).toContain('Replica destination')
  })

  it('names the source side when this device is the destination', () => {
    render({
      peerRole: 'replica_source' as const,
      view: view({ direction: 'replica_destination' }),
    })
    expect(text()).toContain('Replica source')
  })

  it('offers no Link action — a replica channel cannot be linked to a share', () => {
    render()
    expect(text()).not.toMatch(/\bLink\b/)
  })
})

describe('taking a replica peer offline', () => {
  it('offers no control when the peer is not a provisioned helper', () => {
    // A browser peer has no backend actor to suspend, so the affordance must
    // not exist rather than exist and fail.
    render({ canToggleOffline: false })
    expect(text()).not.toMatch(/Go Offline|Go Online/)
  })

  it('offers to suspend a helper peer that is delivering', () => {
    render({ canToggleOffline: true, offline: false })
    expect(buttonLabelled(/Go Offline/)).toBeTruthy()
  })

  it('offers to resume a helper peer that is suspended', () => {
    render({ canToggleOffline: true, offline: true })
    expect(buttonLabelled(/Go Online/)).toBeTruthy()
  })

  it('asks its caller to flip the peer when pressed', () => {
    let toggled = 0
    render({ canToggleOffline: true, offline: true, onToggleOffline: () => { toggled += 1 } })

    buttonLabelled(/Go Online/).click()
    expect(toggled).toBe(1)
  })
})

describe('after the fingerprint modal is dismissed', () => {
  it('still says the channel is unconfirmed', () => {
    render()
    expect(text()).toContain('Pending confirmation')
    expect(text()).toContain('Not confirmed yet')
  })

  it('keeps a way back into the comparison', () => {
    const onOpenFingerprint = vi.fn()

    render({ onOpenFingerprint })
    buttonLabelled(/Confirm fingerprint/).click()

    expect(onOpenFingerprint).toHaveBeenCalledTimes(1)
  })

  it('keeps the expiry deadline on screen and counting', () => {
    // Two minutes into a five-minute timeout: three left.
    render({ view: view({ establishedAt: Date.now() - 120_000 }) })
    expect(text()).toMatch(/Confirm within 3:0\d/)
  })

  it('says the channel expired once the deadline passed, rather than looking live', () => {
    render({ view: view({ establishedAt: Date.now() - 600_000 }) })
    expect(text()).toContain('Expired')
    expect(text()).not.toContain('Pending confirmation')
  })

  it('reads as unconfirmed while the projection has not landed yet', () => {
    // `null` must never read as confirmed: the row would be claiming a
    // verification it cannot see.
    render({ view: null })
    expect(text()).toContain('Pending confirmation')
    expect(text()).toContain('Not confirmed yet')
  })
})

describe('once this device has confirmed', () => {
  const confirmed = view({ status: 'paired', establishedAt: Date.now() })

  it('drops the prompt but keeps the fingerprint reachable', () => {
    const onOpenFingerprint = vi.fn()

    render({ view: confirmed, onOpenFingerprint })

    expect(text()).not.toContain('Not confirmed yet')
    buttonLabelled(/View fingerprint/).click()
    expect(onOpenFingerprint).toHaveBeenCalledTimes(1)
  })

  it('does not claim the peer confirmed when this device cannot see it', () => {
    render({ view: confirmed })
    expect(text()).toContain('The peer confirms on its own screen')
  })

  it('offers "Sync now" on a confirmed source channel', () => {
    const onSyncNow = vi.fn()

    render({ view: confirmed, onSyncNow })
    buttonLabelled(/Sync now/).click()

    expect(onSyncNow).toHaveBeenCalledTimes(1)
  })

  it('offers no "Sync now" on a destination channel — a round would push the wrong way', () => {
    render({ view: view({ status: 'paired', direction: 'replica_destination' }) })
    expect(text()).not.toMatch(/Sync now/)
  })

  it('offers no "Sync now" while the channel is still pending', () => {
    render()
    expect(text()).not.toMatch(/Sync now/)
  })
})

describe('clearing a replica row', () => {
  it('offers no "Unpair" — the helper unpair flow does not address a replica', () => {
    // The library stores group members by replica id, never by channel id, so
    // `Unpair { channel_id }` was rejected on every replica channel — healthy
    // ones included — and left the row with nothing that could clear it.
    render({ view: view({ status: 'paired' }) })
    expect(text()).not.toMatch(/Unpair/)
  })

  it('always offers Forget, even when there is no member to remove', () => {
    // The state a failed pairing leaves: a channel, and no replica id. This is
    // the only action such a row has.
    const onForget = vi.fn()
    render({ view: view({ peerReplicaId: null }), canRemoveFromGroup: false, onForget })
    buttonLabelled(/^Forget$/).click()

    expect(onForget).toHaveBeenCalledTimes(1)
  })

  it('still offers Forget beside a member that can be properly evicted', () => {
    render({
      view: view({ status: 'paired', peerReplicaId: '77' }),
      canRemoveFromGroup: true,
    })

    expect(text()).toContain('Remove from group')
    expect(text()).toContain('Forget')
  })

  it('says Forget is local, so it is not mistaken for a teardown', () => {
    render({ onForget: () => {} })
    expect(buttonLabelled(/^Forget$/).title).toMatch(/without telling them/i)
  })
})

/**
 * A peer in the same group that this device holds no channel with.
 *
 * Two destinations of one source are group members and never pair with each
 * other. Such a row was first given no-op handlers, which left every action on
 * screen doing nothing and the row reporting itself "Verified" and "Confirmed
 * on this device" — asserting a comparison that never happened.
 */
describe('a member known only through the group', () => {
  const member = { viaGroupOnly: true, view: view({ status: 'paired' }) }

  it('claims no verification, because there was no comparison to make', () => {
    render(member)

    expect(text()).not.toMatch(/Verified/)
    expect(text()).not.toMatch(/Confirmed on this device/)
  })

  it('says how it is known instead of leaving the row unexplained', () => {
    render(member)
    expect(text()).toMatch(/no channel of its own/i)
  })

  it('offers no fingerprint — there is no pairing to compare', () => {
    render(member)
    expect(text()).not.toMatch(/fingerprint/i)
  })

  it('offers no Forget — there is no local record to drop', () => {
    render(member)
    expect(text()).not.toMatch(/Forget/)
  })

  it('offers no "Sync now" — a round has no channel to travel over', () => {
    // `direction: replica_source` would otherwise enable it: the member's role
    // in the roster is Destination, so this device reads as the source of it.
    render({ ...member, view: view({ status: 'paired', direction: 'replica_source' }) })
    expect(text()).not.toMatch(/Sync now/)
  })

  it('promises no mirror, which would contradict having nothing to sync', () => {
    render(member)
    expect(text()).not.toMatch(/next protect round/i)
  })

  it('still offers eviction, which names the member rather than a channel', () => {
    const onRemoveFromGroup = vi.fn()
    render({ ...member, canRemoveFromGroup: true, onRemoveFromGroup })
    buttonLabelled(/Remove from group/).click()

    expect(onRemoveFromGroup).toHaveBeenCalledTimes(1)
  })

  it('leaves an ordinary channel row untouched', () => {
    // The flag is opt-in: every existing caller is a real channel.
    render({ view: view({ status: 'paired' }) })

    expect(text()).toMatch(/Verified/)
    expect(text()).toMatch(/Forget/)
  })
})

describe('what the row says after the fixes for stale wording', () => {
  it('shows a destination that missed a version as Behind, not current', () => {
    render({
      view: view({ status: 'paired', lastSync: { version: 2, syncedAt: Date.now() } }),
      vaultVersion: 3,
    })
    expect(text()).toContain('Behind')
    expect(text()).toContain('last mirrored v2')
    expect(text()).toContain('this vault is at v3')
  })

  it('reads current when the acknowledgement matches the vault version', () => {
    render({
      view: view({ status: 'paired', lastSync: { version: 3, syncedAt: Date.now() } }),
      vaultVersion: 3,
    })
    expect(text()).toContain('Verified')
    expect(text()).toContain('Mirrored v3')
    expect(text()).not.toContain('Behind')
  })

  it('records a refused comparison on the row rather than an unanswered prompt', () => {
    render({ view: view({ refused: true }) })
    expect(text()).toContain('Codes didn’t match')
    expect(text()).toContain('You reported that the codes did not match')
    expect(text()).not.toContain('Not confirmed yet')
  })

  it('stops calling an adopted vault an offer', () => {
    render({
      peerRole: 'replica_source',
      view: view({ status: 'paired', direction: 'replica_destination' }),
      holdsPeerVault: true,
      vaultVersion: 4,
    })
    expect(text()).toContain('This vault is Laptop’s, at v4')
    expect(text()).not.toContain('is offered')
  })
})
