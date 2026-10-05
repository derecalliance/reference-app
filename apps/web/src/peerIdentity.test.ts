// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import {
  resolvePeerActor,
  resolveRosterEntries,
  type PeerActorCandidate,
  type RosterCandidate,
} from './peerIdentity'

const GRPC = 'grpc://localhost:50051'

function actor(id: string, name: string, uris: string[], channelId?: string): RosterCandidate {
  return {
    id,
    name,
    transport: { uri: uris[0] },
    transports: uris.map(uri => ({ uri })),
    channel_id: channelId,
  }
}

describe('resolveRosterEntries', () => {
  it('tells apart two gRPC-only helpers that share one authority', () => {
    // Both advertise only the node's one gRPC endpoint: a URI-keyed lookup
    // gave both rows the last helper's identity.
    const alex = actor('a1', 'Alex', [GRPC])
    const richard = actor('r1', 'Richard', [GRPC])

    const matches = resolveRosterEntries(
      [
        { channelId: '11', transports: [{ uri: GRPC }], name: 'Alex' },
        { channelId: '22', transports: [{ uri: GRPC }], name: 'Richard' },
      ],
      [alex, richard],
    )

    expect(matches.map(m => m.actor?.id)).toEqual(['a1', 'r1'])
    expect(matches.map(m => m.transportUri)).toEqual([GRPC, GRPC])
  })

  it('matches on the unique HTTPS mailbox across every advertised endpoint', () => {
    const both = actor('b1', 'Both', [GRPC, 'http://localhost:5000/derec/b1'])
    const grpcOnly = actor('g1', 'Grpc', [GRPC])

    const [match] = resolveRosterEntries(
      [{ channelId: '11', transports: [{ uri: GRPC }, { uri: 'http://localhost:5000/derec/b1' }] }],
      [both, grpcOnly],
    )

    expect(match.actor?.id).toBe('b1')
    // The endpoint recorded is the entry's own first one the actor advertises.
    expect(match.transportUri).toBe(GRPC)
  })

  it('falls back to the channel id when neither URI nor name tells them apart', () => {
    const first = actor('a1', 'Helper', [GRPC], '22')
    const second = actor('a2', 'Helper', [GRPC], '11')

    const matches = resolveRosterEntries(
      [
        { channelId: '11', transports: [{ uri: GRPC }], name: 'Helper' },
        { channelId: '22', transports: [{ uri: GRPC }], name: 'Helper' },
      ],
      [first, second],
    )

    expect(matches.map(m => m.actor?.id)).toEqual(['a2', 'a1'])
  })

  it('never resolves two entries to one actor, leaving the ambiguous one unidentified', () => {
    const alex = actor('a1', 'Alex', [GRPC])

    const matches = resolveRosterEntries(
      [
        { channelId: '11', transports: [{ uri: GRPC }], name: 'Alex' },
        { channelId: '22', transports: [{ uri: GRPC }], name: 'Alex' },
      ],
      [alex],
    )

    expect(matches.map(m => m.actor?.id)).toEqual(['a1', undefined])
    expect(matches[1].transportUri).toBe(GRPC)
  })

  it('does not guess between namesakes', () => {
    const matches = resolveRosterEntries(
      [{ channelId: '11', transports: [{ uri: GRPC }], name: 'Helper' }],
      [actor('a1', 'Helper', [GRPC]), actor('a2', 'Helper', [GRPC])],
    )

    expect(matches[0].actor).toBeUndefined()
  })

  it('keeps the entry’s own first endpoint for a peer the roster does not know', () => {
    const [match] = resolveRosterEntries(
      [{ channelId: '11', transports: [{ uri: 'http://elsewhere/derec/x' }, { uri: GRPC }] }],
      [],
    )

    expect(match).toEqual({ actor: undefined, transportUri: 'http://elsewhere/derec/x' })
  })
})

describe('resolvePeerActor', () => {
  const NODE = 'http://localhost:5000/derec'
  function owner(id: string, name: string, uri = `${NODE}/${id}`): PeerActorCandidate {
    return { id, role: 'owner', name, transport: { protocol: 'https', uri }, browser_managed: true }
  }

  it('does not adopt a lone local owner for a peer on another node', () => {
    // QA: Bob (node B) accepted Alice (node A); the sole unknown owner on
    // node B, "AliceRecB2", was adopted and relabelled the row.
    const stale = owner('stale', 'AliceRecB2')
    const resolved = resolvePeerActor([owner('self', 'Bob'), stale], {
      selfActorId: 'self',
      peerTransportUris: ['http://other-node:5000/derec/alice'],
    })
    expect(resolved).toBeNull()
  })

  it('resolves nothing when no endpoint of the peer is known', () => {
    const resolved = resolvePeerActor([owner('self', 'Bob'), owner('x', 'Only')], {
      selfActorId: 'self',
      peerTransportUris: [],
    })
    expect(resolved).toBeNull()
  })

  it('identifies a local peer by its own mailbox', () => {
    const alice = owner('alice', 'Alice')
    const resolved = resolvePeerActor([owner('self', 'Bob'), owner('x', 'X'), alice], {
      selfActorId: 'self',
      peerTransportUris: [alice.transport.uri],
    })
    expect(resolved?.id).toBe('alice')
  })

  it('never identifies anyone by a gRPC authority several actors share', () => {
    const grpc = (id: string): PeerActorCandidate => ({
      id,
      role: 'helper',
      name: id,
      transport: { protocol: 'grpc', uri: GRPC },
    })
    expect(
      resolvePeerActor([grpc('a'), grpc('b')], { selfActorId: 'self', peerTransportUris: [GRPC] }),
    ).toBeNull()
  })
})
