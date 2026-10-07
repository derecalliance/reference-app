// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * Resolving which registered actor a freshly paired channel belongs to.
 *
 * Browser peers are `owner`-role actors and are never synced into the local
 * participant list, so a pairing with one completes with no actor identity
 * attached. The identity has to be recovered from the server's actor list
 * afterwards — and getting it wrong silently relabels a channel with another
 * peer's name, id and transport.
 */

export interface PeerActorCandidate {
  id: string
  role: 'owner' | 'helper'
  name: string
  transport: { protocol: 'https' | 'grpc'; uri: string }
  /** Every endpoint this actor advertises, in its own preference order. */
  transports?: { protocol: 'https' | 'grpc'; uri: string }[]
  browser_managed?: boolean
}

export interface ResolvePeerActorOptions {
  /** Our own actor id — never a candidate. */
  selfActorId: string
  /**
   * Every endpoint the peer is known to use: the URI of the contact we paired
   * against (initiator side), and whatever the handshake advertised (both
   * sides). Empty when nothing is known — and then nothing is resolved.
   */
  peerTransportUris: readonly string[]
}

/**
 * Identify the actor behind a newly paired channel, or `null` when it cannot
 * be established.
 *
 * Only one strategy: an endpoint the peer uses that **exactly one** actor on
 * this node advertises — the per-actor HTTPS mailbox `…/derec/<actor id>`, in
 * practice. Exact, and it fails closed:
 *
 * - A peer on **another node** advertises endpoints this node's roster does
 *   not hold, so it matches nothing and keeps the name it sent over the wire.
 * - A gRPC endpoint is the node's one authority, shared by every gRPC helper,
 *   so it never identifies anyone by itself.
 *
 * There used to be a second, inferential strategy for the responding side —
 * "the sole owner on this node we do not know yet". This node's roster is not
 * the peer's: a browser on another node pairing in matched whichever stale
 * owner happened to be alone here, and the row was relabelled with an
 * unrelated actor's name, id and transport. Not knowing is the honest answer.
 */
export function resolvePeerActor(
  actors: readonly PeerActorCandidate[],
  { selfActorId, peerTransportUris }: ResolvePeerActorOptions,
): PeerActorCandidate | null {
  const others = actors.filter(a => a.id !== selfActorId)
  for (const uri of peerTransportUris) {
    if (!uri) continue
    const advertisers = others.filter(
      a => a.transport.uri === uri || (a.transports ?? []).some(t => t.uri === uri),
    )
    if (advertisers.length === 1) return advertisers[0]
  }
  return null
}

/** One peer of a recovered or adopted snapshot, as the library decoded it. */
export interface RosterEntry {
  channelId: string
  /** Every endpoint the peer advertised, in its own preference order. */
  transports: readonly { uri: string }[]
  /** The name the peer advertised, when it sent one. */
  name?: string
}

/** The slice of a server actor that re-identifying a snapshot peer reads. */
export interface RosterCandidate {
  id: string
  name: string
  transport: { uri: string }
  transports?: readonly { uri: string }[]
  /** The actor's primary channel, as `GET /api/v1/actors` reports it. */
  channel_id?: string
}

export interface RosterMatch<T> {
  /** The actor this entry belongs to, or `undefined` when it cannot be told. */
  actor: T | undefined
  /** The endpoint to record for the entry. */
  transportUri: string
}

/**
 * Re-identify every peer of a snapshot against the server's actor list.
 *
 * A transport URI alone does not identify an actor: every gRPC (and `both`)
 * helper on a node advertises the node's one `grpc://host:port`, so a lookup
 * keyed by URI lets the last such helper win — two rows then carry one actor's
 * id, React keys collide, and a protect round waits on rows that can never
 * confirm. Hence, in order, and never resolving two entries to one actor:
 *
 *  1. **Unique URI** — an endpoint exactly one actor advertises, such as the
 *     per-actor HTTPS mailbox `…/derec/<actor id>`. Exact.
 *  2. **Channel id** — the actor's primary channel is this entry's channel.
 *  3. **Unique name** — exactly one unclaimed actor carries the advertised
 *     name, narrowed to the actors sharing an endpoint with the entry when any
 *     do. Inference, so applied only when it cannot be a coin flip.
 *
 * Anything left gets no actor: the caller renders a row from the snapshot
 * alone, which is honest, rather than another peer's identity, which is not.
 */
export function resolveRosterEntries<T extends RosterCandidate>(
  entries: readonly RosterEntry[],
  actors: readonly T[],
): RosterMatch<T>[] {
  const urisOf = (actor: T): Set<string> =>
    new Set([actor.transport.uri, ...(actor.transports ?? []).map(t => t.uri)])
  const actorUris = new Map(actors.map(a => [a, urisOf(a)]))

  const advertisers = new Map<string, T[]>()
  for (const [actor, uris] of actorUris) {
    for (const uri of uris) advertisers.set(uri, [...(advertisers.get(uri) ?? []), actor])
  }

  const claimed = new Set<T>()
  const resolved: (T | undefined)[] = entries.map(() => undefined)
  const claim = (index: number, actor: T | undefined): void => {
    if (!actor || claimed.has(actor)) return
    claimed.add(actor)
    resolved[index] = actor
  }

  entries.forEach((entry, i) => {
    const unique = entry.transports
      .map(t => advertisers.get(t.uri))
      .find(found => found?.length === 1)
    claim(i, unique?.[0])
  })

  entries.forEach((entry, i) => {
    if (resolved[i]) return
    claim(i, actors.find(a => !claimed.has(a) && a.channel_id === entry.channelId))
  })

  entries.forEach((entry, i) => {
    if (resolved[i] || !entry.name) return
    const named = actors.filter(a => !claimed.has(a) && a.name === entry.name)
    const sharingEndpoint = named.filter(a =>
      entry.transports.some(t => actorUris.get(a)?.has(t.uri)),
    )
    const candidates = sharingEndpoint.length > 0 ? sharingEndpoint : named
    if (candidates.length === 1) claim(i, candidates[0])
  })

  return entries.map((entry, i) => {
    const actor = resolved[i]
    // The entry's own endpoint the actor advertises; otherwise the entry's
    // first choice is still the best address to record for it.
    const known = actor ? entry.transports.find(t => actorUris.get(actor)?.has(t.uri)) : undefined
    return { actor, transportUri: known?.uri ?? entry.transports[0]?.uri ?? '' }
  })
}
