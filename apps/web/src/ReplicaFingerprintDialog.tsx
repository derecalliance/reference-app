import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material'
import {
  acceptFingerprintMatch,
  fetchFingerprint,
  type ReplicaPairingRole,
  type ReplicaRecord,
  type ReplicaProtocol,
  type ReplicaView,
} from './replicaFlows'
import { ReplicaExpiryNotice } from './ReplicaExpiryNotice'
import { useReplicaExpiry } from './useReplicaExpiry'

/**
 * Out-of-band fingerprint comparison for a replica channel.
 *
 * Modelled on Bluetooth numeric comparison: both ends display a code derived
 * from the shared key, a person checks the two screens are identical, and each
 * end records its own decision. Nothing is transcribed. Asking someone to copy
 * sixteen digits between devices tests their typing, not the channel — the
 * mismatch it most often catches is a typo, and the code is short enough to
 * compare by eye.
 *
 * The comparison is therefore the human's, and this dialog is the place they
 * make it. `Confirm` asserts "these match"; `Doesn't match` refuses, leaving the
 * channel `Pending` and untouched. There is no third outcome, because the device
 * has no independent way to check.
 *
 * Each device's channel stays `Pending` — and therefore outside the protocol's
 * own fan-out — until *that* device confirms. Confirming settles this device's
 * side only. The peer confirms on its own instance, and the two are independent
 * — which is why a source that confirmed first may have to re-send.
 */

export interface ReplicaFingerprintDialogProps {
  open: boolean
  replica: ReplicaView
  protocol: ReplicaProtocol
  /**
   * The owner's configured protocol timeout, in seconds.
   *
   * The same value the library was constructed with, and therefore the same one
   * it drops an unconfirmed channel after — which is what makes the countdown
   * in this dialog a real deadline rather than a guess.
   */
  protocolTimeoutSecs: number
  /** Persist a confirmation for one or both sides of this replica. */
  onConfirm: (patch: Partial<ReplicaRecord>) => void
  onClose: () => void
}

/** Outcome of the last attempt. `idle` before the first one. */
type AttemptState =
  | { kind: 'idle' }
  | { kind: 'verifying' }
  /**
   * This device is confirmed and there is nothing further it can do here.
   *
   * Terminal, and the only success state: the peer confirms on its own protocol
   * instance and this device never sees that happen. `verify_fingerprint` is
   * idempotent — a second call on a channel it already promoted still matches
   * and still returns `true` — so leaving Confirm live would let the user press
   * it repeatedly and watch the very same state be set again, which reads as
   * the dialog having frozen.
   */
  | { kind: 'local-only' }
  | { kind: 'error'; message: string }

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

/** What confirming this channel unlocks, from this device's side of the mirror. */
function mirrorDirectionText(direction: ReplicaPairingRole, peerIsHelper: boolean): string {
  if (direction !== 'replica_source') {
    return 'the peer will not offer its vault to this device until you confirm here.'
  }
  const base = 'this device will not mirror its vault to the replica until you confirm here'
  // For a helper peer, what happens on its end is already covered above — it
  // has no screen and nothing to wait on, so there is nothing further to add.
  return peerIsHelper
    ? `${base}.`
    : `${base}, and the replica will not accept the copy until it confirms on its own screen.`
}

/** The code is the whole content of this dialog, so it is set like it. */
const CODE_SX = {
  fontFamily: 'monospace',
  fontSize: '2rem',
  fontWeight: 600,
  letterSpacing: '0.12em',
  textAlign: 'center',
  lineHeight: 1.3,
} as const

export function ReplicaFingerprintDialog({
  open,
  replica,
  protocol,
  protocolTimeoutSecs,
  onConfirm,
  onClose,
}: ReplicaFingerprintDialogProps) {
  const { channelId } = replica

  // This is where the user spends time comparing codes, so it is where the
  // deadline belongs. `null` on a channel that is already confirmed — nothing
  // is dropped once the library holds it `Paired`.
  const expiry = useReplicaExpiry(replica, protocolTimeoutSecs)

  const [ownCode, setOwnCode] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [attempt, setAttempt] = useState<AttemptState>({ kind: 'idle' })

  // Only this device's code. Every peer now confirms on its own protocol
  // instance — a helper auto-confirms server-side, another browser device
  // confirms on its own screen — so there is no second code to fetch and
  // nothing here may assert the peer's decision on its behalf.
  const loadCode = useCallback(async () => {
    if (!channelId) return
    setLoading(true)
    setLoadError(null)
    try {
      setOwnCode(await fetchFingerprint(protocol, channelId))
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not derive the fingerprint.')
    } finally {
      setLoading(false)
    }
  }, [channelId, protocol])

  useEffect(() => {
    if (!open) return
    setAttempt({ kind: 'idle' })
    void loadCode()
  }, [open, loadCode])

  /**
   * The operator says the codes match. Records this device's side.
   *
   * `ownCode` is what gets verified — see `acceptFingerprintMatch`. The user has
   * already made the comparison this dialog exists for; the call records it.
   */
  async function handleConfirm() {
    if (!channelId || ownCode === null) return
    setAttempt({ kind: 'verifying' })

    let localOk: boolean
    try {
      localOk = await acceptFingerprintMatch(protocol, channelId, ownCode)
    } catch (err) {
      setAttempt({ kind: 'error', message: messageOf(err, 'Verification could not be completed.') })
      return
    }

    if (!localOk) {
      // Not "the codes differ" — the user settled that. Verifying the code this
      // device just derived can only fail if the channel key changed underneath
      // the comparison, so it is reported as the anomaly it is.
      setAttempt({
        kind: 'error',
        message:
          'The channel key changed while you were comparing. Close this and confirm again with a freshly derived code.',
      })
      return
    }

    // Only ever *add* a confirmation — writing `peer: 'none'` would clobber one
    // earned on an earlier attempt.
    onConfirm({ local: true })

    // The peer's confirmation happens on the peer, against its own protocol
    // instance. Nothing here can observe it, and nothing here may assert it on
    // the peer's behalf — this device has confirmed its own side and that is
    // the whole of what it knows.
    setAttempt({ kind: 'local-only' })
  }

  const verifying = attempt.kind === 'verifying'
  // Nothing this device can still contribute: its side is verified, and the
  // peer's is either recorded or unobservable from here.
  const settled = attempt.kind === 'local-only'
  // The code has to be on screen before anyone can claim to have compared it.
  const canConfirm = !!channelId && !loading && !verifying && !settled && ownCode !== null

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="replica-fp-title">
      <DialogTitle id="replica-fp-title">Confirm “{replica.name}”</DialogTitle>

      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <DialogContentText>
            {replica.helperActorId
              ? `${replica.name} is a helper paired in replica mode: it derives and confirms this code automatically, with no screen on its end to check it against — `
              : `Check that ${replica.name} is showing this same code. Confirm only if the two are identical — `}
            {mirrorDirectionText(replica.direction, replica.helperActorId != null)}
          </DialogContentText>

          <ReplicaExpiryNotice expiry={expiry} variant="dialog" />

          {!channelId && (
            <Alert severity="info">
              This replica has not completed pairing yet. Pair it first, then confirm the
              fingerprint.
            </Alert>
          )}

          {loading && (
            <Stack direction="row" spacing={1.5} alignItems="center">
              <CircularProgress size={20} aria-hidden />
              <Typography variant="body2">Deriving fingerprint…</Typography>
            </Stack>
          )}

          {loadError && (
            <Alert
              severity="error"
              action={
                <Button color="inherit" size="small" onClick={() => void loadCode()}>
                  Retry
                </Button>
              }
            >
              {loadError}
            </Alert>
          )}

          {ownCode && (
            <Typography sx={CODE_SX} aria-label={`This device's code: ${ownCode}`}>
              {ownCode}
            </Typography>
          )}

          {attempt.kind === 'local-only' && (
            <Alert severity="info">
              {replica.direction !== 'replica_source' ? (
                <>
                  Confirmed on this device. {replica.name} still has to confirm on theirs
                  before their vault can be offered here.
                </>
              ) : (
                // Naming the required step, not offering it as a fallback: this
                // device cannot see the peer's confirmation, so it will not
                // mirror on its own and the user has to press the button.
                <>
                  Confirmed on this device. This device cannot see {replica.name}’s
                  confirmation, so it will not mirror automatically —{' '}
                  {replica.helperActorId
                    ? `${replica.name} confirms itself automatically as a helper, so press “Sync now” on their row to send the mirror.`
                    : 'once they have confirmed, press “Sync now” on their row.'}
                </>
              )}
            </Alert>
          )}

          {attempt.kind === 'error' && <Alert severity="error">{attempt.message}</Alert>}
        </Stack>
      </DialogContent>

      <DialogActions>
        {/* Once this device is confirmed there is only one thing left to do, so
            the dialog offers exactly that instead of a Confirm that would
            re-run an idempotent verify and appear to do nothing. */}
        {settled ? (
          <Button variant="contained" onClick={onClose} autoFocus>
            Done
          </Button>
        ) : (
          <>
            {/* Refusing is the other half of the comparison, so it is a stated
                choice rather than a dismissal. It writes nothing: the channel
                stays `Pending` and expires on its own. */}
            <Button onClick={onClose} disabled={verifying}>
              Doesn’t match
            </Button>
            <Button
              variant="contained"
              onClick={() => void handleConfirm()}
              disabled={!canConfirm}
            >
              {verifying ? 'Confirming…' : 'Codes match'}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  )
}
