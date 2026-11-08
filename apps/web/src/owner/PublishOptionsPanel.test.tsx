// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PairedParticipant } from '../types'
import { initialPublishOptions, type PublishOptionsDraft } from './publishOptions'
import { PublishOptionsPanel } from './PublishOptionsPanel'
import type { PublishPolicy } from './publishPolicy'

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

const helpers = [helper(1), helper(2)]
const latest: PublishPolicy = {
  defaultThreshold: 2,
  defaultWeights: {},
  helperRetention: { mode: 'latestCommitted' },
  proofCleanup: { mode: 'manual' },
}
const select: PublishPolicy = { ...latest, helperRetention: { mode: 'select' } }

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
  policy: PublishPolicy,
  draft: PublishOptionsDraft,
  extra: { preview?: { kept: number | null; dropped: number[] } | null; open?: number[] } = {},
) {
  const onChange = vi.fn<(d: PublishOptionsDraft) => void>()
  act(() =>
    root.render(
      <PublishOptionsPanel
        helpers={helpers}
        policy={policy}
        committedVersions={[4, 3, 2]}
        openVersions={extra.open ?? []}
        preview={extra.preview ?? null}
        draft={draft}
        onChange={onChange}
        disabled={false}
      />,
    ),
  )
  return onChange
}

function click(el: Element | null) {
  if (!el) throw new Error('missing element')
  act(() => {
    ;(el as HTMLElement).click()
  })
}

describe('PublishOptionsPanel', () => {
  it('names the version helpers keep and the ones they drop under "keep the newest committed version"', () => {
    render(latest, initialPublishOptions(), { preview: { kept: 4, dropped: [3, 2] } })

    expect(host.textContent).toContain('Helpers will keep v4 and this new version')
    expect(host.textContent).toContain('v3, v2 will be dropped')
    expect(host.textContent).toContain('keep the newest committed version')
  })

  it('starts "choose at each publish" on the newest committed version', () => {
    render(select, initialPublishOptions())

    expect(host.querySelector<HTMLInputElement>('#po-keep-4')?.checked).toBe(true)
    expect(host.querySelector<HTMLInputElement>('#po-keep-3')?.checked).toBe(false)
  })

  it('lets the owner pick one version, or none, in "choose at each publish" mode', () => {
    const onChange = render(select, initialPublishOptions())

    click(host.querySelector('#po-keep-3'))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ keep: 3 }))

    click(host.querySelector('#po-keep-none'))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ keep: 0 }))
  })

  it('says a round still being published is dropped by helpers that store this one', () => {
    render(select, initialPublishOptions(), { open: [5] })

    expect(host.querySelector('#po-keep-5')).toBeNull()
    expect(host.textContent).toContain('Still being published, and dropped by helpers that store this one: v5')
  })

  it('shows the secret\'s threshold and weights read-only, pointing to the Channels tab', () => {
    render({ ...latest, defaultWeights: { '901': 2 }, defaultThreshold: 2 }, initialPublishOptions())

    expect(host.textContent).toContain('Threshold 2 of 3 subshares across 2 helpers: Helper 1 ×2, Helper 2 ×1')
    expect(host.textContent).toContain('Set on the Channels tab')
    expect(host.querySelector('input[type="number"]')).toBeNull()
  })

  it('says why a publish cannot go out when the threshold and weights do not work', () => {
    render({ ...latest, defaultThreshold: 5 }, initialPublishOptions())

    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/below the threshold of 5.*Channels tab/)
  })
})
