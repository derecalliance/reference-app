// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PairedParticipant, PublishedRound } from '../types'
import { publishTargets } from '../ownerPairing'
import { AddSecretModal } from './AddSecretModal'
import { ProtectRoundProgress } from './ProtectRoundProgress'
import { roundProgress } from './roundProgress'

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

describe('AddSecretModal and Escape', () => {
  it('closes on Escape before anything is sent', () => {
    const onClose = vi.fn()
    act(() =>
      root.render(
        <AddSecretModal
          participants={[participant('a')]}
          pendingChannelIds={new Set()}
          secretBag={null}
          threshold={1}
          onClose={onClose}
          onAddSecret={async () => ({ version: 4, recipientIds: ['a'] })}
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
        <AddSecretModal
          participants={[participant('a')]}
          pendingChannelIds={new Set()}
          secretBag={null}
          threshold={1}
          onClose={onClose}
          onAddSecret={() => new Promise<PublishedRound>(resolve => (finish = resolve))}
        />,
      ),
    )
    setValue('#ps-name', 'Seed')
    setValue('input[aria-label="Secret data"]', 'one two')

    act(() => (host.querySelector('form') as HTMLFormElement).requestSubmit())
    expect(host.textContent).toContain('Sending…')

    pressEscape()
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => finish({ version: 4, recipientIds: ['a'] }))
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

describe('AddSecretModal size limit', () => {
  it('refuses a secret that would take the bag past the limit, before anything is sent', () => {
    const onAddSecret = vi.fn(async () => ({ version: 4, recipientIds: ['a'] }))
    act(() =>
      root.render(
        <AddSecretModal
          participants={[participant('a')]}
          pendingChannelIds={new Set()}
          secretBag={null}
          threshold={1}
          onClose={() => {}}
          onAddSecret={onAddSecret}
        />,
      ),
    )
    expect(host.textContent).toContain('Up to 32 KB')

    setValue('#ps-name', 'Huge')
    setValue('input[aria-label="Secret data"]', 'x'.repeat(40 * 1024))

    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/over the 32 KB/)
    const submit = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Add Secret')
    expect(submit?.disabled).toBe(true)
    expect(onAddSecret).not.toHaveBeenCalled()
  })

  it('ends on the engine’s own words when the round fails to start', async () => {
    act(() =>
      root.render(
        <AddSecretModal
          participants={[participant('a')]}
          pendingChannelIds={new Set()}
          secretBag={null}
          threshold={1}
          onClose={() => {}}
          onAddSecret={async () => {
            throw new Error('None of the 1 share request(s) could be delivered')
          }}
        />,
      ),
    )
    setValue('#ps-name', 'S')
    setValue('input[aria-label="Secret data"]', 'v')
    const form = host.querySelector('form')!
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(host.textContent).toContain('None of the 1 share request(s) could be delivered')
    // Back on the form, with Cancel available — nothing left blocking the page.
    expect(Array.from(host.querySelectorAll('button')).some(b => b.textContent === 'Cancel' && !b.disabled)).toBe(true)
  })
})

describe('AddSecretModal following a round', () => {
  it('waits only on the participants the round was sent to', async () => {
    // `b` is paired but its fingerprint was refused: the library holds the
    // channel `Pending` and the round never reached it, so it is no recipient.
    act(() =>
      root.render(
        <AddSecretModal
          participants={[participant('a', 'confirmed'), participant('b')]}
          pendingChannelIds={new Set(['9b'])}
          secretBag={null}
          threshold={1}
          onClose={() => {}}
          onAddSecret={async () => ({ version: 4, recipientIds: ['a'] })}
        />,
      ),
    )
    setValue('#ps-name', 'Seed')
    setValue('input[aria-label="Secret data"]', 'one two')
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
        <AddSecretModal
          participants={[participant('a'), participant('b'), participant('c'), replica]}
          pendingChannelIds={new Set(['9b'])}
          secretBag={null}
          threshold={1}
          onClose={() => {}}
          onAddSecret={async () => ({ version: 1, recipientIds: ['a', 'c'] })}
        />,
      ),
    )

    expect(host.textContent).toContain('Participants (2 paired)')
    const listed = Array.from(host.querySelectorAll('.participant-check-item')).map(li => li.textContent)
    expect(listed).toEqual(['A', 'C'])
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
