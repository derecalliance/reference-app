// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { AppShell } from './AppShell'

/**
 * The shell is the app's primary navigation, so what it owes is small and
 * strict: every section reachable, the current one announced to assistive
 * technology rather than only coloured, and the owner content left untouched.
 *
 * The case that matters most is the last one. Admin has to work with no owner
 * at all — that is the whole point of separating it from the owner page, and it
 * is what makes a freshly started container useful before anyone has set
 * anything up.
 *
 * Driven with `createRoot` and `act` rather than a testing library, matching
 * `ReplicaChannelRow.test.tsx`: this repo has no `@testing-library`, and one
 * shell test is not a reason to add three dependencies.
 */

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
  localStorage.clear()
})

/**
 * Every nav entry, by its visible label.
 *
 * Searched from the document rather than the host element: below the `md`
 * breakpoint the nav lives in a temporary `Drawer`, which MUI renders through a
 * portal attached to `document.body`. jsdom provides no `matchMedia`, so
 * `useMediaQuery` reports false and that is the layout under test here unless a
 * case stubs it.
 */
function navButtons(): HTMLElement[] {
  return Array.from(document.querySelectorAll('nav [role="button"], nav button'))
}

function navButton(label: string): HTMLElement {
  const found = navButtons().find((b) => b.textContent?.trim() === label)
  if (!found) {
    throw new Error(
      `no nav entry labelled ${label}; found: ${navButtons()
        .map((b) => b.textContent)
        .join(', ')}`,
    )
  }
  return found
}

function mount(children: React.ReactNode) {
  act(() => root.render(<AppShell>{children}</AppShell>))
}

describe('AppShell', () => {
  it('starts on Owner and renders what it was given', () => {
    mount(<p>owner content</p>)

    expect(host.textContent).toContain('owner content')
  })

  it('marks the current section for assistive technology', () => {
    // Colour alone does not communicate state.
    mount(<p>owner content</p>)

    expect(navButton('Owner').getAttribute('aria-current')).toBe('page')
    expect(navButton('Participants').getAttribute('aria-current')).toBeNull()
  })

  it('switches to a section and back', () => {
    mount(<p>owner content</p>)

    act(() => navButton('Participants').click())
    expect(host.textContent).not.toContain('owner content')
    expect(navButton('Participants').getAttribute('aria-current')).toBe('page')

    act(() => navButton('Owner').click())
    expect(host.textContent).toContain('owner content')
  })

  it('reaches every admin section with no owner present', () => {
    // An operator should not have to become an owner to manage the node.
    mount(null)

    for (const label of ['Participants', 'Settings', 'Inspect']) {
      act(() => navButton(label).click())
      expect(navButton(label).getAttribute('aria-current')).toBe('page')
    }
  })

  it('pins Help to the bottom of the navigation, after every section', () => {
    mount(null)

    const labels = navButtons().map((b) => b.textContent?.trim())
    expect(labels).toEqual(['Owner', 'Participants', 'Settings', 'Inspect', 'Help'])
    // Set apart from the sections by its own list, below a divider.
    const help = navButton('Help')
    expect(help.closest('ul')).not.toBe(navButton('Inspect').closest('ul'))
    expect(document.querySelector('nav hr')).not.toBeNull()
  })

  it('opens Help and names it in the narrow-screen bar', async () => {
    mount(<p>owner content</p>)

    act(() => navButton('Help').click())
    expect(navButton('Help').getAttribute('aria-current')).toBe('page')
    expect(host.textContent).not.toContain('owner content')
    expect(host.textContent).toContain('Help')

    // Lazy-loaded: the pane arrives once its chunk resolves.
    await act(async () => {
      await import('./help/HelpPane')
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(host.querySelector('input[type="search"]')).not.toBeNull()
  })

  it('remembers the section across a remount', () => {
    mount(<p>owner content</p>)
    act(() => navButton('Settings').click())

    act(() => root.unmount())
    root = createRoot(host)
    mount(<p>owner content</p>)

    expect(navButton('Settings').getAttribute('aria-current')).toBe('page')
  })

  it('names the navigation landmark', () => {
    // Without a name, a screen reader announces an unlabelled navigation
    // region, indistinguishable from any other on the page.
    mount(null)

    const nav = document.querySelector('nav')
    expect(nav).not.toBeNull()
    expect(nav?.getAttribute('aria-label')).toBeTruthy()
  })

  it('offers a labelled hamburger on narrow screens', () => {
    // The nav collapses below `md`, and an icon-only control with no accessible
    // name is unreachable to anyone not looking at it.
    mount(null)

    const opener = Array.from(host.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Open sections',
    )
    expect(opener).toBeDefined()
  })

  it('shows the nav inline when there is room for it', () => {
    // The desktop layout: a permanent drawer rather than a portal, so the nav
    // sits in the page next to the content instead of over it.
    const original = window.matchMedia
    window.matchMedia = ((query: string) =>
      ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia

    mount(<p>owner content</p>)

    expect(host.querySelector('nav')).not.toBeNull()
    expect(
      Array.from(host.querySelectorAll('button')).some(
        (b) => b.getAttribute('aria-label') === 'Open sections',
      ),
    ).toBe(false)

    window.matchMedia = original
  })
})
