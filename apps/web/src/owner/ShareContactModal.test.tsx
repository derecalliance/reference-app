// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContactMessage } from '@derec-alliance/web'

import type { ContactModeKey } from '../contactModes'
import { ShareContactModal } from './ShareContactModal'

/**
 * Minting the contact the modal shows: once on open — even under StrictMode,
 * because each request creates a real pending channel — and again on every mode
 * change, applying only the result for the mode still selected.
 */

vi.mock('../ConsoleContext', () => ({
  useConsole: () => ({ log: () => {} }),
}))

vi.mock('./contact', () => ({
  serializeContact: (contact: ContactMessage) => `payload-${contact.channel_id.toString()}`,
}))

// The QR's payload is what identifies the contact on screen; rendering it as
// text keeps the assertions about which contact is shown.
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <span>{value}</span>,
}))

interface Deferred {
  mode: ContactModeKey
  resolve: (channelId: bigint) => void
  reject: (err: Error) => void
}

let host: HTMLDivElement
let root: Root
let requests: Deferred[]
let pairingCreated: bigint[]

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
  requests = []
  pairingCreated = []
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function text(): string {
  return host.textContent ?? ''
}

function createContact(mode: ContactModeKey): Promise<ContactMessage> {
  return new Promise((resolve, reject) => {
    requests.push({
      mode,
      // Only `channel_id` is read once `serializeContact` is stubbed.
      resolve: channelId => resolve({ channel_id: channelId } as unknown as ContactMessage),
      reject,
    })
  })
}

function render(): void {
  act(() =>
    root.render(
      <StrictMode>
        <ShareContactModal
          title="Share Contact"
          transport={{ protocol: 'https', uri: 'http://node/derec/owner' }}
          createContact={createContact}
          onClose={() => {}}
          onPairingCreated={channelId => pairingCreated.push(channelId)}
        />
      </StrictMode>,
    ),
  )
}

async function settle(request: Deferred, outcome: bigint | Error): Promise<void> {
  await act(async () => {
    if (outcome instanceof Error) request.reject(outcome)
    else request.resolve(outcome)
  })
}

function pickMode(mode: ContactModeKey): void {
  const input = host.querySelector<HTMLInputElement>(`#share-contact-mode-${mode}`)
  if (!input) throw new Error(`no ${mode} option — rendered: ${text()}`)
  act(() => input.click())
}

describe('ShareContactModal', () => {
  it('requests one contact on open, even under StrictMode, and shows it', async () => {
    render()
    expect(requests.map(r => r.mode)).toEqual(['inline_keys'])
    expect(text()).toContain('Generating contact message')

    await settle(requests[0], 7n)
    expect(text()).toContain('payload-7')
    expect(pairingCreated).toEqual([7n])
  })

  it('shows the error when minting fails', async () => {
    render()
    await settle(requests[0], new Error('peer unreachable'))
    expect(text()).toContain('peer unreachable')
  })

  it('re-mints on a mode change, keeping the layout while the new contact is generated', async () => {
    render()
    await settle(requests[0], 7n)

    pickMode('hashed_keys')
    expect(requests.map(r => r.mode)).toEqual(['inline_keys', 'hashed_keys'])
    expect(text()).toContain('Generating…')
    expect(text()).not.toContain('Generating contact message')

    await settle(requests[1], 8n)
    expect(text()).toContain('payload-8')
    expect(text()).not.toContain('Generating…')
  })

  it('drops a result superseded by a newer mode', async () => {
    render()
    await settle(requests[0], 7n)

    pickMode('hashed_keys')
    pickMode('no_keys')
    await settle(requests[1], 8n)
    expect(text()).not.toContain('payload-8')
    expect(text()).toContain('Generating…')

    await settle(requests[2], 9n)
    expect(text()).toContain('payload-9')
    expect(pairingCreated).toEqual([7n, 9n])
  })

  it('replaces a shown contact with the error when a re-mint fails', async () => {
    render()
    await settle(requests[0], 7n)

    pickMode('no_keys')
    await settle(requests[1], new Error('mint failed'))
    expect(text()).toContain('mint failed')
    expect(text()).not.toContain('payload-7')
  })
})
