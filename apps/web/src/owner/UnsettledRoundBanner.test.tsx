// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UnsettledRound } from '../types'
import { UnsettledRoundBanner } from './UnsettledRoundBanner'

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

function round(overrides: Partial<UnsettledRound> = {}): UnsettledRound {
  return {
    version: 3,
    recoverable: true,
    confirmedCount: 2,
    failedCount: 1,
    items: [],
    closedAt: 0,
    ...overrides,
  }
}

function render(r: UnsettledRound, retryDisabledReason: string | null = null) {
  const onRetry = vi.fn(async () => null)
  const onDismiss = vi.fn()
  act(() =>
    root.render(
      <UnsettledRoundBanner round={r} onRetry={onRetry} onDismiss={onDismiss} retryDisabledReason={retryDisabledReason} />,
    ),
  )
  return { onRetry, onDismiss }
}

function button(name: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find(b => b.textContent === name)
  if (!found) throw new Error(`no ${name} button`)
  return found
}

describe('UnsettledRoundBanner', () => {
  it('warns when the version is recoverable from the helpers that stored it', () => {
    render(round())

    const banner = host.querySelector('.owner-banner')
    expect(banner?.className).toContain('owner-banner--warning')
    expect(banner?.getAttribute('role')).toBe('status')
    expect(host.textContent).toContain('v3 is not fully settled')
    expect(host.textContent).toContain('recoverable from the 2 helpers that did')
    expect(button('Dismiss')).toBeDefined()
  })

  it('raises a danger alert when the round rolled back and the version is not recoverable', () => {
    render(round({ recoverable: false, confirmedCount: 1, failedCount: 3 }))

    const banner = host.querySelector('.owner-banner')
    expect(banner?.className).toContain('owner-banner--error')
    expect(banner?.getAttribute('role')).toBe('alert')
    expect(host.textContent).toContain('v3 did not reach its threshold and is not recoverable')
    expect(button('Discard v3')).toBeDefined()
  })

  it('retries and dismisses on request', async () => {
    const { onRetry, onDismiss } = render(round({ recoverable: false }))

    await act(async () => button('Retry').click())
    act(() => button('Discard v3').click())

    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('holds Retry back while a round is open, saying why', () => {
    render(round(), 'v4 is still being published.')

    expect(button('Retry').disabled).toBe(true)
    expect(button('Retry').title).toBe('v4 is still being published.')
  })

  it('shows why a retry failed', async () => {
    const onRetry = vi.fn(async () => {
      throw new Error('Need at least 2 paired participants')
    })
    act(() =>
      root.render(
        <UnsettledRoundBanner round={round()} onRetry={onRetry} onDismiss={vi.fn()} retryDisabledReason={null} />,
      ),
    )

    await act(async () => button('Retry').click())

    expect(host.textContent).toContain('Need at least 2 paired participants')
  })
})
