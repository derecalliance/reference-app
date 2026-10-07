// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SenderKind } from '@derec-alliance/web'
import { ReplicasTab, type ReplicasTabProps } from './ReplicasTab'
import {
  applyPairingCompleted,
  type PairingCompletedEvent,
  type ReplicaChannel,
} from './ownerPairing'
import type { ReplicaView } from './replicaFlows'
import type { Vault } from './types'
// Read as text, not imported as modules: these assertions are about *where* a
// dialog is mounted, which is a fact about the source and not about any value
// the module exports. `OwnerPage` also cannot be imported into a test —
// it pulls in WASM.
import replicasTabSource from './ReplicasTab.tsx?raw'
import ownerPageSource from './OwnerPage.tsx?raw'
import pairingFoldSource from './vault/fold/pairing.ts?raw'

/** Every engine module's source, specs and fixtures excluded. */
const engineSource = Object.values(
  import.meta.glob<string>(['./vault/**/*.ts', '!./vault/**/*.test.ts', '!./vault/testVault.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
).join('\n')

/**
 * The Replicas tab, and the line it must not cross.
 *
 * The tab exists because a user needs somewhere to *look at* replicas. It failed
 * the first time because verification moved in with it: the fingerprint control
 * lived inside the panel, so a user who never opened the tab never verified —
 * and the panel was handed a protocol read from a ref during render, which React
 * never re-renders on, so the control was permanently disabled for everyone.
 *
 * So this file asserts two different kinds of thing:
 *
 * 1. that the tab lists every replica, in words, with its role; and
 * 2. that it owns no dialog — the fingerprint comparison, the pairing-request
 *    confirmation and the adoption offer are mounted by the page, outside the
 *    tab switch, and raise themselves whichever tab is selected.
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
  localStorage.clear()
})

function view(overrides: Partial<ReplicaView> = {}): ReplicaView {
  return {
    id: 'replica-channel:1234',
    name: 'Laptop',
    channelId: '1234',
    status: 'pending',
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

const BROWSER_REPLICA: ReplicaChannel = {
  id: 'peer-1234',
  name: 'Laptop',
  channelId: '1234',
  peerRole: 'replica_destination',
}

const HELPER_REPLICA: ReplicaChannel = {
  id: 'peer-5678',
  name: 'Hosted mirror',
  channelId: '5678',
  peerRole: 'replica_source',
}

const BASE: ReplicasTabProps = {
  channels: [BROWSER_REPLICA],
  viewByChannelId: new Map([['1234', view()]]),
  protocolTimeoutSecs: 300,
  syncingChannelId: null,
  catchingUpChannelIds: [],
  syncNoticeFor: () => null,
  onDismissSyncNotice: () => {},
  onOpenFingerprint: () => {},
  onSyncNow: () => {},
  onForget: () => {},
  onReplicaDiscovery: () => {},
  replicaDiscoveryRunning: false,
  vaultVersion: null,
  groupSourceReplicaId: null,
  onRemoveFromGroup: () => {},
  removingReplicaIds: new Set<string>(),
  onToggleOffline: () => {},
  memberRows: [],
  onRemoveMember: () => {},
}

function render(overrides: Partial<ReplicasTabProps> = {}): void {
  act(() => {
    root.render(<ReplicasTab {...BASE} {...overrides} />)
  })
}

function text(): string {
  return host.textContent ?? ''
}

describe('what the Replicas tab lists', () => {
  it('lists a replica channel with its role in words', () => {
    render()

    expect(text()).toContain('Laptop')
    // A colour cannot say "this one is not a helper".
    expect(text()).toContain('Replica destination')
  })

  it('lists both a browser-paired and a helper-backed replica, each with its own role', () => {
    render({
      channels: [BROWSER_REPLICA, HELPER_REPLICA],
      viewByChannelId: new Map([
        ['1234', view()],
        ['5678', view({ id: 'replica-channel:5678', name: 'Hosted mirror', channelId: '5678' })],
      ]),
    })

    expect(text()).toContain('Laptop')
    expect(text()).toContain('Hosted mirror')
    expect(text()).toContain('Replica destination')
    expect(text()).toContain('Replica source')
  })

  it('shows the status and the running deadline on an unconfirmed replica', () => {
    render({ viewByChannelId: new Map([['1234', view({ establishedAt: Date.now() - 120_000 })]]) })

    expect(text()).toContain('Pending confirmation')
    expect(text()).toMatch(/Confirm within 3:0\d/)
  })

  it('offers the source-side Sync now on a confirmed source channel', () => {
    render({
      viewByChannelId: new Map([['1234', view({ status: 'paired', peerConfirmation: 'protocol-verified' })]]),
    })

    const labels = Array.from(host.querySelectorAll('button')).map(b => b.textContent ?? '')
    expect(labels).toContain('Sync now')
  })

  it('shows a destination still fetching its copy as syncing, and says why', () => {
    render({
      viewByChannelId: new Map([
        ['1234', view({ status: 'paired', direction: 'replica_destination' })],
      ]),
      catchingUpChannelIds: ['1234'],
    })

    expect(text()).toContain('Syncing…')
    expect(text()).toContain('keeps asking until Laptop answers')
    expect(text()).not.toContain('Verified')
  })

  it('shows a confirmed destination as verified once its copy has landed', () => {
    render({
      viewByChannelId: new Map([
        ['1234', view({ status: 'paired', direction: 'replica_destination' })],
      ]),
    })

    expect(text()).toContain('Verified')
    expect(text()).not.toContain('Syncing…')
  })

  it('says so plainly when there are no replicas at all', () => {
    render({ channels: [], viewByChannelId: new Map() })

    expect(text()).toContain('No replicas yet')
  })

  it('reopens the fingerprint comparison from the row rather than owning it', () => {
    const onOpenFingerprint = vi.fn()
    render({ onOpenFingerprint })

    const button = Array.from(host.querySelectorAll('button')).find(b =>
      /Confirm fingerprint/.test(b.textContent ?? ''),
    )
    if (!button) throw new Error(`no reopen button — rendered: ${text()}`)
    act(() => button.click())

    // It asks the page to raise the modal; it does not render one.
    expect(onOpenFingerprint).toHaveBeenCalledWith('1234')
  })
})

// ── The modals are the page's, not the tab's ─────────────────────────────────

const DIALOGS = [
  'ReplicaFingerprintDialog',
  'ReplicaAdoptionDialog',
  'ReplicaPairingRequestDialog',
] as const

describe('the replica modals are mounted by the page, not the tab', () => {
  it.each(DIALOGS)('the Replicas tab does not render %s', dialog => {
    // The original failure was verification living inside the panel, where a
    // user who never opened the tab never verified. Importing a dialog here is
    // the first move of that regression.
    expect(replicasTabSource).not.toContain(dialog)
  })

  it.each(DIALOGS)('%s is rendered outside the tab switch', dialog => {
    const page = ownerPageSource
    // `OwnerParticipantPanel` is the last child of `owner-layout`; the tab
    // bar and `tab-panel` both precede it. Anything rendered after it is
    // therefore outside every `activeTab === …` branch.
    const tabRegionStart = page.indexOf('<div className="tab-panel"')
    const tabRegionEnd = page.indexOf('<OwnerParticipantPanel')
    expect(tabRegionStart).toBeGreaterThan(-1)
    expect(tabRegionEnd).toBeGreaterThan(tabRegionStart)

    const tabRegion = page.slice(tabRegionStart, tabRegionEnd)
    expect(tabRegion).not.toContain(`<${dialog}`)
    expect(page.indexOf(`<${dialog}`)).toBeGreaterThan(tabRegionEnd)
  })

  it('gates none of the page-level modals on the selected tab', () => {
    const page = ownerPageSource
    // Everything after the side panel is the page's modal region. Rendering a
    // dialog outside the tab switch is not enough on its own — a
    // `activeTab === 'replicas' &&` in its guard would hide it just as
    // effectively from a user sitting on another tab.
    const modalRegion = page.slice(page.indexOf('<OwnerParticipantPanel'))

    expect(modalRegion).toContain('<ReplicaFingerprintDialog')
    expect(modalRegion).not.toContain('activeTab')
  })

  it('raises the fingerprint modal from the pairing fold, with no tab involved', () => {
    // The fold moved out of the page and into the engine's pairing handlers, so
    // this reads their source. The invariant is unchanged — a replica channel
    // announces itself unconditionally — but it is enforced more strongly than
    // it was: the engine is React-free and has no `activeTab` to gate on.
    const start = pairingFoldSource.indexOf('onReplicaChannelEstablished:')
    expect(start).toBeGreaterThan(-1)
    const handler = pairingFoldSource.slice(start, pairingFoldSource.indexOf('},', start))

    expect(handler).toContain('ctx.effects.openFingerprint(channelId)')
    // No tab, no panel, no ref read: the announcement is unconditional.
    expect(handler).not.toContain('activeTab')
  })

  it('keeps the engine free of any notion of which tab is open', () => {
    // The structural guarantee behind the test above. If `activeTab` ever
    // reaches the engine, a fold could start gating protocol-driven state on
    // what the user happens to be looking at.
    // A glob that matched nothing would pass the check below vacuously.
    expect(engineSource).toContain('class VaultRuntime')
    expect(engineSource).not.toContain('activeTab')
  })
})

// ── …and they raise with a different tab open ────────────────────────────────

function replicaOwner(): Vault {
  return {
    id: 'owner-1',
    name: 'Alice',
    secretId: '42',
    transport: { protocol: 'https', uri: 'https://example.test/owner-1' },
    participants: [],
    secretBag: null,
    // Carries `participantId`, which keeps the fold off the backend lookup.
    pendingPairings: [{ channelId: 7n, participantId: 'device-2' }],
    minParticipants: 2,
    recommendedParticipants: 3,
    recoveredSecrets: [],
    recoveryProgress: null,
    recoveryFailures: [],
    heldShares: [],
    mainChannels: [],
    configOverrides: {},
  }
}

const REPLICA_COMPLETION = {
  type: 'PairingCompleted',
  channel_id: '1234',
  pairing_channel_id: '7',
  kind: SenderKind.ReplicaSource,
  peer_communication_info: { name: 'Second device' },
} as PairingCompletedEvent

/**
 * The page's shape, reduced to the part under test: tab state, a tab switch that
 * mounts exactly one panel, and a modal host that is a *sibling* of the switch
 * rather than a child of it. `applyPairingCompleted` is the real fold, and
 * `onReplicaChannelEstablished` is wired to it exactly as the page wires it.
 *
 * What this proves is the placement: with `secrets` selected — the Replicas tab
 * never mounted — a completed replica handshake still puts the comparison on
 * screen. Nested inside the switch it could not, which is what the mutation
 * below demonstrates.
 */
function PageShaped() {
  const [activeTab, setActiveTab] = useState<'secrets' | 'replicas'>('secrets')
  const [fingerprintChannelId, setFingerprintChannelId] = useState<string | null>(null)

  return (
    <div>
      <button onClick={() => setActiveTab('replicas')}>Replicas</button>
      <div className="tab-panel">
        {activeTab === 'secrets' && <p>Secrets list</p>}
        {activeTab === 'replicas' && <p>Replica channels</p>}
      </div>
      <button
        onClick={() =>
          applyPairingCompleted(replicaOwner(), REPLICA_COMPLETION, {
            log: () => {},
            getVault: replicaOwner,
            commit: () => {},
            onReplicaChannelEstablished: channelId => setFingerprintChannelId(channelId),
          })
        }
      >
        Complete handshake
      </button>
      {/* Page level: a sibling of the tab switch, gated on nothing but its own state. */}
      {fingerprintChannelId !== null && <p>Fingerprint comparison for {fingerprintChannelId}</p>}
    </div>
  )
}

describe('the fingerprint comparison with a different tab open', () => {
  it('raises on pairing completion while the Secrets tab is selected', () => {
    act(() => root.render(<PageShaped />))

    // The Replicas tab has never been opened.
    expect(text()).toContain('Secrets list')
    expect(text()).not.toContain('Replica channels')
    expect(text()).not.toContain('Fingerprint comparison')

    const complete = Array.from(host.querySelectorAll('button')).find(
      b => b.textContent === 'Complete handshake',
    )
    if (!complete) throw new Error('no handshake button')
    act(() => complete.click())

    expect(text()).toContain('Fingerprint comparison for 1234')
    // Still on the other tab: the modal came to the user, not the other way round.
    expect(text()).toContain('Secrets list')
    expect(text()).not.toContain('Replica channels')
  })
})

describe('group members the app cannot account for', () => {
  const orphan = {
    replicaId: '3534782649887640751',
    channelId: '2335620354810298024',
    role: 'Destination',
    status: 'Paired' as const,
    name: 'Bob',
  }

  /** The row shape the tab now receives for a member with no direct channel. */
  const memberRow = {
    replicaId: orphan.replicaId,
    name: 'Bob',
    channelId: orphan.channelId,
    peerRole: 'replica_destination' as const,
    view: {
      id: `replica-member:${orphan.replicaId}`,
      name: 'Bob',
      channelId: orphan.channelId,
      status: 'paired' as const,
      offline: false,
      peerConfirmation: 'none' as const,
      lastSync: null,
      establishedAt: null,
      firstSyncStarted: false,
      direction: 'replica_source' as const,
      peerReplicaId: orphan.replicaId,
      helperActorId: null,
      refused: false,
    },
  }

  it('renders a member with no direct channel as an ordinary row', () => {
    // Two destinations of one source are in the same group and never pair with
    // each other. Listing them under a separate "no channel" heading described
    // the app's bookkeeping; from the group's point of view they are members.
    render({ memberRows: [memberRow] })

    expect(text()).toContain('Bob')
    expect(text()).not.toContain('Group members with no channel')
  })

  it('offers eviction by replica id', () => {
    // The library's removal names a member rather than a channel, so this is
    // the one action that still works without a pairing.
    const onRemoveMember = vi.fn()
    render({ memberRows: [memberRow], onRemoveMember })

    const button = Array.from(host.querySelectorAll('button')).find(
      b => b.textContent === 'Remove from group',
    )
    button!.click()

    expect(onRemoveMember).toHaveBeenCalledWith(orphan.replicaId)
  })

  it('shows a member even when this device holds no replica channel at all', () => {
    // The state that stranded the reported session: every row forgotten, the
    // tab saying "no replicas yet", and the protocol still refusing to pair.
    render({ channels: [], memberRows: [memberRow] })

    expect(text()).toContain('Bob')
  })

  it('marks a removal in flight', () => {
    render({
      memberRows: [memberRow],
      removingReplicaIds: new Set([orphan.replicaId]),
    })
    expect(text()).toContain('Removing…')
  })
})

describe('a destination row whose vault this device already holds', () => {
  it('stops calling it an offer once the vault names that peer as its source', () => {
    render({
      channels: [{ ...HELPER_REPLICA }],
      viewByChannelId: new Map([
        [
          '5678',
          view({ channelId: '5678', status: 'paired', direction: 'replica_destination', peerReplicaId: '9' }),
        ],
      ]),
      vaultVersion: 3,
      groupSourceReplicaId: '9',
    })
    expect(host.textContent).toContain('at v3')
    expect(host.textContent).not.toContain('is offered')
  })
})
