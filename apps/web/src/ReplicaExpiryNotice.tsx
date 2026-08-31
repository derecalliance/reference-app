import { Alert, Typography } from '@mui/material'
import type { ReplicaExpiry } from './replicaFlows'

/**
 * The deadline on an unconfirmed replica channel, in words.
 *
 * A channel the library still holds `Pending` is dropped once it has been
 * pending longer than the configured protocol timeout. The library is right to
 * do this; the app's job is to say so before it happens, and to say plainly
 * that it has happened afterwards rather than leaving a dead row looking live.
 *
 * Purely presentational: the rule is [`replicaChannelExpiry`] and the clock is
 * `useReplicaExpiry`. Nothing here re-states either.
 */

export interface ReplicaExpiryNoticeProps {
  /** The live expiry, or `null` — callers pass `useReplicaExpiry` straight through. */
  expiry: ReplicaExpiry | null
  /**
   * `dialog` is where the user is actively comparing codes, so every state is
   * spelled out there; `row` keeps the healthy case to one quiet line.
   */
  variant: 'row' | 'dialog'
}

/** Whole seconds as `m:ss`. */
function formatRemaining(secs: number): string {
  const minutes = Math.floor(secs / 60)
  return `${minutes}:${String(secs - minutes * 60).padStart(2, '0')}`
}

export function ReplicaExpiryNotice({ expiry, variant }: ReplicaExpiryNoticeProps) {
  if (!expiry) return null

  // Each state differs in wording *and* in form — plain line, warning, error —
  // so none of them depends on its colour to be read.
  if (expiry.state === 'expired') {
    return (
      <Alert severity="error" role="alert" variant="outlined">
        <strong>This channel expired.</strong> It was not confirmed on both devices in time,
        so the protocol has dropped it and its code can no longer be used. Pair again to
        start a new one.
      </Alert>
    )
  }

  const left = formatRemaining(expiry.remainingSecs)

  if (expiry.state === 'expiring-soon') {
    return (
      // The figure changes every second, so the region is not announced on each
      // tick. The one state worth announcing is `expired`, and that arm above
      // is a static `role="alert"`.
      <Alert severity="warning" role="status" aria-live="off" variant="outlined">
        <strong>Expiring in {left}.</strong> Confirm the code on both devices now — once the
        time runs out the protocol drops this channel and you have to pair again.
      </Alert>
    )
  }

  const text = `Confirm within ${left}. An unconfirmed channel is dropped by the protocol after that, and you have to pair again.`

  return variant === 'dialog' ? (
    <Alert severity="info" role="status" aria-live="off" variant="outlined">
      {text}
    </Alert>
  ) : (
    <Typography variant="body2" color="text.secondary" role="status" aria-live="off">
      {text}
    </Typography>
  )
}
