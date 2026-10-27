// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BagVersion, SecretBag } from '../types'
import type { CleanupContext } from '../vault/types'
import { VerificationCopiesPanel } from './VerificationCopiesPanel'

const context: CleanupContext = {
  usage: [4, 3, 2, 1].map(version => ({ version, copies: 2, bytes: 1500 })),
  floor: { latest: 4, open: [] },
  criterion: { kind: 'lastN', n: 2 },
  helperKeep: [3],
  helperChannels: 3,
}

function bagVersion(version: number): BagVersion {
  return {
    version,
    participantIds: ['h1', 'h2'],
    verifiedParticipantIds: ['h1'],
    failedParticipantIds: [],
    secrets: [],
    rawBytes: '',
    helpers: [],
  }
}

// v1 is not in the history: removed from the Secrets tab, or never recorded here.
const bag: SecretBag = { secretId: '42', threshold: 2, currentVersion: bagVersion(4), previousVersions: [bagVersion(3), bagVersion(2)] }

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

function render(ctx: CleanupContext, onDelete = vi.fn<(v: readonly number[]) => Promise<number[]>>(async v => [...v])) {
  act(() =>
    root.render(
      <VerificationCopiesPanel
        context={ctx}
        bag={bag}
        autoCleanup={{ mode: 'manual' }}
        onDelete={onDelete}
        onOpenSettings={() => {}}
      />,
    ),
  )
  return onDelete
}

const box = (version: number) => host.querySelector<HTMLInputElement>(`[aria-label="Select v${version}"]`)
const rowOf = (version: number) => box(version)!.closest('tr')!

function button(text: string | RegExp): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find(b =>
    typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? ''),
  )
  if (!found) throw new Error(`no button ${text}`)
  return found
}

describe('VerificationCopiesPanel', () => {
  it('lists the latest version first and locks it', () => {
    render(context)

    const versions = Array.from(host.querySelectorAll('tbody tr')).map(r => r.querySelector('.version-tag')?.textContent)
    expect(versions).toEqual(['v4', 'v3', 'v2', 'v1'])
    expect(box(4)?.disabled).toBe(true)
    expect(rowOf(4).textContent).toContain('latest')
    expect(host.querySelector('[aria-label="Delete the verification copies of v4"]')).toBeNull()
  })

  it('shows whether each version is in the history and whether helpers still keep it', () => {
    render(context)

    expect(rowOf(3).cells[2].textContent).toBe('Yes')
    expect(rowOf(1).cells[2].textContent).toBe('No')
    expect(rowOf(3).cells[3].textContent).toBe('2 of 3 helpers')
    expect(rowOf(3).cells[5].textContent).toBe('Yes')
    expect(rowOf(2).cells[5].textContent).toBe('No')
    expect(rowOf(3).cells[6].textContent).toBe('1/2')
  })

  it('selects by the vault\'s rule, and deletes the selection after confirming', async () => {
    const onDelete = render(context)

    act(() => button('Select by rule').click())
    expect(box(2)?.checked).toBe(true)
    expect(box(1)?.checked).toBe(true)
    expect(box(3)?.checked).toBe(false)

    act(() => box(1)?.click())
    act(() => button(/^Delete selected/).click())
    await act(async () => button('Delete copies').click())

    expect(onDelete).toHaveBeenCalledWith([2])
    expect(host.textContent).toContain('Deleted the verification copies of v2')
  })

  it('deletes one version from its row', async () => {
    const onDelete = render(context)

    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Delete the verification copies of v3"]')?.click())
    await act(async () => button('Delete copies').click())

    expect(onDelete).toHaveBeenCalledWith([3])
  })

  it('says there is nothing here before any version committed', () => {
    render({ usage: [], floor: null, criterion: { kind: 'retention', keep: null }, helperKeep: null, helperChannels: 0 })

    expect(host.textContent).toContain('No verification copies on this device yet')
  })
})
