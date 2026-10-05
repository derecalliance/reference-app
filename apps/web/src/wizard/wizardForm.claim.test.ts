// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import { actorAppearsActive, CLAIM_ACTIVE_WINDOW_MS } from './wizardForm'

describe('actorAppearsActive', () => {
  const now = Date.parse('2026-10-03T12:00:00Z')

  it('is true for a mailbox drained within the window', () => {
    expect(actorAppearsActive('2026-10-03T11:59:50Z', now)).toBe(true)
  })

  it('is false once the window has passed', () => {
    const stale = new Date(now - CLAIM_ACTIVE_WINDOW_MS - 1).toISOString()
    expect(actorAppearsActive(stale, now)).toBe(false)
  })

  it('counts a slightly future timestamp (clock skew) as recent', () => {
    expect(actorAppearsActive('2026-10-03T12:00:02Z', now)).toBe(true)
  })

  it('invents no conflict from a missing or unreadable timestamp', () => {
    expect(actorAppearsActive(null, now)).toBe(false)
    expect(actorAppearsActive(undefined, now)).toBe(false)
    expect(actorAppearsActive('not a date', now)).toBe(false)
  })
})
