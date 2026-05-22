import { fromBase64Url, toBase64Url } from './derecApi'

function contactKey(ns: string, channelId: string): string {
  return `derec:${ns}:contact:${channelId}`
}

/**
 * Clears all localStorage entries for a given namespace prefix.
 * Must be called before entering recovery mode to simulate a fresh device
 * with no prior protocol state.
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

function secretKey(ns: string, channelId: string, kind: 0 | 1 | 2): string {
  return `derec:${ns}:secret:${channelId}:${kind}`
}

/** Key for the bidirectional channel-link graph (owned by the channel store). */
function channelLinkKey(ns: string): string {
  return `derec:${ns}:channel-links`
}

const CONTACT_INDEX_SUFFIX = ':contact-index'

export function makeChannelStore(namespace: string) {
  const indexKey = `derec:${namespace}${CONTACT_INDEX_SUFFIX}`

  function loadIndex(): string[] {
    const raw = localStorage.getItem(indexKey)
    return raw ? (JSON.parse(raw) as string[]) : []
  }

  function saveIndex(ids: string[]): void {
    localStorage.setItem(indexKey, JSON.stringify(ids))
  }

  return {
    async load(channelId: string): Promise<Uint8Array | null> {
      const val = localStorage.getItem(contactKey(namespace, channelId))
      return val ? fromBase64Url(val) : null
    },
    async save(channelId: string, contactBytes: Uint8Array): Promise<void> {
      localStorage.setItem(contactKey(namespace, channelId), toBase64Url(contactBytes))
      const idx = loadIndex()
      if (!idx.includes(channelId)) {
        idx.push(channelId)
        saveIndex(idx)
      }
    },
    async listChannels(): Promise<string[]> {
      return loadIndex()
    },
    async remove(channelId: string): Promise<boolean> {
      const existed = localStorage.getItem(contactKey(namespace, channelId)) !== null
      localStorage.removeItem(contactKey(namespace, channelId))
      const idx = loadIndex().filter((id) => id !== channelId)
      saveIndex(idx)
      return existed
    },

    // ── Channel linking (same Owner identity) ────────────────────────────────
    // Undirected, idempotent, transitive. Linking moves no data — it only
    // records that two channels belong to the same Owner.

    async linkChannel(a: string, b: string): Promise<void> {
      if (a === b) return
      const key = channelLinkKey(namespace)
      const links: Record<string, string[]> = JSON.parse(localStorage.getItem(key) || '{}')
      if (!links[a]) links[a] = []
      if (!links[b]) links[b] = []
      if (!links[a].includes(b)) links[a].push(b)
      if (!links[b].includes(a)) links[b].push(a)
      localStorage.setItem(key, JSON.stringify(links))
    },

    /** Transitive closure of `channelId`, including `channelId` itself. */
    async linkedChannels(channelId: string): Promise<string[]> {
      const links: Record<string, string[]> = JSON.parse(
        localStorage.getItem(channelLinkKey(namespace)) || '{}',
      )
      const visited = new Set<string>()
      const queue = [channelId]
      while (queue.length) {
        const curr = queue.shift()!
        if (visited.has(curr)) continue
        visited.add(curr)
        for (const linked of (links[curr] ?? [])) {
          if (!visited.has(linked)) queue.push(linked)
        }
      }
      return Array.from(visited)
    },
  }
}

// kind 0 = SharedKey (32 raw bytes), kind 1 = PairingSecret (ephemeral), kind 2 = PairingContact (ephemeral)
export function makeSecretStore(namespace: string) {
  return {
    async load(channelId: string, kind: 0 | 1 | 2): Promise<Uint8Array | null> {
      const val = localStorage.getItem(secretKey(namespace, channelId, kind))
      return val ? fromBase64Url(val) : null
    },
    async save(channelId: string, kind: 0 | 1 | 2, value: Uint8Array): Promise<void> {
      localStorage.setItem(secretKey(namespace, channelId, kind), toBase64Url(value))
    },
    async remove(channelId: string, kind: 0 | 1 | 2): Promise<void> {
      localStorage.removeItem(secretKey(namespace, channelId, kind))
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

// ── Storage key helpers ──────────────────────────────────────────────────────

/** Key for the encoded share bytes: derec:<ns>:share:<channelId>:<version> */
function shareDataKey(ns: string, channelId: string, version: number): string {
  return `derec:${ns}:share:${channelId}:${version}`
}

/** Key for per-share metadata (secretId): derec:<ns>:share-meta:<channelId>:<version> */
function shareMetaKey(ns: string, channelId: string, version: number): string {
  return `derec:${ns}:share-meta:${channelId}:${version}`
}

/** Key for the version index per channel: derec:<ns>:share-idx:channel-versions:<channelId> */
function channelVersionsKey(ns: string, channelId: string): string {
  return `derec:${ns}:share-idx:channel-versions:${channelId}`
}

/** Key for the owner's latest distributed version. */
function ownerVersionKey(ns: string): string {
  return `derec:${ns}:share-idx:owner-version`
}

function loadNumberArray(key: string): number[] {
  const raw = localStorage.getItem(key)
  return raw ? (JSON.parse(raw) as number[]) : []
}

// ── Share store ──────────────────────────────────────────────────────────────

export function makeShareStore(namespace: string) {
  // Local helper: read one share from storage, returning null if absent or if
  // the secretId filter (when provided) doesn't match.
  function readShare(
    channelId: string,
    version: number,
    secretIdFilter: string | null,
  ): Share | null {
    const dataVal = localStorage.getItem(shareDataKey(namespace, channelId, version))
    if (!dataVal) return null
    const secretId = localStorage.getItem(shareMetaKey(namespace, channelId, version)) ?? ''
    if (secretIdFilter !== null && secretId !== secretIdFilter) return null
    return { secretId, version, bytes: fromBase64Url(dataVal) }
  }

  return {
    /**
     * Load shares stored on a single channel for a specific secret.
     *
     * `secretId` (u64 as decimal string) is **required** — versions are
     * namespaced by secret. Empty `versions` array means "all versions of
     * `secretId`".
     */
    async load(
      channelId: string,
      secretId: string,
      versions: number[],
    ): Promise<Share[]> {
      const targetVersions = versions.length > 0
        ? versions
        : loadNumberArray(channelVersionsKey(namespace, channelId))

      const result: Share[] = []
      for (const v of targetVersions) {
        const share = readShare(channelId, v, secretId)
        if (share) result.push(share)
      }
      return result
    },

    async save(channelId: string, share: Share): Promise<void> {
      localStorage.setItem(
        shareDataKey(namespace, channelId, share.version),
        toBase64Url(share.bytes),
      )
      localStorage.setItem(
        shareMetaKey(namespace, channelId, share.version),
        share.secretId,
      )

      const cKey = channelVersionsKey(namespace, channelId)
      const storedVersions = loadNumberArray(cKey)
      if (!storedVersions.includes(share.version)) {
        storedVersions.push(share.version)
        localStorage.setItem(cKey, JSON.stringify(storedVersions))
      }
    },

    /**
     * Load shares for several channels in one call, scoped to one secret.
     * Recovery feeds this the set from the channel store's `linkedChannels`.
     * Flat list — version-dedup is the caller's concern.
     */
    async loadMany(
      channelIds: string[],
      secretId: string,
      versions: number[],
    ): Promise<Share[]> {
      const versionFilter = versions.length > 0 ? new Set(versions) : null
      const result: Share[] = []
      for (const channelId of channelIds) {
        const stored = loadNumberArray(channelVersionsKey(namespace, channelId))
        for (const v of stored) {
          if (versionFilter && !versionFilter.has(v)) continue
          const share = readShare(channelId, v, secretId)
          if (share) result.push(share)
        }
      }
      return result
    },

    /**
     * Load **every** share across the given channels — all secrets, all
     * versions. Discovery-only; recovery/verification must scope by
     * `secretId` via `load`/`loadMany`.
     */
    async loadAll(channelIds: string[]): Promise<Share[]> {
      const result: Share[] = []
      for (const channelId of channelIds) {
        const stored = loadNumberArray(channelVersionsKey(namespace, channelId))
        for (const v of stored) {
          const share = readShare(channelId, v, null)
          if (share) result.push(share)
        }
      }
      return result
    },

    /**
     * Drop every share stored under `channelId` (all secret_ids, all
     * versions) — invoked by the unpair flow when a channel is torn down.
     * Idempotent: a channel with no recorded shares is a no-op.
     */
    async removeChannel(channelId: string): Promise<void> {
      const cKey = channelVersionsKey(namespace, channelId)
      const versions = loadNumberArray(cKey)
      for (const v of versions) {
        localStorage.removeItem(shareDataKey(namespace, channelId, v))
        localStorage.removeItem(shareMetaKey(namespace, channelId, v))
      }
      localStorage.removeItem(cKey)
    },

    async latestVersion(): Promise<number | null> {
      const raw = localStorage.getItem(ownerVersionKey(namespace))
      return raw ? Number(raw) : null
    },

    setOwnerVersion(version: number): void {
      localStorage.setItem(ownerVersionKey(namespace), String(version))
    },

    clearOwnerVersion(): void {
      localStorage.removeItem(ownerVersionKey(namespace))
    },
  }
}

export function makeTransport(sendFn: (uri: string, message: Uint8Array) => Promise<void>) {
  return {
    async send(endpoint: { protocol: string; uri: string }, message: Uint8Array): Promise<void> {
      await sendFn(endpoint.uri, message)
    },
  }
}
