// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PairingRoleOption } from '../pairingRoleOptions'
import { PairInitiatorModal } from './PairInitiatorModal'

/**
 * How a sent pairing request settles. The outcome is derived from the props the
 * page passes down — the paired-channel set, the completion signal and the
 * rejection count — measured against what they were when the request went out.
 */

vi.mock('../ConsoleContext', () => ({
  useConsole: () => ({ log: () => {} }),
}))

vi.mock('./contact', () => ({
  deserializeContact: () => ({}),
}))

vi.mock('@derec-alliance/web', async importOriginal => ({
  ...(await importOriginal<typeof import('@derec-alliance/web')>()),
  advertisedEndpoints: () => [],
}))

const CHANNEL_ID = 42n
const ROLE_OPTIONS: readonly PairingRoleOption<'owner'>[] = [
  { role: 'owner', label: 'Owner', hint: '' },
]

interface Signals {
  paired?: string[]
  rejections?: number
  completions?: number
}

let host: HTMLDivElement
let root: Root

function stubMatchMedia(): void {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
}

beforeEach(() => {
  stubMatchMedia()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function text(): string {
  return host.textContent ?? ''
}

function render({ paired = [], rejections = 0, completions = 0 }: Signals = {}): void {
  act(() =>
    root.render(
      <PairInitiatorModal
        label="Contact"
        placeholder="Paste"
        pairedChannelIds={new Set(paired)}
        pairingRejectionCount={rejections}
        pairingCompletedSignal={completions}
        onClose={() => {}}
        onSuccess={() => {}}
        onPairingRequestSent={() => {}}
        startPairing={async () => CHANNEL_ID}
        roleOptions={ROLE_OPTIONS}
        fixedRole="owner"
      />,
    ),
  )
}

/** Sends the request with the page's signals at `signals`, leaving it waiting. */
async function sendRequest(signals: Signals = {}): Promise<void> {
  render(signals)
  const form = host.querySelector('form')
  if (!form) throw new Error(`no form — rendered: ${text()}`)
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

describe('PairInitiatorModal waiting on the peer', () => {
  it('waits until something happens after the request', async () => {
    await sendRequest()
    expect(text()).toContain('Waiting for the peer to respond')
  })

  it('succeeds once the channel shows up as paired', async () => {
    await sendRequest()
    render({ paired: [CHANNEL_ID.toString()] })
    expect(text()).toContain('Pairing Complete')
  })

  it('succeeds on the completion signal when the long-term channel id differs', async () => {
    await sendRequest({ completions: 3 })
    render({ completions: 4 })
    expect(text()).toContain('Pairing Complete')
  })

  it('fails when the peer rejects', async () => {
    await sendRequest({ rejections: 1 })
    render({ rejections: 2 })
    expect(text()).toContain('Pairing Failed')
    expect(text()).toContain('The peer rejected the pairing request.')
  })

  it('reports a rejection that lands together with a completion as a failure', async () => {
    await sendRequest()
    render({ rejections: 1, completions: 1 })
    expect(text()).toContain('The peer rejected the pairing request.')
  })

  it('ignores signals counted before the request went out', async () => {
    await sendRequest({ rejections: 5, completions: 7 })
    render({ rejections: 5, completions: 7 })
    expect(text()).toContain('Waiting for the peer to respond')
  })

  it('keeps a success once reached, even if the channel later leaves the paired set', async () => {
    await sendRequest()
    render({ paired: [CHANNEL_ID.toString()] })
    render({ paired: [] })
    expect(text()).toContain('Pairing Complete')
  })
})
