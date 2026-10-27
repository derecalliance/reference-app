// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { VaultNotification } from '../types'
import { NotificationsPanel } from './NotificationsPanel'

const notifications: VaultNotification[] = [
  { id: 'c', at: 3, severity: 'critical', title: 'Automatic verification of v2 failed', detail: 'Helper 1 did not answer', read: false, link: 'secrets' },
  { id: 'b', at: 2, severity: 'info', title: 'Automatic verification of v2 started', read: false },
  { id: 'a', at: 1, severity: 'info', title: 'Automatic verification of v1 passed', read: true },
]

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

function render(onMarkRead = vi.fn(), onOpenLink = vi.fn()) {
  act(() => root.render(<NotificationsPanel notifications={notifications} onMarkRead={onMarkRead} onOpenLink={onOpenLink} />))
  return { onMarkRead, onOpenLink }
}

const rows = () => Array.from(host.querySelectorAll('tbody tr'))
function button(text: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === text)
  if (!found) throw new Error(`no button ${text}`)
  return found
}

describe('NotificationsPanel', () => {
  it('lists every notification, newest first, with the unread count', () => {
    render()

    expect(rows()).toHaveLength(3)
    expect(rows()[0].textContent).toContain('Critical')
    expect(rows()[0].textContent).toContain('Helper 1 did not answer')
    expect(host.textContent).toContain('2 unread, 1 critical')
  })

  it('filters to unread and to critical', () => {
    render()

    act(() => button('Unread').click())
    expect(rows()).toHaveLength(2)
    act(() => button('Critical').click())
    expect(rows()).toHaveLength(1)
  })

  it('marks one read, all read, and opens the linked tab marking it read', () => {
    const { onMarkRead, onOpenLink } = render()

    act(() => rows()[1].querySelector('button')!.click())
    expect(onMarkRead).toHaveBeenCalledWith(['b'])

    act(() => button('Mark all read').click())
    expect(onMarkRead).toHaveBeenCalledWith('all')

    act(() => button('Open Secrets').click())
    expect(onMarkRead).toHaveBeenCalledWith(['c'])
    expect(onOpenLink).toHaveBeenCalledWith('secrets')
  })
})
