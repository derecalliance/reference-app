import type { SenderKind } from '@derec-alliance/web'
import {
  localReplicaRoleForPeerSenderKind,
  replicaRoleForSenderKind,
  type ReplicaPairingRole,
} from './pairingRoles'

/**
 * Which confirmation an inbound pairing request deserves.
 *
 * A pairing request arrives as `ActionRequired`, and the event carries the
 * initiator's declared `sender_kind`. Ignoring it is what put a replica pairing
 * behind the ordinary participant modal: the responder was offered "link to
 * existing" — meaningless for a replica channel — and told nothing about the
 * whole secret being mirrored, or about its own vault being replaced.
 *
 * This module **decides which dialog to raise and nothing else**. It reads no
 * storage, writes none, and dispatches no protocol call. Both verdicts share
 * one accept path; the erase itself still happens later, at first sync, behind
 * `ReplicaAdoptionDialog`.
 */

/** The parts of an inbound pairing request a confirmation needs. */
export interface InboundPairingRequest {
  peerName: string
  channelId: string
  /** Opaque action token from the `ActionRequired` event — pass to accept() or reject(). */
  action: Uint8Array
}

/** Who is on which side of a replica mirror. */
export interface ReplicaPairingSides {
  /** The role the initiator declared, read straight off `sender_kind`. */
  peerRole: ReplicaPairingRole
  /** This device's role — the counterparty of `peerRole`. */
  localRole: ReplicaPairingRole
}

/**
 * An inbound pairing request, resolved to the confirmation it needs.
 *
 * `replica` is the discriminator: `null` means an ordinary participant pairing
 * and the existing modal, non-`null` means a replica pairing and the
 * replica-specific dialog.
 */
export interface PendingPairingConfirmation extends InboundPairingRequest {
  replica: ReplicaPairingSides | null
}

/**
 * Resolve an inbound pairing request against the kind its initiator declared.
 *
 * A non-replica kind — `Owner`, `Helper`, or a kind the event omitted — is
 * reported as a participant pairing, unchanged from before this branch existed.
 */
export function classifyInboundPairing(
  request: InboundPairingRequest,
  senderKind: SenderKind | undefined,
): PendingPairingConfirmation {
  const peerRole = replicaRoleForSenderKind(senderKind)
  const localRole = localReplicaRoleForPeerSenderKind(senderKind)

  return {
    ...request,
    replica: peerRole && localRole ? { peerRole, localRole } : null,
  }
}
