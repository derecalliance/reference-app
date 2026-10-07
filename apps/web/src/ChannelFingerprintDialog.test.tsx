// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apiGetActorFingerprint } from './api'
import { ChannelFingerprintDialog } from './ChannelFingerprintDialog'

/**
 * Loading the codes when the dialog opens, and starting each opening from a
 * clean attempt — without a parent re-render wiping an attempt in flight.
 */

vi.mock('./api', async importOriginal => ({
  ...(await importOriginal<typeof import('./api')>()),
  apiGetActorFingerprint: vi.fn(),
  apiConfirmActorFingerprint: vi.fn(),
}))

const getPeerFingerprint = vi.mocked(apiGetActorFingerprint)

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
  getPeerFingerprint.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function text(): string {
  return document.body.textContent ?? ''
}

function button(match: RegExp): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find(b => match.test(b.textContent ?? ''))
  if (!found) throw new Error(`no button matching ${match} — rendered: ${text()}`)
  return found
}

interface RenderOptions {
  open?: boolean
  peerActorId?: string | null
  getFingerprint?: (channelId: bigint) => Promise<string>
  verifyFingerprint?: (channelId: bigint, fingerprint: string) => Promise<boolean>
}

async function render({
  open = true,
  peerActorId = null,
  getFingerprint = async () => '1111 2222',
  verifyFingerprint = async () => true,
}: RenderOptions = {}): Promise<void> {
  await act(async () => {
    root.render(
      <ChannelFingerprintDialog
        open={open}
        peerName="Bob"
        channelId="99"
        peerActorId={peerActorId}
        // Fresh arrows on every render, as the page passes them.
        getFingerprint={channelId => getFingerprint(channelId)}
        verifyFingerprint={(channelId, code) => verifyFingerprint(channelId, code)}
        onConfirmed={() => {}}
        onClose={() => {}}
      />,
    )
  })
}

describe('ChannelFingerprintDialog', () => {
  it('derives this device’s code and reads the fixture peer’s when opened', async () => {
    const getFingerprint = vi.fn(async () => '1111 2222')
    getPeerFingerprint.mockResolvedValue('1111 2222')

    await render({ peerActorId: 'helper-1', getFingerprint })

    expect(getFingerprint).toHaveBeenCalledWith(99n)
    expect(getPeerFingerprint).toHaveBeenCalledWith('helper-1', '99')
    expect(document.querySelector('[aria-label="This device\'s code: 1111 2222"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="Bob\'s code: 1111 2222"]')).not.toBeNull()
    expect(text()).not.toContain('Deriving fingerprint')
  })

  it('keeps this device’s code on screen when only the peer’s read fails, and retries', async () => {
    getPeerFingerprint.mockRejectedValueOnce(new Error('fixture offline'))

    await render({ peerActorId: 'helper-1' })

    expect(text()).toContain('fixture offline')
    expect(document.querySelector('[aria-label="This device\'s code: 1111 2222"]')).not.toBeNull()

    getPeerFingerprint.mockResolvedValueOnce('1111 2222')
    await act(async () => button(/Retry/).click())

    expect(text()).not.toContain('fixture offline')
    expect(document.querySelector('[aria-label="Bob\'s code: 1111 2222"]')).not.toBeNull()
  })

  it('starts a reopened dialog from a clean attempt and a fresh code', async () => {
    const getFingerprint = vi.fn(async () => '1111 2222')
    await render({ getFingerprint })
    act(() => button(/Doesn’t match/).click())
    expect(text()).toContain('The channel has been left')

    await render({ open: false, getFingerprint })
    await render({ getFingerprint })

    expect(text()).not.toContain('The channel has been left')
    expect(button(/Codes match/).disabled).toBe(false)
    expect(getFingerprint).toHaveBeenCalledTimes(2)
  })

  it('does not reset an attempt in flight when the parent re-renders', async () => {
    const verifyFingerprint = vi.fn(() => new Promise<boolean>(() => {}))
    await render({ verifyFingerprint })

    await act(async () => button(/Codes match/).click())
    expect(text()).toContain('Confirming…')

    await render({ verifyFingerprint })

    expect(text()).toContain('Confirming…')
  })
})
