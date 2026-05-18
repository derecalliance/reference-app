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

      const cKey = channelVersionsKey(namespace, channelId)
      const storedVersions = loadNumberArray(cKey)
      if (!storedVersions.includes(version)) {
        storedVersions.push(version)
        localStorage.setItem(cKey, JSON.stringify(storedVersions))
      }
    },

    /**
     * Copies all shares from `fromChannelId` to `toChannelId`.
     * Called when a recovery pairing is accepted so the WASM can serve
     * discovery and get-share requests on the new channel.
     */
    async copyShares(fromChannelId: string, toChannelId: string): Promise<void> {
      const versions = loadNumberArray(channelVersionsKey(namespace, fromChannelId))
      for (const version of versions) {
        const raw = localStorage.getItem(shareDataKey(namespace, fromChannelId, version))
        if (!raw) continue
        localStorage.setItem(shareDataKey(namespace, toChannelId, version), raw)
        const cKey = channelVersionsKey(namespace, toChannelId)
        const existing = loadNumberArray(cKey)
        if (!existing.includes(version)) {
          existing.push(version)
          localStorage.setItem(cKey, JSON.stringify(existing))
        }
      }
    },

    async latestVersion(): Promise<number | null> {
      // Tracks only this owner's distributed version, not shares held for other owners.
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
