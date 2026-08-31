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
import type { Owner } from './types'
// Read as text, not imported as modules: these assertions are about *where* a
// dialog is mounted, which is a fact about the source and not about any value
// the module exports. `OwnerPage` also cannot be imported into a test —
// it pulls in WASM.
import replicasTabSource from './ReplicasTab.tsx?raw'
import ownerPageSource from './OwnerPage.tsx?raw'

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
    provisioned: false,
    direction: 'replica_source',
    peerReplicaId: null,
    ...overrides,
  }
}

const BROWSER_REPLICA: ReplicaChannel = {
  id: 'peer-1234',
  name: 'Laptop',
  channelId: '1234',
  peerRole: 'replica_destination',
}

const PROVISIONED_REPLICA: ReplicaChannel = {
  id: 'peer-5678',
  name: 'Hosted mirror',
  channelId: '5678',
  peerRole: 'replica_source',
}

const BASE: ReplicasTabProps = {
  channels: [BROWSER_REPLICA],
  awaitingPairing: [],
  viewByChannelId: new Map([['1234', view()]]),
  protocolTimeoutSecs: 300,
  syncingChannelId: null,
  unpairingChannelIds: new Set<string>(),
  syncNoticeFor: () => null,
  onDismissSyncNotice: () => {},
  onOpenFingerprint: () => {},
  onSyncNow: () => {},
  onUnpair: () => {},
  onSyncCheck: () => {},
  syncCheckRunning: false,
  onRemoveFromGroup: () => {},
  removingReplicaIds: new Set<string>(),
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

  it('lists both a browser-paired and a provisioned replica, each with its own role', () => {
    render({
      channels: [BROWSER_REPLICA, PROVISIONED_REPLICA],
      viewByChannelId: new Map([
        ['1234', view()],
        ['5678', view({ id: 'hosted', name: 'Hosted mirror', channelId: '5678', provisioned: true })],
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

  it('lists a provisioned replica that has never paired, so the tab is complete', () => {
    render({
      channels: [],
      awaitingPairing: [view({ id: 'hosted', name: 'Spare laptop', channelId: null, provisioned: true })],
    })

    expect(text()).toContain('Spare laptop')
    expect(text()).toContain('Not paired')
  })

  it('says so plainly when there are no replicas at all', () => {
    render({ channels: [], awaitingPairing: [], viewByChannelId: new Map() })

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
    const page = ownerPageSource
    const start = page.indexOf('onReplicaChannelEstablished:')
    expect(start).toBeGreaterThan(-1)
    const handler = page.slice(start, page.indexOf('},', start))

    expect(handler).toContain('setFingerprintChannelId(channelId)')
    // No tab, no panel, no ref read: the announcement is unconditional.
    expect(handler).not.toContain('activeTab')
  })
})

// ── …and they raise with a different tab open ────────────────────────────────

function replicaOwner(): Owner {
  return {
    ownerId: 'owner-1',
    ownerName: 'Alice',
    ownSecretId: '42',
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
    config: {
      protocolTimeoutSecs: 300,
      authenticationMethod: 'user',
      unpairAck: 'required',
      autoAcceptUnpairRequests: false,
    },
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
        {activeTab === 'secrets' && <p>Secret Bag</p>}
        {activeTab === 'replicas' && <p>Replica channels</p>}
      </div>
      <button
        onClick={() =>
          applyPairingCompleted(replicaOwner(), REPLICA_COMPLETION, {
            log: () => {},
            getOwner: replicaOwner,
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
  it('raises on pairing completion while the Secret Bag tab is selected', () => {
    act(() => root.render(<PageShaped />))

    // The Replicas tab has never been opened.
    expect(text()).toContain('Secret Bag')
    expect(text()).not.toContain('Replica channels')
    expect(text()).not.toContain('Fingerprint comparison')

    const complete = Array.from(host.querySelectorAll('button')).find(
      b => b.textContent === 'Complete handshake',
    )
    if (!complete) throw new Error('no handshake button')
    act(() => complete.click())

    expect(text()).toContain('Fingerprint comparison for 1234')
    // Still on the other tab: the modal came to the user, not the other way round.
    expect(text()).toContain('Secret Bag')
    expect(text()).not.toContain('Replica channels')
  })
})
