// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublishContext } from '../secret/types'

import type { BagVersion, PairedParticipant, PublishedRound, ItemBag, Item } from '../types'
import { RemoveItemModal } from './RemoveItemModal'
import { ItemBagPanel } from './ItemBagPanel'

/** A publish dialog's starting point: threshold 2, every helper at 1, keep the newest committed version. */
const PUBLISH_CONTEXT: PublishContext = {
  policy: { defaultThreshold: 2, defaultWeights: {}, helperRetention: { mode: 'latestCommitted' }, proofCleanup: { mode: 'manual' } },
  committedVersions: [],
  openVersions: [],
  preview: { kept: null, dropped: [] },
}

const seed: Item = { id: 'aa', name: 'Seed', data: 'one two' }
const pin: Item = { id: 'bb', name: 'PIN', data: '1234' }

function bagVersion(version: number, items: Item[]): BagVersion {
  return {
    version,
    participantIds: [],
    verifiedParticipantIds: [],
    failedParticipantIds: [],
    items,
    rawBytes: '',
    helpers: [],
  }
}

const bag: ItemBag = {
  secretId: '42',
  threshold: 1,
  currentVersion: bagVersion(2, [seed, pin]),
  previousVersions: [bagVersion(1, [seed])],
}

const helper: PairedParticipant = {
  id: 'h1',
  name: 'Alex',
  channelId: '900',
  transport: { protocol: 'https', uri: 'http://localhost:5000/derec/h1' },
  secretShares: [],
  connectionStatus: 'paired',
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

function buttons(label: string): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`))
}

function buttonWithText(text: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === text)
  if (!found) throw new Error(`no "${text}" button — rendered: ${host.textContent}`)
  return found
}

function renderPanel(onRemoveItem: (s: Item) => void, publishDisabledReason: string | null = null) {
  act(() =>
    root.render(
      <ItemBagPanel
        bag={bag}
        participants={[helper, { ...helper, id: 'h2', name: 'Richard', channelId: '901' }]}
        pendingRounds={[]}
        onVerify={async () => ({ failedChannelIds: [] })}
        onAddItem={() => {}}
        onRemoveItem={onRemoveItem}
        publishDisabledReason={publishDisabledReason}
        onRepublish={() => {}}
        onRemoveVersion={async () => {}}
        defaultThreshold={2}
      />,
    ),
  )
}

describe('removing an item from the Items tab', () => {
  it('offers removal on each item of the current version and hands over the item', () => {
    const onRemove = vi.fn()
    renderPanel(onRemove)

    act(() => buttons('Remove PIN')[0].click())

    expect(onRemove).toHaveBeenCalledWith(pin)
  })

  it('does not offer removal on earlier versions, which are history', () => {
    renderPanel(vi.fn())
    act(() => buttonWithText('Show Previous Versions (1)').click())

    // "Seed" is in both versions; only the current one can remove it.
    expect(buttons('Remove Seed')).toHaveLength(1)
  })

  it('is disabled, saying why, while a new version cannot be published', () => {
    renderPanel(vi.fn(), 'Need at least 3 paired participants (currently 1)')

    const remove = buttons('Remove PIN')[0]
    expect(remove.disabled).toBe(true)
    expect(remove.title).toBe('Need at least 3 paired participants (currently 1)')
  })
})

describe('RemoveItemModal', () => {
  function renderModal(onRemoveItem: (id: string) => Promise<PublishedRound | null>) {
    act(() =>
      root.render(
        <RemoveItemModal
          item={pin}
          pendingChannelIds={new Set()}
          publishContext={PUBLISH_CONTEXT}
          participants={[helper, { ...helper, id: 'h2', name: 'Richard', channelId: '901' }]}
          onClose={() => {}}
          onRemoveItem={onRemoveItem}
        />,
      ),
    )
  }

  it('asks first, warning that earlier versions keep the item', () => {
    const onRemove = vi.fn(async () => ({ version: 3, recipientIds: [helper.id], threshold: 2 }))
    renderModal(onRemove)

    expect(host.textContent).toContain('Earlier versions still contain it')
    expect(onRemove).not.toHaveBeenCalled()
  })

  it('removes on confirmation and follows the round it started', async () => {
    const onRemove = vi.fn(async () => ({ version: 3, recipientIds: [helper.id], threshold: 2 }))
    renderModal(onRemove)

    await act(async () => buttonWithText('Remove Item').click())

    // The owner's publish choice travels with the removal: the default kept version.
    expect(onRemove).toHaveBeenCalledWith('bb', { keep: null })
    expect(host.textContent).toContain('0 of 1 confirmed')
  })

  it('says so when no round was dispatched', async () => {
    renderModal(async () => null)

    await act(async () => buttonWithText('Remove Item').click())

    expect(host.textContent).toContain('The round was not dispatched')
  })
})
