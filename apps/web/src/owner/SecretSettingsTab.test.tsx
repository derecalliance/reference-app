import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SECRET_CONFIG_DEFAULTS } from '../protocolDefaults'
import type { PublishPolicy } from './publishPolicy'
import type { ScheduleChoice, SecretSettingsValues } from './secretSettingsDraft'
import { SecretSettingsTab } from './SecretSettingsTab'

const policy: PublishPolicy = {
  defaultThreshold: 2,
  defaultWeights: { '901': 2 },
  helperRetention: { mode: 'latestCommitted' },
  proofCleanup: { mode: 'manual' },
}

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

function render(
  { schedule = null, protocol = SECRET_CONFIG_DEFAULTS, awaitingRestart = [] }: {
    schedule?: ScheduleChoice | null
    protocol?: SecretSettingsValues['protocol']
    awaitingRestart?: string[]
  } = {},
) {
  const onSave = vi.fn<(next: SecretSettingsValues) => void>()
  act(() =>
    root.render(
      <SecretSettingsTab
        values={{ protocol, policy, schedule }}
        awaitingRestart={awaitingRestart}
        onSave={onSave}
      />,
    ),
  )
  return onSave
}

function field<T extends HTMLElement = HTMLInputElement>(id: string): T {
  const el = host.querySelector<T>(`#${id}`)
  if (!el) throw new Error(`no field #${id}`)
  return el
}

function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function select(id: string, value: string) {
  act(() => {
    const el = field<HTMLSelectElement>(id)
    el.value = value
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function click(el: Element) {
  act(() => {
    ;(el as HTMLElement).click()
  })
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find(b => b.textContent === text)
  if (!found) throw new Error(`no button "${text}"`)
  return found
}

describe('SecretSettingsTab publishing choices', () => {
  it('saves the changed choices and keeps the rest of the policy', () => {
    const onSave = render()

    click(field('vs-retention-select'))
    click(field('vs-cleanup-auto'))
    click(field('vs-cleanup-lastN'))
    setValue(field('vs-cleanup-n'), '2')
    click(button('Save'))

    expect(onSave.mock.calls[0][0].schedule).toBeNull()
    expect(onSave.mock.calls[0][0].policy).toEqual({
      defaultThreshold: 2,
      defaultWeights: { '901': 2 },
      helperRetention: { mode: 'select' },
      proofCleanup: { mode: 'auto', criterion: 'lastN', n: 2 },
    })
  })

  it('does not offer the threshold: it is set on the Channels tab', () => {
    render()

    expect(host.querySelector('#vs-threshold')).toBeNull()
    expect(host.textContent).toContain('The threshold and helper weights are on the Channels tab')
  })

  it('says that following the retention rule in select mode keeps every copy when the choice is not known', () => {
    render()

    click(field('vs-retention-select'))
    click(field('vs-cleanup-auto'))

    expect(host.textContent).toContain('every copy is kept')
  })
})

describe('SecretSettingsTab periodic verification', () => {
  it('turns on verification every amount unit', () => {
    const onSave = render()

    click(field('vs-verify-auto'))
    setValue(field('vs-verify-every'), '5')
    select('vs-verify-unit', 'days')
    click(button('Save'))

    expect(onSave.mock.calls[0][0].schedule).toEqual({ every: 5, unit: 'days' })
  })

  it('starts from the schedule already set, and can turn it off', () => {
    const onSave = render({ schedule: { every: 30, unit: 'minutes' } })

    expect(field('vs-verify-every').value).toBe('30')
    click(field('vs-verify-auto'))
    click(button('Save'))

    expect(onSave.mock.calls[0][0].schedule).toBeNull()
  })
})

describe('SecretSettingsTab protocol settings', () => {
  it('starts from what the secret runs with and marks the defaults', () => {
    render()

    expect(field('ss-timeout').value).toBe(String(SECRET_CONFIG_DEFAULTS.protocolTimeoutSecs))
    expect(field<HTMLSelectElement>('ss-unpair-ack').selectedOptions[0].textContent).toBe('Not required (default)')
    expect(field<HTMLSelectElement>('ss-auto-store').selectedOptions[0].textContent).toBe('Accept automatically (default)')
  })

  it('saves the protocol settings with the rest', () => {
    const onSave = render()

    setValue(field('ss-timeout'), '120')
    select('ss-unpair-ack', 'required')
    select('ss-auto-verify', 'prompt')
    click(button('Save'))

    expect(onSave.mock.calls[0][0].protocol).toEqual({
      ...SECRET_CONFIG_DEFAULTS,
      protocolTimeoutSecs: 120,
      unpairAck: 'required',
      autoAcceptVerifyShareRequests: false,
    })
  })

  it('refuses a timeout the protocol cannot run with', () => {
    const onSave = render()

    setValue(field('ss-timeout'), '3')
    click(button('Save'))

    expect(onSave).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Must be at least 10')
    expect(button('Save').disabled).toBe(true)
  })

  it('puts the protocol settings back to the defaults', () => {
    const onSave = render({ protocol: { ...SECRET_CONFIG_DEFAULTS, protocolTimeoutSecs: 90, unpairAck: 'required' } })

    click(button('Use the defaults'))
    click(button('Save'))

    expect(onSave.mock.calls[0][0].protocol).toEqual(SECRET_CONFIG_DEFAULTS)
    expect(button('Use the defaults').disabled).toBe(true)
  })

  it('offers nothing to save until something changes', () => {
    render()

    expect(button('Save').disabled).toBe(true)
    expect(button('Discard changes').disabled).toBe(true)
  })

  it('says which saved settings wait for the secret to start again', () => {
    render({ awaitingRestart: ['the protocol timeout'] })

    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      'the protocol timeout applies when this secret next starts',
    )
  })
})
