// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PublishPolicy } from './publishPolicy'
import type { ScheduleUnit } from './verificationSchedule'
import { VaultSettingsModal } from './VaultSettingsModal'

const policy: PublishPolicy = {
  defaultThreshold: 2,
  defaultWeights: { '901': 2 },
  helperRetention: { mode: 'lastN', n: 3 },
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

type Saved = (p: PublishPolicy, schedule: { every: number; unit: ScheduleUnit } | null) => void

function render(
  onSave = vi.fn<Saved>(),
  lastPublishedThreshold: number | null = null,
  schedule: { every: number; unit: ScheduleUnit } | null = null,
) {
  act(() =>
    root.render(
      <VaultSettingsModal
        policy={policy}
        schedule={schedule}
        lastPublishedThreshold={lastPublishedThreshold}
        onSave={onSave}
        onClose={() => {}}
      />,
    ),
  )
  return onSave
}

function field(id: string): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>(`#${id}`)
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

function click(el: Element) {
  act(() => {
    ;(el as HTMLElement).click()
  })
}

function saveButton(): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Save')
  if (!button) throw new Error('no save button')
  return button
}

describe('VaultSettingsModal', () => {
  it('saves the changed choices and keeps the rest of the policy', () => {
    const onSave = render()

    setValue(field('vs-threshold'), '3')
    click(field('vs-retention-select'))
    click(field('vs-cleanup-auto'))
    click(field('vs-cleanup-lastN'))
    setValue(field('vs-cleanup-n'), '2')
    click(saveButton())

    expect(onSave).toHaveBeenCalledWith(expect.anything(), null)
    expect(onSave.mock.calls[0][0]).toEqual({
      defaultThreshold: 3,
      defaultWeights: { '901': 2 },
      helperRetention: { mode: 'select' },
      proofCleanup: { mode: 'auto', criterion: 'lastN', n: 2 },
    })
  })

  it('refuses a threshold below 2 before anything is saved', () => {
    const onSave = render()

    setValue(field('vs-threshold'), '1')

    expect(host.textContent).toContain('at least 2')
    expect(saveButton().disabled).toBe(true)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('says when the library last published at a different threshold', () => {
    render(undefined, 4)

    expect(host.textContent).toContain('last published at 4')
  })

  it('says that following the retention rule keeps everything in select mode', () => {
    render()

    click(field('vs-retention-select'))
    click(field('vs-cleanup-auto'))

    expect(host.textContent).toContain('keeps every copy')
  })
})

describe('periodic verification setting', () => {
  it('turns on verification every amount unit', () => {
    const onSave = render()

    click(field('vs-verify-auto'))
    setValue(field('vs-verify-every'), '5')
    act(() => {
      const unit = host.querySelector<HTMLSelectElement>('#vs-verify-unit')!
      unit.value = 'days'
      unit.dispatchEvent(new Event('change', { bubbles: true }))
    })
    click(saveButton())

    expect(onSave.mock.calls[0][1]).toEqual({ every: 5, unit: 'days' })
  })

  it('starts from the schedule already set, and can turn it off', () => {
    const onSave = render(undefined, null, { every: 30, unit: 'minutes' })

    expect(field('vs-verify-every').value).toBe('30')
    click(field('vs-verify-auto'))
    click(saveButton())

    expect(onSave.mock.calls[0][1]).toBeNull()
  })
})

