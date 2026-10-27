// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublishContext } from '../vault/types'

import type { BagVersion, PairedParticipant, PublishedRound, SecretBag, UserSecret } from '../types'
import { RemoveSecretModal } from './RemoveSecretModal'
import { SecretBagPanel } from './SecretBagPanel'

/** A publish dialog's starting point: threshold 2, every helper at 1, keep the last 3. */
const PUBLISH_CONTEXT: PublishContext = {
  policy: { defaultThreshold: 2, defaultWeights: {}, helperRetention: { mode: 'lastN', n: 3 }, proofCleanup: { mode: 'manual' } },
  committedVersions: [],
  openVersions: [],
  preview: { kept: [], dropped: [] },
}

const seed: UserSecret = { id: 'aa', name: 'Seed', data: 'one two' }
const pin: UserSecret = { id: 'bb', name: 'PIN', data: '1234' }

function bagVersion(version: number, secrets: UserSecret[]): BagVersion {
  return {
    version,
    participantIds: [],
    verifiedParticipantIds: [],
    failedParticipantIds: [],
    secrets,
    rawBytes: '',
    helpers: [],
  }
}

const bag: SecretBag = {
  secretId: '42',
  threshold: 1,
  currentVersion: bagVersion(2, [seed, pin]),
  previousVersions: [bagVersion(1, [seed])],
}

const helper: PairedParticipant = {
  id: 'h1',
  name: 'Alex',
  channelId: '900',
  transport: { protocol: 'https', uri: 'http://localhost:5000/derec/h1' },
  secretShares: [],
  connectionStatus: 'paired',
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

function buttons(label: string): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`))
}

function buttonWithText(text: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === text)
  if (!found) throw new Error(`no "${text}" button — rendered: ${host.textContent}`)
  return found
}

function renderPanel(onRemoveSecret: (s: UserSecret) => void, removeDisabledReason: string | null = null) {
  act(() =>
    root.render(
      <SecretBagPanel
        bag={bag}
        participants={[helper, { ...helper, id: 'h2', name: 'Richard', channelId: '901' }]}
        pendingRounds={[]}
        onVerify={async () => ({ failedChannelIds: [] })}
        onAddSecret={() => {}}
        onRemoveSecret={onRemoveSecret}
        removeDisabledReason={removeDisabledReason}
        onRepublish={() => {}}
        onRemoveVersion={async () => {}}
        defaultThreshold={2}
      />,
    ),
  )
}

describe('removing a secret from the Secrets tab', () => {
  it('offers removal on each secret of the current version and hands over the secret', () => {
    const onRemove = vi.fn()
    renderPanel(onRemove)

    act(() => buttons('Remove PIN')[0].click())

    expect(onRemove).toHaveBeenCalledWith(pin)
  })

  it('does not offer removal on earlier versions, which are history', () => {
    renderPanel(vi.fn())
    act(() => buttonWithText('Show Previous Versions (1)').click())

    // "Seed" is in both versions; only the current one can remove it.
    expect(buttons('Remove Seed')).toHaveLength(1)
  })

  it('is disabled, saying why, while a new version cannot be published', () => {
    renderPanel(vi.fn(), 'Need at least 3 paired participants (currently 1)')

    const remove = buttons('Remove PIN')[0]
    expect(remove.disabled).toBe(true)
    expect(remove.title).toBe('Need at least 3 paired participants (currently 1)')
  })
})

describe('RemoveSecretModal', () => {
  function renderModal(onRemoveSecret: (id: string) => Promise<PublishedRound | null>) {
    act(() =>
      root.render(
        <RemoveSecretModal
          secret={pin}
          pendingChannelIds={new Set()}
          publishContext={PUBLISH_CONTEXT}
          participants={[helper, { ...helper, id: 'h2', name: 'Richard', channelId: '901' }]}
          onClose={() => {}}
          onRemoveSecret={onRemoveSecret}
        />,
      ),
    )
  }

  it('asks first, warning that earlier versions keep the secret', () => {
    const onRemove = vi.fn(async () => ({ version: 3, recipientIds: [helper.id], threshold: 2 }))
    renderModal(onRemove)

    expect(host.textContent).toContain('Earlier versions still contain it')
    expect(onRemove).not.toHaveBeenCalled()
  })

  it('removes on confirmation and follows the round it started', async () => {
    const onRemove = vi.fn(async () => ({ version: 3, recipientIds: [helper.id], threshold: 2 }))
    renderModal(onRemove)

    await act(async () => buttonWithText('Remove Secret').click())

    // The owner's publish choice travels with the removal: defaults, untouched.
    expect(onRemove).toHaveBeenCalledWith('bb', expect.objectContaining({ threshold: 2, keep: null }))
    expect(host.textContent).toContain('0 of 1 confirmed')
  })

  it('says so when no round was dispatched', async () => {
    renderModal(async () => null)

    await act(async () => buttonWithText('Remove Secret').click())

    expect(host.textContent).toContain('The round was not dispatched')
  })
})
