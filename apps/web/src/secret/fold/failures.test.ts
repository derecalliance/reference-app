// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { StatusEnum, type DeRecEvent } from '@derec-alliance/web'
import { describe, expect, it, vi } from 'vitest'

import { RoundTracker } from '../rounds'
import { secret } from '../testSecret'
import { foldEvent, type FoldContext } from '.'

function context(): FoldContext {
  return {
    log: vi.fn(),
    notify: { error: vi.fn(), info: vi.fn(), outcome: vi.fn() },
    effects: {
      refreshReplicas: vi.fn(),
      openFingerprint: vi.fn(),
      openAdoption: vi.fn(),
      pairingRejected: vi.fn(),
      pairingCompleted: vi.fn(),
      unpairSettled: vi.fn(),
      channelsLinked: vi.fn(),
    },
    rounds: new RoundTracker(),
    flowProgressed: vi.fn(),
    roundResolved: vi.fn(),
    getSecret: () => secret(),
    commit: vi.fn(),
    offerReplicaAdoption: vi.fn(),
    readChannelInfo: vi.fn(() => null),
    channelInfoOutcome: vi.fn(),
    awaitingIdentityAnswer: vi.fn(() => false),
    isShareHeld: vi.fn(() => true),
    respondToFailure: vi.fn(),
  }
}

function requestFailed(overrides: Partial<Extract<DeRecEvent, { type: 'RequestFailed' }>>): DeRecEvent {
  return {
    type: 'RequestFailed',
    channel_id: '7',
    action_kind: 'StoreShare',
    responded: false,
    status: StatusEnum.Fail,
    memo: 'request could not be processed',
    error_code: 'store_error',
    message: 'quota exceeded',
    ...overrides,
  } as DeRecEvent
}

describe('RequestFailed (SDK 0.0.9)', () => {
  // This secret runs with `auto_respond_on_failure` off: a token the library
  // hands back is the app's to answer, or the peer times out.
  it('answers an unanswered request with the status and memo the library chose', () => {
    const ctx = context()
    const action = new Uint8Array([1, 2, 3])

    foldEvent(
      secret(),
      requestFailed({ action, status: StatusEnum.Rejected, memo: "the sender's role does not permit this request" }),
      ctx,
    )

    expect(ctx.respondToFailure).toHaveBeenCalledWith(
      action,
      StatusEnum.Rejected,
      "the sender's role does not permit this request",
    )
    expect(ctx.notify.error).toHaveBeenCalled()
  })

  it('does not answer twice what the library already answered', () => {
    const ctx = context()

    foldEvent(secret(), requestFailed({ responded: true }), ctx)

    expect(ctx.respondToFailure).not.toHaveBeenCalled()
  })

  it('reports a failure with no reply target without trying to answer it', () => {
    const ctx = context()

    foldEvent(secret(), requestFailed({ action: undefined }), ctx)

    expect(ctx.respondToFailure).not.toHaveBeenCalled()
    expect(ctx.log).toHaveBeenCalledWith(expect.objectContaining({ step: 'RequestFailed' }))
  })
})

describe('refusals the library made itself', () => {
  it('reports a refused share by its status name', () => {
    const ctx = context()

    foldEvent(
      secret(),
      { type: 'ShareRefused', channel_id: '7', version: 2, status: StatusEnum.VerificationFailed, memo: 'bad proof' },
      ctx,
    )

    expect(ctx.notify.error).toHaveBeenCalledWith(
      expect.stringContaining('v2'),
      'VerificationFailed: bad proof',
      { channelId: '7' },
    )
  })
})
