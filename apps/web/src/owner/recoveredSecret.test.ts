// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import type { RecoveredSecretSnapshot } from '../types'
import { snapshotToPayload } from './recoveredSecret'

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
  // The SDK refuses a present-but-undefined `communication_info` with
  // `invalid_recovered_secret` ("Reflect.get called on non-object"), so a peer
  // recorded without one must not carry the key at all.
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
