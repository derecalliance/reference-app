// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { VaultEntry } from './vault/manager'
import { VaultList, type VaultListProps } from './VaultList'

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

function entry(overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    id: 'v1',
    name: 'Crypto Seeds',
    state: 'running',
    failure: null,
    pairedCount: 2,
    bagVersion: 3,
    replicaCount: 1,
    attention: 0,
    ...overrides,
  }
}

function render(overrides: Partial<VaultListProps> = {}) {
  const props: VaultListProps = {
    entries: [entry()],
    notice: null,
    onNew: vi.fn(),
    onOpen: vi.fn(),
    onClaim: vi.fn(),
    onRetry: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  }
  act(() => root.render(<VaultList {...props} />))
  return props
}

function button(name: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === name)
  if (!found) throw new Error(`no "${name}" button — rendered: ${host.textContent}`)
  return found
}

describe('VaultList', () => {
  it('greets a browser with no vaults and offers to set one up', () => {
    // e2e `openApp` waits for this heading on a fresh context.
    const props = render({ entries: [] })

    expect(host.querySelector('h2')?.textContent).toBe('Get started')
    act(() => button('Set up a new vault').click())
    expect(props.onNew).toHaveBeenCalledWith('setup')
  })

  it('offers the claim flow as well', () => {
    const props = render({ entries: [] })

    act(() => button('Claim an existing actor').click())

    expect(props.onNew).toHaveBeenCalledWith('claim')
  })

  it('lists vaults with their counts under a different heading', () => {
    render()

    expect(host.querySelector('h2')?.textContent).toBe('Your vaults')
    expect(host.textContent).toContain('Crypto Seeds')
    expect(host.textContent).toContain('Running')
    expect(host.textContent).toContain('v3')
  })

  it.each([
    ['running', 'Running', 'Open'],
    ['stopped', 'Stopped', 'Open'],
    ['blocked', 'Blocked', 'Open'],
    ['elsewhere', 'Open in another tab', 'Claim'],
    ['failed', 'Failed to start', 'Retry'],
  ] as const)('shows a %s vault in words, with its action', (state, words, action) => {
    const props = render({ entries: [entry({ state, failure: state === 'failed' ? 'no wasm' : null })] })

    expect(host.textContent).toContain(words)
    act(() => button(action).click())

    const handler = action === 'Open' ? props.onOpen : action === 'Claim' ? props.onClaim : props.onRetry
    expect(handler).toHaveBeenCalledWith('v1')
  })

  it.each(['failed', 'stopped'] as const)('offers to remove a %s vault, which no page can', state => {
    const props = render({ entries: [entry({ state })] })

    act(() => button('Remove').click())

    expect(props.onRemove).toHaveBeenCalledWith('v1')
  })

  it.each(['running', 'elsewhere', 'starting'] as const)('offers no removal from the row of a %s vault', state => {
    // Running: Leave on its page does it. Elsewhere: another tab is using its stores.
    render({ entries: [entry({ state })] })

    expect(Array.from(host.querySelectorAll('button')).map(b => b.textContent)).not.toContain('Remove')
  })

  it('says why a vault failed to start', () => {
    render({ entries: [entry({ state: 'failed', failure: 'no wasm' })] })

    expect(host.textContent).toContain('no wasm')
  })

  it('offers no action on a vault still starting', () => {
    render({ entries: [entry({ state: 'starting' })] })

    expect(host.textContent).toContain('Starting…')
    expect(Array.from(host.querySelectorAll('button')).map(b => b.textContent)).not.toContain('Open')
  })

  it('badges a vault that needs a decision, in words', () => {
    render({ entries: [entry({ attention: 2 })] })

    expect(host.textContent).toContain('2 need your decision')
  })

  it('shows no badge when nothing is waiting', () => {
    render()

    expect(host.textContent).not.toContain('need your decision')
    expect(host.textContent).not.toContain('needs your decision')
  })

  it('shows a notice when it has one', () => {
    render({ notice: 'That vault is not saved in this browser.' })

    expect(host.textContent).toContain('That vault is not saved in this browser.')
  })
})
