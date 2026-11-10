// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type {
  ManualReplicaSyncOutcome,
  ReplicaView,
  UnresolvedAutomaticSync,
} from './replicaFlows'

/**
 * What a sync round has to say for itself, in the words the row shows.
 *
 * Both paths — the round the user asked for and the automatic one nobody
 * watched — end in the same shape and on the same row, because the recovery is
 * the same in both cases: press "Sync now". Kept out of the row component so the
 * wording is assertable without rendering anything.
 */

/** A one-line result banner for a sync round. */
export interface ReplicaRowSyncNotice {
  severity: 'success' | 'info' | 'warning' | 'error'
  message: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Report an explicitly requested sync, including the outcomes that sent nothing. */
export function describeManualSyncOutcome(
  outcome: ManualReplicaSyncOutcome,
  name: string,
): ReplicaRowSyncNotice {
  switch (outcome.kind) {
    case 'dispatched':
      return {
        severity: 'success',
        message: `A copy of this secret was sent. ${name} will acknowledge it once it arrives.`,
      }
    case 'nothing-to-mirror':
      return {
        severity: 'info',
        message: `This secret holds no items yet, so there was nothing to send to ${name}.`,
      }
    case 'busy':
      return {
        severity: 'warning',
        message:
          'Another round is already running. Nothing was sent — try again once it finishes.',
      }
    case 'failed':
      return {
        severity: 'error',
        message: `Could not send this secret to ${name}: ${errorText(outcome.error)}`,
      }
  }
}

/**
 * Report an automatic round that sent nothing, and name the way out.
 *
 * The automatic round runs once per destination and is never retried, so
 * without this the user is left with a replica that will not receive a copy
 * until some later protect round happens to run — and with a "Sync now" button
 * they have no reason to press. Both messages therefore end at that button.
 */
export function describeAutomaticSyncOutcome(
  outcome: UnresolvedAutomaticSync,
): ReplicaRowSyncNotice {
  switch (outcome.kind) {
    case 'nothing-to-mirror':
      return {
        severity: 'info',
        message:
          'A replica became ready to receive this secret, but it holds no items yet, so nothing was sent. Add an item, then use “Sync now” here.',
      }
    case 'failed':
      return {
        severity: 'error',
        message: `Automatically sending this secret to a newly confirmed replica failed: ${errorText(
          outcome.error,
        )}. It will not be retried on its own — use “Sync now” here.`,
      }
  }
}

/**
 * Whether a "sent — will acknowledge" notice has been answered.
 *
 * The dispatched notice promises an acknowledgement, so once one lands for
 * this row — any ack observed at or after the send — the promise is kept and
 * the notice has nothing left to say; the row's own "Mirrored vN" line takes
 * over. Every other outcome stays until dismissed: they report something the
 * user still has to act on.
 */
export function isSyncNoticeAnswered(
  outcome: ManualReplicaSyncOutcome['kind'],
  sentAt: number,
  view: ReplicaView,
): boolean {
  return outcome === 'dispatched' && view.lastSync !== null && view.lastSync.syncedAt >= sentAt
}
