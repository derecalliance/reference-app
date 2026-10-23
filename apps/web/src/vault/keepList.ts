// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { committedVersionsOf } from '../owner/heldShares'
import { DEFAULT_RETAINED_VERSIONS, resolvePublishPolicy } from '../owner/publishPolicy'
import type { Vault } from '../types'

/**
 * How many committed versions every helper keeps unless the owner says
 * otherwise in Vault Settings.
 *
 * Up to SDK 0.0.6 the library capped helpers at the last three version
 * *numbers* itself (`keep_versions_count`, default 3), counting rounds that
 * never reached threshold alongside those that did. From 0.0.7 the owner
 * decides through `ShareStore.keepList`; the app's default keeps the same cap
 * of three — of versions that actually committed, so a rolled-back round is
 * never kept on a helper's behalf — and the owner can change it, or pick the
 * versions at each publish (`PublishPolicy.helperRetention`).
 */
export const KEPT_COMMITTED_VERSIONS = DEFAULT_RETAINED_VERSIONS

/**
 * The versions helpers keep once the round distributing `version` lands — the
 * vault's answer to `ShareStore.keepList`.
 *
 * The SDK's rule (0.0.7): list every version that could still become the
 * latest, and leave out only versions whose round failed or was rolled back —
 * helpers delete whatever is not listed. That is two sets:
 *
 *  - **Committed versions**, capped at {@link KEPT_COMMITTED_VERSIONS}, newest
 *    first. Committed means "reached the bag": a protect round enters it only
 *    when enough helpers confirmed, and so does a round the library starts
 *    itself (pair-completion and fingerprint-confirmation publishes, folded by
 *    `SharingComplete`). A restored or adopted vault's bag holds the version it
 *    was rebuilt at, which is committed by definition — helpers served it.
 *  - **Open rounds** older than `version`, uncapped. Leaving one out would let
 *    helpers drop its share while it can still commit: if `version`'s round
 *    then fails and the open one succeeds, the vault's latest version would be
 *    gone from those helpers. A failed or rolled-back round is no longer open,
 *    so it is not listed. `openVersions` comes from the live round tracker;
 *    the record's persisted rounds are merged in for instances built by a
 *    command, which answer from the record.
 *
 * `version` itself is added by the library.
 *
 * `null` sends no list, so helpers keep everything they hold. Returned when
 * the record cannot vouch for anything, because a wrong list can make the
 * secret unrecoverable:
 *
 *  - the round is for another secret than the one this record describes —
 *    the moment between a restore or adoption rebuilding the instance and
 *    the record catching up;
 *  - the bag is empty, so no committed version is known on this device.
 */
export function keepListFor(
  vault: Vault,
  secretId: string,
  version: number,
  openVersions: readonly number[] = [],
  selection?: readonly number[] | null,
): number[] | null {
  if (secretId !== vault.secretId) return null
  const committed = [...committedVersionsOf(vault.secretBag)].sort((a, b) => b - a)
  if (committed.length === 0) return null
  const retention = resolvePublishPolicy(vault).helperRetention

  // `version` is excluded only so it is not counted against the cap: the
  // library lists it regardless, and a re-share of a committed number never
  // happens — every round takes a new one.
  let kept: Set<number>
  if (retention.mode === 'lastN') {
    kept = new Set(committed.filter(v => v !== version).slice(0, retention.n))
  } else {
    // The owner picks per publish. A round with no pick — one the library
    // started on its own — sends no list: nothing is dropped unless the owner
    // chose it.
    if (selection === undefined || selection === null) return null
    const chosen = new Set(selection)
    kept = new Set(committed.filter(v => v !== version && chosen.has(v)))
  }

  // Open rounds stay whatever the rule: dropping one could lose a version
  // that still commits.
  const persistedOpen = (vault.pendingProtectRounds ?? []).map(round => round.version)
  for (const open of [...openVersions, ...persistedOpen]) {
    if (open < version) kept.add(open)
  }
  return [...kept].sort((a, b) => b - a)
}

/**
 * What the next publish under the vault's "keep the last N" rule tells helpers,
 * for the publish dialogs to say before anything is sent: the committed
 * versions kept, and the ones dropped, newest first. Open rounds are always
 * kept and not listed here. `null` in select mode, where the owner picks.
 */
export function retentionPreview(
  vault: Vault,
  openVersions: readonly number[],
): { kept: number[]; dropped: number[] } | null {
  const retention = resolvePublishPolicy(vault).helperRetention
  if (retention.mode !== 'lastN') return null
  const open = new Set([...openVersions, ...(vault.pendingProtectRounds ?? []).map(r => r.version)])
  const committed = [...committedVersionsOf(vault.secretBag)].filter(v => !open.has(v)).sort((a, b) => b - a)
  return { kept: committed.slice(0, retention.n), dropped: committed.slice(retention.n) }
}
