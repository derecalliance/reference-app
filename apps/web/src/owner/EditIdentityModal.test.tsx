// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { IdentityUpdate } from '../vault/types'
import { EditIdentityModal, type EditIdentityInput } from './EditIdentityModal'

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

function setValue(selector: string, value: string) {
  const el = host.querySelector<HTMLInputElement>(selector)
  if (!el) throw new Error(`no ${selector}`)
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === text)
  if (!found) throw new Error(`no "${text}" button — rendered: ${host.textContent}`)
  return found
}

const sent: IdentityUpdate = {
  changed: { name: true, endpoint: false },
  values: { name: 'Family Vault' },
  sentAt: 0,
  channels: {
    '7': { peerName: 'Alex', sentAt: Date.now(), outcome: 'updated', detail: null },
    '8': { peerName: 'Bob-1', sentAt: Date.now(), outcome: 'pending', detail: null },
  },
}

const undelivered: IdentityUpdate = {
  ...sent,
  channels: {
    '7': { peerName: 'Alex', sentAt: 0, outcome: 'updated', detail: null },
    '8': { peerName: 'Bob-1', sentAt: 0, outcome: 'failed', detail: 'unreachable' },
  },
}

function render(
  onSubmit: (input: EditIdentityInput) => Promise<IdentityUpdate | null>,
  update: IdentityUpdate | null = null,
  extra: { onResend?: () => Promise<IdentityUpdate | null>; nodeAddress?: string | null; rosterLoaded?: boolean } = {},
) {
  act(() =>
    root.render(
      <EditIdentityModal
        vaultId="v1"
        currentName="Crypto Seeds"
        currentEndpoint="http://localhost:5000/derec/v1"
        pinned={false}
        nodeAddress={extra.nodeAddress === undefined ? 'http://localhost:5000/derec/v1' : extra.nodeAddress}
        rosterLoaded={extra.rosterLoaded ?? true}
        timeoutSecs={60}
        update={update}
        onSubmit={onSubmit}
        onResend={extra.onResend ?? (async () => null)}
        onClose={() => {}}
      />,
    ),
  )
}

describe('EditIdentityModal', () => {
  it('follows the node by default, so saving a rename sends no endpoint', async () => {
    const onSubmit = vi.fn(async () => sent)
    render(onSubmit, sent)

    setValue('#identity-name', 'Family Vault')
    await act(async () => button('Save and tell peers').click())

    expect(onSubmit).toHaveBeenCalledWith({ name: 'Family Vault', endpoint: null })
  })

  it('pins a typed endpoint once "follow the node" is unticked', async () => {
    const onSubmit = vi.fn(async () => sent)
    render(onSubmit, sent)

    const follow = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    act(() => follow.click())
    setValue('#identity-endpoint', 'https://relay.example/derec/v1')
    await act(async () => button('Save and tell peers').click())

    expect(onSubmit).toHaveBeenCalledWith({ name: 'Crypto Seeds', endpoint: 'https://relay.example/derec/v1' })
  })

  it('will not save an invalid name or endpoint, and says why', () => {
    render(vi.fn())

    setValue('#identity-name', '  ')
    expect(host.textContent).toContain('Enter a name.')
    expect(button('Save and tell peers').disabled).toBe(true)

    setValue('#identity-name', 'Ok')
    act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    setValue('#identity-endpoint', 'grpc://host:50051/derec/v1')
    expect(host.textContent).toContain('cannot serve gRPC')
    expect(button('Save and tell peers').disabled).toBe(true)
  })

  it('shows how each paired peer answered', async () => {
    render(vi.fn(async () => sent), sent)

    setValue('#identity-name', 'Family Vault')
    await act(async () => button('Save and tell peers').click())

    expect(host.textContent).toContain('New name sent to 2 peers: 1 updated · 1 waiting')
    expect(host.textContent).toContain('Alex')
    expect(host.textContent).toContain('Updated')
    expect(host.textContent).toContain('Waiting…')
  })

  it('offers to resend to the peers an update did not reach', async () => {
    const onResend = vi.fn(async () => undelivered)
    render(vi.fn(async () => undelivered), undelivered, { onResend })

    setValue('#identity-name', 'Family Vault')
    await act(async () => button('Save and tell peers').click())

    expect(host.textContent).toContain('1 not delivered')
    await act(async () => button('Resend to 1 peer that didn’t get it').click())
    expect(onResend).toHaveBeenCalledTimes(1)
  })

  it('says saving again resends, when the last update has unreached peers', () => {
    render(vi.fn(), undelivered)
    expect(host.textContent).toContain('did not reach 1 peer')
  })

  it('shows how long each peer has been waited on', async () => {
    render(vi.fn(async () => sent), sent)
    setValue('#identity-name', 'Family Vault')
    await act(async () => button('Save and tell peers').click())
    expect(host.textContent).toMatch(/Waiting… \d+s of 60s/)
  })

  it('warns, without blocking, about a pinned path that is not this vault’s mailbox', () => {
    render(vi.fn())
    act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    setValue('#identity-endpoint', 'http://localhost:5000/derec/someone-else')

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('/derec/v1')
    expect(button('Save and tell peers').disabled).toBe(false)
  })

  it('does not claim the node has not listed the vault before the roster loads', () => {
    render(vi.fn(), null, { nodeAddress: null, rosterLoaded: false })
    expect(host.textContent).not.toContain('has not listed this vault')
    expect(host.textContent).toContain('checking where the node lists this vault')
  })

  it('shows the error and stays editable when the update fails', async () => {
    render(vi.fn(async () => { throw new Error('Start this vault before changing how peers see it.') }))

    setValue('#identity-name', 'Family Vault')
    await act(async () => button('Save and tell peers').click())

    expect(host.textContent).toContain('Start this vault before changing how peers see it.')
    expect(button('Save and tell peers').disabled).toBe(false)
  })
})
