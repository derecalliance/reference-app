// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { navigate } from './routing'
import { useHashRoute } from './useHashRoute'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.location.hash = ''
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.location.hash = ''
})

function Probe() {
  const route = useHashRoute()
  return <span>{route.kind === 'vault' ? `vault:${route.id}` : route.kind}</span>
}

describe('useHashRoute', () => {
  it('follows navigation', async () => {
    act(() => root.render(<Probe />))
    expect(host.textContent).toBe('list')

    await act(async () => {
      navigate({ kind: 'vault', id: 'abc' })
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })

    expect(host.textContent).toBe('vault:abc')
  })
})
