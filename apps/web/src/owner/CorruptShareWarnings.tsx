// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { Alert, AlertTitle, Button, Stack } from '@mui/material'

import { AppMuiTheme } from '../AppMuiTheme'
import type { CorruptionReason, CorruptShareReport, PairedParticipant } from '../types'

/** What each reason means, in the owner's terms. */
const REASON_TEXT: Record<CorruptionReason, string> = {
  Malformed: 'its answer held no readable share of this secret and version',
  InvalidProof: 'the share failed its own integrity proof',
  Inconsistent: 'the share disagreed with the shares the secret was rebuilt from',
}

export interface CorruptShareWarningsProps {
  reports: readonly CorruptShareReport[]
  participants: readonly PairedParticipant[]
  /** Ask to unpair the helper on `channelId` — the caller confirms first. */
  onUnpair: (participant: PairedParticipant) => void
  onDismiss: (report: CorruptShareReport) => void
}

/**
 * One warning per helper that sent a corrupted recovery share.
 *
 * The library sets such a share aside and recovers from the others, so nothing
 * is lost — but an honest helper never sends one, so the helper is either
 * damaged or compromised, and the owner is the one to decide what to do about
 * it. Kept on screen until they do: a toast would scroll away with the only
 * record of which helper it was.
 */
export function CorruptShareWarnings({
  reports,
  participants,
  onUnpair,
  onDismiss,
}: CorruptShareWarningsProps) {
  if (reports.length === 0) return null

  return (
    <AppMuiTheme>
      <Stack spacing={1} sx={{ mx: 2, my: 1 }}>
        {reports.map(report => {
          const participant = participants.find(
            p => p.channelId === report.channelId && p.connectionStatus === 'paired',
          )
          return (
            <Alert
              key={`${report.channelId}:${report.version}:${report.reason}`}
              severity="error"
              sx={{ textAlign: 'left' }}
              action={
                <Stack direction="row" spacing={1}>
                  {participant && (
                    <Button color="inherit" size="small" onClick={() => onUnpair(participant)}>
                      Unpair…
                    </Button>
                  )}
                  <Button color="inherit" size="small" onClick={() => onDismiss(report)}>
                    Dismiss
                  </Button>
                </Stack>
              }
            >
              <AlertTitle>
                {report.peerName} sent a corrupted recovery share ({report.reason})
              </AlertTitle>
              While recovering v{report.version}, {REASON_TEXT[report.reason]}. The share was set
              aside and did not count towards the recovery. An honest helper never sends one, so{' '}
              {report.peerName} may be damaged or compromised
              {participant
                ? ' — consider unpairing it.'
                : '. It is no longer paired with this vault.'}
            </Alert>
          )
        })}
      </Stack>
    </AppMuiTheme>
  )
}
