// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * Why nothing that starts a round of sharing may run now, or `null`.
 *
 * Settling rounds is the application's job. From SDK 0.0.10 a helper keeps at
 * most the version being shared and one earlier version, so a round started
 * while another is open can make helpers drop a version that then commits.
 * Every action that publishes — adding or removing an item, republishing,
 * retrying, pairing (a completed pairing publishes), confirming a fingerprint
 * (a promotion publishes), unpairing a helper and removing a replica (both
 * publish a new version to the rest) — waits until no round is open.
 *
 * `openVersions` are the rounds still open, this secret's and the library's
 * own. `pendingUnpairs` counts the unpairs still waiting for the helper's
 * answer: the app publishes when each completes, so one in flight is a
 * round about to start.
 */
export function roundInProgressReason(
  openVersions: readonly number[],
  pendingUnpairs = 0,
): string | null {
  if (openVersions.length > 0) {
    const versions = [...openVersions].sort((a, b) => a - b).map(v => `v${v}`)
    const which = versions.length === 1 ? `${versions[0]} is` : `${versions.join(', ')} are`
    return (
      `${which} still being published. Wait until every helper has answered, or the round times out, ` +
      'before starting anything that publishes.'
    )
  }
  if (pendingUnpairs > 0) {
    const which = pendingUnpairs === 1 ? 'An unpair is' : `${pendingUnpairs} unpairs are`
    return (
      `${which} waiting for the helper's answer, and publishes a new version when it completes. ` +
      'Wait for it, or for it to time out, before starting anything that publishes.'
    )
  }
  return null
}
