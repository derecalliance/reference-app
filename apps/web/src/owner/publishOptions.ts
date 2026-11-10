// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { PairedParticipant } from '../types'
import type { PublishChoice } from '../secret/types'
import type { PublishPolicy } from './publishPolicy'
import { hasNoSharingProblems, sharingProblems } from './sharingSettings'

/**
 * What a publish dialog's options hold while the owner edits them: only the
 * earlier version helpers keep. The threshold and weights are the secret's,
 * set on the Channels tab.
 */
export interface PublishOptionsDraft {
  /**
   * The earlier version helpers keep — read only in "choose at each publish"
   * mode; `0` keeps none. `null` is the newest committed version, read when
   * the owner publishes, so a version that commits while the dialog is open
   * is the one kept unless the owner picked another.
   */
  keep: number | null
}

/** The dialog's starting point: the newest committed version kept. */
export function initialPublishOptions(): PublishOptionsDraft {
  return { keep: null }
}

/**
 * The owner's choice as the runtime takes it, or `null` while the secret's
 * threshold and weights would make the SDK refuse the round.
 */
export function toPublishChoice(
  draft: PublishOptionsDraft,
  helpers: readonly PairedParticipant[],
  policy: PublishPolicy,
): PublishChoice | null {
  if (!hasNoSharingProblems(sharingProblems(helpers, policy))) return null
  return { keep: policy.helperRetention.mode === 'select' ? draft.keep : null }
}
