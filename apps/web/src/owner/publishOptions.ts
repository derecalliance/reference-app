// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { PairedParticipant } from '../types'
import type { PublishChoice } from '../vault/types'
import { defaultWeightFor, type PublishPolicy } from './publishPolicy'
import { participantWeight, weightProblem } from './weights'

/**
 * What a publish dialog's options hold while the owner edits them: every
 * helper's weight and the threshold as typed, the versions to drop in
 * "choose at each publish" mode, and whether to remember a changed threshold.
 */
export interface PublishOptionsDraft {
  /** As typed, by channel id. */
  weights: Record<string, string>
  threshold: string
  /**
   * Committed versions the owner unchecked — read only in "choose at each
   * publish" mode. Held as what is dropped rather than kept, so a version that
   * commits while the dialog is open is kept unless the owner unchecks it.
   */
  dropped: number[]
  rememberThreshold: boolean
}

export interface PublishOptionsProblems {
  threshold?: string
  /** By channel id. */
  weights: Record<string, string>
  /** The weights together fall short of the threshold. */
  total?: string
}

/** The dialog's starting point: the vault's defaults, and every committed version kept. */
export function initialPublishOptions(
  helpers: readonly PairedParticipant[],
  policy: PublishPolicy,
): PublishOptionsDraft {
  return {
    weights: Object.fromEntries(
      helpers.map(h => [h.channelId, String(defaultWeightFor(policy, h.channelId, participantWeight(h)))]),
    ),
    threshold: String(policy.defaultThreshold),
    dropped: [],
    rememberThreshold: false,
  }
}

/** What is wrong with `draft` — the rules the SDK enforces, said before anything is sent. */
export function publishOptionsProblems(
  draft: PublishOptionsDraft,
  helpers: readonly PairedParticipant[],
): PublishOptionsProblems {
  const problems: PublishOptionsProblems = { weights: {} }
  const threshold = Number(draft.threshold)
  if (draft.threshold.trim() === '' || !Number.isInteger(threshold) || threshold < 2) {
    problems.threshold = 'Must be a whole number, at least 2 — one helper must never recover alone'
    return problems
  }
  let total = 0
  for (const h of helpers) {
    const typed = draft.weights[h.channelId] ?? ''
    const weight = Number(typed)
    const problem = typed.trim() === '' ? 'Required' : weightProblem(weight, threshold)
    if (problem) problems.weights[h.channelId] = problem
    else total += weight
  }
  if (Object.keys(problems.weights).length === 0 && total < threshold) {
    problems.total = `These weights total ${total} subshares, below the threshold of ${threshold}: no version could be published.`
  }
  return problems
}

/** Whether `problems` lets the publish go ahead. */
export function hasNoProblems(problems: PublishOptionsProblems): boolean {
  return problems.threshold === undefined && problems.total === undefined && Object.keys(problems.weights).length === 0
}

/**
 * The owner's choice as the runtime takes it, or `null` while the draft is
 * invalid. `committedVersions` is read now, not when the dialog opened.
 */
export function toPublishChoice(
  draft: PublishOptionsDraft,
  helpers: readonly PairedParticipant[],
  policy: PublishPolicy,
  committedVersions: readonly number[],
): PublishChoice | null {
  if (!hasNoProblems(publishOptionsProblems(draft, helpers))) return null
  const threshold = Number(draft.threshold)
  return {
    weights: new Map(helpers.map(h => [h.channelId, Number(draft.weights[h.channelId])])),
    threshold,
    keep: policy.helperRetention.mode === 'select' ? committedVersions.filter(v => !draft.dropped.includes(v)) : null,
    rememberThreshold: draft.rememberThreshold && threshold !== policy.defaultThreshold,
  }
}
