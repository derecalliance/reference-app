// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import type { SecretEntry } from './secret/manager'
import { secretScreen } from './secretScreen'

function entry(state: SecretEntry['state'], failure: string | null = null): SecretEntry {
  return {
    id: 'v1',
    name: 'Crypto Seeds',
    state,
    failure,
    pairedCount: 0,
    bagVersion: null,
    replicaCount: 0,
    attention: 0,
    notifications: [],
  }
}

describe('secretScreen', () => {
  it('waits while the manager has not listed the stored secrets yet', () => {
    // Before boot, "not listed" means "not read yet", not "gone".
    expect(secretScreen(null, false, false)).toEqual({ kind: 'loading' })
  })

  it('reports a secret this browser does not hold', () => {
    expect(secretScreen(null, false, true)).toEqual({ kind: 'missing' })
  })

  it('never mounts the page for a secret another tab runs', () => {
    // Two runtimes over one set of stores would split its mailbox.
    expect(secretScreen(entry('elsewhere'), false, true)).toEqual({ kind: 'elsewhere' })
  })

  it('shows a running secret', () => {
    expect(secretScreen(entry('running'), true, true)).toEqual({ kind: 'page' })
  })

  it('shows a blocked secret, whose page is the blocked screen', () => {
    expect(secretScreen(entry('blocked'), true, true)).toEqual({ kind: 'page' })
  })

  it('waits for a secret still starting', () => {
    expect(secretScreen(entry('starting'), true, true)).toEqual({ kind: 'loading' })
  })

  it('says why a secret failed to start', () => {
    expect(secretScreen(entry('failed', 'no wasm'), true, true)).toEqual({
      kind: 'failed',
      failure: 'no wasm',
    })
  })

  it('offers to start a stopped secret', () => {
    expect(secretScreen(entry('stopped'), false, true)).toEqual({ kind: 'stopped' })
  })
})
