// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * Periodic verification: the same challenge as Verify Shares, run on a
 * schedule the owner sets — "every {amount} {unit}", nothing else. The DeRec
 * protocol suggests verifying periodically, so a helper that lost its share is
 * noticed before the share is needed.
 */

export type ScheduleUnit = 'minutes' | 'hours' | 'days'

export interface VerificationSchedule {
  every: number
  unit: ScheduleUnit
  /** When the schedule was set (ms since the epoch): the first check is one interval after it. */
  since: number
}

const UNIT_MS: Record<ScheduleUnit, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
}

/** The schedule's interval in milliseconds. */
export function scheduleIntervalMs(schedule: Pick<VerificationSchedule, 'every' | 'unit'>): number {
  return schedule.every * UNIT_MS[schedule.unit]
}

/** Whether a scheduled check is due at `now`, given when the last one ran (if any). */
export function isVerificationDue(schedule: VerificationSchedule, lastRunAt: number | undefined, now: number): boolean {
  return now - (lastRunAt ?? schedule.since) >= scheduleIntervalMs(schedule)
}

/** Why `amount` is not a valid "every" amount, or `null` when it is. */
export function scheduleProblem(amount: number): string | null {
  if (!Number.isInteger(amount)) return 'Must be a whole number'
  if (amount < 1) return 'Must be at least 1'
  return null
}

/** "every 30 minutes", "every 1 day". */
export function describeSchedule(schedule: Pick<VerificationSchedule, 'every' | 'unit'>): string {
  const unit = schedule.every === 1 ? schedule.unit.slice(0, -1) : schedule.unit
  return `every ${schedule.every} ${unit}`
}
