// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { StatusEnum } from '@derec-alliance/web'

import type { SecretShareRef } from '../types'

/**
 * Why a participant does not hold a share it was sent — in the three ways a
 * person needs told apart, because each asks something different of them:
 *
 * - `rejected` — the peer answered, and said no. Ask them why.
 * - `no-answer` — nothing came back before the round closed. The peer may be
 *   offline; trying again later may work.
 * - `unreachable` — the request never left: the send itself failed (the relay
 *   is off, the node is down, the address is wrong). Nothing the peer did.
 *
 * Every view that names a failure — the protect round's progress, the Secrets
 * panel, a channel row — reads it from here, so one peer is never "Rejected"
 * in one place and "timeout" in another.
 */
export type ShareFailureKind = 'rejected' | 'no-answer' | 'unreachable'

/** What the library (or the app, for a round it closed) said about the failure. */
export interface ShareFailureDetail {
  status: number
  memo: string
}

/** The words for each kind, the same in every view. */
export const SHARE_FAILURE_LABEL: Record<ShareFailureKind, string> = {
  rejected: 'Rejected',
  'no-answer': 'No answer',
  unreachable: 'Not reachable',
}

const NO_ANSWER_MEMO = /time(d)?[\s-]?out|no answer|expired/i
const UNREACHABLE_MEMO = /send|transport|unreachable|dispatch|network|connect|relay/i

/**
 * Classify a failure from its status and memo.
 *
 * The library reports a peer that never answered as `ShareRejected` with
 * status `Fail` and memo `timeout`, and a request it could not dispatch with a
 * memo naming the transport — so the memo is what tells them apart from a
 * peer that actually refused (`Rejected`, or any other status it sent).
 */
export function classifyShareFailure({ status, memo }: ShareFailureDetail): ShareFailureKind {
  if (status === StatusEnum.Rejected) return 'rejected'
  if (UNREACHABLE_MEMO.test(memo)) return 'unreachable'
  if (NO_ANSWER_MEMO.test(memo)) return 'no-answer'
  return 'rejected'
}

/** The label for a failure, with the peer's own memo kept for a tooltip. */
export function shareFailureLabel(detail: ShareFailureDetail): string {
  return SHARE_FAILURE_LABEL[classifyShareFailure(detail)]
}

/**
 * Why `share` failed, or `null` when it did not.
 *
 * A failed share recorded before the app kept its detail is a refusal as far
 * as anyone can now tell — which is what it was always shown as.
 */
export function shareFailureKind(share: SecretShareRef | undefined): ShareFailureKind | null {
  if (share?.status !== 'rejected') return null
  return share.failure ? classifyShareFailure(share.failure) : 'rejected'
}

/**
 * The delivery problem to flag on a channel row: how the newest share sent
 * over it failed, when that was a silence or a send failure.
 *
 * A refusal is not flagged — the peer answered, so it is plainly reachable.
 */
export function lastDeliveryProblem(
  shares: readonly SecretShareRef[],
): Exclude<ShareFailureKind, 'rejected'> | null {
  const latest = shares.reduce<SecretShareRef | undefined>(
    (newest, s) => (newest === undefined || s.version > newest.version ? s : newest),
    undefined,
  )
  const kind = shareFailureKind(latest)
  return kind === 'rejected' ? null : kind
}
