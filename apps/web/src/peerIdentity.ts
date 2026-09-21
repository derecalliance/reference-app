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
  /** Actor ids already represented locally. */
  knownActorIds: ReadonlySet<string>
  /**
   * Transport URI taken from the contact we paired against. Present only on
   * the initiating side, where it identifies the peer exactly.
   */
  peerTransportUri?: string
}

/**
 * Identify the actor behind a newly paired channel, or `null` when it cannot
 * be established.
 *
 * Two strategies, in order:
 *
 *  1. **Transport URI** — exact. The initiator paired against a contact that
 *     carries the peer's mailbox URI, and URIs are unique per actor.
 *  2. **Sole unknown owner** — inference, for the responding side, which has
 *     no contact to match on. Only applied when exactly one candidate exists.
 *     A server that has accumulated stale owner actors (a device that reset
 *     its storage and rejoined leaves its old actor behind) has several, and
 *     picking one would be a coin flip — so we return `null` and let the
 *     caller keep whatever the peer declared over the wire.
 */
export function resolvePeerActor(
  actors: readonly PeerActorCandidate[],
  { selfActorId, knownActorIds, peerTransportUri }: ResolvePeerActorOptions,
): PeerActorCandidate | null {
  if (peerTransportUri) {
    return (
      actors.find(a => a.id !== selfActorId && a.transport.uri === peerTransportUri) ?? null
    )
  }

  const candidates = actors.filter(
    a => a.role === 'owner' && a.id !== selfActorId && !knownActorIds.has(a.id),
  )
  return candidates.length === 1 ? candidates[0] : null
}

/**
 * Resolve a recovered-roster entry against the actor list by transport URI.
 *
 * Since SDK 0.0.3 a roster entry carries *every* endpoint the peer advertised
 * rather than one. They all address the same actor, so the first one the
 * roster recognises identifies it; when none does — the peer has moved, or was
 * never a registered actor — the entry's own first choice is still the best
 * endpoint to record for it.
 */
export function resolveRosterActor<T>(
  transports: readonly { uri: string }[],
  actorByUri: ReadonlyMap<string, T>,
): { actor: T | undefined; transportUri: string } {
  const matched = transports.find(t => actorByUri.has(t.uri))
  return {
    actor: matched ? actorByUri.get(matched.uri) : undefined,
    transportUri: matched?.uri ?? transports[0]?.uri ?? '',
  }
}
