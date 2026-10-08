// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ServerDefaultsResult } from '../api'
import { FALLBACK_SERVER_DEFAULTS } from '../config'
import { loadDefaultOverrides } from '../protocolDefaults'

const api = vi.hoisted(() => ({
  apiGetDebugConfig: vi.fn(),
  apiGetServerDefaults: vi.fn(),
}))
vi.mock('../api', () => api)

import { SettingsPane } from './SettingsPane'

let host: HTMLDivElement
let root: Root
let resolveDefaults: (result: ServerDefaultsResult) => void

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  api.apiGetDebugConfig.mockReset().mockRejectedValue(new Error('no debug config'))
  api.apiGetServerDefaults.mockReset().mockReturnValue(
    new Promise<ServerDefaultsResult>(resolve => {
      resolveDefaults = resolve
    }),
  )
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function field(label: string): HTMLInputElement {
  const labelEl = Array.from(host.querySelectorAll('label')).find(
    l => l.textContent?.replace('*', '').trim() === label,
  )
  const id = labelEl?.getAttribute('for')
  const input = id ? (document.getElementById(id) as HTMLInputElement | null) : null
  if (!input) throw new Error(`no "${label}" field — rendered: ${host.textContent}`)
  return input
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function saveButton(): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Save')
  if (!button) throw new Error('no Save button')
  return button
}

async function render() {
  await act(async () => root.render(<SettingsPane />))
}

describe('the protocol defaults form', () => {
  it('is not editable until the node’s own defaults have loaded', async () => {
    await render()

    expect(host.textContent).toContain('Reading the node’s defaults…')
    expect(host.querySelector('input')).toBeNull()

    await act(async () => {
      resolveDefaults({
        defaults: {
          ...FALLBACK_SERVER_DEFAULTS,
          participantCount: 4,
          recommendedParticipants: 4,
          helperTransports: { http: 4, grpc: 0, both: 0 },
        },
        reachable: true,
        fromServer: true,
      })
    })

    expect(field('Participants').value).toBe('4')
  })

  it('offers Retry instead of a form when the node cannot be reached', async () => {
    await render()
    await act(async () => {
      resolveDefaults({ defaults: FALLBACK_SERVER_DEFAULTS, reachable: false, fromServer: false })
    })

    expect(host.textContent).toContain('Cannot reach the DeRec server')
    expect(host.querySelector('input')).toBeNull()
  })

  it('shows what is wrong and refuses to save an invalid draft', async () => {
    await render()
    await act(async () => {
      resolveDefaults({ defaults: FALLBACK_SERVER_DEFAULTS, reachable: true, fromServer: true })
    })

    type(field('Minimum'), '9')

    expect(host.textContent).toContain('Cannot exceed the pool of 7')
    expect(field('Minimum').getAttribute('aria-invalid')).toBe('true')
    expect(saveButton().disabled).toBe(true)
    act(() => saveButton().click())
    expect(loadDefaultOverrides()).toEqual({})
  })

  it('stores only what differs from the node', async () => {
    await render()
    await act(async () => {
      resolveDefaults({ defaults: FALLBACK_SERVER_DEFAULTS, reachable: true, fromServer: true })
    })

    type(field('Minimum'), '2')
    act(() => saveButton().click())

    expect(loadDefaultOverrides()).toEqual({ minParticipants: 2 })
  })

  it('refuses a minimum of 1, which no vault could start with', async () => {
    await render()
    await act(async () => {
      resolveDefaults({ defaults: FALLBACK_SERVER_DEFAULTS, reachable: true, fromServer: true })
    })

    type(field('Minimum'), '1')

    expect(host.textContent).toContain('Must be at least 2')
    expect(saveButton().disabled).toBe(true)
  })

  it('refuses exponent notation and pools the node cannot hold', async () => {
    await render()
    await act(async () => {
      resolveDefaults({ defaults: FALLBACK_SERVER_DEFAULTS, reachable: true, fromServer: true })
    })

    type(field('Participants'), '1e3')
    expect(host.textContent).toContain('Enter a whole number')
    // What was typed stays on screen rather than vanishing.
    expect(field('Participants').value).toBe('1e3')
    expect(saveButton().disabled).toBe(true)

    type(field('Participants'), '256')
    expect(host.textContent).toContain('Must be at most 255')
  })
})
