// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import { describeSchedule, isVerificationDue, scheduleIntervalMs, scheduleProblem } from './verificationSchedule'

describe('scheduleIntervalMs', () => {
  it('turns "every amount unit" into milliseconds', () => {
    expect(scheduleIntervalMs({ every: 30, unit: 'minutes' })).toBe(30 * 60_000)
    expect(scheduleIntervalMs({ every: 2, unit: 'hours' })).toBe(2 * 3_600_000)
    expect(scheduleIntervalMs({ every: 5, unit: 'days' })).toBe(5 * 86_400_000)
  })
})

describe('isVerificationDue', () => {
  const schedule = { every: 30, unit: 'minutes' as const, since: 0 }

  it('is due once the interval has passed since the last check', () => {
    expect(isVerificationDue(schedule, 1_000, 1_000 + 30 * 60_000)).toBe(true)
    expect(isVerificationDue(schedule, 1_000, 1_000 + 29 * 60_000)).toBe(false)
  })

  it('counts from when the schedule was set when nothing ran yet', () => {
    expect(isVerificationDue({ ...schedule, since: 5_000 }, undefined, 5_000 + 30 * 60_000)).toBe(true)
    expect(isVerificationDue({ ...schedule, since: 5_000 }, undefined, 5_000 + 60_000)).toBe(false)
  })
})

describe('scheduleProblem and describeSchedule', () => {
  it('needs a whole amount of at least 1', () => {
    expect(scheduleProblem(0)).toMatch(/at least 1/)
    expect(scheduleProblem(1.5)).toMatch(/whole number/)
    expect(scheduleProblem(5)).toBeNull()
  })

  it('reads as the owner set it', () => {
    expect(describeSchedule({ every: 1, unit: 'days' })).toBe('every 1 day')
    expect(describeSchedule({ every: 30, unit: 'minutes' })).toBe('every 30 minutes')
  })
})
