// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PairedParticipant } from '../types'
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
          secretBag={null}
          threshold={1}
          onClose={onClose}
          onAddSecret={async () => 4}
        />,
      ),
    )

    pressEscape()

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores Escape while the round is being sent', async () => {
    const onClose = vi.fn()
    let finish: (version: number) => void = () => {}
    act(() =>
      root.render(
        <AddSecretModal
          participants={[participant('a')]}
          secretBag={null}
          threshold={1}
          onClose={onClose}
          onAddSecret={() => new Promise<number>(resolve => (finish = resolve))}
        />,
      ),
    )
    setValue('#ps-name', 'Seed')
    setValue('input[aria-label="Secret data"]', 'one two')

    act(() => (host.querySelector('form') as HTMLFormElement).requestSubmit())
    expect(host.textContent).toContain('Sending…')

    pressEscape()
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => finish(4))
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
    const onAddSecret = vi.fn(async () => 4)
    act(() =>
      root.render(
        <AddSecretModal
          participants={[participant('a')]}
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
