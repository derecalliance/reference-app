import type { PairingRole } from './pairingRoles'

/**
 * The copy a pairing role picker needs.
 *
 * Kept out of `OwnerPage` so the replica wording lives with the rest of
 * the replica feature, and so the option list for a given pairing surface is a
 * value that can be asserted on directly.
 */

/** One choice in a pairing role picker. */
export interface PairingRoleOption<R extends PairingRole = PairingRole> {
  role: R
  label: string
  /** One line saying what picking this role means for *this* device. */
  hint: string
}

const ROLE_LABELS: Record<PairingRole, string> = {
  owner: 'Owner',
  helper: 'Helper',
  replica_source: 'Replica source',
  replica_destination: 'Replica destination',
}

/** Human-readable name for a role, for labels and prose. */
export function pairingRoleLabel(role: PairingRole): string {
  return ROLE_LABELS[role]
}

/**
 * Every role a browser peer may declare when it initiates a pairing.
 *
 * A browser replica is an ordinary owner actor that happens to have paired on a
 * replica channel — there is no separate replica entry point. The relationship
 * is established here, by picking a side, exactly as Owner↔Helper is.
 *
 * `replica_destination` is the only destructive choice, and its hint says so;
 * `requiresEraseConsent` is what actually gates it.
 */
export const BROWSER_PAIRING_ROLE_OPTIONS: readonly PairingRoleOption[] = [
  {
    role: 'owner',
    label: ROLE_LABELS.owner,
    hint: 'You protect the secret; the peer holds a share for you.',
  },
  {
    role: 'helper',
    label: ROLE_LABELS.helper,
    hint: 'You hold a share; the peer protects their own secret.',
  },
  {
    role: 'replica_source',
    label: ROLE_LABELS.replica_source,
    hint: 'You keep your vault and mirror it to the peer. Nothing here changes.',
  },
  {
    role: 'replica_destination',
    label: ROLE_LABELS.replica_destination,
    hint: 'You receive the peer’s vault. Erases everything this device holds.',
  },
]

/**
 * Owner/Helper options for participant pairing, with caller-supplied copy.
 *
 * Deliberately narrower than the browser list: the hints name whichever side is
 * doing the pairing, and provisioned actors pair through a backend route that
 * accepts only these two roles.
 */
export function participantPairingRoleOptions(
  ownerHint: string,
  helperHint: string,
): readonly PairingRoleOption<'owner' | 'helper'>[] {
  return [
    { role: 'owner', label: ROLE_LABELS.owner, hint: ownerHint },
    { role: 'helper', label: ROLE_LABELS.helper, hint: helperHint },
  ]
}

/** What a completed pairing means for this device, given the role it declared. */
export function pairingSuccessMessage(role: PairingRole): string {
  switch (role) {
    case 'owner':
      return 'Pairing completed successfully. The helper is now ready to receive shares.'
    case 'helper':
      return 'Pairing completed successfully. The owner can now distribute shares here.'
    case 'replica_source':
      return 'Pairing completed successfully. Confirm the fingerprint with the peer, then this device can mirror its vault to them.'
    case 'replica_destination':
      return 'Pairing completed successfully. Nothing has been erased yet — this device is asked to confirm before the peer’s vault replaces it.'
  }
}
