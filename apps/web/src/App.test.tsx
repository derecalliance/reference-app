// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { VaultEntry } from './vault/manager'

// `OwnerPage` pulls in WASM; the page itself is not what these tests are about.
vi.mock('./OwnerPage', () => ({ default: () => <div>owner page</div> }))

const entries: VaultEntry[] = []
const fakeManager = {
  runtime: vi.fn((id: string) => (entries.some(e => e.id === id && e.state === 'running') ? {} : null)),
  isBooted: () => true,
  release: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  open: vi.fn(async () => true),
  retry: vi.fn(async () => {}),
  create: vi.fn(async () => true),
  setOnScreen: vi.fn(),
}
vi.mock('./vault/managerContext', () => ({
  VaultManagerProvider: ({ children }: { children: unknown }) => children,
  useVaultManager: () => fakeManager,
  useVaultEntries: () => entries,
}))

// jsdom has no `matchMedia`; MUI's `useMediaQuery` in the shell needs one.
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList

const { default: App } = await import('./App')

let host: HTMLDivElement
let root: Root

function entry(overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    id: 'v1',
    name: 'Crypto Seeds',
    state: 'running',
    failure: null,
    pairedCount: 0,
    bagVersion: null,
    replicaCount: 0,
    attention: 0,
    ...overrides,
  }
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  entries.splice(0, entries.length, entry())
  vi.clearAllMocks()
  window.location.hash = '#/vault/v1'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<App />))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.location.hash = ''
})

function click(name: string): void {
  const found = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === name)
  if (!found) throw new Error(`no "${name}" button — rendered: ${host.textContent}`)
  act(() => found.click())
}

describe('leaving a vault', () => {
  it('shows the vault page on its route', () => {
    expect(host.textContent).toContain('owner page')
  })

  it('removes the on-screen vault once and returns to the list', async () => {
    click('Leave')
    await act(async () => click('Remove from browser'))

    expect(fakeManager.remove).toHaveBeenCalledTimes(1)
    expect(fakeManager.remove).toHaveBeenCalledWith('v1')
    expect(window.location.hash).toBe('#/')
  })

  it('stops the vault without removing it', async () => {
    click('Leave')
    await act(async () => click('Stop running here'))

    expect(fakeManager.release).toHaveBeenCalledWith('v1')
    expect(fakeManager.remove).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('#/')
  })

  it('goes back to the list without stopping anything', () => {
    // Every vault keeps running in the background; the list is just another screen.
    click('All vaults')

    expect(window.location.hash).toBe('#/')
    expect(fakeManager.release).not.toHaveBeenCalled()
  })
})

describe('the vault on screen', () => {
  it('is reported to the manager, so only the others raise banners', () => {
    expect(fakeManager.setOnScreen).toHaveBeenLastCalledWith('v1')
  })

  it('is none on the list', async () => {
    click('All vaults')
    // jsdom fires `hashchange` asynchronously.
    await act(() => new Promise(resolve => setTimeout(resolve, 0)))

    expect(fakeManager.setOnScreen).toHaveBeenLastCalledWith(null)
  })
})

describe('the indicator for other vaults', () => {
  function rerender(): void {
    act(() => root.render(<App />))
  }

  it('counts decisions waiting on other vaults, in words', () => {
    entries.push(entry({ id: 'v2', name: 'Beta', attention: 1 }))
    rerender()

    expect(host.textContent).toContain('1 other vault needs your decision')
  })

  it('counts vaults, not decisions, and ignores the one on screen', () => {
    entries[0] = entry({ attention: 3 })
    entries.push(entry({ id: 'v2', name: 'Beta', attention: 2 }), entry({ id: 'v3', name: 'Gamma', attention: 1 }))
    rerender()

    expect(host.textContent).toContain('2 other vaults need your decision')
  })

  it('is hidden when no other vault is waiting', () => {
    entries[0] = entry({ attention: 3 })
    entries.push(entry({ id: 'v2', name: 'Beta', attention: 0 }))
    rerender()

    expect(host.textContent).not.toContain('other vault')
  })

  it('leads to the list', () => {
    entries.push(entry({ id: 'v2', name: 'Beta', attention: 1 }))
    rerender()

    click('1 other vault needs your decision')

    expect(window.location.hash).toBe('#/')
  })
})

describe('removing a vault that is not running', () => {
  it('asks first, then removes it', async () => {
    entries[0] = entry({ state: 'failed', failure: 'no transport' })
    window.location.hash = '#/'
    await act(() => new Promise(resolve => setTimeout(resolve, 0)))

    click('Remove')
    expect(fakeManager.remove).not.toHaveBeenCalled()
    await act(async () => click('Remove from browser'))

    expect(fakeManager.remove).toHaveBeenCalledWith('v1')
  })

  it('can be removed from its own route, too', async () => {
    entries[0] = entry({ state: 'stopped' })
    act(() => root.render(<App />))

    click('Remove')
    await act(async () => click('Remove from browser'))

    expect(fakeManager.remove).toHaveBeenCalledWith('v1')
  })
})

describe('the vault switcher', () => {
  function switcher(): HTMLSelectElement {
    const found = host.querySelector<HTMLSelectElement>('select[aria-label="Go to vault"]')
    if (!found) throw new Error(`no vault switcher — rendered: ${host.textContent}`)
    return found
  }

  function pick(id: string): Promise<void> {
    const select = switcher()
    return act(async () => {
      select.value = id
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  async function rerenderOnList(): Promise<void> {
    window.location.hash = '#/'
    await act(() => new Promise(resolve => setTimeout(resolve, 0)))
  }

  it('shows the vault on screen as selected', () => {
    entries.push(entry({ id: 'v2', name: 'Beta' }))
    act(() => root.render(<App />))

    expect(switcher().value).toBe('v1')
  })

  it('opens a running vault straight away', async () => {
    entries.push(entry({ id: 'v2', name: 'Beta' }))
    act(() => root.render(<App />))

    await pick('v2')

    expect(fakeManager.open).toHaveBeenCalledWith('v2')
    expect(window.location.hash).toBe('#/vault/v2')
  })

  it('starts a stopped vault rather than showing its Open screen', async () => {
    entries.push(entry({ id: 'v2', name: 'Beta', state: 'stopped' }))
    await rerenderOnList()

    await pick('v2')

    expect(fakeManager.open).toHaveBeenCalledWith('v2')
    expect(window.location.hash).toBe('#/vault/v2')
  })

  it('leaves a vault open in another tab to its own screen, without claiming it', async () => {
    entries.push(entry({ id: 'v2', name: 'Beta', state: 'elsewhere' }))
    await rerenderOnList()

    await pick('v2')

    expect(fakeManager.open).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('#/vault/v2')
  })

  it('names states that are not running', async () => {
    entries.push(entry({ id: 'v2', name: 'Beta', state: 'stopped', attention: 2 }))
    await rerenderOnList()

    const labels = Array.from(switcher().options).map(o => o.textContent)
    expect(labels).toEqual(['Go to vault…', 'Crypto Seeds', 'Beta (stopped) · 2 waiting'])
  })
})
