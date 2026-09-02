import { beforeEach, describe, expect, it } from 'vitest'
import { makeChannelStore, makeStateStore, makeTransport } from './stores'

const NS = 'test-ns'
const SECRET = '42'
/** The protocol's "absent" replica id — addresses a helper channel. */
const HELPER = '0'

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function decode(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes))
}

/** A stored record is the externally tagged union serde emits. */
function helperRecord(channelId: string) {
  return encode({ Helper: { channel_id: channelId, status: 'Paired' } })
}

function replicaRecord(channelId: string, replicaId: string, role = 'Destination') {
  return encode({ Replica: { channel_id: channelId, replica_id: replicaId, role } })
}

describe('channel store', () => {
  beforeEach(() => localStorage.clear())

  it('keeps helpers and replica members in separate keyspaces', async () => {
    const store = makeChannelStore(NS)

    // Same channel id, one as a helper and one as a group member. Collapsing
    // these into one keyspace would make the second write clobber the first.
    await store.save(SECRET, '100', HELPER, helperRecord('100'))
    await store.save(SECRET, '100', '7', replicaRecord('100', '7'))

    expect(decode((await store.load(SECRET, '100', HELPER))!)).toEqual({
      Helper: { channel_id: '100', status: 'Paired' },
    })
    expect(decode((await store.load(SECRET, '100', '7'))!)).toEqual({
      Replica: { channel_id: '100', replica_id: '7', role: 'Destination' },
    })
  })

  it('finds a member by replicaId alone after it moves channels', async () => {
    const store = makeChannelStore(NS)
    await store.save(SECRET, '100', '7', replicaRecord('100', '7'))

    // An admission handover moves the member to a new channel. It is the same
    // member, so it must stay findable — including under its *old* channel id,
    // because the key is the replica id and the channel is only context.
    await store.save(SECRET, '200', '7', replicaRecord('200', '7'))

    expect(decode((await store.load(SECRET, '999', '7'))!)).toEqual({
      Replica: { channel_id: '200', replica_id: '7', role: 'Destination' },
    })
    expect(decode(await store.listReplicas(SECRET))).toHaveLength(1)
  })

  it('lists unwrapped inner records, not the tagged union', async () => {
    const store = makeChannelStore(NS)
    await store.save(SECRET, '100', HELPER, helperRecord('100'))
    await store.save(SECRET, '101', HELPER, helperRecord('101'))

    expect(decode(await store.listHelpers(SECRET))).toEqual([
      { channel_id: '100', status: 'Paired' },
      { channel_id: '101', status: 'Paired' },
    ])
  })

  it('keeps each listing to its own variant', async () => {
    const store = makeChannelStore(NS)
    await store.save(SECRET, '100', HELPER, helperRecord('100'))
    await store.save(SECRET, '300', '7', replicaRecord('300', '7'))

    expect(decode(await store.listHelpers(SECRET))).toHaveLength(1)
    expect(decode(await store.listReplicas(SECRET))).toEqual([
      { channel_id: '300', replica_id: '7', role: 'Destination' },
    ])
  })

  it('preserves u64 ids beyond 2^53 exactly', async () => {
    const store = makeChannelStore(NS)
    // Above Number.MAX_SAFE_INTEGER: a listing that round-tripped through
    // JSON.parse would round this to ...6776 and silently corrupt the roster.
    const huge = '18446744073709551615'
    await store.save(SECRET, huge, '9', replicaRecord(huge, '9'))

    const text = new TextDecoder().decode(await store.listReplicas(SECRET))
    expect(text).toContain(huge)
  })

  it('returns an empty JSON array when nothing is stored', async () => {
    const store = makeChannelStore(NS)
    expect(decode(await store.listHelpers(SECRET))).toEqual([])
    expect(decode(await store.listReplicas(SECRET))).toEqual([])
  })

  it('lists members in join order, which is the succession policy', async () => {
    const store = makeChannelStore(NS)
    await store.save(SECRET, '300', '11', replicaRecord('300', '11'))
    await store.save(SECRET, '300', '22', replicaRecord('300', '22'))
    await store.save(SECRET, '300', '33', replicaRecord('300', '33'))
    // Re-saving must not reorder: the protocol promotes the first eligible
    // entry, so an update should not change who succeeds.
    await store.save(SECRET, '300', '11', replicaRecord('300', '11', 'Source'))

    const ids = (decode(await store.listReplicas(SECRET)) as Array<{ replica_id: string }>)
      .map(m => m.replica_id)
    expect(ids).toEqual(['11', '22', '33'])
  })

  it('drops a removed record from its listing', async () => {
    const store = makeChannelStore(NS)
    await store.save(SECRET, '300', '11', replicaRecord('300', '11'))
    await store.save(SECRET, '300', '22', replicaRecord('300', '22'))

    expect(await store.remove(SECRET, '300', '11')).toBe(true)
    expect(await store.remove(SECRET, '300', '11')).toBe(false)

    const ids = (decode(await store.listReplicas(SECRET)) as Array<{ replica_id: string }>)
      .map(m => m.replica_id)
    expect(ids).toEqual(['22'])
  })

  it('partitions by secretId', async () => {
    const store = makeChannelStore(NS)
    await store.save(SECRET, '100', HELPER, helperRecord('100'))
    await store.save('99', '200', HELPER, helperRecord('200'))

    expect(decode(await store.listHelpers(SECRET))).toHaveLength(1)
    expect(decode(await store.listHelpers('99'))).toEqual([
      { channel_id: '200', status: 'Paired' },
    ])
  })
})

// The library narrows a listing with a filter and does *not* re-apply it to
// what comes back, so a store that ignored it would hand the protocol rows it
// asked to be spared — and the protocol would act on them.
describe('channel store listing filters', () => {
  beforeEach(() => localStorage.clear())

  const ANY: ChannelFilter = { ids: [], status: [], role: null, exclude: [] }

  interface ChannelFilter {
    ids: string[]
    status: Array<'Pending' | 'Paired' | 'Unpairing'>
    role: string | null
    exclude: string[]
  }

  function taggedHelper(channelId: string, status: string, peerRole: string) {
    return encode({ Helper: { channel_id: channelId, status, peer_role: peerRole } })
  }

  async function seedMembers(store: ReturnType<typeof makeChannelStore>) {
    await store.save(SECRET, '300', '11', encode({
      Replica: { channel_id: '300', replica_id: '11', role: 'Source', status: 'Paired' },
    }))
    await store.save(SECRET, '300', '22', encode({
      Replica: { channel_id: '300', replica_id: '22', role: 'Destination', status: 'Paired' },
    }))
    await store.save(SECRET, '300', '33', encode({
      Replica: { channel_id: '300', replica_id: '33', role: 'Destination', status: 'Pending' },
    }))
  }

  const memberIds = (bytes: Uint8Array) =>
    (decode(bytes) as Array<{ replica_id: string }>).map(m => m.replica_id)

  it('selects everything for an all-empty filter', async () => {
    const store = makeChannelStore(NS)
    await seedMembers(store)

    expect(memberIds(await store.listReplicas(SECRET, ANY))).toEqual(['11', '22', '33'])
  })

  it('restricts to the requested ids and applies exclude last', async () => {
    const store = makeChannelStore(NS)
    await seedMembers(store)

    expect(
      memberIds(await store.listReplicas(SECRET, { ...ANY, ids: ['11', '22'] })),
    ).toEqual(['11', '22'])
    // `exclude` overrides `ids`, so naming a member in both omits it.
    expect(
      memberIds(await store.listReplicas(SECRET, { ...ANY, ids: ['11', '22'], exclude: ['11'] })),
    ).toEqual(['22'])
  })

  it('restricts by status and role, combined with AND', async () => {
    const store = makeChannelStore(NS)
    await seedMembers(store)

    expect(memberIds(await store.listReplicas(SECRET, { ...ANY, status: ['Pending'] })))
      .toEqual(['33'])
    expect(memberIds(await store.listReplicas(SECRET, { ...ANY, role: 'Destination' })))
      .toEqual(['22', '33'])
    // This is the publish-target shape: paired destinations only.
    expect(
      memberIds(
        await store.listReplicas(SECRET, { ...ANY, status: ['Paired'], role: 'Destination' }),
      ),
    ).toEqual(['22'])
  })

  it('preserves join order, since filtering only ever drops entries', async () => {
    const store = makeChannelStore(NS)
    await seedMembers(store)

    expect(memberIds(await store.listReplicas(SECRET, { ...ANY, exclude: ['22'] })))
      .toEqual(['11', '33'])
  })

  it('reads a helper filter against channel_id and the peer role', async () => {
    const store = makeChannelStore(NS)
    await store.save(SECRET, '100', HELPER, taggedHelper('100', 'Paired', 'Owner'))
    await store.save(SECRET, '101', HELPER, taggedHelper('101', 'Pending', 'Helper'))

    const channelIds = (bytes: Uint8Array) =>
      (decode(bytes) as Array<{ channel_id: string }>).map(h => h.channel_id)

    expect(channelIds(await store.listHelpers(SECRET, { ...ANY, role: 'Helper' })))
      .toEqual(['101'])
    expect(channelIds(await store.listHelpers(SECRET, { ...ANY, ids: ['100'] })))
      .toEqual(['100'])
  })

  it('treats a record with no status as Paired, matching the serde default', async () => {
    const store = makeChannelStore(NS)
    await store.save(SECRET, '100', HELPER, encode({ Helper: { channel_id: '100' } }))

    expect(decode(await store.listHelpers(SECRET, { ...ANY, status: ['Paired'] })))
      .toHaveLength(1)
    expect(decode(await store.listHelpers(SECRET, { ...ANY, status: ['Pending'] })))
      .toEqual([])
  })
})

// `transport` became `transports` at SDK 0.0.3, with no serde default — a
// stale row fails to decode rather than yielding a paired-looking channel with
// no endpoint. Rows this app wrote before the upgrade are lifted on read.
describe('legacy channel records', () => {
  beforeEach(() => localStorage.clear())

  const legacy = (channelId: string) =>
    encode({
      Helper: {
        channel_id: channelId,
        transport: { uri: 'http://localhost:5000/derec/a', protocol: 0 },
        peer_role: 'Helper',
      },
    })

  it('wraps a stored single endpoint into the list on load', async () => {
    const store = makeChannelStore(NS)
    await store.save(SECRET, '100', HELPER, legacy('100'))

    expect(decode((await store.load(SECRET, '100', HELPER))!)).toEqual({
      Helper: {
        channel_id: '100',
        transports: [{ uri: 'http://localhost:5000/derec/a', protocol: 0 }],
        peer_role: 'Helper',
      },
    })
  })

  it('wraps it in listings too', async () => {
    const store = makeChannelStore(NS)
    await store.save(SECRET, '100', HELPER, legacy('100'))

    const [record] = decode(await store.listHelpers(SECRET)) as Array<{
      transports: Array<{ uri: string }>
    }>
    expect(record.transports).toEqual([{ uri: 'http://localhost:5000/derec/a', protocol: 0 }])
  })

  it('leaves a current record untouched', async () => {
    const store = makeChannelStore(NS)
    const current = encode({
      Helper: {
        channel_id: '100',
        transports: [
          { uri: 'https://a.example/derec', protocol: 0 },
          { uri: 'grpcs://a.example:443', protocol: 1 },
        ],
        peer_role: 'Helper',
      },
    })
    await store.save(SECRET, '100', HELPER, current)

    expect(decode((await store.load(SECRET, '100', HELPER))!)).toEqual(decode(current))
  })

  it('does not disturb u64 ids while lifting', async () => {
    const store = makeChannelStore(NS)
    const huge = '18446744073709551615'
    await store.save(SECRET, '100', HELPER, legacy(huge))

    const text = new TextDecoder().decode((await store.load(SECRET, '100', HELPER))!)
    expect(text).toContain(huge)
    expect(text).toContain('"transports":[')
  })
})

describe('transport', () => {
  const message = new TextEncoder().encode('bytes')
  const https = (uri: string) => ({ protocol: 'https', uri })
  const grpc = (uri: string) => ({ protocol: 'grpc', uri })

  it('posts directly to an http endpoint and never reaches the relay', () => {
    const posted: string[] = []
    const relayed: string[] = []
    const transport = makeTransport(
      async uri => { posted.push(uri) },
      async uri => { relayed.push(uri) },
    )

    return transport.send([https('https://a.example')], message).then(() => {
      expect(posted).toEqual(['https://a.example'])
      expect(relayed).toEqual([])
    })
  })

  it('sends a grpc endpoint through the relay, since a browser cannot dial it', async () => {
    const posted: string[] = []
    const relayed: string[] = []
    const transport = makeTransport(
      async uri => { posted.push(uri) },
      async uri => { relayed.push(uri) },
    )

    await transport.send([grpc('grpc://a.example:50051')], message)

    expect(relayed).toEqual(['grpc://a.example:50051'])
    expect(posted).toEqual([])
  })

  it('walks a mixed list in the peer order and stops at the first success', async () => {
    const attempted: string[] = []
    const transport = makeTransport(
      async uri => { attempted.push(uri) },
      async uri => { attempted.push(uri); throw new Error('relay off') },
    )

    await transport.send([grpc('grpc://a:1'), https('https://b:2')], message)

    expect(attempted).toEqual(['grpc://a:1', 'https://b:2'])
  })

  it('rejects when the relay is unavailable and grpc is all the peer offered', async () => {
    // With the relay disabled a browser owner genuinely has no way to reach a
    // grpc-only peer; the transport must say so rather than hang.
    const transport = makeTransport(
      async () => {},
      async () => { throw new Error('relay disabled') },
    )

    await expect(
      transport.send([grpc('grpc://a:1')], message),
    ).rejects.toThrow(/no endpoint accepted/)
  })

  it('rejects when the peer offered a protocol with no leg at all', async () => {
    const transport = makeTransport(async () => {}, async () => {})

    await expect(
      transport.send([{ protocol: 'quic', uri: 'quic://a:1' }], message),
    ).rejects.toThrow(/no dialable endpoint/)
  })
})

describe('state store', () => {
  beforeEach(() => localStorage.clear())

  /**
   * Kind 4 is the trap: its *item* carries a version while its *key* carries
   * none. Keying the write by version would file the row where no read ever
   * looks, and the check would hang forever rather than fail.
   */
  it('keys kind 4 without its item version', async () => {
    const store = makeStateStore(NS)
    await store.save(SECRET, encode({ kind: 4, version: 7, payload: 'x' }))

    const loaded = await store.load(SECRET, encode({ kind: 4 }))
    expect(loaded).not.toBeNull()
    expect(decode(loaded!)).toEqual({ kind: 4, version: 7, payload: 'x' })
  })

  /**
   * Kind 3 is the opposite, and getting it wrong is what let two publishing
   * rounds overwrite each other. Rounds start on their own — the
   * pair-completion hook and the promotion inside `verifyFingerprint` both
   * publish — so concurrent rounds are ordinary, and each needs its own row.
   */
  it('keys kind 3 by the round version, so concurrent rounds coexist', async () => {
    const store = makeStateStore(NS)
    await store.save(SECRET, encode({ kind: 3, version: 1, targets: ['a'] }))
    await store.save(SECRET, encode({ kind: 3, version: 2, targets: ['b'] }))

    expect(decode((await store.load(SECRET, encode({ kind: 3, version: 1 })))!)).toEqual({
      kind: 3,
      version: 1,
      targets: ['a'],
    })
    expect(await store.loadAll(SECRET, 3)).toHaveLength(2)

    expect(await store.remove(SECRET, encode({ kind: 3, version: 1 }))).toBe(true)
    expect(await store.loadAll(SECRET, 3)).toHaveLength(1)
  })

  it('enumerates PendingReplicaDiscovery rows under kind 4', async () => {
    const store = makeStateStore(NS)
    await store.save(SECRET, encode({ kind: 4, version: 2 }))

    expect(await store.loadAll(SECRET, 4)).toHaveLength(1)
    expect(await store.loadAll(SECRET, 3)).toHaveLength(0)
  })

  it('replaces a kind 4 row on re-save rather than accumulating', async () => {
    const store = makeStateStore(NS)
    await store.save(SECRET, encode({ kind: 4, version: 1 }))
    await store.save(SECRET, encode({ kind: 4, version: 2 }))

    const all = await store.loadAll(SECRET, 4)
    expect(all).toHaveLength(1)
    expect(decode(all[0])).toEqual({ kind: 4, version: 2 })
  })

  it('keys PendingVerification by channel and PendingRecovery by secret+version', async () => {
    const store = makeStateStore(NS)
    await store.save(SECRET, encode({ kind: 0, channel_id: 'a' }))
    await store.save(SECRET, encode({ kind: 0, channel_id: 'b' }))
    await store.save(SECRET, encode({ kind: 1, secret_id: '7', version: 1 }))
    await store.save(SECRET, encode({ kind: 1, secret_id: '7', version: 2 }))

    expect(await store.loadAll(SECRET, 0)).toHaveLength(2)
    expect(await store.loadAll(SECRET, 1)).toHaveLength(2)
    expect(await store.remove(SECRET, encode({ kind: 0, channel_id: 'a' }))).toBe(true)
    expect(await store.loadAll(SECRET, 0)).toHaveLength(1)
  })
})
