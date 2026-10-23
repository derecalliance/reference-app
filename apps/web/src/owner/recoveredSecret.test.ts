// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import type { RecoveredSecretSnapshot } from '../types'
import { snapshotFromEvent, snapshotToPayload } from './recoveredSecret'

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

function snapshot(communicationInfo?: Record<string, string>): RecoveredSecretSnapshot {
  return {
    helpers: [
      {
        channelId: '7',
        transports: [{ uri: 'http://h/derec/a', protocol: 'https' }],
        sharedKey: KEY,
        ...(communicationInfo ? { communicationInfo } : {}),
      },
    ],
    secrets: [],
    replicas: {
      channelId: '9',
      sharedKey: KEY,
      members: [
        {
          replicaId: '11',
          transports: [],
          role: 'Source',
          ...(communicationInfo ? { communicationInfo } : {}),
        },
      ],
    },
  }
}

describe('snapshotToPayload', () => {
  // SDK builds before the 0.0.9 fix refused a present-but-undefined
  // `communication_info` ("Reflect.get called on non-object"); the payload
  // still leaves the key out for a peer recorded without one.
  it('omits communication_info for a peer recorded without one', () => {
    const payload = snapshotToPayload(snapshot())

    expect('communication_info' in payload.helpers[0]).toBe(false)
    expect('communication_info' in payload.replicas!.members[0]).toBe(false)
  })

  it('passes communication_info through when there is one', () => {
    const payload = snapshotToPayload(snapshot({ name: 'Alex' }))

    expect(payload.helpers[0].communication_info).toEqual({ name: 'Alex' })
    expect(payload.replicas!.members[0].communication_info).toEqual({ name: 'Alex' })
  })
})

describe('helper weights through a persisted snapshot', () => {
  // `restore` writes each helper's roster weight into its channel record, and
  // reads an absent one as 1 — so a weight dropped on the way through the
  // persisted snapshot would quietly reset the owner's weights.
  it('carries a helper\'s weight from the event to the restore payload', () => {
    const payload = snapshotToPayload(snapshot())
    const recovered = snapshotFromEvent({
      ...payload,
      helpers: [{ ...payload.helpers[0], weight: 3 }],
    })

    expect(recovered.helpers[0].weight).toBe(3)
    expect(snapshotToPayload(recovered).helpers[0].weight).toBe(3)
  })

  it('leaves the weight out of a snapshot persisted before weighted helpers', () => {
    expect('weight' in snapshotToPayload(snapshot()).helpers[0]).toBe(false)
  })
})

describe('the recovered roster\'s threshold and null communication info (SDK 0.0.9)', () => {
  it('carries the threshold from the event to the restore payload', () => {
    const payload = snapshotToPayload(snapshot())
    const recovered = snapshotFromEvent({ ...payload, threshold: 4 })

    expect(recovered.threshold).toBe(4)
    expect(snapshotToPayload(recovered).threshold).toBe(4)
  })

  it('reads a null communication_info as none', () => {
    const payload = snapshotToPayload(snapshot())
    const recovered = snapshotFromEvent({
      ...payload,
      helpers: [{ ...payload.helpers[0], communication_info: null }],
    })

    expect(recovered.helpers[0].communicationInfo).toBeUndefined()
  })
})

