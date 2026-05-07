import { fromBase64Url, toBase64Url } from './derecApi'

// ── Storage key helpers ───────────────────────────────────────────────────────

function contactKey(ns: string, channelId: string): string {
  return `derec:${ns}:contact:${channelId}`
}

function secretKey(ns: string, channelId: string, kind: 0 | 1 | 2): string {
  return `derec:${ns}:secret:${channelId}:${kind}`
}

// ── ChannelStore ──────────────────────────────────────────────────────────────
//
// Stores JSON-encoded Channel records per channel.
// The library uses these to route outgoing messages back to the peer.
//
// JS interface contract:
//   load(channelId: string): Promise<Uint8Array | null | undefined>
//   save(channelId: string, bytes: Uint8Array): Promise<void>
//   remove(channelId: string): Promise<boolean>
//   listChannels(): Promise<string[]>

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
  }
}

// ── SecretStore ───────────────────────────────────────────────────────────────
//
// Stores ephemeral pairing key material and established shared keys per channel.
//
//   kind 0 = SharedKey       (32 raw bytes, established after pairing)
//   kind 1 = PairingSecret   (ark-serialized, ephemeral — discarded after pairing)
//   kind 2 = PairingContact  (protobuf-encoded ContactMessage, ephemeral — discarded after pairing)
//
// JS interface contract:
//   load(channelId: string, kind: 0 | 1 | 2): Promise<Uint8Array | null | undefined>
//   save(channelId: string, kind: 0 | 1 | 2, value: Uint8Array): Promise<void>
//   remove(channelId: string, kind: 0 | 1 | 2): Promise<void>

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

// ── ShareStore ────────────────────────────────────────────────────────────────
//
// Stores committed shares keyed by (channelId, version). In the single-secret-bag
// model there is one secret per channel, so secret_id is implicit.
//
// Two indexes support the required lookup patterns:
//   - by-version: which channels hold a given version
//   - by-channel: which versions a channel holds
//
// JS interface contract (matches WASM trait):
//   load(channelId: string, versions: number[]): Promise<Array<[number, Uint8Array]>>
//   save(channelId: string, version: number, encoded: Uint8Array): Promise<void>

function shareDataKey(ns: string, channelId: string, version: number): string {
  return `derec:${ns}:share:${channelId}:${version}`
}

function channelVersionsKey(ns: string, channelId: string): string {
  return `derec:${ns}:share-idx:channel-versions:${channelId}`
}

function ownerVersionKey(ns: string): string {
  return `derec:${ns}:share-idx:owner-version`
}

function loadNumberArray(key: string): number[] {
  const raw = localStorage.getItem(key)
  return raw ? (JSON.parse(raw) as number[]) : []
}

export function makeShareStore(namespace: string) {
  return {
    async load(channelId: string, versions: number[]): Promise<Array<[number, Uint8Array]>> {
      const targetVersions = versions.length > 0
        ? versions
        : loadNumberArray(channelVersionsKey(namespace, channelId))

      const result: Array<[number, Uint8Array]> = []
      for (const v of targetVersions) {
        const val = localStorage.getItem(shareDataKey(namespace, channelId, v))
        if (val) {
          result.push([v, fromBase64Url(val)])
        }
      }
      return result
    },

    async save(channelId: string, version: number, encoded: Uint8Array): Promise<void> {
      localStorage.setItem(shareDataKey(namespace, channelId, version), toBase64Url(encoded))

      // Update by-channel index (versions held by this channel)
      const cKey = channelVersionsKey(namespace, channelId)
      const storedVersions = loadNumberArray(cKey)
      if (!storedVersions.includes(version)) {
        storedVersions.push(version)
        localStorage.setItem(cKey, JSON.stringify(storedVersions))
      }
    },

    async latestVersion(): Promise<number | null> {
      // Return only the owner's distributed version — NOT held shares from other owners.
      // This counter is updated by setOwnerVersion() after a successful ProtectSecret flow.
      const raw = localStorage.getItem(ownerVersionKey(namespace))
      return raw ? Number(raw) : null
    },

    /** Update the owner-distributed version counter after a successful ProtectSecret. */
    setOwnerVersion(version: number): void {
      localStorage.setItem(ownerVersionKey(namespace), String(version))
    },
  }
}

// ── Transport ─────────────────────────────────────────────────────────────────
//
// Sends raw protobuf-encoded DeRec wire bytes to a peer's transport endpoint.
// The `send` method is called internally by DeRecProtocolWasm for all outbound
// messages (pairing, sharing, verification, recovery, discovery).
//
// JS interface contract:
//   send(endpoint: { protocol: string; uri: string }, message: Uint8Array): Promise<void>

export function makeTransport(sendFn: (uri: string, message: Uint8Array) => Promise<void>) {
  return {
    async send(endpoint: { protocol: string; uri: string }, message: Uint8Array): Promise<void> {
      await sendFn(endpoint.uri, message)
    },
  }
}
