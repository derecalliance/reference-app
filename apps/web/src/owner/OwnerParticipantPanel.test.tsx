// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PairedParticipant } from '../types'
import { OwnerParticipantPanel } from './OwnerParticipantPanel'

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

function participant(id: string, channelId: string): PairedParticipant {
  return {
    id,
    name: `Helper ${id}`,
    channelId,
    transport: { protocol: 'https', uri: `http://node/derec/${id}` },
    connectionStatus: 'paired',
    peerRole: 'helper',
    secretShares: [],
  }
}

function render(props: { unpairing?: string[]; removed?: string[] } = {}) {
  act(() =>
    root.render(
      <OwnerParticipantPanel
        participants={[participant('a', '1'), participant('b', '2')]}
        replicaSection={null}
        onTogglePair={() => {}}
        onPairingRequestSent={() => {}}
        listChannels={async () => []}
        linkChannels={async () => {}}
        onAddParticipant={async () => {}}
        getParticipantFunctions={() => ({
          createContact: vi.fn(),
          startPairing: vi.fn(),
        })}
        pairedChannelIds={new Set()}
        pairingRejectionCount={0}
        pairingCompletedSignal={0}
        unconfirmedChannelIds={new Set()}
        onConfirmFingerprint={() => {}}
        unpairingChannelIds={new Set(props.unpairing ?? [])}
        removedFromNodeIds={new Set(props.removed ?? [])}
      />,
    ),
  )
}

describe('OwnerParticipantPanel', () => {
  it('marks a helper the node no longer has, and does not count it as on this node', () => {
    render({ removed: ['b'] })

    expect(host.textContent).toContain('1 on this node')
    expect(host.textContent).toContain('Removed from node')
  })

  it('shows "Unpairing…" while an unpair is on the wire', () => {
    render({ unpairing: ['1'] })

    expect(host.textContent).toContain('Unpairing…')
    expect(host.textContent).toContain('2 on this node')
  })
})
