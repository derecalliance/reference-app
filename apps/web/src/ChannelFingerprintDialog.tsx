import { useCallback, useEffect, useRef, useState } from 'react'
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
import { apiConfirmActorFingerprint, apiGetActorFingerprint } from './api'

/**
 * Out-of-band fingerprint comparison for a **helper** channel paired with
 * `ContactMode.NoKeys`.
 *
 * A `NoKeys` contact carries no keys and no commitment to them, so nothing
 * binds the keys the scanner receives over the plaintext `PrePair` leg to the
 * contact that was delivered out of band. The library therefore holds the
 * channel `Pending` — not a publish target, not a recovery source, ignoring
 * inbound messages — until `verifyFingerprint` succeeds on *both* sides.
 *
 * A man-in-the-middle on that leg leaves the two sides with different shared
 * keys and so different codes, which is exactly what the comparison catches.
 * That makes "doesn't match" a security event rather than a typo: it is
 * surfaced as such, and refusing simply leaves the channel `Pending`.
 *
 * The sibling of {@link ReplicaFingerprintDialog}, which does the same job for
 * replica channels — those are gated in every contact mode and carry mirroring
 * semantics this one has no business knowing about.
 */

export interface ChannelFingerprintDialogProps {
  open: boolean
  /** Display name of the peer on the other end. */
  peerName: string
  /** Long-term channel id, as a decimal string. */
  channelId: string
  /**
   * Provisioned actor id when the peer is a backend fixture, `null` when it is
   * another browser. A fixture has no screen, so this device reads its code
   * over HTTP and stands in for the human at that end; a browser peer shows its
   * own code and confirms for itself.
   */
  peerActorId: string | null
  getFingerprint: (channelId: bigint) => Promise<string>
  verifyFingerprint: (channelId: bigint, fingerprint: string) => Promise<boolean>
  /** Called once this device's side is promoted to `Paired`. */
  onConfirmed: (channelId: string) => void
  onClose: () => void
}

type AttemptState =
  | { kind: 'idle' }
  | { kind: 'verifying' }
  /** This device is confirmed; the peer's side is recorded or unobservable. */
  | { kind: 'local-only' }
  /** The operator said the codes differ. */
  | { kind: 'refused' }
  | { kind: 'error'; message: string }

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
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

export function ChannelFingerprintDialog({
  open,
  peerName,
  channelId,
  peerActorId,
  getFingerprint,
  verifyFingerprint,
  onConfirmed,
  onClose,
}: ChannelFingerprintDialogProps) {
  const [ownCode, setOwnCode] = useState<string | null>(null)
  const [peerCode, setPeerCode] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [attempt, setAttempt] = useState<AttemptState>({ kind: 'idle' })

  /**
   * The callbacks, held so they cannot change this component's effects.
   *
   * They arrive as inline arrows, so every parent render hands over fresh
   * identities. Depending on them directly made `loadCodes` — and therefore the
   * effect below — new on every render, and that effect resets `attempt` to
   * `idle`. Pressing "Codes match" set `verifying`, the next render wiped it,
   * and the dialog sat there looking untouched while re-deriving the
   * fingerprint over and over. Refs keep the deps to what actually identifies
   * the work: the channel and the peer.
   */
  const getFingerprintRef = useRef(getFingerprint)
  const verifyFingerprintRef = useRef(verifyFingerprint)
  const onConfirmedRef = useRef(onConfirmed)
  useEffect(() => { getFingerprintRef.current = getFingerprint }, [getFingerprint])
  useEffect(() => { verifyFingerprintRef.current = verifyFingerprint }, [verifyFingerprint])
  useEffect(() => { onConfirmedRef.current = onConfirmed }, [onConfirmed])

  const loadCodes = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      setOwnCode(await getFingerprintRef.current(BigInt(channelId)))
      if (peerActorId) setPeerCode(await apiGetActorFingerprint(peerActorId, channelId))
    } catch (err) {
      setLoadError(messageOf(err, 'Could not derive the fingerprint.'))
    } finally {
      setLoading(false)
    }
  }, [channelId, peerActorId])

  useEffect(() => {
    if (!open) return
    setAttempt({ kind: 'idle' })
    void loadCodes()
  }, [open, loadCodes])

  async function handleConfirm() {
    if (ownCode === null) return
    setAttempt({ kind: 'verifying' })

    let localOk: boolean
    try {
      localOk = await verifyFingerprintRef.current(BigInt(channelId), ownCode)
    } catch (err) {
      setAttempt({ kind: 'error', message: messageOf(err, 'Verification could not be completed.') })
      return
    }

    if (!localOk) {
      // The operator already settled whether the codes match. Verifying the code
      // this device just derived can only fail if the channel key moved
      // underneath the comparison.
      setAttempt({
        kind: 'error',
        message:
          'The channel key changed while you were comparing. Close this and confirm again with a freshly derived code.',
      })
      return
    }

    onConfirmedRef.current(channelId)

    if (!peerActorId) {
      setAttempt({ kind: 'local-only' })
      return
    }

    try {
      const peerOk = await apiConfirmActorFingerprint(peerActorId, channelId, ownCode)
      if (!peerOk) {
        setAttempt({
          kind: 'error',
          message: `${peerName} derived a different code from ours. Treat this channel as compromised and pair again.`,
        })
        return
      }
    } catch (err) {
      setAttempt({
        kind: 'error',
        message: messageOf(err, `${peerName}'s confirmation could not be recorded.`),
      })
      return
    }

    onClose()
  }

  const verifying = attempt.kind === 'verifying'
  const settled = attempt.kind === 'local-only' || attempt.kind === 'refused'
  const canConfirm = !loading && !verifying && !settled && ownCode !== null

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="channel-fp-title">
      <DialogTitle id="channel-fp-title">Confirm “{peerName}”</DialogTitle>

      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <DialogContentText>
            This channel was paired with a contact that carried no keys, so nothing
            proves the keys came from {peerName}.{' '}
            {peerActorId
              ? 'Both codes below are derived from the shared key — confirm only if they are identical.'
              : `Check that ${peerName} is showing this same code, and confirm only if the two are identical.`}{' '}
            Until both sides confirm, the channel holds no shares and ignores
            anything sent on it.
          </DialogContentText>

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
                <Button color="inherit" size="small" onClick={() => void loadCodes()}>
                  Retry
                </Button>
              }
            >
              {loadError}
            </Alert>
          )}

          {ownCode && (
            <Stack spacing={0.5}>
              {peerActorId && (
                <Typography variant="overline" component="h3" color="text.secondary">
                  This device
                </Typography>
              )}
              <Typography sx={CODE_SX} aria-label={`This device's code: ${ownCode}`}>
                {ownCode}
              </Typography>
            </Stack>
          )}

          {peerCode && (
            <Stack spacing={0.5}>
              <Typography variant="overline" component="h3" color="text.secondary">
                {peerName}
              </Typography>
              <Typography sx={CODE_SX} aria-label={`${peerName}'s code: ${peerCode}`}>
                {peerCode}
              </Typography>
            </Stack>
          )}

          {attempt.kind === 'local-only' && (
            <Alert severity="info">
              Confirmed on this device. {peerName} still has to confirm on theirs before
              the channel can carry anything.
            </Alert>
          )}

          {attempt.kind === 'refused' && (
            <Alert severity="error">
              Two devices sharing a key always derive the same code, so different codes
              mean something sat between them during pairing. The channel has been left
              unusable. Pair again over a delivery channel you trust, or use inline or
              hashed keys instead.
            </Alert>
          )}

          {attempt.kind === 'error' && <Alert severity="error">{attempt.message}</Alert>}
        </Stack>
      </DialogContent>

      <DialogActions>
        {settled ? (
          <Button variant="contained" onClick={onClose} autoFocus>
            Done
          </Button>
        ) : (
          <>
            {/* Refusing writes nothing: the channel stays `Pending` and is swept
                on its own. It is a security outcome, so it says so rather than
                dismissing quietly. */}
            <Button
              color="error"
              onClick={() => setAttempt({ kind: 'refused' })}
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
