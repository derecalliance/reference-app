// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  apiLinkRemoteHelperChannels,
  offersRemoteLink,
  parseHelperMailbox,
} from './remoteHelperLink'
import type { PairedParticipant } from './types'

const ID = '3f2b8c1e-5d4a-4b6f-9e2d-1a7c0b9d8e6f'
const HERE = 'http://localhost:5000'

function row(uri: string, overrides: Partial<PairedParticipant> = {}): PairedParticipant {
  return {
    id: `peer-1`,
    name: 'Richard',
    channelId: '7',
    transport: { protocol: uri.startsWith('grpc') ? 'grpc' : 'https', uri },
    secretShares: [],
    connectionStatus: 'paired',
    peerRole: 'helper',
    ...overrides,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('parseHelperMailbox', () => {
  it('splits a mailbox into its node and actor', () => {
    expect(parseHelperMailbox(` http://other:5500/derec/${ID} `)).toEqual({
      baseUrl: 'http://other:5500',
      actorId: ID,
    })
  })

  it('refuses anything that is not a mailbox', () => {
    expect(parseHelperMailbox('grpc://other:50051')).toBeNull()
    expect(parseHelperMailbox('http://other:5500/derec/not-an-id')).toBeNull()
  })
})

describe('offersRemoteLink', () => {
  it('offers it for a helper on another node, or with no known mailbox', () => {
    expect(offersRemoteLink(row(`http://other:5500/derec/${ID}`), HERE)).toBe(true)
    expect(offersRemoteLink(row('grpc://other:50051'), HERE)).toBe(true)
  })

  it('leaves this node’s helpers to the side panel, and browser or owner peers alone', () => {
    expect(offersRemoteLink(row(`${HERE}/derec/${ID}`), HERE)).toBe(false)
    expect(offersRemoteLink(row(`http://other:5500/derec/${ID}`, { browserManaged: true }), HERE)).toBe(false)
    expect(offersRemoteLink(row(`http://other:5500/derec/${ID}`, { peerRole: 'owner' }), HERE)).toBe(false)
  })
})

describe('apiLinkRemoteHelperChannels', () => {
  it('posts the link to the helper’s own node', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await apiLinkRemoteHelperChannels({ baseUrl: 'http://other:5500', actorId: ID }, '7', '3')

    expect(fetchMock).toHaveBeenCalledWith(
      `http://other:5500/api/v1/helpers/${ID}/link`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ channel_id: '7', link_to_channel_id: '3' }),
      }),
    )
  })
})
