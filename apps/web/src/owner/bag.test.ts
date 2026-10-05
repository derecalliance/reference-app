// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import type { StoredReplicaMember } from '../stores'
import type { BagVersion } from '../types'
import { buildSecretContainerPayload, replicaGroupFromStore, userSecretIdHex } from './bag'

function member(overrides: Partial<StoredReplicaMember> = {}): StoredReplicaMember {
  return { replicaId: '11', channelId: '500', role: 'Source', status: 'Paired', name: 'Laptop', ...overrides }
}

function version(overrides: Partial<BagVersion> = {}): BagVersion {
  return {
    version: 3,
    participantIds: [],
    verifiedParticipantIds: [],
    failedParticipantIds: [],
    secrets: [],
    rawBytes: '',
    helpers: [],
    ...overrides,
  }
}

describe('replicaGroupFromStore', () => {
  it('names every member, this device included, on the channel of its own row', () => {
    const group = replicaGroupFromStore(
      [
        member(),
        // Admitted since the last round: still on its pairing channel.
        member({ replicaId: '22', channelId: '777', role: 'Destination', name: 'Phone' }),
      ],
      '11',
    )

    expect(group).toEqual({
      channelId: '500',
      members: [
        { replicaId: '11', role: 'Source', name: 'Laptop' },
        { replicaId: '22', role: 'Destination', name: 'Phone' },
      ],
    })
  })

  it('leaves out a member that is leaving, as the library does', () => {
    const group = replicaGroupFromStore([member(), member({ replicaId: '22', status: 'Unpairing' })], '11')

    expect(group?.members.map(m => m.replicaId)).toEqual(['11'])
  })

  it('is null with no group', () => {
    expect(replicaGroupFromStore([], '11')).toBeNull()
  })
})

describe('buildSecretContainerPayload', () => {
  it('carries the replica group, with the key elided', () => {
    const payload = buildSecretContainerPayload(
      version({ replicas: { channelId: '500', members: [{ replicaId: '11', role: 'Source', name: 'Laptop' }] } }),
    )

    expect(payload.replicas).toEqual({
      channel_id: '500',
      members: [{ replica_id: '11', role: 'Source', name: 'Laptop', transports: '(advertised endpoints)' }],
      shared_key: '(32-byte group key)',
    })
  })

  it('shows no group as null, and an untracked version as unknown rather than empty', () => {
    expect(buildSecretContainerPayload(version({ replicas: null })).replicas).toBeNull()
    expect(buildSecretContainerPayload(version()).replicas).toBe('(not recorded for this version)')
  })
})

describe('buildSecretContainerPayload masking', () => {
  const withSecret = version({ secrets: [{ id: 'ab', name: 'seed', data: 'correct horse' }] })

  it('masks secret values unless asked to reveal them', () => {
    const masked = JSON.stringify(buildSecretContainerPayload(withSecret, { maskSecrets: true }))
    expect(masked).not.toContain('correct horse')
    expect(masked).toContain('seed')

    expect(JSON.stringify(buildSecretContainerPayload(withSecret))).toContain('correct horse')
  })
})

describe('userSecretIdHex', () => {
  it('shows a minted hex id and its base64url form from an adopted snapshot identically', () => {
    // 0xfb 0xff 0x10 in base64url is "-_8Q".
    expect(userSecretIdHex('fbff10')).toBe('fbff10')
    expect(userSecretIdHex('-_8Q')).toBe('fbff10')
  })
})
