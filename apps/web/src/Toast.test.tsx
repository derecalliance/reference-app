// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { navigate } from './routing'
import { ToastProvider } from './Toast'
import { clearNotice, reportError, reportInfo, showNotice } from './toastBus'

vi.mock('./routing', () => ({ navigate: vi.fn() }))

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.spyOn(console, 'error').mockImplementation(() => {})
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<ToastProvider>{null}</ToastProvider>))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.mocked(navigate).mockClear()
})

function toastButton(name: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes(name))
  if (!found) throw new Error(`no button containing "${name}" — rendered: ${host.textContent}`)
  return found
}

describe('ToastProvider', () => {
  it('names the vault a banner came from', () => {
    act(() => reportInfo('Secret recovered', { vaultId: 'beta', vaultName: 'Beta' }))

    expect(host.textContent).toContain('Beta: Secret recovered')
  })

  it('opens the vault when its banner is clicked, and dismisses the banner', () => {
    act(() => reportInfo('Secret recovered', { vaultId: 'beta', vaultName: 'Beta' }))

    act(() => toastButton('Beta: Secret recovered').click())

    // A vault removed since the banner was raised is not special here: the
    // route resolves to the list with a notice, as any unknown id does.
    expect(navigate).toHaveBeenCalledWith({ kind: 'vault', id: 'beta' })
    expect(host.textContent).not.toContain('Secret recovered')
  })

  it('names the vault on an error, too', () => {
    act(() => reportError('Mailbox poll failed', 'offline', undefined, { vaultId: 'beta', vaultName: 'Beta' }))

    expect(host.textContent).toContain('Beta: Mailbox poll failed: offline')
  })

  it('leaves a toast with no origin as plain text that goes nowhere', () => {
    act(() => reportInfo('Copied'))

    expect(host.textContent).toContain('Copied')
    expect(Array.from(host.querySelectorAll('button')).map(b => b.textContent)).toEqual(['✕'])
  })

  it('keeps a standing notice up past the toasts until it is cleared, and shows it once', () => {
    vi.useFakeTimers()
    try {
      act(() => showNotice('node', 'error', 'Cannot reach the node'))
      act(() => showNotice('node', 'error', 'Cannot reach the node'))
      // More passing toasts than the stack holds do not push it out.
      act(() => {
        for (let i = 0; i < 6; i++) reportInfo(`event ${i}`)
      })
      act(() => vi.advanceTimersByTime(60_000))

      expect(host.textContent?.match(/Cannot reach the node/g)).toHaveLength(1)

      act(() => clearNotice('node'))
      expect(host.textContent).not.toContain('Cannot reach the node')
    } finally {
      vi.useRealTimers()
    }
  })
})
