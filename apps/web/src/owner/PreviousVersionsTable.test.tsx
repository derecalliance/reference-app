// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BagVersion, PairedParticipant, PendingProtectRound } from '../types'
import { PreviousVersionsTable } from './PreviousVersionsTable'

function bagVersion(version: number, overrides: Partial<BagVersion> = {}): BagVersion {
  return {
    version,
    participantIds: ['h1', 'h2'],
    verifiedParticipantIds: [],
    failedParticipantIds: [],
    secrets: [
      { id: 'aa', name: 'Seed', data: 'one two' },
      { id: 'bb', name: 'PIN', data: '1234' },
    ],
    rawBytes: '',
    helpers: [],
    threshold: 2,
    ...overrides,
  }
}

function participant(n: number): PairedParticipant {
  return {
    id: `h${n}`,
    name: `Helper ${n}`,
    channelId: `90${n}`,
    transport: { protocol: 'https', uri: `http://localhost:5000/derec/h${n}` },
    secretShares: [],
    connectionStatus: 'paired',
  }
}

const participants = [participant(1), participant(2)]

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

function render(
  versions: BagVersion[],
  onVerify: (version: number) => void = () => {},
  pendingRounds: PendingProtectRound[] = [],
  onRemove: (version: number) => Promise<void> = async () => {},
) {
  act(() =>
    root.render(
      <PreviousVersionsTable
        versions={versions}
        participants={participants}
        pendingRounds={pendingRounds}
        onVerify={onVerify}
        onRemove={onRemove}
      />,
    ),
  )
}

function rows(): HTMLTableRowElement[] {
  return Array.from(host.querySelectorAll('tbody tr'))
}

function cells(row: HTMLTableRowElement): string[] {
  return Array.from(row.cells).map(c => c.textContent?.trim() ?? '')
}

describe('PreviousVersionsTable', () => {
  it('renders one row per version, in the order given, without secret values', () => {
    render([bagVersion(3), bagVersion(2)])

    expect(rows()).toHaveLength(2)
    const [version, secrets, threshold, helpers, recoverable] = cells(rows()[0])
    expect(version).toBe('v3')
    expect(secrets).toBe('2Seed, PIN')
    expect(threshold).toBe('2')
    expect(helpers).toBe('0/2 verified')
    expect(recoverable).toBe('—')
    expect(cells(rows()[1])[0]).toBe('v2')
    expect(host.textContent).not.toContain('one two')
  })

  it('summarises verification and failures, with the per-helper detail in the tooltip', () => {
    render([
      bagVersion(2, {
        participantIds: ['h1'],
        verifiedParticipantIds: ['h1'],
        verifiedSubshares: { h1: 2 },
        verifiedThreshold: 2,
        failedParticipantIds: [{ id: 'h2', status: 1, memo: '' }],
      }),
    ])

    const helpersCell = rows()[0].cells[3]
    expect(helpersCell.textContent).toBe('1/1 verified · 1 failed')
    expect(helpersCell.title).toContain('Helper 1: verified')
    expect(helpersCell.title).toContain('Helper 2:')
    expect(rows()[0].cells[4].textContent).toBe('Yes')
  })

  it('verifies the row’s own version', () => {
    const onVerify = vi.fn()
    render([bagVersion(3), bagVersion(2)], onVerify)

    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Verify Shares of v2"]')?.click())
    expect(onVerify).toHaveBeenCalledWith(2)
  })

  it('offers no Verify for a version no helper confirmed', () => {
    render([bagVersion(2, { participantIds: [] })])

    expect(host.querySelector('[aria-label="Verify Shares of v2"]')).toBeNull()
    expect(rows()[0].cells[3].textContent).toBe('None confirmed')
  })

  it('removes the row’s version after confirming', async () => {
    const onRemove = vi.fn(async () => {})
    render([bagVersion(3), bagVersion(2)], undefined, [], onRemove)

    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Remove v2"]')?.click())
    expect(document.body.textContent).toContain('helpers that keep v2 still hold their shares')
    const confirm = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Remove v2')
    await act(async () => confirm?.click())

    expect(onRemove).toHaveBeenCalledWith(2)
    expect(document.querySelector('[aria-label="Remove v2"][role="dialog"], .modal-overlay')).toBeNull()
  })

  it('opens the payload of the row’s version', () => {
    render([bagVersion(3), bagVersion(2)])

    act(() => host.querySelector<HTMLButtonElement>('[aria-label="View Payload of v2"]')?.click())
    expect(document.body.textContent).toContain('v2')
    expect(document.querySelector('#payload-modal-title')).not.toBeNull()
  })
})
