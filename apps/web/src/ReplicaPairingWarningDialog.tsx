import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  AlertTitle,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material'
import { AppMuiTheme } from './AppMuiTheme'

/**
 * Consent, taken up front, for pairing as a replica destination.
 *
 * Picking `replica_destination` is the moment the user commits this device to
 * giving up its own vault, so it is the moment to say so. **Nothing is erased
 * here** — this dialog only decides whether the pairing is dispatched. The wipe
 * happens later, at first sync, behind `ReplicaAdoptionDialog`, which asks
 * again against the concrete offer.
 *
 * Cancel is the default action: it takes focus, carries the filled styling, and
 * is what Escape and a backdrop click resolve to. Cancelling starts no pairing
 * and destroys nothing.
 */

export interface ReplicaPairingWarningDialogProps {
  open: boolean
  /** Proceed with the pairing. Still destroys nothing on its own. */
  onConfirm: () => void
  /** Abandon the pairing. The default action. */
  onCancel: () => void
}

export function ReplicaPairingWarningDialog({
  open,
  onConfirm,
  onCancel,
}: ReplicaPairingWarningDialogProps) {
  return (
    <AppMuiTheme>
      <Dialog
        open={open}
        onClose={onCancel}
        fullWidth
        maxWidth="sm"
        aria-labelledby="replica-pair-warning-title"
      >
        <DialogTitle id="replica-pair-warning-title">
          Pair as replica destination?
        </DialogTitle>

        <DialogContent>
          <Stack spacing={2.5} sx={{ pt: 1 }}>
            <Alert severity="warning">
              <AlertTitle>This device’s vault will be erased</AlertTitle>
              A replica destination does not keep anything of its own. Every secret,
              helper channel and share stored on this device is deleted and replaced
              with the source owner’s vault. It cannot be undone from this app.
            </Alert>

            <DialogContentText>
              Pick this side only on a device you are willing to give over to the other
              owner’s vault. If you meant to send this device’s vault somewhere else,
              cancel and pair as <strong>replica source</strong> instead.
            </DialogContentText>

            <Typography variant="body2" color="text.secondary">
              Nothing is erased by continuing. The pairing is set up first, and you are
              asked to confirm once more — against the actual vault being offered —
              before anything on this device is replaced.
            </Typography>
          </Stack>
        </DialogContent>

        <DialogActions>
          {/* Cancel is the default action: autofocused and filled. Escape and a
              backdrop click resolve here too. */}
          <Button variant="contained" onClick={onCancel} autoFocus>
            Cancel
          </Button>
          <Button variant="outlined" color="error" onClick={onConfirm}>
            Continue as destination
          </Button>
        </DialogActions>
      </Dialog>
    </AppMuiTheme>
  )
}

/** A pending consent request and the props that render its dialog. */
export interface ReplicaEraseConsent {
  /**
   * Open the warning and wait for a verdict. Resolves `true` only on an
   * explicit confirmation; Escape, the backdrop, Cancel and unmount all resolve
   * `false`, which the caller must treat as "start nothing".
   */
  request: () => Promise<boolean>
  dialogProps: ReplicaPairingWarningDialogProps
}

/**
 * Drive `ReplicaPairingWarningDialog` as an awaitable gate.
 *
 * Lets a submit handler read as `if (!(await request())) return` while the
 * dialog stays a plain controlled component.
 */
// Colocated with the dialog it drives — same convention as `ConsoleContext`.
// eslint-disable-next-line react-refresh/only-export-components
export function useReplicaEraseConsent(): ReplicaEraseConsent {
  const [open, setOpen] = useState(false)
  const resolverRef = useRef<((granted: boolean) => void) | null>(null)

  const settle = useCallback((granted: boolean) => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setOpen(false)
    resolve?.(granted)
  }, [])

  const request = useCallback(() => {
    // Deny any request still in flight rather than stranding its caller — the
    // safe direction, since a denial starts nothing.
    resolverRef.current?.(false)
    setOpen(true)
    return new Promise<boolean>(resolve => {
      resolverRef.current = resolve
    })
  }, [])

  // Unmounting with a request open must not leave the awaiting caller hanging.
  useEffect(
    () => () => {
      const resolve = resolverRef.current
      resolverRef.current = null
      resolve?.(false)
    },
    [],
  )

  return {
    request,
    dialogProps: {
      open,
      onConfirm: () => settle(true),
      onCancel: () => settle(false),
    },
  }
}
