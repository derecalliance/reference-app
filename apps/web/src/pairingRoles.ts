import { SenderKind } from '@derec-alliance/web'

/**
 * App-level pairing roles.
 *
 * Pairing is unidirectional in both modes: Owner↔Helper for participants,
 * ReplicaSource↔ReplicaDestination for replicas. A channel's role is fixed
 * at handshake time and stored on the channel record.
 */
export type PairingRole = 'owner' | 'helper' | 'replica_source' | 'replica_destination'

/** The two sides of a replica pairing. */
export type ReplicaPairingRole = Extract<PairingRole, 'replica_source' | 'replica_destination'>

/** `SenderKind` for an app-level pairing role. */
export function senderKindFor(role: PairingRole): SenderKind {
  switch (role) {
    case 'owner':
      return SenderKind.Owner
    case 'helper':
      return SenderKind.Helper
    case 'replica_source':
      return SenderKind.ReplicaSource
    case 'replica_destination':
      return SenderKind.ReplicaDestination
  }
}

/** The role that complements `role` — what the other side of a channel takes. */
export function complementRole(role: PairingRole): PairingRole {
  switch (role) {
    case 'owner':
      return 'helper'
    case 'helper':
      return 'owner'
    case 'replica_source':
      return 'replica_destination'
    case 'replica_destination':
      return 'replica_source'
  }
}

/** Whether `role` takes part in a replica-mode pairing. */
export function isReplicaRole(role: PairingRole): role is ReplicaPairingRole {
  return role === 'replica_source' || role === 'replica_destination'
}

/** Every app-level pairing role, for exhaustive lookups. */
const ALL_ROLES: readonly PairingRole[] = [
  'owner',
  'helper',
  'replica_source',
  'replica_destination',
]

/**
 * The replica role a wire `SenderKind` denotes, or `null` when it denotes none.
 *
 * Protocol events report `SenderKind`, not the app's role vocabulary, so the
 * event handlers need this direction too. Derived by inverting `senderKindFor`
 * over the replica roles rather than matching enum members directly, so the two
 * mappings cannot drift apart.
 *
 * On `PairingCompleted` the reported kind is the **local** party's role, so the
 * answer here is which side of the mirror *this* device is on.
 */
export function replicaRoleForSenderKind(
  kind: SenderKind | undefined,
): ReplicaPairingRole | null {
  if (kind === undefined) return null
  return ALL_ROLES.filter(isReplicaRole).find(role => senderKindFor(role) === kind) ?? null
}

/**
 * The replica role *this* device takes when a peer declares `kind` on an
 * **inbound** pairing, or `null` when the pairing is not a replica one.
 *
 * `ActionRequired` reports the **sender's** kind, not the local one — the
 * opposite of `PairingCompleted`. The library resolves the responder's side by
 * taking the counterparty of what the initiator declared
 * (`handlers/pairing.rs`: `let kind = peer_kind.counterparty()`), so this is
 * that same step expressed in the app's role vocabulary: look the peer's role
 * up with `replicaRoleForSenderKind`, then flip it with `complementRole`. Both
 * are reused rather than re-derived, so the UI cannot disagree with the library
 * about which side of the mirror this device is on.
 */
export function localReplicaRoleForPeerSenderKind(
  kind: SenderKind | undefined,
): ReplicaPairingRole | null {
  const peerRole = replicaRoleForSenderKind(kind)
  if (peerRole === null) return null
  // `complementRole` is total over `PairingRole`; the narrowing is a formality,
  // since the complement of a replica role is the other replica role.
  const localRole = complementRole(peerRole)
  return isReplicaRole(localRole) ? localRole : null
}

/**
 * Whether a wire `SenderKind` belongs to a replica-mode pairing.
 *
 * Defined as "`replicaRoleForSenderKind` found a role" so the predicate that
 * guards the participant roster and the lookup that names the direction can
 * never disagree about which kinds are replica kinds.
 */
export function isReplicaSenderKind(kind: SenderKind | undefined): boolean {
  return replicaRoleForSenderKind(kind) !== null
}
