import type { ManualReplicaSyncOutcome, UnresolvedAutomaticSync } from './replicaFlows'

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
        message: `A copy of this vault was sent. ${name} will acknowledge it once it arrives.`,
      }
    case 'nothing-to-mirror':
      return {
        severity: 'info',
        message: `This vault holds no secrets yet, so there was nothing to send to ${name}.`,
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
        message: `Could not send this vault to ${name}: ${errorText(outcome.error)}`,
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
          'A replica became ready to receive this vault, but the vault holds no secrets yet, so nothing was sent. Protect a secret, then use “Sync now” here.',
      }
    case 'failed':
      return {
        severity: 'error',
        message: `Automatically sending this vault to a newly confirmed replica failed: ${errorText(
          outcome.error,
        )}. It will not be retried on its own — use “Sync now” here.`,
      }
  }
}
