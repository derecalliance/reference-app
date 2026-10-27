// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ThemeToggle } from './ThemeToggle'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function toggle(): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('button')
  if (!button) throw new Error('no toggle rendered')
  return button
}

describe('ThemeToggle', () => {
  it('names the scheme it switches to, and switches the page there', () => {
    // jsdom has no `matchMedia`, so the system scheme reads as dark.
    act(() => root.render(<ThemeToggle />))
    expect(toggle().getAttribute('aria-label')).toBe('Switch to light theme')

    act(() => toggle().click())
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(toggle().getAttribute('aria-label')).toBe('Switch to dark theme')

    act(() => toggle().click())
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(toggle().getAttribute('aria-label')).toBe('Switch to light theme')
  })
})
