// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CleanupContext } from '../vault/types'
import { CleanupModal } from './CleanupModal'

const context: CleanupContext = {
  usage: [4, 3, 2, 1].map(version => ({ version, copies: 2, bytes: 1500 })),
  floor: { latest: 4, open: [] },
  criterion: { kind: 'lastN', n: 2 },
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

function render(ctx: CleanupContext, onCleanup = vi.fn<(v: readonly number[]) => Promise<number[]>>(async v => [...v])) {
  act(() => root.render(<CleanupModal context={ctx} onCleanup={onCleanup} onClose={() => {}} />))
  return onCleanup
}

const box = (version: number) => host.querySelector<HTMLInputElement>(`#cu-${version}`)

function deleteButton(): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.startsWith('Delete'))
  if (!button) throw new Error('no delete button')
  return button
}

describe('CleanupModal', () => {
  it('pre-selects what the vault\'s criterion would delete, and locks the latest version', () => {
    render(context)

    expect(box(2)?.checked).toBe(true)
    expect(box(1)?.checked).toBe(true)
    expect(box(3)?.checked).toBe(false)
    expect(box(4)?.disabled).toBe(true)
    expect(host.textContent).toContain('always kept')
  })

  it('deletes what the owner leaves checked', async () => {
    const onCleanup = render(context)

    act(() => box(1)?.click())
    await act(async () => deleteButton().click())

    expect(onCleanup).toHaveBeenCalledWith([2])
    expect(host.textContent).toContain('Deleted the verification copies of v2')
  })

  it('says there is nothing to clean up before any version committed', () => {
    render({ usage: [], floor: null, criterion: { kind: 'retention', keep: null } })

    expect(host.textContent).toContain('Nothing to clean up')
  })
})
