// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OutgoingUnpairDialog } from './OutgoingUnpairDialog'

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

function button(label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find(b => b.textContent === label)
  if (!found) throw new Error(`no button "${label}"`)
  return found
}

const base = { participantId: 'h1', peerName: 'Alex', channelId: '7' }

describe('OutgoingUnpairDialog', () => {
  it('offers no way to forget a channel while the unpair can still go through', () => {
    act(() =>
      root.render(
        <OutgoingUnpairDialog confirmation={base} inFlight={false} onCancel={() => {}} onConfirm={() => {}} onForget={() => {}} />,
      ),
    )
    expect(host.textContent).toContain('Unpair channel?')
    expect(host.textContent).not.toContain('Forget')
  })

  it('says why an unpair failed and forgets the channel only after a second confirmation', () => {
    const onForget = vi.fn()
    act(() =>
      root.render(
        <OutgoingUnpairDialog
          confirmation={{ ...base, failure: 'The unpair request could not be sent to Alex: HTTP 404' }}
          inFlight={false}
          onCancel={() => {}}
          onConfirm={() => {}}
          onForget={onForget}
        />,
      ),
    )
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('HTTP 404')

    act(() => button('Forget this channel…').click())
    expect(host.textContent).toContain('this device only')
    expect(onForget).not.toHaveBeenCalled()

    act(() => button('Forget channel').click())
    expect(onForget).toHaveBeenCalledTimes(1)
  })
})
