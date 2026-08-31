import { beforeEach, describe, expect, it } from 'vitest'
import { makeChannelStore, makeStateStore } from './stores'

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

  it('enumerates PendingSyncCheck rows under kind 4', async () => {
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
