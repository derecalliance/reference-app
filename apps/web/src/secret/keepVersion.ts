// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { committedVersionsOf } from '../owner/heldShares'
import { resolvePublishPolicy } from '../owner/publishPolicy'
import type { Secret } from '../types'

/**
 * The one earlier version helpers keep once the round distributing `version`
 * lands — the secret's answer to `ShareStore.keepVersion`. `0` keeps none.
 *
 * From SDK 0.0.10 an owner names a single `keepVersion`: a helper holds at most
 * the version being shared and that one, and deletes every other version it
 * holds on the channel — rounds still open included. (Up to 0.0.9 the owner
 * sent a `keepList`, and the app kept the newest committed versions plus every
 * open round.)
 *
 * - **Newest committed** is the answer by default, and the library's own
 *   advice: the version recovery falls back to if this round fails. Committed
 *   means "reached the bag": a protect round enters it only when enough
 *   helpers confirmed, and so does a round the library starts itself
 *   (pair-completion and fingerprint-confirmation publishes, folded by
 *   `SharingComplete`). A restored or adopted secret's bag holds the version it
 *   was rebuilt at, which is committed by definition — helpers served it.
 * - **The owner's pick**, in "choose at each publish" mode, when this round
 *   carries one (`selection`; `0` keeps none). A round the library starts on
 *   its own carries none and keeps the newest committed version.
 *
 * When the record cannot vouch for anything the answer is `version - 1`, the
 * newest version that may have committed — the SDK numbers a round one above
 * the latest snapshot it holds. Keeping a version that never committed only
 * costs helpers storage; dropping the one that did can make the secret
 * unrecoverable. That covers:
 *
 *  - a round for another secret than the one this record describes — the
 *    moment between a restore or adoption rebuilding the instance and the
 *    record catching up;
 *  - an empty bag, so no committed version is known on this device.
 */
export function keepVersionFor(
  secret: Secret,
  secretId: string,
  version: number,
  selection?: number | null,
): number {
  const newestPossible = Math.max(0, version - 1)
  if (secretId !== secret.secretId) return newestPossible
  if (
    resolvePublishPolicy(secret).helperRetention.mode === 'select' &&
    selection !== undefined &&
    selection !== null &&
    selection < version
  ) {
    return selection
  }
  return newestCommittedBelow(secret, version) ?? newestPossible
}

/**
 * What the next publish tells helpers under the secret's "keep the newest
 * committed version" rule, for the publish dialogs to say before anything is
 * sent: the version kept, and the committed versions dropped, newest first.
 * `null` in select mode, where the owner picks.
 */
export function retentionPreview(secret: Secret): { kept: number | null; dropped: number[] } | null {
  if (resolvePublishPolicy(secret).helperRetention.mode !== 'latestCommitted') return null
  const [kept = null, ...dropped] = [...committedVersionsOf(secret.itemBag)].sort((a, b) => b - a)
  return { kept, dropped }
}

function newestCommittedBelow(secret: Secret, version: number): number | null {
  const below = [...committedVersionsOf(secret.itemBag)].filter(v => v < version)
  return below.length === 0 ? null : Math.max(...below)
}
