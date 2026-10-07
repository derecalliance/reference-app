// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BagVersion, PairedParticipant, PendingProtectRound, SecretBag } from '../types'
import { SecretBagPanel } from './SecretBagPanel'
import type { VerifyDispatch } from './verification'

function bagVersion(version: number, overrides: Partial<BagVersion> = {}): BagVersion {
  return {
    version,
    participantIds: ['h1', 'h2'],
    verifiedParticipantIds: [],
    failedParticipantIds: [],
    secrets: [{ id: 'aa', name: 'Seed', data: 'one two' }],
    rawBytes: '',
    helpers: [],
    ...overrides,
  }
}

function participant(n: number): PairedParticipant {
  return {
    id: `h${n}`,
    name: `Helper ${n}`,
    channelId: `90${n}`,
    transport: { protocol: 'https', uri: `http://localhost:5000/derec/h${n}` },
    secretShares: [{ version: 4, status: 'confirmed', verified: false }],
    connectionStatus: 'paired',
  }
}

const participants = [participant(1), participant(2)]

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
  bag: SecretBag,
  onVerify: (version: number) => Promise<VerifyDispatch>,
  pendingRounds: PendingProtectRound[] = [],
) {
  act(() =>
    root.render(
      <SecretBagPanel
        bag={bag}
        participants={participants}
        pendingRounds={pendingRounds}
        onVerify={onVerify}
        onAddSecret={() => {}}
        onRemoveSecret={() => {}}
        removeDisabledReason={null}
      />,
    ),
  )
}

function verifyButton(): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Verify Shares')
  if (!found) throw new Error(`no Verify Shares button — rendered: ${host.textContent}`)
  return found
}

describe('verifying shares from the Secrets tab', () => {
  it('keeps following the version it challenged when a publish lands mid-verification', async () => {
    const onVerify = vi.fn(async () => ({ failedChannelIds: [] }))
    render({ secretId: '42', threshold: 2, currentVersion: bagVersion(4), previousVersions: [] }, onVerify)

    await act(async () => verifyButton().click())
    expect(onVerify).toHaveBeenCalledWith(4)

    // v5 lands; the answers for v4 keep arriving against v4.
    render(
      {
        secretId: '42',
        threshold: 2,
        currentVersion: bagVersion(5, { participantIds: [] }),
        previousVersions: [bagVersion(4, { verifiedParticipantIds: ['h1', 'h2'] })],
      },
      onVerify,
    )

    expect(host.textContent).toContain('Verifying Shares · v4')
    expect(host.textContent).toContain('2 of 2 verified')
  })

  it('is disabled, saying why, while a publish is still open', () => {
    const round: PendingProtectRound = {
      version: 5,
      protocolSecretId: '42',
      bag: { secretId: '42', threshold: 2, currentVersion: bagVersion(5, { participantIds: ['h1'] }), previousVersions: [] },
      channelIds: ['901', '902'],
    }
    render({ secretId: '42', threshold: 2, currentVersion: bagVersion(4), previousVersions: [] }, vi.fn(), [round])

    expect(verifyButton().disabled).toBe(true)
    expect(verifyButton().title).toContain('Publishing v5')
    // The open round itself is on the tab, so closing its dialog early loses nothing.
    expect(host.textContent).toContain('Publishing v5: 1 of')
  })

  it('explains why a version restored from recovery cannot be verified', () => {
    render(
      { secretId: '42', threshold: 2, currentVersion: bagVersion(4, { restoredFromRecovery: true }), previousVersions: [] },
      vi.fn(),
    )

    expect(verifyButton().disabled).toBe(true)
    expect(host.textContent).toContain('restored from a recovered bag')
  })

  it('resolves every row at once when the challenge could not be sent', async () => {
    render(
      { secretId: '42', threshold: 2, currentVersion: bagVersion(4), previousVersions: [] },
      async () => {
        throw new Error('v4 was restored from a recovered bag.')
      },
    )

    await act(async () => verifyButton().click())

    expect(host.textContent).toContain('0 of 2 verified · 2 failed')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('restored from a recovered bag')
    expect(host.querySelector('.verify-spinner')).toBeNull()
  })
})
