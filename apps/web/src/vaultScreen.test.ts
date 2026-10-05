// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import type { VaultEntry } from './vault/manager'
import { vaultScreen } from './vaultScreen'

function entry(state: VaultEntry['state'], failure: string | null = null): VaultEntry {
  return {
    id: 'v1',
    name: 'Crypto Seeds',
    state,
    failure,
    pairedCount: 0,
    bagVersion: null,
    replicaCount: 0,
    attention: 0,
  }
}

describe('vaultScreen', () => {
  it('waits while the manager has not listed the stored vaults yet', () => {
    // Before boot, "not listed" means "not read yet", not "gone".
    expect(vaultScreen(null, false, false)).toEqual({ kind: 'loading' })
  })

  it('reports a vault this browser does not hold', () => {
    expect(vaultScreen(null, false, true)).toEqual({ kind: 'missing' })
  })

  it('never mounts the page for a vault another tab runs', () => {
    // Two runtimes over one set of stores would split its mailbox.
    expect(vaultScreen(entry('elsewhere'), false, true)).toEqual({ kind: 'elsewhere' })
  })

  it('shows a running vault', () => {
    expect(vaultScreen(entry('running'), true, true)).toEqual({ kind: 'page' })
  })

  it('shows a blocked vault, whose page is the blocked screen', () => {
    expect(vaultScreen(entry('blocked'), true, true)).toEqual({ kind: 'page' })
  })

  it('waits for a vault still starting', () => {
    expect(vaultScreen(entry('starting'), true, true)).toEqual({ kind: 'loading' })
  })

  it('says why a vault failed to start', () => {
    expect(vaultScreen(entry('failed', 'no wasm'), true, true)).toEqual({
      kind: 'failed',
      failure: 'no wasm',
    })
  })

  it('offers to start a stopped vault', () => {
    expect(vaultScreen(entry('stopped'), false, true)).toEqual({ kind: 'stopped' })
  })
})
