// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PairedParticipant } from '../types'
import type { PublishPolicy, ThresholdSetting } from './publishPolicy'
import { SharingSettingsPanel } from './SharingSettingsPanel'

function helper(n: number): PairedParticipant {
  return {
    id: `h${n}`,
    name: `Helper ${n}`,
    channelId: `90${n}`,
    transport: { protocol: 'https', uri: '' },
    secretShares: [],
    connectionStatus: 'paired',
    peerRole: 'helper',
  }
}

const helpers = [helper(1), helper(2), helper(3)]

function policy(defaultThreshold: number, percent?: number): PublishPolicy {
  return {
    ...(percent === undefined ? {} : { thresholdMode: 'percent' as const, thresholdPercent: percent }),
    defaultThreshold,
    defaultWeights: {},
    helperRetention: { mode: 'latestCommitted' },
    proofCleanup: { mode: 'manual' },
  }
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

function render(threshold: number, lastPublishedThreshold: number | null = null, percent?: number) {
  const onSet = vi.fn<(setting: ThresholdSetting) => void>()
  act(() =>
    root.render(
      <SharingSettingsPanel
        helpers={helpers}
        policy={policy(threshold, percent)}
        lastPublishedThreshold={lastPublishedThreshold}
        onSetThreshold={onSet}
      />,
    ),
  )
  return onSet
}

function type(value: string) {
  const field = host.querySelector<HTMLInputElement>('#ch-threshold')
  if (!field) throw new Error('no threshold field')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('SharingSettingsPanel', () => {
  it('shows the threshold and what the helpers hold under it', () => {
    render(2)

    expect(host.querySelector<HTMLInputElement>('#ch-threshold')?.value).toBe('2')
    expect(host.textContent).toContain('3 subshares across 3 helpers; any helpers holding 2 together can recover')
  })

  it('saves a valid threshold as it is typed', () => {
    const onSet = render(2)

    type('3')

    expect(onSet).toHaveBeenCalledWith({ mode: 'fixed', value: 3 })
  })

  it('refuses a threshold below 2 without saving it', () => {
    const onSet = render(2)

    type('1')

    expect(onSet).not.toHaveBeenCalled()
    expect(host.textContent).toContain('at least 2')
  })

  it('says when the helpers fall short of the threshold', () => {
    render(4)

    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/3 subshares.*below the threshold of 4/)
  })

  it('works a percentage out from the helpers, rounded up and never below 2', () => {
    render(2, null, 60)

    expect(host.querySelector<HTMLInputElement>('#ch-threshold')?.value).toBe('60')
    // 60% of 3 subshares is 1.8, rounded up to 2.
    expect(host.textContent).toContain('60% → threshold 2.')
  })

  it('explains in a tooltip when the threshold is raised above the percentage', () => {
    const onSet = vi.fn<(setting: ThresholdSetting) => void>()
    const weighted = [helper(1), { ...helper(2), weight: 2 }, helper(3)]
    act(() =>
      root.render(
        <SharingSettingsPanel helpers={weighted} policy={policy(2, 50)} lastPublishedThreshold={null} onSetThreshold={onSet} />,
      ),
    )

    expect(host.textContent).toContain('50% → threshold 3 (raised)')
    const raised = host.querySelector('[aria-label="Why the threshold is above the percentage"]')
    expect(describedBy(raised)?.textContent).toContain('Helper 2 holds 2 and could then recover alone')
  })

  it('keeps the explanation in a tooltip behind a ? button', () => {
    render(2, null, 50)
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="About the threshold"]')
    expect(trigger?.textContent).toBe('?')
    expect(describedBy(trigger)?.textContent).toContain('worked out again at every publish')
  })

  it('saves a percentage as it is typed, and refuses one above 100', () => {
    const onSet = render(2, null, 50)

    type('75')
    expect(onSet).toHaveBeenLastCalledWith({ mode: 'percent', percent: 75 })

    onSet.mockClear()
    type('120')
    expect(onSet).not.toHaveBeenCalled()
    expect(host.textContent).toContain('from 1 to 100')
  })

  it('switches modes, each keeping its own value', () => {
    const onSet = render(3, null, 50)

    act(() => host.querySelector<HTMLInputElement>('#ch-threshold-mode-fixed')?.click())

    expect(onSet).toHaveBeenCalledWith({ mode: 'fixed', value: 3 })
  })

  it('says when the library last published at a different threshold', () => {
    render(2, 3)

    expect(host.textContent).toContain('last published at 3')
  })
})

/** The element `trigger` names in its `aria-describedby` — a tooltip's body. */
function describedBy(trigger: Element | null): HTMLElement | null {
  const id = trigger?.getAttribute('aria-describedby')
  return id ? document.getElementById(id) : null
}
