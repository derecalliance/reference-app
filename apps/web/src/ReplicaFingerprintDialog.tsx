// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

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
import { errorText } from './errorText'

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
  /**
   * The person says the codes do not match. Recorded on this device only —
   * the protocol has no message for a refusal, so the peer is never told.
   */
  onRefuse: () => void
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

/**
 * `fallback` is used only when nothing thrown carries any text at all.
 *
 * The WASM bindings reject with plain `{ code, message }` objects, so testing
 * for `Error` and giving up threw away the one sentence that says *why* the
 * channel would not derive or verify — leaving a dialog whose Retry can only
 * fail again for a reason it never showed.
 */
function messageOf(err: unknown, fallback: string): string {
  const text = errorText(err)
  return text === 'unknown error' ? fallback : text
}

/**
 * What happens next once this device has confirmed, from its side of the
 * mirror.
 *
 * The library publishes the mirror itself the moment `verify_fingerprint`
 * promotes the channel on a source, so nothing here asks for "Sync now". A
 * helper confirms itself server-side and takes that copy at once; a browser
 * destination that has not confirmed yet drops it, and fetches the copy itself
 * when it does — which is what its row's "Syncing…" is.
 */
function afterConfirmText(direction: ReplicaPairingRole, name: string, peerIsHelper: boolean): string {
  if (direction !== 'replica_source') {
    return `Confirmed on this device. ${name} still has to confirm on theirs before their vault can be offered here.`
  }
  return peerIsHelper
    ? `Confirmed on this device. ${name} confirms itself as a helper, so the mirror goes out now — their row shows the version once they acknowledge it.`
    : `Confirmed on this device. The mirror goes out now; if ${name} has not confirmed yet, their device fetches the copy itself once they do. Their row shows the version once they acknowledge it.`
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
  onRefuse,
  onClose,
}: ReplicaFingerprintDialogProps) {
  const { channelId } = replica
  // Opened on a channel this device already confirmed — "View fingerprint".
  // Captured once: a confirmation made *in* this dialog lands in `local-only`,
  // which has its own wording, rather than flipping the dialog into this mode.
  const [alreadyConfirmed] = useState(() => replica.status === 'paired')

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
      setLoadError(messageOf(err, 'Could not derive the fingerprint.'))
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
    // A refusal recorded earlier was a misreading, by the person's own account.
    onConfirm({ local: true, refused: false })

    // The peer's confirmation happens on the peer, against its own protocol
    // instance. Nothing here can observe it, and nothing here may assert it on
    // the peer's behalf — this device has confirmed its own side and that is
    // the whole of what it knows.
    setAttempt({ kind: 'local-only' })
  }

  const verifying = attempt.kind === 'verifying'
  // Nothing this device can still contribute: its side is verified, and the
  // peer's is either recorded or unobservable from here.
  const settled = attempt.kind === 'local-only' || alreadyConfirmed
  // The code has to be on screen before anyone can claim to have compared it.
  const canConfirm = !!channelId && !loading && !verifying && !settled && ownCode !== null

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="replica-fp-title">
      <DialogTitle id="replica-fp-title">
        {alreadyConfirmed ? `Fingerprint for “${replica.name}”` : `Confirm “${replica.name}”`}
      </DialogTitle>

      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          {alreadyConfirmed ? (
            // A confirmed channel has nothing left to decide: re-offering
            // "Codes match / Doesn't match" and saying nothing mirrors "until
            // you confirm" contradicted the row that opened this.
            <DialogContentText>
              This device already confirmed this code. It is shown again so it can be
              compared with {replica.name}’s screen at any time — there is nothing left to
              decide here.
            </DialogContentText>
          ) : (
            <DialogContentText>
              {replica.helperActorId
                ? `${replica.name} is a helper paired in replica mode: it derives and confirms this code automatically, with no screen on its end to check it against — `
                : `Check that ${replica.name} is showing this same code. Confirm only if the two are identical — `}
              {mirrorDirectionText(replica.direction, replica.helperActorId != null)}
            </DialogContentText>
          )}

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
              {afterConfirmText(replica.direction, replica.name, replica.helperActorId != null)}
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
            {alreadyConfirmed ? 'Close' : 'Done'}
          </Button>
        ) : (
          <>
            {/* Refusing is the other half of the comparison, so it is a stated
                choice rather than a dismissal: it is recorded on this device,
                and the row says so. The channel stays `Pending` and expires on
                its own — the protocol has no way to tell the peer. */}
            <Button
              onClick={() => {
                onRefuse()
                onClose()
              }}
              disabled={verifying}
            >
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
