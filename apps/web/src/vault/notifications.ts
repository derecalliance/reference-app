// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { bagVersionOf } from '../owner/bag'
import { recoverability } from '../owner/recoverability'
import { randomId } from '../randomId'
import type {
  AutoVerificationResult,
  PendingAutoVerification,
  Vault,
  VaultNotification,
} from '../types'

/** The most notifications a vault keeps; read ones go first. */
export const MAX_NOTIFICATIONS = 200

export type NotificationInput = Pick<VaultNotification, 'severity' | 'title' | 'detail' | 'link'>

/** `vault` with `input` added as its newest, unread notification. */
export function withNotification(vault: Vault, input: NotificationInput, now = Date.now()): Vault {
  const notification: VaultNotification = { id: randomId(), at: now, read: false, ...input }
  return { ...vault, notifications: capped([notification, ...(vault.notifications ?? [])]) }
}

/** `vault` with the notifications `ids` — or every one — marked read. */
export function withNotificationsRead(vault: Vault, ids: readonly string[] | 'all'): Vault {
  const notifications = vault.notifications ?? []
  const marks = (n: VaultNotification) => !n.read && (ids === 'all' || ids.includes(n.id))
  if (!notifications.some(marks)) return vault
  return { ...vault, notifications: notifications.map(n => (marks(n) ? { ...n, read: true } : n)) }
}

export interface UnreadCount {
  total: number
  critical: number
}

export function unreadCount(notifications: readonly VaultNotification[] | undefined): UnreadCount {
  let total = 0
  let critical = 0
  for (const n of notifications ?? []) {
    if (n.read) continue
    total += 1
    if (n.severity === 'critical') critical += 1
  }
  return { total, critical }
}

/** Newest first, at most `MAX_NOTIFICATIONS`: the oldest read ones are dropped first, then the oldest. */
function capped(notifications: VaultNotification[]): VaultNotification[] {
  if (notifications.length <= MAX_NOTIFICATIONS) return notifications
  const excess = notifications.length - MAX_NOTIFICATIONS
  const readOldestFirst = notifications.filter(n => n.read).reverse()
  const dropped = new Set(readOldestFirst.slice(0, excess).map(n => n.id))
  const kept = notifications.filter(n => !dropped.has(n.id))
  return kept.slice(0, MAX_NOTIFICATIONS)
}

/**
 * How a scheduled verification ended, read from the answers folded into the
 * bag: each challenged helper verified, refused, sent an invalid proof, or
 * said nothing before its challenge expired. It passed only if every helper
 * that holds the version proved its share.
 */
export function autoVerificationResult(
  vault: Vault,
  pending: PendingAutoVerification,
  now = Date.now(),
): AutoVerificationResult {
  const { version } = pending
  const bagVersion = bagVersionOf(vault.secretBag, version)
  const nameOf = (channelId: string) =>
    vault.participants.find(p => p.channelId === channelId)?.name ?? `channel ${channelId}`
  const idOf = (channelId: string) => vault.participants.find(p => p.channelId === channelId)?.id

  const problems: string[] = []
  let verified = 0
  for (const channelId of pending.channelIds) {
    const id = idOf(channelId)
    if (id && bagVersion?.verifiedParticipantIds.includes(id)) {
      verified += 1
      continue
    }
    const rejection = id ? bagVersion?.verifyRejections?.find(r => r.id === id) : undefined
    if (id && bagVersion?.invalidProofParticipantIds?.includes(id)) {
      problems.push(`${nameOf(channelId)}'s proof is invalid`)
    } else if (rejection) {
      problems.push(`${nameOf(channelId)} rejected it (${rejection.memo || `status ${rejection.status}`})`)
    } else {
      problems.push(`${nameOf(channelId)} did not answer within ${formatWindow(pending.reportBy - pending.startedAt)}`)
    }
  }
  for (const channelId of pending.notReachedChannelIds) problems.push(`${nameOf(channelId)} could not be reached`)

  const helpers = pending.channelIds.length + pending.notReachedChannelIds.length
  const passed = problems.length === 0
  const counted = `${verified}/${helpers} helper${helpers === 1 ? '' : 's'} verified`
  const recoverable = bagVersion ? recoverabilityText(bagVersion) : 'the version is no longer on this device'
  return {
    version,
    at: now,
    passed,
    summary: passed ? `${counted}, ${recoverable}` : `${problems.join('; ')}. ${counted}, ${recoverable}.`,
  }
}

function recoverabilityText(version: Parameters<typeof recoverability>[0]): string {
  const verdict = recoverability(version)
  if (!verdict) return 'no helper proved its share'
  if (verdict.kind === 'recoverable') return `recoverable (${verdict.verified} of ${verdict.threshold} subshares)`
  if (verdict.kind === 'short') {
    return `not recoverable from verified helpers alone (${verdict.verified} of ${verdict.threshold} subshares)`
  }
  return 'recoverability unknown'
}

/** "45 s", "5 min", "2 h": how long a run waited for its answers. */
function formatWindow(ms: number): string {
  const secs = Math.round(ms / 1000)
  if (secs < 120) return `${secs} s`
  const mins = Math.round(secs / 60)
  return mins < 120 ? `${mins} min` : `${Math.round(mins / 60)} h`
}
