import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  ReplicaPairingRequestDialog,
  type ReplicaPairingRequestDialogProps,
} from './ReplicaPairingRequestDialog'

/**
 * What the responder is actually told, and what it takes to say yes.
 *
 * The destination side of a replica pairing is agreeing to have its whole vault
 * replaced. If that warning renders on the wrong side — or the accept button is
 * the one holding focus — the consent this dialog exists to collect is not
 * consent. Asserted against the rendered DOM rather than the props, because the
 * warning being *reachable* is the whole point.
 */

let host: HTMLDivElement
let root: Root

/** jsdom ships no `matchMedia`; `AppMuiTheme` reads the colour scheme through it. */
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
  stubMatchMedia()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const BASE: ReplicaPairingRequestDialogProps = {
  open: true,
  peerName: 'Alice',
  channelId: 'chan-7',
  localRole: 'replica_destination',
  peerRole: 'replica_source',
  onAccept: () => {},
  onReject: () => {},
}

function render(overrides: Partial<ReplicaPairingRequestDialogProps> = {}): void {
  act(() => {
    root.render(<ReplicaPairingRequestDialog {...BASE} {...overrides} />)
  })
}

/** The dialog portals to `document.body`, so read the whole document. */
function text(): string {
  return document.body.textContent ?? ''
}

function buttonLabelled(match: RegExp): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find(b =>
    match.test(b.textContent ?? ''),
  )
  if (!button) throw new Error(`no button matching ${match} — rendered: ${text()}`)
  return button
}

describe('what the dialog says', () => {
  it('names it a replica pairing rather than a participant one', () => {
    render()
    expect(text()).toContain('replica')
    expect(text()).toContain('not as a participant')
  })

  it('says a replica mirrors the whole secret, not a share', () => {
    render()
    expect(text()).toContain('whole secret')
    expect(text()).toContain('rather than holding one share')
  })

  it('names the peer and states which side this device will be', () => {
    render()
    expect(text()).toContain('Alice')
    expect(text()).toContain('Replica destination')
    expect(text()).toContain('Replica source')
  })

  it('offers no linking — a replica channel cannot be linked', () => {
    render()
    expect(text()).not.toMatch(/Link to existing/i)
    expect(
      Array.from(document.querySelectorAll('button')).some(b =>
        /link/i.test(b.textContent ?? ''),
      ),
    ).toBe(false)
    expect(text()).toContain('cannot be linked to an existing channel')
  })
})

describe('the erase warning', () => {
  it('warns prominently when this device will be the ReplicaDestination', () => {
    render({ localRole: 'replica_destination', peerRole: 'replica_source' })
    expect(text()).toContain('Accepting replaces this device’s vault')
    expect(text()).toContain('deleted and replaced')
    // A MUI Alert, so the warning carries an icon and a worded title rather
    // than resting on colour alone.
    expect(document.querySelector('.MuiAlert-root')).not.toBeNull()
  })

  it('does not warn when this device will be the ReplicaSource', () => {
    render({ localRole: 'replica_source', peerRole: 'replica_destination' })
    expect(text()).not.toContain('Accepting replaces this device’s vault')
    expect(text()).not.toContain('deleted and replaced')
    expect(document.querySelector('.MuiAlert-root')).toBeNull()
  })
})

describe('reject is the default, and starts nothing', () => {
  it('gives Reject the focus, not Accept', () => {
    render()
    const reject = buttonLabelled(/^Reject$/)
    expect(document.activeElement).toBe(reject)
  })

  it('calls onReject and never onAccept when Reject is clicked', () => {
    const onAccept = vi.fn()
    const onReject = vi.fn()
    render({ onAccept, onReject })

    act(() => {
      buttonLabelled(/^Reject$/).click()
    })

    expect(onReject).toHaveBeenCalledTimes(1)
    expect(onAccept).not.toHaveBeenCalled()
  })

  it('routes Escape to reject', () => {
    const onAccept = vi.fn()
    const onReject = vi.fn()
    render({ onAccept, onReject })

    // MUI listens on the modal root, so the event has to originate inside it —
    // which is where focus already is.
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })

    expect(onReject).toHaveBeenCalled()
    expect(onAccept).not.toHaveBeenCalled()
  })

  it('routes a backdrop click to reject', () => {
    const onAccept = vi.fn()
    const onReject = vi.fn()
    render({ onAccept, onReject })

    const backdrop = document.querySelector('.MuiBackdrop-root')
    expect(backdrop).not.toBeNull()
    act(() => {
      ;(backdrop as HTMLElement).click()
    })

    expect(onReject).toHaveBeenCalled()
    expect(onAccept).not.toHaveBeenCalled()
  })
})

describe('accepting', () => {
  it('calls onAccept only on a deliberate click, and nothing else', () => {
    const onAccept = vi.fn()
    const onReject = vi.fn()
    render({ onAccept, onReject })

    expect(onAccept).not.toHaveBeenCalled()

    act(() => {
      buttonLabelled(/^Accept/).click()
    })

    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(onReject).not.toHaveBeenCalled()
  })
})
