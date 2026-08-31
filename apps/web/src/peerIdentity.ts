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
  role: 'owner' | 'participant' | 'replica'
  name: string
  transport: { protocol: 'https'; uri: string }
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
