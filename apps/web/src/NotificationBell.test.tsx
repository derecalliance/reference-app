// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NotificationBell } from './NotificationBell'
import type { VaultNotification } from './types'
import type { VaultEntry } from './vault/manager'

function note(id: string, severity: VaultNotification['severity'], read = false, at = 1): VaultNotification {
  return { id, at, severity, title: `Title ${id}`, read }
}

function entry(id: string, notifications: VaultNotification[]): VaultEntry {
  return {
    id,
    name: `Vault ${id}`,
    state: 'running',
    failure: null,
    pairedCount: 0,
    bagVersion: null,
    replicaCount: 0,
    attention: 0,
    notifications,
  }
}

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

function render(entries: VaultEntry[], onOpen = vi.fn()) {
  act(() => root.render(<NotificationBell entries={entries} onOpen={onOpen} currentVaultId="a" />))
  return onOpen
}

const bell = () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!

describe('NotificationBell', () => {
  it('counts unread across vaults and calls out critical ones', () => {
    render([entry('a', [note('1', 'critical'), note('2', 'info', true)]), entry('b', [note('3', 'info')])])

    expect(bell().getAttribute('aria-label')).toBe('Notifications — 2 unread, 1 critical')
    expect(host.textContent).toContain('2')
  })

  it('says nothing is unread when everything is read', () => {
    render([entry('a', [note('1', 'critical', true)])])

    expect(bell().getAttribute('aria-label')).toBe('Notifications')
  })

  it('lists the newest first and opens the picked one', () => {
    const onOpen = render([entry('a', [note('old', 'info', false, 1)]), entry('b', [note('new', 'critical', false, 2)])])

    act(() => bell().click())
    const items = Array.from(document.querySelectorAll('[role="menuitem"]'))
    expect(items[0].textContent).toContain('Title new')
    expect(items[0].textContent).toContain('Vault b')

    act(() => (items[0] as HTMLElement).click())
    expect(onOpen).toHaveBeenCalledWith('b', 'new')
  })

  it('opens the current vault’s tab from "View all"', () => {
    const onOpen = render([entry('a', [note('1', 'info')])])

    act(() => bell().click())
    const viewAll = Array.from(document.querySelectorAll('[role="menuitem"]')).find(i => i.textContent?.includes('View all'))
    act(() => (viewAll as HTMLElement).click())
    expect(onOpen).toHaveBeenCalledWith('a', null)
  })
})
