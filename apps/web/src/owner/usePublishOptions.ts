// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState } from 'react'

import { publishTargets } from '../ownerPairing'
import type { PairedParticipant } from '../types'
import type { PublishChoice, PublishContext } from '../secret/types'
import { initialPublishOptions, toPublishChoice, type PublishOptionsDraft } from './publishOptions'

export interface PublishOptionsState {
  /** The helpers this publish goes to — see `publishTargets`. */
  helpers: PairedParticipant[]
  draft: PublishOptionsDraft
  setDraft: (next: PublishOptionsDraft) => void
  /** The owner's choice, or `null` while anything in the draft is invalid. */
  choice: PublishChoice | null
}

/**
 * The state behind a publish dialog's `PublishOptionsPanel`: the helpers the
 * round goes to and the owner's pick of the version helpers keep. The
 * threshold and weights are the secret's own, read from `context.policy`.
 */
export function usePublishOptions(
  participants: readonly PairedParticipant[],
  pendingChannelIds: ReadonlySet<string>,
  context: PublishContext,
): PublishOptionsState {
  const helpers = publishTargets(participants, pendingChannelIds)
  const [draft, setDraft] = useState(initialPublishOptions)
  return {
    helpers,
    draft,
    setDraft,
    choice: toPublishChoice(draft, helpers, context.policy),
  }
}
