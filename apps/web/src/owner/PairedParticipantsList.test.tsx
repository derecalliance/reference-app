// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('default weight per helper (SDK 0.0.9 weighted helpers)', () => {
  function renderWeights(h: PairedParticipant, defaultWeight: number, onSet = vi.fn<(c: string, w: number) => void>()) {
    const group: LinkGroup = { key: h.channelId, name: h.name, mainChannelId: h.channelId, channels: [h] }
    act(() =>
      root.render(
        <PairedParticipantsList
          groups={[group]}
          unpairingChannelIds={new Set()}
          onTogglePair={() => {}}
          onLink={() => {}}
          defaultWeights={{ weightFor: () => defaultWeight, max: 3, onSet }}
        />,
      ),
    )
    return onSet
  }

  function weightField(): HTMLInputElement {
    const el = host.querySelector<HTMLInputElement>('input[aria-label="Default weight for Bob"]')
    if (!el) throw new Error('no default weight field')
    return el
  }

  it('lets the owner set a helper\'s default weight', () => {
    const onSet = renderWeights(row({}), 1)
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set

    act(() => {
      setter?.call(weightField(), '2')
      weightField().dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(onSet).toHaveBeenCalledWith('42', 2)
  })

  it('can be cleared and retyped, and falls back to the default if left invalid (review M3)', () => {
    const onSet = renderWeights(row({}), 1)
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    const type = (value: string) =>
      act(() => {
        setter?.call(weightField(), value)
        weightField().dispatchEvent(new Event('input', { bubbles: true }))
      })

    type('')
    expect(weightField().value).toBe('')
    expect(onSet).not.toHaveBeenCalled()

    act(() => weightField().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(weightField().value).toBe('1')

    type('')
    type('3')
    expect(onSet).toHaveBeenCalledWith('42', 3)
  })

  it('shows the weight last published when it differs from the default', () => {
    renderWeights(row({ weight: 3 }), 2)

    expect(host.textContent).toContain('last published 3')
  })

  it('offers no default weight on a channel where this vault is the helper', () => {
    renderWeights(row({ peerRole: 'owner' }), 1)

    expect(host.querySelector('input[aria-label="Default weight for Bob"]')).toBeNull()
  })
})
