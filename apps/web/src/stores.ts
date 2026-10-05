// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { TRANSPORT_PROTOCOL_GRPC } from './contactDto'
import { DeliveryError, fromBase64Url, toBase64Url } from './derecApi'
import { errorText } from './errorText'
import type { Transport } from './types'

// ── Key layout ───────────────────────────────────────────────────────────────
//
// Every store is partitioned by `secretId`: a protocol instance is bound to a
// single secret, and one browser profile runs several instances (one for the
// secret it owns, one per owner it helps). Keys therefore carry the secret id
// between the namespace and the record type:
//
//   derec:<ns>:<secretId>:<record>:<...>

function partition(ns: string, secretId: string): string {
  return `derec:${ns}:${secretId}`
}

/**
 * The `replicaId` the protocol reserves as "absent". Seeing it on a channel
 * store call means the call addresses a helper channel rather than a member of
 * the replica group.
 */
const HELPER_REPLICA_ID = '0'

/** Helper channels are keyed by `channelId`. */
function helperRecordKey(ns: string, secretId: string, channelId: string): string {
  return `${partition(ns, secretId)}:channel:helper:${channelId}`
}

/**
 * Replica-group members are keyed by `replicaId` **alone**.
 *
 * Every member of a group shares one `channelId`, so the channel cannot be the
 * key; and a member moves between channels during an admission handover while
 * remaining the same member, so keying on the pair would lose the row exactly
 * when that move needs to be observed.
 */
function memberRecordKey(ns: string, secretId: string, replicaId: string): string {
  return `${partition(ns, secretId)}:channel:replica:${replicaId}`
}

/** Insertion-ordered index of helper channel ids in this partition. */
function helperIndexKey(ns: string, secretId: string): string {
  return `${partition(ns, secretId)}:channel-idx:helper`
}

/** Insertion-ordered index of replica ids in this partition. */
function memberIndexKey(ns: string, secretId: string): string {
  return `${partition(ns, secretId)}:channel-idx:replica`
}

/** Key for the bidirectional channel-link graph (owned by the channel store). */
function channelLinkKey(ns: string, secretId: string): string {
  return `${partition(ns, secretId)}:channel-links`
}

function secretKey(ns: string, secretId: string, channelId: string, kind: 0 | 1 | 2): string {
  return `${partition(ns, secretId)}:secret:${channelId}:${kind}`
}

/**
 * Clears all localStorage entries for a given namespace prefix, across every
 * secret partition. Must be called before entering recovery mode to simulate a
 * fresh device with no prior protocol state.
 */
export function clearNamespace(ns: string): void {
  const prefix = `derec:${ns}:`
  const toRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && key.startsWith(prefix)) toRemove.push(key)
  }
  for (const key of toRemove) localStorage.removeItem(key)
}

// ── Storage quota ────────────────────────────────────────────────────────────
//
// Every store here writes to localStorage, which holds a few megabytes per
// origin. When a write is refused the library sees only a generic "store
// backend error" — the reason does not survive the trip through WASM — so the
// refusal is also recorded here, where the runtime can read it back and say
// what actually went wrong.

/** Thrown when browser storage refuses a write because it is full. */
export class StorageQuotaError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(STORAGE_FULL_MESSAGE, options)
    this.name = 'StorageQuotaError'
  }
}

/** What a full browser storage means for the person using the app. */
export const STORAGE_FULL_MESSAGE =
  'This browser’s storage for the app is full, so the change could not be saved. ' +
  'Remove vaults or secrets you no longer need (or use smaller secrets), then try again.'

/** When storage last refused a write, or `null` if it has not since it was last read. */
let lastQuotaFailureAt: number | null = null

/** Whether `err` is the browser refusing a write for lack of space. */
export function isQuotaError(err: unknown): boolean {
  if (err instanceof StorageQuotaError) return true
  if (!(err instanceof DOMException)) return false
  // `code` 22 / the Firefox name cover browsers that predate the standard name.
  return err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22
}

/** `localStorage.setItem`, recording a quota refusal before rethrowing it legibly. */
function storeItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch (err) {
    if (!isQuotaError(err)) throw err
    lastQuotaFailureAt = Date.now()
    throw new StorageQuotaError({ cause: err })
  }
}

/**
 * Whether a store write was refused for lack of space since `sinceMs`, and
 * forget it either way. The runtime calls this when a flow fails with a
 * generic store error, to replace that with what actually happened.
 */
export function takeStorageQuotaFailure(sinceMs: number): boolean {
  const failed = lastQuotaFailureAt !== null && lastQuotaFailureAt >= sinceMs
  lastQuotaFailureAt = null
  return failed
}

/** How recent a refused write must be to explain a generic store error. */
const QUOTA_FAILURE_RELEVANCE_MS = 60_000

/**
 * `error` in words a person can act on: the library's generic "store backend
 * error" becomes "storage is full" when a write was refused for lack of space
 * within the last minute. Anything else is returned unchanged.
 */
export function describeStorageFailure(error: string): string {
  const recent = lastQuotaFailureAt !== null && Date.now() - lastQuotaFailureAt <= QUOTA_FAILURE_RELEVANCE_MS
  if (!recent || !/store backend error|store_error|storage/i.test(error)) return error
  return `${STORAGE_FULL_MESSAGE} (${error})`
}

const HEADROOM_PROBE_KEY = 'derec:storage-headroom-probe'

/**
 * Whether browser storage can take `chars` more characters right now.
 *
 * localStorage reports no free space, so this asks it directly: it writes a
 * throwaway value of that size and removes it at once. Checked before work
 * whose writes cannot be taken back — a protect round sends each share to its
 * helper *before* storing this side's copy, so running out of space halfway
 * would leave the helpers holding a version this vault never recorded.
 */
export function hasStorageHeadroom(chars: number): boolean {
  if (chars <= 0) return true
  try {
    localStorage.setItem(HEADROOM_PROBE_KEY, 'x'.repeat(chars))
    return true
  } catch (err) {
    if (isQuotaError(err)) return false
    throw err
  } finally {
    try {
      localStorage.removeItem(HEADROOM_PROBE_KEY)
    } catch {
      // Nothing was written, or storage is unavailable altogether.
    }
  }
}

function loadStringArray(key: string): string[] {
  const raw = localStorage.getItem(key)
  return raw ? (JSON.parse(raw) as string[]) : []
}

function loadNumberArray(key: string): number[] {
  const raw = localStorage.getItem(key)
  return raw ? (JSON.parse(raw) as number[]) : []
}

/** Append `value` to a JSON string-array at `key` if not already present. */
function addToIndex(key: string, value: string): void {
  const idx = loadStringArray(key)
  if (!idx.includes(value)) {
    idx.push(value)
    storeItem(key, JSON.stringify(idx))
  }
}

// ── Channel store ────────────────────────────────────────────────────────────

/**
 * Lift a channel record written before SDK 0.0.3 onto the endpoint *list*.
 *
 * `HelperChannel.transport` / `ReplicaMember.transport` became `transports`,
 * and the field carries no serde default — deliberately, so a stale row fails
 * loudly instead of decoding into a channel that looks paired and has no
 * endpoint. The documented migration is to wrap the stored object in an array,
 * which is what this does.
 *
 * Done as a **text** substitution, like the splice below and for the same
 * reason: every id in the record is a `u64`, and `JSON.parse` would round
 * anything above 2^53. The endpoint object is flat — `{"uri":…,"protocol":N}`
 * — so `[^{}]*` matches exactly its body.
 */
function liftLegacyTransport(text: string): string {
  return text.replace(/"transport":(\{[^{}]*\})/, '"transports":[$1]')
}

/**
 * Splice stored records into the JSON array the library expects.
 *
 * The bytes are spliced as **text** rather than parsed and re-serialised.
 * Channel and replica ids are `u64`, and round-tripping them through
 * `JSON.parse` would silently round every value above 2^53 to the nearest
 * double. A stored record is always the externally tagged `{"<variant>":{…}}`
 * that serde emits, so unwrapping it is a prefix/suffix slice — and the library
 * wants the *inner* records, not the tagged ones.
 */
function spliceRecords(rows: Array<string | null>, variant: 'Helper' | 'Replica'): Uint8Array {
  const tag = `{"${variant}":`
  const inner: string[] = []

  for (const row of rows) {
    if (!row) continue
    const text = liftLegacyTransport(new TextDecoder().decode(fromBase64Url(row)))
    if (!text.startsWith(tag)) continue
    inner.push(text.slice(tag.length, -1))
  }

  return new TextEncoder().encode(`[${inner.join(',')}]`)
}

// ── Listing filters ──────────────────────────────────────────────────────────
//
// The library narrows `listHelpers` / `listReplicas` with a filter. It is
// applied here so the store returns only what was asked; the library re-applies
// it to what comes back (`retain_matching` in `extensions/channel_store.rs`) as
// a safety net, so this is about not shipping rows across the boundary for
// nothing rather than about correctness.
//
// localStorage has no query language to push the filter into, so this is the
// list-and-match shape the SDK documents as correct-but-unoptimised. Ids come
// from the index, where they are already strings; `status` and `role` are read
// by parsing a throwaway copy of the record. Parsing is safe *for predicates*
// — the values are enum names, not `u64`s — while the record itself is still
// spliced from the original text, so no id is ever routed through `JSON.parse`.

type ChannelStatusName = 'Pending' | 'Paired' | 'Unpairing'

interface ChannelFilter<Role> {
  ids: string[]
  status: ChannelStatusName[]
  role: Role | null
  exclude: string[]
}

/** Serde omits a defaulted field, so an absent `status` is the default. */
const DEFAULT_STATUS: ChannelStatusName = 'Paired'

/**
 * The `status` and `role` of a stored record, or `null` when it cannot be
 * read. A row that will not parse cannot be shown to satisfy the filter, so it
 * is dropped rather than passed through — the library would fail to decode it
 * a moment later anyway.
 */
function readAttributes(
  row: string,
  variant: 'Helper' | 'Replica',
  roleField: 'peer_role' | 'role',
): { status: ChannelStatusName; role: unknown } | null {
  try {
    const text = new TextDecoder().decode(fromBase64Url(row))
    const parsed = JSON.parse(text) as Record<string, Record<string, unknown> | undefined>
    const record = parsed[variant]
    if (!record) return null
    return {
      status: (record['status'] as ChannelStatusName | undefined) ?? DEFAULT_STATUS,
      // Left as-is rather than coerced: the filter's role and the record's
      // role are the same Rust enum through the same serde, so comparing them
      // raw stays correct whatever representation that is.
      role: record[roleField],
    }
  } catch {
    return null
  }
}

function selectRows(
  ids: string[],
  toKey: (id: string) => string,
  filter: ChannelFilter<unknown> | undefined,
  variant: 'Helper' | 'Replica',
  roleField: 'peer_role' | 'role',
): Array<string | null> {
  const kept: Array<string | null> = []

  for (const id of ids) {
    if (filter) {
      if (filter.ids.length > 0 && !filter.ids.includes(id)) continue
      if (filter.exclude.includes(id)) continue
    }

    const row = localStorage.getItem(toKey(id))
    if (!row) continue

    if (filter && (filter.status.length > 0 || filter.role !== null)) {
      const attrs = readAttributes(row, variant, roleField)
      if (!attrs) continue
      if (filter.status.length > 0 && !filter.status.includes(attrs.status)) continue
      if (filter.role !== null && filter.role !== attrs.role) continue
    }

    kept.push(row)
  }

  return kept
}

export function makeChannelStore(namespace: string) {
  /**
   * Which of the two keyspaces a call addresses. `replicaId === "0"` is the
   * protocol's "absent" marker and means the helper channel at `channelId`;
   * anything else is that member of the replica group.
   */
  function rowKey(secretId: string, channelId: string, replicaId: string): string {
    return replicaId === HELPER_REPLICA_ID
      ? helperRecordKey(namespace, secretId, channelId)
      : memberRecordKey(namespace, secretId, replicaId)
  }

  function indexKey(secretId: string, replicaId: string): string {
    return replicaId === HELPER_REPLICA_ID
      ? helperIndexKey(namespace, secretId)
      : memberIndexKey(namespace, secretId)
  }

  return {
    async load(
      secretId: string,
      channelId: string,
      replicaId: string,
    ): Promise<Uint8Array | null> {
      const val = localStorage.getItem(rowKey(secretId, channelId, replicaId))
      if (!val) return null
      const text = liftLegacyTransport(new TextDecoder().decode(fromBase64Url(val)))
      return new TextEncoder().encode(text)
    },

    async save(
      secretId: string,
      channelId: string,
      replicaId: string,
      bytes: Uint8Array,
    ): Promise<void> {
      storeItem(rowKey(secretId, channelId, replicaId), toBase64Url(bytes))
      addToIndex(
        indexKey(secretId, replicaId),
        replicaId === HELPER_REPLICA_ID ? channelId : replicaId,
      )
    },

    async remove(
      secretId: string,
      channelId: string,
      replicaId: string,
    ): Promise<boolean> {
      const key = rowKey(secretId, channelId, replicaId)
      const existed = localStorage.getItem(key) !== null
      localStorage.removeItem(key)

      const idxKey = indexKey(secretId, replicaId)
      const dropped = replicaId === HELPER_REPLICA_ID ? channelId : replicaId
      storeItem(
        idxKey,
        JSON.stringify(loadStringArray(idxKey).filter(id => id !== dropped)),
      )
      return existed
    },

    /**
     * JSON array of the helper channels stored under `secretId` that `filter`
     * selects. Filter ids are channel ids and its role is the peer's role.
     */
    async listHelpers(
      secretId: string,
      filter?: ChannelFilter<unknown>,
    ): Promise<Uint8Array> {
      const ids = loadStringArray(helperIndexKey(namespace, secretId))
      return spliceRecords(
        selectRows(
          ids,
          id => helperRecordKey(namespace, secretId, id),
          filter,
          'Helper',
          'peer_role',
        ),
        'Helper',
      )
    },

    /**
     * JSON array of the replica-group members stored under `secretId` that
     * `filter` selects, including this device's own row unless the filter
     * excludes it. Filter ids are replica ids and its role is the member's.
     *
     * The order chooses the app's source-succession policy: when the group's
     * `Source` is removed, the protocol promotes the first entry here that is
     * neither departing nor leaving. The index is append-only, so this is join
     * order — the longest-standing member succeeds. That is a deliberate
     * choice, not the storage engine's default. Filtering preserves it, since
     * it only ever drops entries.
     */
    async listReplicas(
      secretId: string,
      filter?: ChannelFilter<unknown>,
    ): Promise<Uint8Array> {
      const ids = loadStringArray(memberIndexKey(namespace, secretId))
      return spliceRecords(
        selectRows(
          ids,
          id => memberRecordKey(namespace, secretId, id),
          filter,
          'Replica',
          'role',
        ),
        'Replica',
      )
    },

    // ── Channel linking (same Owner identity) ────────────────────────────────
    // Undirected, idempotent, transitive. Linking moves no data — it only
    // records that two channels belong to the same Owner.

    async linkChannel(secretId: string, a: string, b: string): Promise<void> {
      if (a === b) return
      const key = channelLinkKey(namespace, secretId)
      const links: Record<string, string[]> = JSON.parse(localStorage.getItem(key) || '{}')
      if (!links[a]) links[a] = []
      if (!links[b]) links[b] = []
      if (!links[a].includes(b)) links[a].push(b)
      if (!links[b].includes(a)) links[b].push(a)
      storeItem(key, JSON.stringify(links))
    },

    /** Transitive closure of `channelId`, including `channelId` itself. */
    async linkedChannels(secretId: string, channelId: string): Promise<string[]> {
      const links: Record<string, string[]> = JSON.parse(
        localStorage.getItem(channelLinkKey(namespace, secretId)) || '{}',
      )
      const visited = new Set<string>()
      const queue = [channelId]
      while (queue.length) {
        const curr = queue.shift()!
        if (visited.has(curr)) continue
        visited.add(curr)
        for (const linked of links[curr] ?? []) {
          if (!visited.has(linked)) queue.push(linked)
        }
      }
      return Array.from(visited)
    },
  }
}

/**
 * Lifecycle of a stored channel, as the library records it.
 *
 * `Pending` is the one that changes app behaviour: such a channel is not a
 * publish target, not a recovery source, and inbound messages on it are
 * ignored. Every replica pairing and every `NoKeys` pairing lands there and
 * stays until a fingerprint is confirmed on both sides.
 */
export type ChannelStatus = 'Pending' | 'Paired' | 'Unpairing'

/**
 * Read the status of a stored helper channel, or `null` if there is no such
 * record.
 *
 * Parsing the record here is safe in a way that parsing it for `listHelpers`
 * would not be: only the `status` string is read, so the `u64` ids that
 * `JSON.parse` would round are discarded rather than handed back to the
 * library.
 */
export function readHelperChannelStatus(
  namespace: string,
  secretId: string,
  channelId: string,
): ChannelStatus | null {
  const raw = localStorage.getItem(helperRecordKey(namespace, secretId, channelId))
  if (!raw) return null

  try {
    const record = JSON.parse(new TextDecoder().decode(fromBase64Url(raw))) as {
      Helper?: { status?: string }
    }
    const status = record.Helper?.status
    return status === 'Pending' || status === 'Paired' || status === 'Unpairing'
      ? status
      : // A record that omits `status` predates the field; the library's serde
        // default is `Paired`, so match it rather than inventing a third state.
        'Paired'
  } catch {
    return null
  }
}

/** One helper-type channel, as the library's own store holds it. */
export interface StoredHelperChannel {
  /** Decimal string — from the index, so never rounded through `JSON.parse`. */
  channelId: string
  status: ChannelStatus
  /** The *peer's* role as serde wrote it — `Helper` or `Owner` — or `null`. */
  peerRole: string | null
  /** Seconds since the epoch the record was created, or `null` when absent. */
  createdAtSecs: number | null
}

/**
 * Every helper-type channel in one partition, in index order.
 *
 * Read for the app's own decisions — which channels a broadcast may name, and
 * which `Pending` record a failed pairing left behind. Only the status, role
 * and timestamp are parsed out; the channel id comes from the index.
 */
export function listHelperChannels(namespace: string, secretId: string): StoredHelperChannel[] {
  const channels: StoredHelperChannel[] = []
  for (const channelId of loadStringArray(helperIndexKey(namespace, secretId))) {
    const raw = localStorage.getItem(helperRecordKey(namespace, secretId, channelId))
    if (!raw) continue
    try {
      const record = (
        JSON.parse(new TextDecoder().decode(fromBase64Url(raw))) as {
          Helper?: Record<string, unknown>
        }
      ).Helper
      if (!record) continue
      const status = record['status']
      const createdAt = record['created_at']
      channels.push({
        channelId,
        status: status === 'Pending' || status === 'Paired' || status === 'Unpairing' ? status : 'Paired',
        peerRole: typeof record['peer_role'] === 'string' ? (record['peer_role'] as string) : null,
        createdAtSecs: typeof createdAt === 'number' && createdAt > 0 ? createdAt : null,
      })
    } catch {
      // A record that will not parse is the library's to report.
    }
  }
  return channels
}

/**
 * Remove every trace of one helper-type channel from this partition: its
 * record and index entry, its keys and pairing material, the shares filed
 * under it and its links.
 *
 * The local half of an unpair, for when there is no peer left to agree to
 * one — a pairing that never completed, or a helper deleted from its node.
 * Nothing is sent: the peer, if it still exists, keeps its side. The caller
 * must hold the protocol lock, so the library cannot be mid-way through a
 * call that reads these rows.
 */
export function forgetHelperChannel(namespace: string, secretId: string, channelId: string): void {
  localStorage.removeItem(helperRecordKey(namespace, secretId, channelId))
  const idxKey = helperIndexKey(namespace, secretId)
  const index = loadStringArray(idxKey)
  if (index.includes(channelId)) {
    storeItem(idxKey, JSON.stringify(index.filter(id => id !== channelId)))
  }

  for (const kind of [0, 1, 2] as const) {
    localStorage.removeItem(secretKey(namespace, secretId, channelId, kind))
  }

  const cKey = channelVersionsKey(namespace, secretId, channelId)
  for (const version of loadNumberArray(cKey)) {
    localStorage.removeItem(shareDataKey(namespace, secretId, channelId, version))
    localStorage.removeItem(shareMetaKey(namespace, secretId, channelId, version))
  }
  localStorage.removeItem(cKey)
  const sharesKey = shareChannelsKey(namespace, secretId)
  const withShares = loadStringArray(sharesKey)
  if (withShares.includes(channelId)) {
    storeItem(sharesKey, JSON.stringify(withShares.filter(id => id !== channelId)))
  }

  const linksKey = channelLinkKey(namespace, secretId)
  const links: Record<string, string[]> = JSON.parse(localStorage.getItem(linksKey) || '{}')
  if (links[channelId] !== undefined || Object.values(links).some(peers => peers.includes(channelId))) {
    delete links[channelId]
    for (const id of Object.keys(links)) links[id] = links[id].filter(peer => peer !== channelId)
    storeItem(linksKey, JSON.stringify(links))
  }
}

/** What a peer last told this vault about itself, as its channel record holds it. */
export interface StoredChannelInfo {
  /** The peer's advertised `name`, or `null` when it sent none. */
  name: string | null
  /** Every endpoint the peer advertised, in its preference order. */
  transports: Transport[]
}

/**
 * The name and endpoints the **library's own store** holds for a helper-type
 * channel — what `UpdateChannelInfo` rewrites on the receiving side.
 *
 * The protocol's `ChannelInfoUpdated` event names the channel only; the new
 * values are applied to the stored record, so this is where they are read back
 * from. Only `communication_info` and `transports` are read, so `JSON.parse`
 * rounding the record's `u64` channel id does not matter here.
 */
export function readHelperChannelInfo(
  namespace: string,
  secretId: string,
  channelId: string,
): StoredChannelInfo | null {
  const raw = localStorage.getItem(helperRecordKey(namespace, secretId, channelId))
  if (!raw) return null

  try {
    const text = liftLegacyTransport(new TextDecoder().decode(fromBase64Url(raw)))
    const record = (JSON.parse(text) as { Helper?: Record<string, unknown> }).Helper
    if (!record) return null

    const info = record['communication_info']
    const name =
      typeof info === 'object' && info !== null && typeof (info as Record<string, unknown>)['name'] === 'string'
        ? ((info as Record<string, string>)['name'].trim() || null)
        : null

    const transports = Array.isArray(record['transports'])
      ? (record['transports'] as Array<{ uri?: unknown; protocol?: unknown }>).flatMap(t =>
          typeof t.uri === 'string' && t.uri !== ''
            ? [{ uri: t.uri, protocol: transportProtocolOf(t.protocol) }]
            : [],
        )
      : []

    return { name, transports }
  } catch {
    return null
  }
}

/** A stored protocol discriminant or name, as the app's transport type. */
function transportProtocolOf(value: unknown): Transport['protocol'] {
  if (value === TRANSPORT_PROTOCOL_GRPC || (typeof value === 'string' && value.toLowerCase() === 'grpc')) {
    return 'grpc'
  }
  return 'https'
}

/**
 * One member of the replica group, as the **library's own store** holds it.
 *
 * Read straight from the store rather than from the app's replica bookkeeping,
 * because the two can disagree and only this side is authoritative about who
 * the protocol thinks is in the group. A member the app has forgotten — or
 * never recorded — still blocks a peer from rejoining with the same replica id,
 * and until this existed nothing in the app could see it, let alone name it.
 */
export interface StoredReplicaMember {
  /** Decimal string; the key the member is stored under and `RemoveReplica` names. */
  replicaId: string
  /** Decimal string, or `null` if the record does not parse. */
  channelId: string | null
  /** `Source` or `Destination`, as serde wrote it. */
  role: string | null
  status: ChannelStatus
  /** The peer's advertised name, when it sent one. */
  name: string | null
}

/**
 * Every replica-group member in one partition, oldest first.
 *
 * `replicaId` comes from the index, which stores it as a string already, and
 * `channelId` is pulled out with a regex rather than `JSON.parse` — both ids are
 * `u64` and would be silently rounded by a parse, which is the same reason
 * `readHelperChannelStatus` reads only the status string.
 */
export function listReplicaMembers(namespace: string, secretId: string): StoredReplicaMember[] {
  const members: StoredReplicaMember[] = []

  for (const replicaId of loadStringArray(memberIndexKey(namespace, secretId))) {
    const raw = localStorage.getItem(memberRecordKey(namespace, secretId, replicaId))
    if (!raw) continue

    let text: string
    try {
      text = new TextDecoder().decode(fromBase64Url(raw))
    } catch {
      continue
    }

    const record = (() => {
      try {
        return (JSON.parse(text) as { Replica?: Record<string, unknown> }).Replica ?? null
      } catch {
        return null
      }
    })()

    const status = record?.['status']
    members.push({
      replicaId,
      channelId: /"channel_id":(\d+)/.exec(text)?.[1] ?? null,
      role: typeof record?.['role'] === 'string' ? (record['role'] as string) : null,
      status:
        status === 'Pending' || status === 'Paired' || status === 'Unpairing' ? status : 'Paired',
      name: readMemberName(record),
    })
  }

  return members
}

function readMemberName(record: Record<string, unknown> | null): string | null {
  const info = record?.['communication_info']
  if (typeof info !== 'object' || info === null) return null
  const name = (info as Record<string, unknown>)['name']
  return typeof name === 'string' && name.trim() !== '' ? name : null
}

// ── Secret store ─────────────────────────────────────────────────────────────

// kind 0 = SharedKey (32 raw bytes), kind 1 = PairingSecret (ephemeral), kind 2 = PairingContact (ephemeral)
export function makeSecretStore(namespace: string) {
  return {
    async load(
      secretId: string,
      channelId: string,
      kind: 0 | 1 | 2,
    ): Promise<Uint8Array | null> {
      const val = localStorage.getItem(secretKey(namespace, secretId, channelId, kind))
      return val ? fromBase64Url(val) : null
    },

    /**
     * Batch sibling of `load`, used when the protocol broadcasts to many
     * channels at once. Returns one entry per input id in the same order;
     * `null` marks a channel with no stored secret of `kind`. Whether a
     * missing entry is an error is the library's call (SDK 0.0.6 dropped the
     * `missingPolicy` argument that used to pass that decision down here).
     */
    async loadMany(
      secretId: string,
      channelIds: string[],
      kind: 0 | 1 | 2,
    ): Promise<Array<Uint8Array | null>> {
      return channelIds.map(channelId => {
        const val = localStorage.getItem(secretKey(namespace, secretId, channelId, kind))
        return val ? fromBase64Url(val) : null
      })
    },

    async save(
      secretId: string,
      channelId: string,
      kind: 0 | 1 | 2,
      value: Uint8Array,
    ): Promise<void> {
      storeItem(secretKey(namespace, secretId, channelId, kind), toBase64Url(value))
    },

    async remove(secretId: string, channelId: string, kind: 0 | 1 | 2): Promise<void> {
      localStorage.removeItem(secretKey(namespace, secretId, channelId, kind))
    },
  }
}

// ── Share types (matches WASM JS interface) ──────────────────────────────────

export interface Share {
  /** Numeric secret identifier (u64 as decimal string). */
  secretId: string
  version: number
  bytes: Uint8Array
}

// ── Share storage keys ───────────────────────────────────────────────────────

/** Encoded share bytes: derec:<ns>:<secretId>:share:<channelId>:<version> */
function shareDataKey(
  ns: string,
  secretId: string,
  channelId: string,
  version: number,
): string {
  return `${partition(ns, secretId)}:share:${channelId}:${version}`
}

/**
 * The *record's* secret id: derec:<ns>:<secretId>:share-meta:<channelId>:<version>
 *
 * Distinct from the partition key. A Helper stores every share it holds under
 * its own secret partition, but each record belongs to the Owner that sent it
 * and carries that Owner's `secret_id`. Discovery groups by the record value,
 * so conflating the two makes a Helper report its own id for every share it
 * holds — and a recovering Owner would never recognise its secret.
 */
function shareMetaKey(
  ns: string,
  secretId: string,
  channelId: string,
  version: number,
): string {
  return `${partition(ns, secretId)}:share-meta:${channelId}:${version}`
}

/** Version index per channel, within one secret partition. */
function channelVersionsKey(ns: string, secretId: string, channelId: string): string {
  return `${partition(ns, secretId)}:share-idx:channel-versions:${channelId}`
}

/** Index of channels that hold shares, within one secret partition. */
function shareChannelsKey(ns: string, secretId: string): string {
  return `${partition(ns, secretId)}:share-idx:channels`
}

/**
 * Raw stored share bytes (base64url) for display, or `null` when absent.
 *
 * `secretId` is the **partition** — the secret id of the instance that stored
 * the share. For a Helper that is its own secret id, *not* the owner id the
 * record carries (see `shareMetaKey`), so callers must not pass a share's
 * `secretId` field here.
 */
export function loadRawShare(
  ns: string,
  secretId: string,
  channelId: string,
  version: number,
): string | null {
  return localStorage.getItem(shareDataKey(ns, secretId, channelId, version))
}

// ── Share store ──────────────────────────────────────────────────────────────

export function makeShareStore(namespace: string) {
  // Read one share from storage, or null if absent. The secret id is the
  // partition key, so it needs no separate metadata record.
  function readShare(secretId: string, channelId: string, version: number): Share | null {
    const dataVal = localStorage.getItem(shareDataKey(namespace, secretId, channelId, version))
    if (!dataVal) return null
    // The owning secret comes off the record, never from the partition — see
    // `shareMetaKey`. Fall back to the partition only for records written
    // before the metadata existed.
    const recordSecretId =
      localStorage.getItem(shareMetaKey(namespace, secretId, channelId, version)) ?? secretId
    return { secretId: recordSecretId, version, bytes: fromBase64Url(dataVal) }
  }

  function versionsFor(secretId: string, channelId: string): number[] {
    return loadNumberArray(channelVersionsKey(namespace, secretId, channelId))
  }

  return {
    /**
     * Load shares stored on a single channel. An empty `versions` array means
     * "all versions of this secret on this channel".
     */
    async load(secretId: string, channelId: string, versions: number[]): Promise<Share[]> {
      const targetVersions = versions.length > 0 ? versions : versionsFor(secretId, channelId)
      const result: Share[] = []
      for (const v of targetVersions) {
        const share = readShare(secretId, channelId, v)
        if (share) result.push(share)
      }
      return result
    },

    /**
     * Load shares across several channels in one call. Recovery feeds this the
     * set from the channel store's `linkedChannels`. Flat list — version-dedup
     * is the caller's concern.
     */
    async loadMany(
      secretId: string,
      channelIds: string[],
      versions: number[],
    ): Promise<Share[]> {
      const versionFilter = versions.length > 0 ? new Set(versions) : null
      const result: Share[] = []
      for (const channelId of channelIds) {
        for (const v of versionsFor(secretId, channelId)) {
          if (versionFilter && !versionFilter.has(v)) continue
          const share = readShare(secretId, channelId, v)
          if (share) result.push(share)
        }
      }
      return result
    },

    /**
     * Load every share this secret holds across the given channels, all
     * versions. Used by discovery to enumerate holdings.
     */
    async loadAll(secretId: string, channelIds: string[]): Promise<Share[]> {
      return this.loadMany(secretId, channelIds, [])
    },

    async save(secretId: string, channelId: string, share: Share): Promise<void> {
      storeItem(
        shareDataKey(namespace, secretId, channelId, share.version),
        toBase64Url(share.bytes),
      )
      // `share.secretId` is the Owner's, which for a Helper differs from the
      // partition it is filed under.
      storeItem(
        shareMetaKey(namespace, secretId, channelId, share.version),
        share.secretId,
      )

      const cKey = channelVersionsKey(namespace, secretId, channelId)
      const storedVersions = loadNumberArray(cKey)
      if (!storedVersions.includes(share.version)) {
        storedVersions.push(share.version)
        storeItem(cKey, JSON.stringify(storedVersions))
      }
      addToIndex(shareChannelsKey(namespace, secretId), channelId)
    },

    /**
     * Highest version stored for this secret across every channel. The owner
     * stores its own committed shares, so this covers both roles without a
     * separate owner-side counter.
     */
    async latestVersion(secretId: string): Promise<number | null> {
      let max: number | null = null
      for (const channelId of loadStringArray(shareChannelsKey(namespace, secretId))) {
        for (const v of versionsFor(secretId, channelId)) {
          if (max === null || v > max) max = v
        }
      }
      return max
    },

    /**
     * Drop every share stored under `(secretId, channelId)` — invoked by the
     * unpair flow when a channel is torn down. Idempotent.
     */
    async removeChannel(secretId: string, channelId: string): Promise<void> {
      const cKey = channelVersionsKey(namespace, secretId, channelId)
      for (const v of loadNumberArray(cKey)) {
        localStorage.removeItem(shareDataKey(namespace, secretId, channelId, v))
        localStorage.removeItem(shareMetaKey(namespace, secretId, channelId, v))
      }
      localStorage.removeItem(cKey)

      const remaining = loadStringArray(shareChannelsKey(namespace, secretId)).filter(
        (c) => c !== channelId,
      )
      storeItem(shareChannelsKey(namespace, secretId), JSON.stringify(remaining))
    },
  }
}

// ── User secret store ────────────────────────────────────────────────────────

/** One user-facing secret entry, as the WASM bridge exchanges it. */
export interface UserSecretEntry {
  id: Uint8Array
  name: string
  data: Uint8Array
}

export interface UserSecrets {
  version: number
  secrets: UserSecretEntry[]
  description?: string
}

/** Persisted form — binary fields base64url-encoded so it survives JSON. */
interface StoredUserSecrets {
  version: number
  secrets: Array<{ id: string; name: string; data: string }>
  description?: string
}

function userSecretKey(ns: string, secretId: string): string {
  return `${partition(ns, secretId)}:user-secret`
}

/**
 * Latest user-facing secret snapshot per secret id. The library reads this in
 * its pair-completion auto-publish hook, so a peer that pairs after a protect
 * round still receives the current secret without an explicit re-publish.
 */
export function makeUserSecretStore(namespace: string) {
  return {
    async loadLatest(secretId: string): Promise<UserSecrets | null> {
      const raw = localStorage.getItem(userSecretKey(namespace, secretId))
      if (!raw) return null
      const stored = JSON.parse(raw) as StoredUserSecrets
      return {
        version: stored.version,
        description: stored.description,
        secrets: stored.secrets.map((s) => ({
          id: fromBase64Url(s.id),
          name: s.name,
          data: fromBase64Url(s.data),
        })),
      }
    },

    async saveLatest(secretId: string, value: UserSecrets): Promise<void> {
      const stored: StoredUserSecrets = {
        version: value.version,
        description: value.description,
        secrets: value.secrets.map((s) => ({
          id: toBase64Url(s.id),
          name: s.name,
          data: toBase64Url(s.data),
        })),
      }
      storeItem(userSecretKey(namespace, secretId), JSON.stringify(stored))
    },

    async remove(secretId: string): Promise<void> {
      localStorage.removeItem(userSecretKey(namespace, secretId))
    },
  }
}

// ── State store ──────────────────────────────────────────────────────────────

/**
 * In-flight orchestrator state: outstanding verification challenges, recovery
 * accumulators, pending unpair acks, and the active sharing round.
 *
 * The library hands over opaque JSON blobs. Rows are keyed by
 * `(secretId, kind, channel_id?, version?)` — `save` receives the item blob
 * (which carries those fields at its top level) while `load`/`remove` receive
 * a key blob with the same fields. Rather than depend on the two blobs
 * serializing byte-identically, both paths are reduced to the same canonical
 * composite key.
 */
type StateKindNum = 0 | 1 | 2 | 3 | 4

interface StateKeyFields {
  kind: StateKindNum
  channel_id?: string | null
  /**
   * PendingRecovery only: the secret *being recovered*, which is not the
   * secret naming the partition — a recovering device runs an ephemeral
   * instance whose own id owns the partition while the target belongs to the
   * wire. Part of the key so concurrent recoveries at the same version don't
   * share a row.
   */
  secret_id?: string | null
  version?: number | null
}

/**
 * Reduce a key or item blob to the row key for its kind.
 *
 * Only the fields that form a kind's *key* may take part, and which those are
 * is per kind rather than "every field present". Kind 4 is the one that bites:
 * its item carries the device's `local_version` while
 * `StateKey::PendingReplicaDiscovery` carries none, so including it would key the
 * write as `4:<version>` while every read looked for `4` — the row would be
 * written and then never found, and the check would never resolve.
 *
 * Kind 3 *is* keyed by version, and that is load-bearing: rounds are not
 * started only by `start(ProtectSecret)` — the pair-completion hook and the
 * promotion inside `verifyFingerprint` both publish while handling an inbound
 * message. A single unkeyed row let a second round overwrite the first's
 * accumulator, and then neither completed.
 *
 *   0 PendingVerification → channel_id
 *   1 PendingRecovery     → secret_id (recovered) + version
 *   2 PendingUnpair       → channel_id
 *   3 SharingRound        → version (one row per publishing round)
 *   4 PendingReplicaDiscovery    → (none; at most one per secret)
 */
function canonicalStateKey(fields: StateKeyFields): string {
  switch (fields.kind) {
    case 0:
    case 2:
      return `${fields.kind}:${fields.channel_id ?? ''}`
    case 1:
      return `${fields.kind}:${fields.secret_id ?? ''}:${fields.version ?? ''}`
    case 3:
      return `3:${fields.version ?? ''}`
    case 4:
      return '4'
  }
}

function decodeStateKeyFields(json: Uint8Array): StateKeyFields {
  return JSON.parse(new TextDecoder().decode(json)) as StateKeyFields
}

function stateRowKey(ns: string, secretId: string, composite: string): string {
  return `${partition(ns, secretId)}:state:${composite}`
}

/** Index of composite keys per `(secretId, kind)`, so `loadAll` can enumerate. */
function stateIndexKey(ns: string, secretId: string, kind: StateKindNum): string {
  return `${partition(ns, secretId)}:state-idx:${kind}`
}

export function makeStateStore(namespace: string) {
  return {
    async save(secretId: string, itemJson: Uint8Array): Promise<void> {
      // The item blob carries the same discriminator fields the key blob
      // does, so the row key is derivable without a separate key argument.
      const fields = decodeStateKeyFields(itemJson)
      const composite = canonicalStateKey(fields)

      storeItem(
        stateRowKey(namespace, secretId, composite),
        toBase64Url(itemJson),
      )
      addToIndex(stateIndexKey(namespace, secretId, fields.kind), composite)
    },

    async load(secretId: string, keyJson: Uint8Array): Promise<Uint8Array | null> {
      const composite = canonicalStateKey(decodeStateKeyFields(keyJson))
      const val = localStorage.getItem(stateRowKey(namespace, secretId, composite))
      return val ? fromBase64Url(val) : null
    },

    async remove(secretId: string, keyJson: Uint8Array): Promise<boolean> {
      const fields = decodeStateKeyFields(keyJson)
      const composite = canonicalStateKey(fields)
      const rowKey = stateRowKey(namespace, secretId, composite)

      const existed = localStorage.getItem(rowKey) !== null
      localStorage.removeItem(rowKey)

      const idxKey = stateIndexKey(namespace, secretId, fields.kind)
      const remaining = loadStringArray(idxKey).filter((c) => c !== composite)
      storeItem(idxKey, JSON.stringify(remaining))

      return existed
    },

    async loadAll(secretId: string, kind: StateKindNum): Promise<Uint8Array[]> {
      const result: Uint8Array[] = []
      for (const composite of loadStringArray(stateIndexKey(namespace, secretId, kind))) {
        const val = localStorage.getItem(stateRowKey(namespace, secretId, composite))
        if (val) result.push(fromBase64Url(val))
      }
      return result
    },
  }
}

// ── Transport ────────────────────────────────────────────────────────────────

/**
 * The library hands over every endpoint the peer advertised that survived its
 * transport policy, in the peer's own order, and leaves the choice between
 * them to the application.
 *
 * HTTP endpoints are posted directly. gRPC endpoints go through the backend
 * relay: a browser cannot speak gRPC itself, and the backend already
 * terminates transport for every actor here. Anything else is skipped. The
 * first endpoint that accepts wins; the promise rejects only when none did.
 *
 * An endpoint that could not be *reached* — a `DeliveryError` marked
 * transient: the node restarting, a proxy timing out — is tried again after
 * each of `retryDelaysMs` before the next one is tried. Message handling is
 * idempotent on the receiving side, so a duplicate is harmless. The retry is
 * deliberately short and bounded: the library awaits this call while holding
 * the protocol lock, so a long one would stall every other flow on the vault.
 * A peer down for longer is reported as not delivered, and each flow says so.
 */
export function makeTransport(
  sendFn: (uri: string, message: Uint8Array) => Promise<void>,
  relayFn: (uri: string, message: Uint8Array) => Promise<void>,
  options: { retryDelaysMs?: readonly number[] } = {},
) {
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_SEND_RETRY_DELAYS_MS

  async function deliverWithRetry(
    deliver: (uri: string, message: Uint8Array) => Promise<void>,
    uri: string,
    message: Uint8Array,
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await deliver(uri, message)
        return
      } catch (err) {
        const transient = err instanceof DeliveryError && err.transient
        if (!transient || attempt >= retryDelaysMs.length) throw err
        await new Promise(resolve => setTimeout(resolve, retryDelaysMs[attempt]))
      }
    }
  }

  return {
    async send(
      endpoints: ReadonlyArray<{ protocol: string; uri: string }>,
      message: Uint8Array,
    ): Promise<void> {
      const plan = endpoints
        .map(e => {
          const protocol = e.protocol.toLowerCase()
          if (protocol === 'https') return { uri: e.uri, deliver: sendFn }
          if (protocol === 'grpc') return { uri: e.uri, deliver: relayFn }
          return null
        })
        .filter((leg): leg is { uri: string; deliver: typeof sendFn } => leg !== null)

      if (plan.length === 0) {
        throw new Error(
          `transport: no dialable endpoint among the peer's ${endpoints.length} offer(s)`,
        )
      }

      const failures: string[] = []
      for (const leg of plan) {
        try {
          await deliverWithRetry(leg.deliver, leg.uri, message)
          return
        } catch (err) {
          failures.push(`${leg.uri}: ${errorText(err)}`)
        }
      }

      const reason = `transport: no endpoint accepted the message — not delivered (${failures.join('; ')})`
      recordDeliveryFailure(plan.map(leg => leg.uri), reason)
      throw new Error(reason)
    },
  }
}

// ── Delivery failures, in the node's own words ───────────────────────────────
//
// The library reports a failed send as a bare "transport.send promise
// rejected": the reason this transport threw — the node's "relay delivery
// failed: …", "gRPC is disabled on this node", an unknown actor — does not
// survive the trip through WASM. Each failure is kept here, briefly, by the
// endpoints it was for, so whoever reports the library's error can put the
// real reason back.

/** How long a recorded failure may explain a library error. */
const DELIVERY_FAILURE_RELEVANCE_MS = 30_000

const deliveryFailures = new Map<string, { message: string; at: number }>()

function recordDeliveryFailure(uris: readonly string[], message: string): void {
  const at = Date.now()
  for (const uri of uris) deliveryFailures.set(uri, { message, at })
}

/**
 * `error` with the transport's own reason restored, when it is the library's
 * bare "transport.send" failure and a send to one of `uris` — or, with none
 * given, any send — failed moments ago. Anything else is returned unchanged.
 */
export function explainDeliveryFailure(error: string, uris?: readonly string[]): string {
  if (!/transport\.send/i.test(error)) return error
  const now = Date.now()
  let latest: { message: string; at: number } | null = null
  for (const [uri, failure] of deliveryFailures) {
    if (now - failure.at > DELIVERY_FAILURE_RELEVANCE_MS) {
      deliveryFailures.delete(uri)
      continue
    }
    if (uris && !uris.includes(uri)) continue
    if (!latest || failure.at > latest.at) latest = failure
  }
  return latest ? `${error}: ${latest.message}` : error
}

/** Pauses before each resend of an unreachable endpoint — about 1.6 s in all. */
const DEFAULT_SEND_RETRY_DELAYS_MS: readonly number[] = [400, 1200]
