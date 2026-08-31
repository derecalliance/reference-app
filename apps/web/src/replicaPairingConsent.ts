import type { SenderKind } from '@derec-alliance/web'
import { complementRole, senderKindFor, type PairingRole } from './pairingRoles'

/**
 * The consent gate in front of a `replica_destination` pairing.
 *
 * Choosing `replica_destination` is a commitment: the peer's vault will replace
 * this device's. The user is told that here, before anything is dispatched, so
 * the commitment is never made by accident.
 *
 * This module **destroys nothing**. It reads no storage and writes none; it
 * decides whether a pairing may start and resolves the role to what goes on the
 * wire. The erase itself happens later, at first sync, behind the separate
 * adoption confirmation in `ReplicaAdoptionDialog` — which is the only place
 * `clearNamespace` and `restore` are reachable from.
 */

/**
 * Whether choosing `role` commits this device's vault to being erased, and so
 * needs explicit consent before the pairing starts.
 *
 * Only the destination side loses anything: a `replica_source` keeps its vault
 * and mirrors it outward.
 */
export function requiresEraseConsent(role: PairingRole): boolean {
  return role === 'replica_destination'
}

/** A pairing the user has agreed to, resolved to what the handshake needs. */
export interface ConsentedPairing {
  role: PairingRole
  /**
   * What reaches the wire as `sender_kind`.
   *
   * Resolved through `senderKindFor` and carried here so no caller re-derives
   * it — a hand-rolled mapping is what once collapsed a replica pairing into a
   * helper one.
   */
  senderKind: SenderKind
  /** The role the responder takes, derived from `complementRole`. */
  peerRole: PairingRole
}

export type PairingConsent =
  | { kind: 'granted'; pairing: ConsentedPairing }
  | { kind: 'cancelled' }

/**
 * Resolve a chosen role into a dispatchable pairing, asking for consent first
 * when the choice is destructive.
 *
 * `requestEraseConsent` is only ever called for a role that
 * `requiresEraseConsent` flags, and a `false` from it is final: the result is
 * `cancelled`, the caller starts no pairing, and nothing has been touched.
 */
export async function requestPairingConsent(
  role: PairingRole,
  requestEraseConsent: () => Promise<boolean>,
): Promise<PairingConsent> {
  if (requiresEraseConsent(role) && !(await requestEraseConsent())) {
    return { kind: 'cancelled' }
  }
  return {
    kind: 'granted',
    pairing: {
      role,
      senderKind: senderKindFor(role),
      peerRole: complementRole(role),
    },
  }
}
