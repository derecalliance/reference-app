// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ColorSchemeModule = typeof import('./colorScheme')

/** A controllable `prefers-color-scheme: light` query; jsdom ships none. */
function stubSystemScheme(light: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const query = {
    matches: light,
    addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
  }
  window.matchMedia = (() => query) as unknown as typeof window.matchMedia
  return {
    change(nowLight: boolean) {
      query.matches = nowLight
      for (const listener of listeners) listener({ matches: nowLight } as MediaQueryListEvent)
    },
  }
}

/** The module holds the pick in module state, so each test loads it afresh. */
async function load(): Promise<ColorSchemeModule> {
  vi.resetModules()
  return import('./colorScheme')
}

let host: HTMLDivElement
let root: Root
let seen: string[]

/** Mount a probe that records the scheme `useColorScheme` reports. */
function mount({ useColorScheme }: ColorSchemeModule) {
  function Probe() {
    seen.push(useColorScheme())
    return null
  }
  act(() => root.render(createElement(Probe)))
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  delete document.documentElement.dataset.theme
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  seen = []
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('colorScheme', () => {
  it('follows the system until the viewer picks, and keeps following it', async () => {
    const system = stubSystemScheme(false)
    mount(await load())
    expect(seen.at(-1)).toBe('dark')

    act(() => system.change(true))
    expect(seen.at(-1)).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('stores a pick, applies it, and lets it win over the system', async () => {
    const system = stubSystemScheme(true)
    const scheme = await load()
    mount(scheme)

    act(() => scheme.setColorScheme('dark'))
    expect(seen.at(-1)).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('derec.theme')).toBe('dark')

    act(() => system.change(false))
    act(() => system.change(true))
    expect(seen.at(-1)).toBe('dark')
  })

  it('starts from a stored pick', async () => {
    stubSystemScheme(false)
    localStorage.setItem('derec.theme', 'light')
    mount(await load())
    expect(seen.at(-1)).toBe('light')
  })

  it('ignores a stored value that is not a scheme', async () => {
    stubSystemScheme(true)
    localStorage.setItem('derec.theme', 'sepia')
    mount(await load())
    expect(seen.at(-1)).toBe('light')
  })

  it('takes up a pick made in another tab', async () => {
    stubSystemScheme(false)
    mount(await load())

    localStorage.setItem('derec.theme', 'light')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'derec.theme', newValue: 'light' }))
    })
    expect(seen.at(-1)).toBe('light')
  })

  it('is dark where there is no media query at all', async () => {
    // @ts-expect-error -- jsdom's own state: no matchMedia.
    delete window.matchMedia
    mount(await load())
    expect(seen.at(-1)).toBe('dark')
  })
})
