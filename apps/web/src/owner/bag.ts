import type { BagVersion, SecretBag } from '../types'

export function updateBagVersion(
  bag: SecretBag,
  version: number,
  updater: (v: BagVersion) => BagVersion,
): SecretBag {
  if (bag.currentVersion.version === version) {
    return { ...bag, currentVersion: updater(bag.currentVersion) }
  }
  return {
    ...bag,
    previousVersions: bag.previousVersions.map(v => (v.version === version ? updater(v) : v)),
  }
}

export function updateBagParticipant(
  bag: SecretBag,
  version: number,
  participantId: string,
): SecretBag {
  return updateBagVersion(bag, version, v =>
    v.participantIds.includes(participantId)
      ? v
      : { ...v, participantIds: [...v.participantIds, participantId] },
  )
}

export function updateBagVerified(
  bag: SecretBag,
  version: number,
  participantId: string,
): SecretBag {
  return updateBagVersion(bag, version, v =>
    v.verifiedParticipantIds.includes(participantId)
      ? v
      : { ...v, verifiedParticipantIds: [...v.verifiedParticipantIds, participantId] },
  )
}

/** Builds a structured representation of the SecretContainer that gets protobuf-encoded and distributed. */
export function buildSecretContainerPayload(version: BagVersion) {
  return {
    helpers: version.helpers.map(h => ({
      channel_id: h.channelId,
      transport_uri: `(paired endpoint)`,
      name: h.name,
      shared_key: '(32-byte symmetric key)',
    })),
    secrets: version.secrets.map(s => ({
      id: s.id,
      name: s.name,
      data: s.data,
    })),
  }
}

/** Returns a hex dump of the UTF-8 JSON payload, 32 bytes per line. */
export function hexDump(data: Uint8Array): string[] {
  const lines: string[] = []
  const bytesPerLine = 16
  for (let offset = 0; offset < data.length; offset += bytesPerLine) {
    const slice = data.slice(offset, offset + bytesPerLine)
    const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = Array.from(slice).map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('')
    const addr = offset.toString(16).padStart(8, '0')
    lines.push(`${addr}  ${hex.padEnd(bytesPerLine * 3 - 1)}  ${ascii}`)
  }
  return lines
}
