import type { PairedParticipant } from '../types'

/** A group of paired channels that belong to the same Owner identity. */
export interface LinkGroup {
  /** Stable key (sorted member channel IDs joined). */
  key: string
  /** Display name (the "main" channel's name; all members share it by construction). */
  name: string
  /** The name-bearing channel; used as the Link-button source for the group. */
  mainChannelId: string
  /** Member participants, one per channel, sorted for stable rendering. */
  channels: PairedParticipant[]
}

/**
 * Collapse paired channels into one group per Owner identity.
 *
 * One peer can hold several channels with this device — that is what the link
 * mechanism records — and the Channels tab shows the peer, not the channels.
 * Membership is the transitive closure of the link graph, so linking A to B and
 * B to C puts all three in one group; union-find is what makes that closure
 * order-independent.
 *
 * `closures` maps a channel id to the ids it links to, as read from the channel
 * store. Only ids that are themselves paired participants are joined: a link
 * record naming a channel that has since been unpaired must not resurrect it,
 * and a replica must never be pulled into a participant group.
 */
export function buildLinkGroups(
  paired: PairedParticipant[],
  closures: ReadonlyMap<string, string[]>,
  mains: readonly string[],
): LinkGroup[] {
  const pairedIds = new Set(paired.map(p => p.channelId))

  const parent = new Map<string, string>()
  const find = (x: string): string => {
    const p = parent.get(x)
    if (p === undefined || p === x) {
      parent.set(x, x)
      return x
    }
    const root = find(p)
    parent.set(x, root)
    return root
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(rb, ra)
  }

  for (const p of paired) {
    find(p.channelId)
    for (const c of closures.get(p.channelId) ?? [p.channelId]) {
      if (pairedIds.has(c)) union(p.channelId, c)
    }
  }

  const byRoot = new Map<string, PairedParticipant[]>()
  for (const p of paired) {
    const r = find(p.channelId)
    const arr = byRoot.get(r) ?? []
    arr.push(p)
    byRoot.set(r, arr)
  }

  const groups: LinkGroup[] = []
  for (const members of byRoot.values()) {
    const channels = [...members].sort((a, b) => a.channelId.localeCompare(b.channelId))
    const mainCh =
      channels.find(m => mains.includes(m.channelId))?.channelId ?? channels[0].channelId
    const name = channels.find(m => m.channelId === mainCh)?.name ?? channels[0].name
    groups.push({
      key: channels.map(m => m.channelId).join('|'),
      name,
      mainChannelId: mainCh,
      channels,
    })
  }

  groups.sort(
    (a, b) => a.name.localeCompare(b.name) || a.mainChannelId.localeCompare(b.mainChannelId),
  )
  return groups
}
