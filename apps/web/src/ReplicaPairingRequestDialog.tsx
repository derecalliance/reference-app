import {
  Alert,
  AlertTitle,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  Stack,
  Typography,
} from '@mui/material'
import { AppMuiTheme } from './AppMuiTheme'
import { pairingRoleLabel } from './pairingRoleOptions'
import { requiresEraseConsent } from './replicaPairingConsent'
import type { ReplicaPairingRole } from './pairingRoles'

/**
 * The confirmation raised when the *inbound* pairing request is a replica one.
 *
 * The generic "Incoming Pairing Request" modal describes an ordinary
 * participant pairing and offers "Link to existing". Both are wrong here: a
 * replica channel mirrors the whole secret rather than holding a share, and it
 * cannot be linked into another channel's group. Worse, the destination side of
 * a replica pairing is agreeing to have its own vault replaced, and the generic
 * modal never said so — the consent for that erase existed only on the
 * initiator's side (`ReplicaPairingWarningDialog`). This is its counterpart for
 * the responder.
 *
 * **Nothing is erased here.** This dialog only decides whether the pairing is
 * accepted; accepting goes through the same `protocol.accept` path a
 * participant pairing takes. The wipe happens later, at first sync, behind
 * `ReplicaAdoptionDialog` — the only place `clearNamespace` and `restore` are
 * reachable from.
 *
 * Reject is the default action: it takes focus, carries the filled styling, and
 * is what Escape and a backdrop click resolve to. Rejecting destroys nothing.
 */

export interface ReplicaPairingRequestDialogProps {
  open: boolean
  /** The peer that initiated the pairing. */
  peerName: string
  /** The channel the request arrived on, shown so the two sides can be matched up. */
  channelId: string
  /** This device's side of the mirror — the counterparty of `peerRole`. */
  localRole: ReplicaPairingRole
  /** The side the peer declared on the wire. */
  peerRole: ReplicaPairingRole
  /** Accept the pairing. Goes through the shared accept path; erases nothing. */
  onAccept: () => void
  /** Decline the pairing. The default action, and it destroys nothing. */
  onReject: () => void
}

export function ReplicaPairingRequestDialog({
  open,
  peerName,
  channelId,
  localRole,
  peerRole,
  onAccept,
  onReject,
}: ReplicaPairingRequestDialogProps) {
  // The same predicate that gates the initiator-side warning, so the two sides
  // cannot disagree about which role loses its vault.
  const losesOwnVault = requiresEraseConsent(localRole)

  return (
    <AppMuiTheme>
      <Dialog
        // Escape and a backdrop click resolve to reject — the safe direction.
        open={open}
        onClose={onReject}
        fullWidth
        maxWidth="sm"
        aria-labelledby="replica-pair-request-title"
        aria-describedby="replica-pair-request-summary"
      >
        <DialogTitle id="replica-pair-request-title">
          Incoming replica pairing request
        </DialogTitle>

        <DialogContent>
          <Stack spacing={2.5} sx={{ pt: 1 }}>
            {losesOwnVault && (
              // Severity carries an icon and a worded title, so the warning does
              // not depend on colour alone.
              <Alert severity="warning">
                <AlertTitle>Accepting replaces this device’s vault</AlertTitle>
                As the replica destination, this device keeps nothing of its own. Every
                secret, helper channel and share stored here is deleted and replaced with{' '}
                {peerName}’s vault. It cannot be undone from this app.
              </Alert>
            )}

            <DialogContentText id="replica-pair-request-summary">
              <strong>{peerName}</strong> wants to pair with this device as a{' '}
              <strong>replica</strong>, not as a participant. A replica is not a helper: it
              mirrors the <strong>whole secret</strong> — the entire vault, in the clear to
              its holder — rather than holding one share of it.
            </DialogContentText>

            <Divider />

            <Stack spacing={0.5}>
              <Typography variant="body2" color="text.secondary">
                This device will be the <strong>{pairingRoleLabel(localRole)}</strong>;{' '}
                {peerName} declared <strong>{pairingRoleLabel(peerRole)}</strong>.
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Channel {channelId}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                A replica channel cannot be linked to an existing channel, and it does not
                join the participant list.
              </Typography>
            </Stack>

            <Typography variant="body2" color="text.secondary">
              {losesOwnVault
                ? 'Nothing is erased by accepting. The channel is established first, both sides confirm the fingerprint, and this device is asked once more — against the actual vault being offered — before anything here is replaced.'
                : 'Accepting only establishes the channel. Both sides confirm the fingerprint before this device mirrors anything to the peer.'}
            </Typography>
          </Stack>
        </DialogContent>

        <DialogActions>
          {/* Reject is the default action: autofocused and filled. Escape and a
              backdrop click resolve here too. Rejecting destroys nothing. */}
          <Button variant="contained" onClick={onReject} autoFocus>
            Reject
          </Button>
          <Button
            variant="outlined"
            color={losesOwnVault ? 'error' : 'primary'}
            onClick={onAccept}
          >
            {losesOwnVault ? 'Accept and become the replica' : 'Accept'}
          </Button>
        </DialogActions>
      </Dialog>
    </AppMuiTheme>
  )
}
