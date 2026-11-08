// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublishContext } from '../secret/types'

import type { PairedParticipant, PublishedRound } from '../types'
import { publishTargets } from '../ownerPairing'
import { AddItemModal } from './AddItemModal'
import { ProtectRoundProgress } from './ProtectRoundProgress'
import { roundProgress } from './roundProgress'

/** A publish dialog's starting point: threshold 2, every helper at 1, keep the newest committed version. */
const PUBLISH_CONTEXT: PublishContext = {
  policy: { defaultThreshold: 2, defaultWeights: {}, helperRetention: { mode: 'latestCommitted' }, proofCleanup: { mode: 'manual' } },
  committedVersions: [],
  openVersions: [],
  preview: { kept: null, dropped: [] },
}

function participant(id: string, status?: 'pending' | 'confirmed'): PairedParticipant {
  return {
    id,
    name: id.toUpperCase(),
    channelId: `9${id}`,
    transport: { protocol: 'https', uri: `http://localhost:5000/derec/${id}` },
    secretShares: status ? [{ version: 4, status, verified: false }] : [],
    connectionStatus: 'paired',
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

function pressEscape() {
  const target = document.activeElement ?? host
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

function setValue(selector: string, value: string) {
  const el = host.querySelector<HTMLInputElement>(selector)
  if (!el) throw new Error(`no ${selector}`)
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('AddItemModal and Escape', () => {
  it('closes on Escape before anything is sent', () => {
    const onClose = vi.fn()
    act(() =>
      root.render(
        <AddItemModal
          participants={[participant('a'), participant('z')]}
          pendingChannelIds={new Set()}
          itemBag={null}
          publishContext={PUBLISH_CONTEXT}
          onClose={onClose}
          onAddItem={async () => ({ version: 4, recipientIds: ['a'], threshold: 2 })}
        />,
      ),
    )

    pressEscape()

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores Escape while the round is being sent', async () => {
    const onClose = vi.fn()
    let finish: (round: PublishedRound) => void = () => {}
    act(() =>
      root.render(
        <AddItemModal
          participants={[participant('a'), participant('z')]}
          pendingChannelIds={new Set()}
          itemBag={null}
          publishContext={PUBLISH_CONTEXT}
          onClose={onClose}
          onAddItem={() => new Promise<PublishedRound>(resolve => (finish = resolve))}
        />,
      ),
    )
    setValue('#ps-name', 'Seed')
    setValue('input[aria-label="Item data"]', 'one two')

    act(() => (host.querySelector('form') as HTMLFormElement).requestSubmit())
    expect(host.textContent).toContain('Sending…')

    pressEscape()
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => finish({ version: 4, recipientIds: ['a'], threshold: 2 }))
  })
})

describe('ProtectRoundProgress while a participant has not answered', () => {
  function render(confirmed: number) {
    const rows = [
      participant('a', confirmed >= 1 ? 'confirmed' : 'pending'),
      participant('b', confirmed >= 2 ? 'confirmed' : 'pending'),
      participant('c', 'pending'),
    ]
    act(() =>
      root.render(
        <ProtectRoundProgress
          progress={roundProgress(rows, ['a', 'b', 'c'], 4)}
          threshold={2}
          version={4}
          failureHeading="Secret protection failed."
          onClose={() => {}}
        />,
      ),
    )
  }

  it('says the threshold is met and the version commits once the rest answer or time out', () => {
    render(2)

    expect(host.textContent).toContain('2 of 3 confirmed · 1 waiting (need 2)')
    expect(host.textContent).toContain('Threshold reached')
    expect(host.textContent).toContain('v4 is committed once it answers or times out')
    expect(host.textContent).toContain('You can close this')
  })

  it('says how many more confirmations are needed before then', () => {
    render(1)

    expect(host.textContent).toContain('1 more confirmation needed before v4 can be committed')
  })
})

describe('AddItemModal size limit', () => {
  it('refuses an item that would take the bag past the limit, before anything is sent', () => {
    const onAddItem = vi.fn(async () => ({ version: 4, recipientIds: ['a'], threshold: 2 }))
    act(() =>
      root.render(
        <AddItemModal
          participants={[participant('a'), participant('z')]}
          pendingChannelIds={new Set()}
          itemBag={null}
          publishContext={PUBLISH_CONTEXT}
          onClose={() => {}}
          onAddItem={onAddItem}
        />,
      ),
    )
    expect(host.textContent).toContain('Up to 32 KB')

    setValue('#ps-name', 'Huge')
    setValue('input[aria-label="Item data"]', 'x'.repeat(40 * 1024))

    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/over the 32 KB/)
    const submit = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Add Item')
    expect(submit?.disabled).toBe(true)
    expect(onAddItem).not.toHaveBeenCalled()
  })

  it('ends on the engine’s own words when the round fails to start', async () => {
    act(() =>
      root.render(
        <AddItemModal
          participants={[participant('a'), participant('z')]}
          pendingChannelIds={new Set()}
          itemBag={null}
          publishContext={PUBLISH_CONTEXT}
          onClose={() => {}}
          onAddItem={async () => {
            throw new Error('None of the 1 share request(s) could be delivered')
          }}
        />,
      ),
    )
    setValue('#ps-name', 'S')
    setValue('input[aria-label="Item data"]', 'v')
    const form = host.querySelector('form')!
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(host.textContent).toContain('None of the 1 share request(s) could be delivered')
    // Back on the form, with Cancel available — nothing left blocking the page.
    expect(Array.from(host.querySelectorAll('button')).some(b => b.textContent === 'Cancel' && !b.disabled)).toBe(true)
  })
})

describe('AddItemModal following a round', () => {
  it('waits only on the participants the round was sent to', async () => {
    // `b` is paired but its fingerprint was refused: the library holds the
    // channel `Pending` and the round never reached it, so it is no recipient.
    act(() =>
      root.render(
        <AddItemModal
          participants={[participant('a', 'confirmed'), participant('b'), participant('c')]}
          pendingChannelIds={new Set(['9b'])}
          itemBag={null}
          publishContext={PUBLISH_CONTEXT}
          onClose={() => {}}
          onAddItem={async () => ({ version: 4, recipientIds: ['a'], threshold: 2 })}
        />,
      ),
    )
    setValue('#ps-name', 'Seed')
    setValue('input[aria-label="Item data"]', 'one two')
    await act(async () => (host.querySelector('form') as HTMLFormElement).requestSubmit())

    expect(host.textContent).toContain('1 of 1 confirmed')
    expect(host.textContent).not.toMatch(/no answer|did not store/)
  })

  it('lists only the participants the round will target', () => {
    // `b` completed its handshake but its fingerprint was refused, so the
    // library holds the channel `Pending` and a round sends it nothing. `r` is
    // a replica channel, which never receives a share.
    const replica: PairedParticipant = { ...participant('r'), peerRole: 'replica_destination' }
    act(() =>
      root.render(
        <AddItemModal
          participants={[participant('a'), participant('b'), participant('c'), replica]}
          pendingChannelIds={new Set(['9b'])}
          itemBag={null}
          publishContext={PUBLISH_CONTEXT}
          onClose={() => {}}
          onAddItem={async () => ({ version: 1, recipientIds: ['a', 'c'], threshold: 2 })}
        />,
      ),
    )

    // The summary names the helpers the round targets, and no other.
    expect(host.textContent).toContain('across 2 helpers: A ×1, C ×1')
  })
})

describe('publishTargets', () => {
  it('keeps share targets the library does not hold Pending', () => {
    const owner: PairedParticipant = { ...participant('o'), peerRole: 'owner' }
    const unpaired: PairedParticipant = { ...participant('u'), connectionStatus: 'available' }
    const targets = publishTargets(
      [participant('a'), participant('b'), owner, unpaired],
      new Set(['9b']),
    )
    expect(targets.map(p => p.id)).toEqual(['a'])
  })
})
