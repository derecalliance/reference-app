// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ReplicaAdoptionDialog } from './ReplicaAdoptionDialog'
import { ReplicaFingerprintDialog } from './ReplicaFingerprintDialog'
import { ReplicaRemovalDialog } from './ReplicaRemovalDialog'
import type { PendingReplicaAdoption, ReplicaProtocol, ReplicaView } from './replicaFlows'
import { removalRequestFor } from './replicaRemoval'

/**
 * The replica confirmations whose wording or dismissal was wrong: removal had
 * no confirmation at all, adoption ignored Escape though the docs promised it
 * resolved to Reject, and the fingerprint dialog re-offered a decision on a
 * channel already confirmed.
 */

let host: HTMLDivElement
let root: Root

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

function text(): string {
  return document.body.textContent ?? ''
}

function button(match: RegExp): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find(b => match.test(b.textContent ?? ''))
  if (!found) throw new Error(`no button matching ${match} — rendered: ${text()}`)
  return found
}

function view(overrides: Partial<ReplicaView> = {}): ReplicaView {
  return {
    id: 'replica-channel:1234',
    name: 'Laptop',
    channelId: '1234',
    status: 'paired',
    offline: false,
    peerConfirmation: 'none',
    lastSync: null,
    establishedAt: Date.now(),
    firstSyncStarted: false,
    direction: 'replica_source',
    peerReplicaId: '77',
    helperActorId: null,
    refused: false,
    ...overrides,
  }
}

describe('removing a replica', () => {
  it('names the source, and the erase, when the member being evicted is the source', () => {
    const request = removalRequestFor(view({ direction: 'replica_destination', name: 'Alice' }))!
    expect(request).toMatchObject({ kind: 'remove', targetIsSource: true, replicaId: '77' })

    act(() => root.render(<ReplicaRemovalDialog request={request} onCancel={() => {}} onConfirm={() => {}} />))

    expect(text()).toContain('Remove the source, Alice?')
    expect(text()).toContain('the device this vault came from')
    expect(text()).toContain('which may be this device')
  })

  it('still says the evicted destination loses its copy', () => {
    const request = removalRequestFor(view({ name: 'Bob' }))!
    act(() => root.render(<ReplicaRemovalDialog request={request} onCancel={() => {}} onConfirm={() => {}} />))

    expect(text()).toContain('This erases Bob’s copy')
    expect(text()).not.toContain('source of this group')
  })

  it('does nothing until confirmed, and passes the request back on confirm', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const request = removalRequestFor(view())!
    act(() => root.render(<ReplicaRemovalDialog request={request} onCancel={onCancel} onConfirm={onConfirm} />))

    act(() => button(/^Cancel$/).click())
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)

    act(() => button(/^Remove from group$/).click())
    expect(onConfirm).toHaveBeenCalledWith(request)
  })

  it('states the documented semantics: anyone may remove anyone, the removed device is not warned', () => {
    const request = removalRequestFor(view({ direction: 'replica_destination', name: 'Alice' }))!
    act(() => root.render(<ReplicaRemovalDialog request={request} onCancel={() => {}} onConfirm={() => {}} />))

    expect(text()).toContain('Any member may remove any other, the source included')
    expect(text()).toContain('Alice is not asked and gets no warning')
    expect(text()).toContain('The first remaining member in this device’s replica list becomes the source')
    expect(text()).toContain('survives on the remaining members and the helpers')
  })

  it('offers no removal for a member whose replica id is unknown', () => {
    expect(removalRequestFor(view({ peerReplicaId: null }))).toBeNull()
  })

  it('tells the truth about Forget: the protocol keeps mirroring', () => {
    act(() =>
      root.render(
        <ReplicaRemovalDialog
          request={{ kind: 'forget', channelId: '1234', name: 'Laptop' }}
          onCancel={() => {}}
          onConfirm={() => {}}
        />,
      ),
    )
    expect(text()).toContain('keeps mirroring to them')
    expect(text()).not.toContain('Nothing is mirrored to them again')
  })
})

describe('the adoption dialog', () => {
  const offer: PendingReplicaAdoption = {
    channelId: '1234',
    fromReplicaId: '77',
    secretId: '9',
    version: 2,
    secret: { helpers: [], secrets: [] },
    shares: [],
  }

  it('resolves Escape to Reject, as documented', () => {
    const onCancel = vi.fn()
    act(() =>
      root.render(
        <ReplicaAdoptionDialog
          open
          adoption={offer}
          sourceLabel="Alice"
          onAdopt={async () => {}}
          onAdopted={() => {}}
          priorFailure={null}
          onFailed={() => {}}
          onCancel={onCancel}
        />,
      ),
    )

    const dialog = document.querySelector('[role="dialog"]')!
    act(() => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('the fingerprint dialog', () => {
  const protocol = {
    getFingerprint: vi.fn(async () => '1234567890123456'),
    verifyFingerprint: vi.fn(async () => true),
  } as unknown as ReplicaProtocol

  it('re-offers no decision on a channel this device already confirmed', async () => {
    await act(async () => {
      root.render(
        <ReplicaFingerprintDialog
          open
          replica={view({ status: 'paired' })}
          protocol={protocol}
          protocolTimeoutSecs={300}
          onConfirm={() => {}}
          onDeclineAdoption={() => {}}
          onRefuse={() => {}}
          onClose={() => {}}
        />,
      )
    })

    expect(text()).toContain('already confirmed this code')
    expect(text()).not.toContain('Codes match')
    expect(text()).not.toContain('Doesn’t match')
    expect(text()).not.toContain('until you confirm')
  })

  it('records a refusal rather than just closing', async () => {
    const onRefuse = vi.fn()
    const onClose = vi.fn()
    await act(async () => {
      root.render(
        <ReplicaFingerprintDialog
          open
          replica={view({ status: 'pending' })}
          protocol={protocol}
          protocolTimeoutSecs={300}
          onConfirm={() => {}}
          onDeclineAdoption={() => {}}
          onRefuse={onRefuse}
          onClose={onClose}
        />,
      )
    })

    act(() => button(/Doesn’t match/).click())

    expect(onRefuse).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('says a hosted replica mirrors on its own, without asking for Sync now', async () => {
    await act(async () => {
      root.render(
        <ReplicaFingerprintDialog
          open
          replica={view({ status: 'pending', helperActorId: 'h1', name: 'Hosted' })}
          protocol={protocol}
          protocolTimeoutSecs={300}
          onConfirm={() => {}}
          onDeclineAdoption={() => {}}
          onRefuse={() => {}}
          onClose={() => {}}
        />,
      )
    })

    await act(async () => button(/Codes match/).click())

    expect(text()).toContain('the mirror goes out now')
    expect(text()).not.toContain('will not mirror automatically')
    expect(text()).not.toContain('press “Sync now”')
  })

  it('starts a reopened dialog from a clean attempt and a freshly derived code', async () => {
    const getFingerprint = vi.fn(async () => '1234567890123456')
    const freshProtocol = { getFingerprint, verifyFingerprint: vi.fn(async () => true) } as unknown as ReplicaProtocol
    const renderOpen = (open: boolean) =>
      act(async () => {
        root.render(
          <ReplicaFingerprintDialog
            open={open}
            replica={view({ status: 'pending' })}
            protocol={freshProtocol}
            protocolTimeoutSecs={300}
            onConfirm={() => {}}
            onDeclineAdoption={() => {}}
            onRefuse={() => {}}
            onClose={() => {}}
          />,
        )
      })

    await renderOpen(true)
    await act(async () => button(/Codes match/).click())
    expect(text()).toContain('Confirmed on this device')

    await renderOpen(false)
    await renderOpen(true)

    expect(text()).not.toContain('Confirmed on this device')
    expect(button(/Codes match/).disabled).toBe(false)
    expect(getFingerprint).toHaveBeenCalledTimes(2)
  })

  it('shows why the code could not be derived, and derives it again on Retry', async () => {
    const getFingerprint = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ code: 'channel', message: 'channel not found' })
      .mockResolvedValueOnce('1234567890123456')
    const flakyProtocol = { getFingerprint, verifyFingerprint: vi.fn(async () => true) } as unknown as ReplicaProtocol
    await act(async () => {
      root.render(
        <ReplicaFingerprintDialog
          open
          replica={view({ status: 'pending' })}
          protocol={flakyProtocol}
          protocolTimeoutSecs={300}
          onConfirm={() => {}}
          onDeclineAdoption={() => {}}
          onRefuse={() => {}}
          onClose={() => {}}
        />,
      )
    })
    expect(text()).toContain('channel not found')
    expect(button(/Codes match/).disabled).toBe(true)

    await act(async () => button(/Retry/).click())

    expect(text()).not.toContain('channel not found')
    expect(button(/Codes match/).disabled).toBe(false)
  })

  describe('on a destination, where confirming adopts the source\'s vault', () => {
    function renderDestination(handlers: {
      onConfirm?: () => void
      onDeclineAdoption?: () => void
      onClose?: () => void
      verify?: ReturnType<typeof vi.fn>
    }) {
      const verify = handlers.verify ?? vi.fn(async () => true)
      const destinationProtocol = {
        getFingerprint: vi.fn(async () => '1234567890123456'),
        verifyFingerprint: verify,
      } as unknown as ReplicaProtocol
      return act(async () => {
        root.render(
          <ReplicaFingerprintDialog
            open
            replica={view({ status: 'pending', direction: 'replica_destination', name: 'Alice' })}
            protocol={destinationProtocol}
            protocolTimeoutSecs={300}
            onConfirm={handlers.onConfirm ?? (() => {})}
            onDeclineAdoption={handlers.onDeclineAdoption ?? (() => {})}
            onRefuse={() => {}}
            onClose={handlers.onClose ?? (() => {})}
          />,
        )
      })
    }

    it('asks about adoption before confirming anything', async () => {
      const verify = vi.fn(async () => true)
      const onConfirm = vi.fn()
      await renderDestination({ verify, onConfirm })

      await act(async () => button(/Codes match/).click())

      expect(text()).toContain('Confirming adopts Alice’s vault')
      expect(verify).not.toHaveBeenCalled()
      expect(onConfirm).not.toHaveBeenCalled()
    })

    it('declines by never confirming', async () => {
      const verify = vi.fn(async () => true)
      const onDeclineAdoption = vi.fn()
      const onClose = vi.fn()
      await renderDestination({ verify, onDeclineAdoption, onClose })

      await act(async () => button(/Codes match/).click())
      await act(async () => button(/Don’t adopt/).click())

      expect(onDeclineAdoption).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(verify).not.toHaveBeenCalled()
    })

    it('confirms, recording the consent, only once adoption is agreed', async () => {
      const verify = vi.fn(async () => true)
      const onConfirm = vi.fn()
      await renderDestination({ verify, onConfirm })

      await act(async () => button(/Codes match/).click())
      await act(async () => button(/Adopt and confirm/).click())

      expect(verify).toHaveBeenCalledTimes(1)
      expect(onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({ local: true, adoptionConsented: true, adoptionDeclined: false }),
      )
      expect(text()).toContain('adopted here as soon as it arrives')
    })

    it('makes not adopting the default answer', async () => {
      await renderDestination({})
      await act(async () => button(/Codes match/).click())

      // The filled button is the default; the destructive answer is outlined.
      expect(button(/Don’t adopt/).className).toContain('MuiButton-contained')
      expect(button(/Adopt and confirm/).className).toContain('MuiButton-outlined')
    })
  })
})
