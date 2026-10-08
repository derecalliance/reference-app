// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BEActorWithStatus } from '../api'
import { FALLBACK_SERVER_DEFAULTS } from '../config'

const api = vi.hoisted(() => ({
  apiAddHelper: vi.fn(),
  apiDeleteParticipant: vi.fn(),
  apiEnsureHelpers: vi.fn(),
  apiGetActors: vi.fn(),
  apiGetServerDefaults: vi.fn(),
  apiToggleParticipantStatus: vi.fn(),
}))
vi.mock('../api', () => api)

import { ParticipantsPane } from './ParticipantsPane'

function helper(id: string, name: string): BEActorWithStatus {
  return {
    id,
    role: 'helper',
    name,
    transport: { protocol: 'https', uri: `http://node/derec/${id}` },
    transports: [{ protocol: 'https', uri: `http://node/derec/${id}` }],
    secret_id: '1',
  }
}

let host: HTMLDivElement
let root: Root

function stubMatchMedia(): void {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
}

beforeEach(() => {
  vi.useFakeTimers()
  stubMatchMedia()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  api.apiGetActors
    .mockReset()
    .mockResolvedValue([helper('aaaaaaaa-1', 'Alex'), helper('bbbbbbbb-2', 'Alex')])
  api.apiGetServerDefaults
    .mockReset()
    .mockResolvedValue({ defaults: FALLBACK_SERVER_DEFAULTS, reachable: true, fromServer: true })
  api.apiToggleParticipantStatus.mockReset().mockRejectedValue(new Error('node said no'))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

async function renderPane() {
  await act(async () => root.render(<ParticipantsPane />))
  await act(async () => {})
}

describe('ParticipantsPane', () => {
  it('keeps an action error on screen through the next poll', async () => {
    await renderPane()

    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label^="Take offline Alex"]')!
    await act(async () => toggle.click())
    expect(host.textContent).toContain('node said no')

    // The poll succeeds — and used to wipe the error with it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500)
    })
    expect(host.textContent).toContain('node said no')
  })

  it('tells same-named participants apart in their accessible names', async () => {
    await renderPane()

    const labels = Array.from(host.querySelectorAll('button[aria-label^="Delete"]')).map(b =>
      b.getAttribute('aria-label'),
    )
    expect(labels).toEqual(['Delete Alex (aaaaaaaa)', 'Delete Alex (bbbbbbbb)'])
  })
})
