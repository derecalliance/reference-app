import { fromBase64Url, toBase64Url } from './derecApi'

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

function contactKey(ns: string, secretId: string, channelId: string): string {
  return `${partition(ns, secretId)}:contact:${channelId}`
}

function contactIndexKey(ns: string, secretId: string): string {
  return `${partition(ns, secretId)}:contact-index`
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
    localStorage.setItem(key, JSON.stringify(idx))
  }
}

// ── Channel store ────────────────────────────────────────────────────────────

export function makeChannelStore(namespace: string) {
  return {
    async load(secretId: string, channelId: string): Promise<Uint8Array | null> {
      const val = localStorage.getItem(contactKey(namespace, secretId, channelId))
      return val ? fromBase64Url(val) : null
    },

    async save(secretId: string, channelId: string, bytes: Uint8Array): Promise<void> {
      localStorage.setItem(contactKey(namespace, secretId, channelId), toBase64Url(bytes))
      addToIndex(contactIndexKey(namespace, secretId), channelId)
    },

    async listChannels(secretId: string): Promise<string[]> {
      return loadStringArray(contactIndexKey(namespace, secretId))
    },

    async remove(secretId: string, channelId: string): Promise<boolean> {
      const key = contactKey(namespace, secretId, channelId)
      const existed = localStorage.getItem(key) !== null
      localStorage.removeItem(key)
      const idx = loadStringArray(contactIndexKey(namespace, secretId)).filter(
        (id) => id !== channelId,
      )
      localStorage.setItem(contactIndexKey(namespace, secretId), JSON.stringify(idx))
      return existed
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
      localStorage.setItem(key, JSON.stringify(links))
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
     * `null` marks a channel with no stored secret of `kind`.
     *
     * `missingPolicy` is the library's contract for absent entries: `skip`
     * tolerates them, `fail` treats them as a cross-store invariant breach.
     */
    async loadMany(
      secretId: string,
      channelIds: string[],
      kind: 0 | 1 | 2,
      missingPolicy: 'skip' | 'fail',
    ): Promise<Array<Uint8Array | null>> {
      const result: Array<Uint8Array | null> = []
      const missing: string[] = []

      for (const channelId of channelIds) {
        const val = localStorage.getItem(secretKey(namespace, secretId, channelId, kind))
        if (val) {
          result.push(fromBase64Url(val))
        } else {
          missing.push(channelId)
          result.push(null)
        }
      }

      if (missingPolicy === 'fail' && missing.length > 0) {
        throw new Error(
          `secret store: missing kind ${kind} entries for channel(s): ${missing.join(', ')}`,
        )
      }
      return result
    },

    async save(
      secretId: string,
      channelId: string,
      kind: 0 | 1 | 2,
      value: Uint8Array,
    ): Promise<void> {
      localStorage.setItem(secretKey(namespace, secretId, channelId, kind), toBase64Url(value))
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
      localStorage.setItem(
        shareDataKey(namespace, secretId, channelId, share.version),
        toBase64Url(share.bytes),
      )
      // `share.secretId` is the Owner's, which for a Helper differs from the
      // partition it is filed under.
      localStorage.setItem(
        shareMetaKey(namespace, secretId, channelId, share.version),
        share.secretId,
      )

      const cKey = channelVersionsKey(namespace, secretId, channelId)
      const storedVersions = loadNumberArray(cKey)
      if (!storedVersions.includes(share.version)) {
        storedVersions.push(share.version)
        localStorage.setItem(cKey, JSON.stringify(storedVersions))
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
      localStorage.setItem(shareChannelsKey(namespace, secretId), JSON.stringify(remaining))
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
      localStorage.setItem(userSecretKey(namespace, secretId), JSON.stringify(stored))
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
type StateKindNum = 0 | 1 | 2 | 3

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
 * Only the fields that form a kind's *key* may take part. This is not the same
 * as "every field present": a SharingRound item carries a `version`, but the
 * key for kind 3 has no secondary field at all. Including it would key the
 * write as `3:<version>` while every read looked for `3:` — the row would be
 * written and then never found, and the sharing round would never complete.
 *
 *   0 PendingVerification → channel_id
 *   1 PendingRecovery     → secret_id (recovered) + version
 *   2 PendingUnpair       → channel_id
 *   3 SharingRound        → (none; at most one per secret)
 */
function canonicalStateKey(fields: StateKeyFields): string {
  switch (fields.kind) {
    case 0:
    case 2:
      return `${fields.kind}:${fields.channel_id ?? ''}`
    case 1:
      return `${fields.kind}:${fields.secret_id ?? ''}:${fields.version ?? ''}`
    case 3:
      return '3'
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

      localStorage.setItem(
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
      localStorage.setItem(idxKey, JSON.stringify(remaining))

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

export function makeTransport(sendFn: (uri: string, message: Uint8Array) => Promise<void>) {
  return {
    async send(endpoint: { protocol: string; uri: string }, message: Uint8Array): Promise<void> {
      await sendFn(endpoint.uri, message)
    },
  }
}
