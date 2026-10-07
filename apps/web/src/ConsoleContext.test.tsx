// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import { makeConsoleEntry } from './ConsoleContext'

describe('console entries', () => {
  it('keeps the vault an entry came from', () => {
    expect(
      makeConsoleEntry({ role: 'owner', flow: 'pairing', step: 's', description: 'd', vaultId: 'v1' })
        .vaultId,
    ).toBe('v1')
  })

  it('accepts a server entry that belongs to no vault', () => {
    // Backend events polled from /debug/events are node-wide; forcing a vault
    // onto them would file them under an arbitrary one.
    expect(
      makeConsoleEntry({ role: 'server', flow: 'transport', step: 's', description: 'd' }).vaultId,
    ).toBeUndefined()
  })

  it('stamps an id and the given time', () => {
    const at = new Date(1000)
    const entry = makeConsoleEntry({ role: 'owner', flow: 'setup', step: 's', description: 'd' }, at)

    expect(entry.id).toBeTruthy()
    expect(entry.timestamp).toBe(at)
  })
})
