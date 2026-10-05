// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConsoleEntry } from './ConsoleContext'

const entries: ConsoleEntry[] = []
vi.mock('./ConsoleContext', () => ({
  useConsole: () => ({ entries, log: () => {}, clear: () => {} }),
}))
const clipboard = vi.hoisted(() => ({ copyText: vi.fn(async (text: string) => text.length > 0) }))
vi.mock('./clipboard', () => clipboard)
const toasts = vi.hoisted(() => ({ reportInfo: vi.fn(), reportError: vi.fn() }))
vi.mock('./toastBus', () => toasts)

const { default: ConsolePanel } = await import('./ConsolePanel')

const ALPHA = 'aaaaaaaa-0000-4000-8000-000000000001'
const GONE = 'bbbbbbbb-0000-4000-8000-000000000002'

function entry(step: string, vaultId?: string): ConsoleEntry {
  return {
    id: step,
    timestamp: new Date(0),
    role: vaultId ? 'owner' : 'server',
    flow: 'setup',
    step,
    description: step,
    vaultId,
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  entries.splice(0, entries.length, entry('one', ALPHA), entry('two', GONE), entry('three'))
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<ConsolePanel vaults={[{ id: ALPHA, name: 'Crypto Seeds' }]} />))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function filter(): HTMLSelectElement {
  return host.querySelector('select[aria-label="Show entries for"]') as HTMLSelectElement
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find(b => b.textContent === text)
  if (!found) throw new Error(`no "${text}" button — rendered: ${host.textContent}`)
  return found
}

describe('the console panel', () => {
  it('names vaults in the filter, falling back to the id for one no longer here', () => {
    const labels = Array.from(filter().options).map(o => o.textContent)

    // Entries are newest-first; vaults are listed by first appearance.
    expect(labels).toEqual(['All vaults', 'Vault bbbbbbbb…', 'Crypto Seeds', 'Node only'])
  })

  it('copies what the filter shows, and says so on the button', async () => {
    act(() => {
      filter().value = `vault:${ALPHA}`
      filter().dispatchEvent(new Event('change', { bubbles: true }))
    })

    await act(async () => button('Copy shown (1)').click())

    const copied = JSON.parse(clipboard.copyText.mock.calls[0][0]) as { step: string }[]
    expect(copied.map(e => e.step)).toEqual(['one'])
    expect(button('Download shown (1)')).toBeTruthy()
  })

  it('confirms a copy, and says so when the browser refuses one', async () => {
    await act(async () => button('Copy all').click())
    expect(toasts.reportInfo).toHaveBeenCalledWith('Copied 3 log entries as JSON')

    clipboard.copyText.mockResolvedValueOnce(false)
    await act(async () => button('Copy all').click())
    expect(toasts.reportError).toHaveBeenCalledWith(expect.stringContaining('Could not copy the log'))
  })
})
