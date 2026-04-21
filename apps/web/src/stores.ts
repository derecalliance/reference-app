import { fromBase64Url, toBase64Url } from './derecApi'

// ── Storage key helpers ───────────────────────────────────────────────────────

function contactKey(ns: string, channelId: string): string {
  return `derec:${ns}:contact:${channelId}`
}

function secretKey(ns: string, channelId: string, kind: 0 | 1): string {
  return `derec:${ns}:secret:${channelId}:${kind}`
}

function shareKey(ns: string, channelId: string, secretIdHex: string, version: number): string {
  return `derec:${ns}:share:${channelId}:${secretIdHex}:${version}`
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── ContactStore ──────────────────────────────────────────────────────────────
//
// Stores raw protobuf-encoded ContactMessage bytes per channel.
// The library uses these to route outgoing messages back to the peer.
//
// JS interface contract:
//   load(channelId: string): Promise<Uint8Array | null | undefined>
//   save(channelId: string, contactBytes: Uint8Array): Promise<void>

export function makeContactStore(namespace: string) {
  return {
    async load(channelId: string): Promise<Uint8Array | null> {
      const val = localStorage.getItem(contactKey(namespace, channelId))
      return val ? fromBase64Url(val) : null
    },
    async save(channelId: string, contactBytes: Uint8Array): Promise<void> {
      localStorage.setItem(contactKey(namespace, channelId), toBase64Url(contactBytes))
    },
  }
}

// ── SecretStore ───────────────────────────────────────────────────────────────
//
// Stores ephemeral pairing key material and established shared keys per channel.
//
//   kind 0 = SharedKey      (32 raw bytes, established after pairing)
//   kind 1 = PairingSecret  (ark-serialized, ephemeral — discarded after pairing)
//
// JS interface contract:
//   load(channelId: string, kind: 0 | 1): Promise<Uint8Array | null | undefined>
//   save(channelId: string, kind: 0 | 1, value: Uint8Array): Promise<void>
//   remove(channelId: string, kind: 0 | 1): Promise<void>

export function makeSecretStore(namespace: string) {
  return {
    async load(channelId: string, kind: 0 | 1): Promise<Uint8Array | null> {
      const val = localStorage.getItem(secretKey(namespace, channelId, kind))
      return val ? fromBase64Url(val) : null
    },
    async save(channelId: string, kind: 0 | 1, value: Uint8Array): Promise<void> {
      localStorage.setItem(secretKey(namespace, channelId, kind), toBase64Url(value))
    },
    async remove(channelId: string, kind: 0 | 1): Promise<void> {
      localStorage.removeItem(secretKey(namespace, channelId, kind))
    },
  }
}

// ── ShareStore ────────────────────────────────────────────────────────────────
//
// Stores committed shares on the helper side, keyed by (channelId, secretId, version).
// Also maintains two indexes for the required lookup patterns.
//
// JS interface contract:
//   load(channelId: string, secretId: Uint8Array, version: number): Promise<Uint8Array | null>
//   save(channelId: string, secretId: Uint8Array, version: number, encoded: Uint8Array): Promise<void>
//   loadChannelsForSecret(secretId: Uint8Array, version: number): Promise<string[]>
//   loadSecretsForChannel(channelId: string): Promise<Array<[Uint8Array, number[]]>>

function shareIndexBySecretKey(ns: string, secretIdHex: string, version: number): string {
  return `derec:${ns}:share-idx:secret:${secretIdHex}:${version}`
}

function shareIndexByChannelKey(ns: string, channelId: string): string {
  return `derec:${ns}:share-idx:channel:${channelId}`
}

interface ShareIndexEntry {
  channelId: string
  secretIdHex: string
  version: number
}

function loadShareIndex(key: string): ShareIndexEntry[] {
  const raw = localStorage.getItem(key)
  return raw ? (JSON.parse(raw) as ShareIndexEntry[]) : []
}

function saveShareIndex(key: string, entries: ShareIndexEntry[]): void {
  localStorage.setItem(key, JSON.stringify(entries))
}

export function makeShareStore(namespace: string) {
  return {
    async load(channelId: string, secretId: Uint8Array, version: number): Promise<Uint8Array | null> {
      const val = localStorage.getItem(shareKey(namespace, channelId, bytesToHex(secretId), version))
      return val ? fromBase64Url(val) : null
    },

    async save(channelId: string, secretId: Uint8Array, version: number, encoded: Uint8Array): Promise<void> {
      const secretIdHex = bytesToHex(secretId)
      localStorage.setItem(shareKey(namespace, channelId, secretIdHex, version), toBase64Url(encoded))

      // Update the by-secret index (channels that hold this secret/version)
      const bySecretKey = shareIndexBySecretKey(namespace, secretIdHex, version)
      const bySecretEntries = loadShareIndex(bySecretKey)
      if (!bySecretEntries.some(e => e.channelId === channelId)) {
        bySecretEntries.push({ channelId, secretIdHex, version })
        saveShareIndex(bySecretKey, bySecretEntries)
      }

      // Update the by-channel index (secrets held by this channel)
      const byChannelKey = shareIndexByChannelKey(namespace, channelId)
      const byChannelEntries = loadShareIndex(byChannelKey)
      if (!byChannelEntries.some(e => e.secretIdHex === secretIdHex && e.version === version)) {
        byChannelEntries.push({ channelId, secretIdHex, version })
        saveShareIndex(byChannelKey, byChannelEntries)
      }
    },

    async loadChannelsForSecret(secretId: Uint8Array, version: number): Promise<string[]> {
      const secretIdHex = bytesToHex(secretId)
      const entries = loadShareIndex(shareIndexBySecretKey(namespace, secretIdHex, version))
      return entries.map(e => e.channelId)
    },

    async loadSecretsForChannel(channelId: string): Promise<Array<[Uint8Array, number[]]>> {
      const entries = loadShareIndex(shareIndexByChannelKey(namespace, channelId))

      // Group by secretId: secretIdHex → version[]
      const grouped = new Map<string, number[]>()
      for (const e of entries) {
        const versions = grouped.get(e.secretIdHex) ?? []
        if (!versions.includes(e.version)) versions.push(e.version)
        grouped.set(e.secretIdHex, versions)
      }

      return Array.from(grouped.entries()).map(([hex, versions]) => {
        const bytes = new Uint8Array(hex.length / 2)
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
        }
        return [bytes, versions] as [Uint8Array, number[]]
      })
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
