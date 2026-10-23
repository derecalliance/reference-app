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
const lastN: PublishPolicy = {
  defaultThreshold: 2,
  defaultWeights: {},
  helperRetention: { mode: 'lastN', n: 2 },
  proofCleanup: { mode: 'manual' },
}
const select: PublishPolicy = { ...lastN, helperRetention: { mode: 'select' } }

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
  extra: { preview?: { kept: number[]; dropped: number[] } | null; open?: number[] } = {},
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
  it('names the versions helpers keep and the ones they drop under "keep the last N"', () => {
    render(lastN, initialPublishOptions(helpers, lastN), { preview: { kept: [4, 3], dropped: [2] } })

    expect(host.textContent).toContain('Helpers will keep v4, v3 and this new version')
    expect(host.textContent).toContain('v2 will be dropped')
    expect(host.textContent).toContain('keep the last 2')
  })

  it('lets the owner pick the versions in "choose at each publish" mode', () => {
    const onChange = render(select, initialPublishOptions(helpers, select))

    click(host.querySelector('#po-keep-3'))

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ dropped: [3] }))
  })

  it('keeps a round still being published, locked', () => {
    render(select, initialPublishOptions(helpers, select), { open: [5] })

    const open = host.querySelector<HTMLInputElement>('#po-keep-5')
    expect(open?.checked).toBe(true)
    expect(open?.disabled).toBe(true)
  })

  it('asks whether to remember a threshold that differs from the default', () => {
    const draft = { ...initialPublishOptions(helpers, lastN), threshold: '3' }
    render(lastN, draft)

    expect(host.textContent).toContain('Remember this threshold for future publishes')
  })

  it('does not ask while the threshold is the default', () => {
    render(lastN, initialPublishOptions(helpers, lastN))

    expect(host.textContent).not.toContain('Remember this threshold')
  })
})
