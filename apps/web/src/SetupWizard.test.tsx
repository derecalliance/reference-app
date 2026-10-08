// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BEActorWithStatus, ServerDefaultsResult } from './api'
import { FALLBACK_SERVER_DEFAULTS } from './config'
import { persistDefaultOverrides } from './protocolDefaults'
import type { Vault } from './types'

const api = vi.hoisted(() => ({
  apiGetServerDefaults: vi.fn(),
  apiGetActors: vi.fn(),
  apiRegisterOwner: vi.fn(),
}))
vi.mock('./api', () => api)
vi.mock('./ConsoleContext', () => ({ useConsole: () => ({ log: () => {} }) }))

import SetupWizard from './SetupWizard'

function helper(id: string): BEActorWithStatus {
  return {
    id,
    role: 'helper',
    name: `Helper ${id}`,
    transport: { protocol: 'https', uri: `http://node/derec/${id}` },
    transports: [{ protocol: 'https', uri: `http://node/derec/${id}` }],
    secret_id: '1',
  }
}

const OWNER = {
  id: '3f2b8c1e-5d4a-4b6f-9e2d-1a7c0b9d8e6f',
  role: 'owner' as const,
  name: 'Alice',
  transport: { protocol: 'https' as const, uri: 'http://node/derec/owner' },
  transports: [],
  secret_id: '42',
}

let host: HTMLDivElement
let root: Root
let resolveDefaults: (result: ServerDefaultsResult) => void

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  api.apiGetServerDefaults.mockReset().mockReturnValue(
    new Promise<ServerDefaultsResult>(resolve => {
      resolveDefaults = resolve
    }),
  )
  api.apiGetActors.mockReset().mockResolvedValue([helper('a'), helper('b')])
  api.apiRegisterOwner.mockReset().mockResolvedValue(OWNER)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render(onReady: (vault: Vault) => Promise<boolean> = async () => true) {
  act(() =>
    root.render(<SetupWizard initialFlow="setup" onReady={onReady} onCancel={() => {}} />),
  )
}

function button(name: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find(
    b => b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
  )
  if (!found) throw new Error(`no "${name}" button — rendered: ${host.textContent}`)
  return found
}

function typeName(value: string) {
  const input = host.querySelector<HTMLInputElement>('input[placeholder="e.g. Alice"]')
  if (!input) throw new Error('no name input')
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function counts(): string[] {
  return Array.from(host.querySelectorAll('.count')).map(el => el.textContent ?? '')
}

async function landDefaults(overrides: Partial<typeof FALLBACK_SERVER_DEFAULTS> = {}) {
  await act(async () => {
    resolveDefaults({ defaults: { ...FALLBACK_SERVER_DEFAULTS, ...overrides }, reachable: true, fromServer: true })
  })
}

describe('the settings step while the node is still being probed', () => {
  it('shows no number and offers no Set up until the node has answered', async () => {
    render()
    typeName('Alice')
    act(() => button('Next →').click())

    expect(counts()).toEqual(['…', '…'])
    expect(button('Increase pre-paired participants').disabled).toBe(true)
    expect(button('Checking the node…').disabled).toBe(true)

    await landDefaults({ prePairedCount: 3 })

    // Two helpers online cap the default of three: shown and used agree.
    expect(counts()).toEqual(['300', '2'])
    expect(button('Set up').disabled).toBe(false)
  })

  it('pre-pairs exactly what the stepper showed', async () => {
    const onReady = vi.fn(async (vault: Vault) => {
      void vault
      return true
    })
    render(onReady)
    typeName('Alice')
    act(() => button('Next →').click())
    await landDefaults({ prePairedCount: 3 })

    await act(async () => button('Set up').click())

    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady.mock.calls[0][0].prePairedCount).toBe(2)
  })
})

describe('a vault the app could not take on', () => {
  it('leaves the busy state and says why when onReady answers false', async () => {
    render(async () => false)
    typeName('Alice')
    act(() => button('Next →').click())
    await landDefaults()

    await act(async () => button('Set up').click())

    // Not stuck on "Setting up…": the button is back, and the reason is shown.
    expect(button('Set up').disabled).toBe(false)
    expect(host.textContent).toContain('already open in another tab')
  })
})

describe('Settings overrides with a name typed before /config returns', () => {
  it('creates the vault from the overridden defaults and records no override', async () => {
    persistDefaultOverrides({ minParticipants: 2, protocolTimeoutSecs: 120 })
    const onReady = vi.fn(async (vault: Vault) => {
      void vault
      return true
    })
    render(onReady)
    // The race QA hit: the name is in before the node's defaults land.
    typeName('Alice')
    await landDefaults({ minParticipants: 3, protocolTimeoutSecs: 300 })
    act(() => button('Next →').click())

    expect(counts()[0]).toBe('120')
    await act(async () => button('Set up').click())

    const vault = onReady.mock.calls[0][0]
    expect(vault.minParticipants).toBe(2)
    // Nothing was edited, so nothing is frozen onto the vault.
    expect(vault.configOverrides).toEqual({})
  })

  it('records the timeout only when the user changed it', async () => {
    const onReady = vi.fn(async (vault: Vault) => {
      void vault
      return true
    })
    render(onReady)
    typeName('Alice')
    act(() => button('Next →').click())
    await landDefaults({ protocolTimeoutSecs: 300 })

    act(() => button('Increase protocol timeout').click())
    await act(async () => button('Set up').click())

    expect(onReady.mock.calls[0][0].configOverrides).toEqual({ protocolTimeoutSecs: 330 })
  })
})

describe('the unreachable-server notice', () => {
  it('names both ways of running the backend', async () => {
    render()
    await act(async () => {
      resolveDefaults({ defaults: FALLBACK_SERVER_DEFAULTS, reachable: false, fromServer: false })
    })

    expect(host.textContent).toContain('cargo run')
    expect(host.textContent).toContain('Docker container')
  })
})

describe('claiming an actor', () => {
  it('refuses a malformed actor id before it reaches the server', async () => {
    api.apiGetActors.mockResolvedValue([])
    act(() =>
      root.render(
        <SetupWizard initialFlow="claim" onReady={async () => true} onCancel={() => {}} />,
      ),
    )
    await act(async () => {})

    const input = host.querySelector<HTMLInputElement>('input[placeholder="e.g. a1b2c3d4-…"]')
    if (!input) throw new Error('no actor id input')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'not-a-uuid')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(host.textContent).toContain('That is not an actor ID')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(button('Claim').disabled).toBe(true)
    expect(api.apiRegisterOwner).not.toHaveBeenCalled()
  })
})

describe('the name step', () => {
  it('advances on Enter, like any other form', () => {
    render()
    typeName('Alice')

    const form = host.querySelector('input[placeholder="e.g. Alice"]')!.closest('form')!
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(host.textContent).toContain('Step 2 of 2')
  })

  it('does not advance on Enter with no name', () => {
    render()
    const form = host.querySelector('input[placeholder="e.g. Alice"]')!.closest('form')!
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(host.textContent).toContain('Step 1 of 2')
  })
})

describe('claiming an owner that looks active elsewhere', () => {
  const liveOwner: BEActorWithStatus = { ...OWNER, last_polled_at: new Date().toISOString() }

  function renderClaim(onReady: (vault: Vault) => Promise<boolean> = async () => true) {
    act(() =>
      root.render(<SetupWizard initialFlow="claim" onReady={onReady} onCancel={() => {}} />),
    )
  }

  it('warns, and holds Claim until the risk is acknowledged', async () => {
    api.apiGetActors.mockReset().mockResolvedValue([liveOwner])
    const onReady = vi.fn(async () => true)
    renderClaim(onReady)
    await act(async () => {})

    act(() => (host.querySelector('[role="option"]') as HTMLButtonElement).click())

    expect(host.textContent).toContain('looks active in another browser')
    expect(button('Claim').disabled).toBe(true)

    const confirm = host.querySelector<HTMLInputElement>('.wizard-claim-warning input[type="checkbox"]')!
    act(() => confirm.click())
    expect(button('Claim').disabled).toBe(false)

    await act(async () => button('Claim').click())
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('says nothing for an owner whose mailbox has gone quiet', async () => {
    api.apiGetActors
      .mockReset()
      .mockResolvedValue([{ ...OWNER, last_polled_at: '2020-01-01T00:00:00Z' }])
    renderClaim()
    await act(async () => {})

    act(() => (host.querySelector('[role="option"]') as HTMLButtonElement).click())

    expect(host.textContent).not.toContain('looks active in another browser')
    expect(button('Claim').disabled).toBe(false)
  })
})

describe('the name step’s limits', () => {
  it('refuses a name over 64 characters on the name step itself', () => {
    render()
    typeName('x'.repeat(65))
    expect(host.textContent).toContain('At most 64 characters')
    expect(button('Next →').disabled).toBe(true)
  })

  it('counts a decomposed accent once, as the node will after NFC', async () => {
    const onReady = vi.fn(async (vault: Vault) => {
      void vault
      return true
    })
    render(onReady)
    // 40 visible characters, 80 code points before normalisation.
    typeName('é'.repeat(40))
    expect(button('Next →').disabled).toBe(false)
    act(() => button('Next →').click())
    await landDefaults()
    await act(async () => button('Set up').click())

    const sent = api.apiRegisterOwner.mock.calls[0][0] as string
    expect(Array.from(sent)).toHaveLength(40)
    expect(onReady.mock.calls[0][0].name).toBe(sent)
  })

  it('warns, without blocking, on a name another vault here already uses', () => {
    act(() =>
      root.render(
        <SetupWizard
          initialFlow="setup"
          onReady={async () => true}
          onCancel={() => {}}
          existingVaultNames={['Alice']}
        />,
      ),
    )
    typeName('alice')
    expect(host.textContent).toContain('already has this name')
    expect(button('Next →').disabled).toBe(false)
  })
})

describe('an unusable minimum from Settings', () => {
  it('holds Set up and says where to fix it', async () => {
    persistDefaultOverrides({ minParticipants: 1 })
    render()
    typeName('Alice')
    act(() => button('Next →').click())
    await landDefaults()

    expect(host.textContent).toContain('The minimum in Settings (1) cannot protect a secret')
    expect(button('Set up').disabled).toBe(true)
  })
})

describe('the claimed vault’s threshold', () => {
  function renderClaim(onReady: (vault: Vault) => Promise<boolean>) {
    act(() =>
      root.render(<SetupWizard initialFlow="claim" onReady={onReady} onCancel={() => {}} />),
    )
  }

  function thresholdInput(): HTMLInputElement {
    const input = host.querySelector<HTMLInputElement>('input[type="number"]')
    if (!input) throw new Error('no threshold input')
    return input
  }

  function setThreshold(value: string) {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(thresholdInput(), value)
      thresholdInput().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('creates the vault with the threshold the person confirmed', async () => {
    api.apiGetActors.mockReset().mockResolvedValue([OWNER])
    const onReady = vi.fn(async (vault: Vault) => {
      void vault
      return true
    })
    renderClaim(onReady)
    await act(async () => {})
    act(() => (host.querySelector('[role="option"]') as HTMLButtonElement).click())

    setThreshold('2')
    await act(async () => button('Claim').click())

    expect(onReady.mock.calls[0][0].minParticipants).toBe(2)
  })

  it('refuses a threshold of 1', async () => {
    api.apiGetActors.mockReset().mockResolvedValue([OWNER])
    renderClaim(async () => true)
    await act(async () => {})
    act(() => (host.querySelector('[role="option"]') as HTMLButtonElement).click())

    setThreshold('1')
    expect(host.textContent).toContain('Must be at least 2')
    expect(button('Claim').disabled).toBe(true)
  })
})
