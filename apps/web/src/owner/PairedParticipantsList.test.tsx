// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { PairedParticipant } from '../types'
import type { LinkGroup } from './linkGroups'
import { PairedParticipantsList } from './PairedParticipantsList'

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

function row(overrides: Partial<PairedParticipant>): PairedParticipant {
  return {
    id: 'p1',
    name: 'Bob',
    channelId: '42',
    transport: { protocol: 'https', uri: 'http://node/derec/p1' },
    secretShares: [],
    connectionStatus: 'paired',
    peerRole: 'helper',
    ...overrides,
  }
}

function render(h: PairedParticipant, committedVersions?: ReadonlySet<number>) {
  const group: LinkGroup = { key: h.channelId, name: h.name, mainChannelId: h.channelId, channels: [h] }
  act(() =>
    root.render(
      <PairedParticipantsList
        groups={[group]}
        unpairingChannelIds={new Set()}
        onTogglePair={() => {}}
        onLink={() => {}}
        committedVersions={committedVersions}
      />,
    ),
  )
}

function hasButton(name: string): boolean {
  return Array.from(host.querySelectorAll('button')).some(b => b.textContent?.trim() === name)
}

describe('PairedParticipantsList', () => {
  it('offers Unpair on a channel where this vault is the owner', () => {
    render(row({ peerRole: 'helper' }))
    expect(hasButton('Unpair')).toBe(true)
  })

  it('does not offer Unpair where the peer is the owner — only it can unpair', () => {
    render(row({ peerRole: 'owner' }))
    expect(hasButton('Unpair')).toBe(false)
    expect(host.textContent).toContain('Only the owner can unpair')
  })

  it('counts only the shares the helper holds for committed versions', () => {
    render(
      row({
        secretShares: [
          { version: 1, status: 'confirmed', verified: false },
          { version: 2, status: 'rejected', verified: false },
          { version: 3, status: 'confirmed', verified: false },
        ],
      }),
      new Set([1, 2]),
    )
    const shares = Array.from(host.querySelectorAll('.channel-prop')).find(el =>
      el.textContent?.startsWith('Shares'),
    )
    expect(shares?.querySelector('.channel-prop-value')?.textContent).toBe('1')
  })

  it('does not show a green dot for a peer whose last share went unanswered', () => {
    render(
      row({
        secretShares: [
          { version: 1, status: 'rejected', verified: false, failure: { status: 2, memo: 'timeout' } },
        ],
      }),
    )
    expect(host.querySelector('.participant-dot')?.className).toContain('available')
    expect(host.textContent).toContain('Last share: No answer')
  })
})
