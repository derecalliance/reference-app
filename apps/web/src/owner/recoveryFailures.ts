import type { RecoveryFailure } from '../types'

/**
 * Insert or replace the failure entry for a (secret_id, version) pair.
 * Used when an in-flight recovery attempt reaches a terminal failure state;
 * the entry must survive subsequent Recover clicks on other versions so the
 * row keeps its "Incomplete" status until the user retries it specifically.
 */
export function upsertRecoveryFailure(
  failures: RecoveryFailure[],
  secretId: string,
  version: number,
  error: string,
): RecoveryFailure[] {
  const without = failures.filter(f => !(f.secretId === secretId && f.version === version))
  return [...without, { secretId, version, error }]
}

/**
 * Drop the failure entry for a (secret_id, version) pair. Used on a fresh
 * Recover click for that version (the new attempt's outcome supersedes the
 * old one) and on `SecretRecovered` (success).
 */
export function removeRecoveryFailure(
  failures: RecoveryFailure[],
  secretId: string,
  version: number,
): RecoveryFailure[] {
  return failures.filter(f => !(f.secretId === secretId && f.version === version))
}

export function findRecoveryFailure(
  failures: RecoveryFailure[] | undefined,
  secretId: string,
  version: number,
): RecoveryFailure | undefined {
  return failures?.find(f => f.secretId === secretId && f.version === version)
}
