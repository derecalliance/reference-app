// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { DeRecEvent } from '@derec-alliance/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ReplicaCatchUp, type ReplicaCatchUpDeps } from './replicaSync'

const discoveryComplete = (fetchedFrom?: string): DeRecEvent =>
  ({
    type: 'ReplicaDiscoveryComplete',
    local_version: 0,
    group_version: fetchedFrom ? 1 : 0,
    ...(fetchedFrom ? { fetched_from: fetchedFrom } : {}),
  }) as DeRecEvent

const installed = (channelId: string): DeRecEvent =>
  ({
    type: 'ReplicaSecretInstalled',
    channel_id: channelId,
    from_replica_id: 'ff01',
    author_replica_id: 'ff01',
    secret_id: '99',
    version: 1,
    secret: { helpers: [], secrets: [] },
    shares: [],
  }) as DeRecEvent

function catchUp(overrides: Partial<ReplicaCatchUpDeps> = {}) {
  const deps: ReplicaCatchUpDeps = {
    // Asked: the request went out and the answer comes later, through `observe`.
    discover: vi.fn(async () => []),
    isEligible: () => true,
    log: vi.fn(),
    onChange: vi.fn(),
    ...overrides,
  }
  return { tracker: new ReplicaCatchUp(deps), deps }
}

describe('ReplicaCatchUp', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('asks for the copy as soon as it starts, and reports the channel as syncing', async () => {
    const { tracker, deps } = catchUp()

    tracker.start('900')
    await vi.advanceTimersByTimeAsync(0)

    expect(deps.discover).toHaveBeenCalledTimes(1)
    expect(tracker.syncing()).toEqual(['900'])
  })

  it('stops once the copy arrives on the channel', async () => {
    const { tracker, deps } = catchUp()
    tracker.start('900')
    await vi.advanceTimersByTimeAsync(0)

    tracker.observe(installed('900'))
    await vi.advanceTimersByTimeAsync(120_000)

    expect(tracker.syncing()).toEqual([])
    expect(deps.discover).toHaveBeenCalledTimes(1)
  })

  it('stops when the group answers with nothing newer', async () => {
    // Every member answered and none is ahead: there is nothing to fetch.
    const { tracker } = catchUp()
    tracker.start('900')
    await vi.advanceTimersByTimeAsync(0)

    tracker.observe(discoveryComplete())

    expect(tracker.syncing()).toEqual([])
  })

  it('keeps waiting while a fetch it was told about is in flight', async () => {
    const { tracker } = catchUp()
    tracker.start('900')
    await vi.advanceTimersByTimeAsync(0)

    tracker.observe(discoveryComplete('ff01'))

    expect(tracker.syncing()).toEqual(['900'])
  })

  it('retries when an attempt gets no answer in time', async () => {
    // The library never times out a discovery nobody answers — a source that
    // has not confirmed yet ignores it — so the retry has to come from here.
    const { tracker, deps } = catchUp()
    tracker.start('900')
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(ReplicaCatchUp.ATTEMPT_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(ReplicaCatchUp.RETRY_DELAYS_MS[0])

    expect(deps.discover).toHaveBeenCalledTimes(2)
    expect(tracker.syncing()).toEqual(['900'])
  })

  it('backs off between attempts when no peer could be reached', async () => {
    // `start` answers synchronously with a completion when it sent nothing.
    const discover = vi.fn(async () => [discoveryComplete()])
    const { tracker } = catchUp({ discover })
    tracker.start('900')
    await vi.advanceTimersByTimeAsync(0)
    expect(discover).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(ReplicaCatchUp.RETRY_DELAYS_MS[0])
    expect(discover).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(ReplicaCatchUp.RETRY_DELAYS_MS[1])
    expect(discover).toHaveBeenCalledTimes(3)
    expect(tracker.syncing()).toEqual(['900'])
  })

  it('does not mistake the completion folded during its own start for an answer', async () => {
    // The runtime folds `start`'s events as they come back, so the same
    // "nobody reachable" completion also reaches `observe` while starting.
    const { tracker } = catchUp({
      discover: vi.fn(async () => {
        tracker.observe(discoveryComplete())
        return [discoveryComplete()]
      }),
    })
    tracker.start('900')
    await vi.advanceTimersByTimeAsync(0)

    expect(tracker.syncing()).toEqual(['900'])
  })

  it('retries after a failed attempt', async () => {
    const discover = vi.fn(async () => {
      throw new Error('offline')
    })
    const { tracker } = catchUp({ discover })
    tracker.start('900')
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(ReplicaCatchUp.RETRY_DELAYS_MS[0])

    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('drops a channel that is no longer eligible', async () => {
    // Forgotten, adopted or no longer confirmed: nothing to ask for any more.
    let eligible = true
    const { tracker, deps } = catchUp({ isEligible: () => eligible })
    tracker.start('900')
    await vi.advanceTimersByTimeAsync(0)

    eligible = false
    await vi.advanceTimersByTimeAsync(ReplicaCatchUp.ATTEMPT_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(ReplicaCatchUp.RETRY_DELAYS_MS[0])

    expect(tracker.syncing()).toEqual([])
    expect(deps.discover).toHaveBeenCalledTimes(1)
  })

  it('caps the delay between attempts', () => {
    const delays = ReplicaCatchUp.RETRY_DELAYS_MS
    expect(ReplicaCatchUp.retryDelay(delays.length + 10)).toBe(delays[delays.length - 1])
  })

  it('stops everything on stopAll', async () => {
    const { tracker, deps } = catchUp()
    tracker.start('900')
    await vi.advanceTimersByTimeAsync(0)

    tracker.stopAll()
    await vi.advanceTimersByTimeAsync(300_000)

    expect(tracker.syncing()).toEqual([])
    expect(deps.discover).toHaveBeenCalledTimes(1)
  })

  it('starting a channel that is already syncing does not ask twice', async () => {
    const { tracker, deps } = catchUp()
    tracker.start('900')
    tracker.start('900')
    await vi.advanceTimersByTimeAsync(0)

    expect(deps.discover).toHaveBeenCalledTimes(1)
  })
})
