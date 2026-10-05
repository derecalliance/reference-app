// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ModalFrame } from './ModalFrame'

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

function pressEscape(target: Element) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

function dialog(): HTMLElement {
  const found = host.querySelector<HTMLElement>('[role="dialog"]')
  if (!found) throw new Error('no dialog')
  return found
}

describe('ModalFrame', () => {
  it('takes focus when it opens, so Tab starts inside it', () => {
    act(() =>
      root.render(
        <ModalFrame overlayClassName="modal-overlay" className="modal" label="Example">
          <button>Inside</button>
        </ModalFrame>,
      ),
    )

    expect(dialog().contains(document.activeElement)).toBe(true)
    expect(dialog().getAttribute('aria-modal')).toBe('true')
    expect(dialog().getAttribute('aria-label')).toBe('Example')
  })

  it('closes on Escape', () => {
    const onEscape = vi.fn()
    act(() =>
      root.render(
        <ModalFrame overlayClassName="modal-overlay" className="modal" label="Example" onEscape={onEscape}>
          <button>Inside</button>
        </ModalFrame>,
      ),
    )

    pressEscape(host.querySelector('button') as HTMLButtonElement)

    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  it('stays open on Escape while closing is not allowed', () => {
    const outer = vi.fn()
    act(() =>
      root.render(
        // The outer handler stands for anything behind the dialog.
        <div onKeyDown={outer}>
          <ModalFrame overlayClassName="modal-overlay" className="modal" label="Sending">
            <button>Inside</button>
          </ModalFrame>
        </div>,
      ),
    )

    pressEscape(host.querySelector('button') as HTMLButtonElement)

    expect(dialog()).toBeTruthy()
    // Nor does the Escape leak out to close whatever is behind it.
    expect(outer).not.toHaveBeenCalled()
  })

  it('closes on a click on the scrim but not on the panel', () => {
    const onScrimClick = vi.fn()
    act(() =>
      root.render(
        <ModalFrame overlayClassName="modal-overlay" className="modal" label="Example" onScrimClick={onScrimClick}>
          <button>Inside</button>
        </ModalFrame>,
      ),
    )

    act(() => (host.querySelector('button') as HTMLButtonElement).click())
    expect(onScrimClick).not.toHaveBeenCalled()

    act(() => dialog().click())
    expect(onScrimClick).toHaveBeenCalledTimes(1)
  })
})
