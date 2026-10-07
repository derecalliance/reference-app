// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { HelpPane } from './HelpPane'
import { parseTopic } from './topics'

/**
 * Driven with `createRoot` and `act`, like the other component tests here:
 * the repo has no testing library. jsdom has no `matchMedia`, so the pane
 * renders its desktop layout.
 */

const TOPICS = [
  parseTopic(
    './content/00-getting-started.md',
    '# Getting started\n\nA first walk through the app.\n\nSee [Pairing](03-pairing.md) next.\n',
  ),
  parseTopic(
    './content/03-pairing.md',
    '# Pairing\n\nHow to pair a vault.\n\n## Contact modes\n\n| Mode | Usable |\n| --- | --- |\n| No keys | after a fingerprint |\n',
  ),
  parseTopic('./content/17-glossary.md', '# Glossary\n\nShort definitions of every term.\n'),
]

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

function mount() {
  act(() => root.render(<HelpPane topics={TOPICS} />))
}

function listTitles(): string[] {
  return Array.from(host.querySelectorAll('nav[aria-label="Help topics"] [role="button"]')).map(
    b => b.querySelector('.MuiListItemText-primary')?.textContent ?? '',
  )
}

function article(): HTMLElement {
  const found = host.querySelector('article')
  if (!found) throw new Error('no article')
  return found as HTMLElement
}

function searchBox(): HTMLInputElement {
  const input = host.querySelector('input[type="search"]')
  if (!input) throw new Error('no search box')
  return input as HTMLInputElement
}

/** Type into the search box the way React hears it. */
function search(text: string) {
  const input = searchBox()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(key: string) {
  act(() => {
    searchBox().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

describe('HelpPane', () => {
  it('lists every topic and opens Getting started by default', () => {
    mount()

    expect(listTitles()).toEqual(['Getting started', 'Pairing', 'Glossary'])
    expect(article().querySelector('h1')?.textContent).toBe('Getting started')
  })

  it('renders tables as tables', () => {
    mount()
    act(() => (host.querySelectorAll('nav [role="button"]')[1] as HTMLElement).click())

    expect(article().querySelector('table')).not.toBeNull()
    expect(article().textContent).toContain('after a fingerprint')
  })

  it('filters the list as you type, with a snippet of the match', () => {
    mount()
    search('fingerprint')

    expect(listTitles()).toEqual(['Pairing'])
    expect(host.textContent).toContain('1 topic matches')
    expect(host.querySelector('.MuiListItemText-secondary')?.textContent).toContain('fingerprint')
  })

  it('says so when nothing matches', () => {
    mount()
    search('kubernetes')

    expect(listTitles()).toEqual([])
    expect(host.textContent).toContain('No topics match “kubernetes”')
  })

  it('opens the first result on Enter and clears the search on Escape', () => {
    mount()
    search('glossary')
    press('Enter')

    expect(article().querySelector('h1')?.textContent).toBe('Glossary')

    press('Escape')
    expect(searchBox().value).toBe('')
    expect(listTitles()).toHaveLength(3)
  })

  it('follows a link to another topic in place', () => {
    mount()
    const link = Array.from(article().querySelectorAll('button')).find(b => b.textContent === 'Pairing')
    if (!link) throw new Error('no link to Pairing')
    act(() => link.click())

    expect(article().querySelector('h1')?.textContent).toBe('Pairing')
  })

  it('remembers the open topic across a remount', () => {
    mount()
    act(() => (host.querySelectorAll('nav [role="button"]')[2] as HTMLElement).click())
    act(() => root.unmount())
    root = createRoot(host)
    mount()

    expect(article().querySelector('h1')?.textContent).toBe('Glossary')
  })
})
