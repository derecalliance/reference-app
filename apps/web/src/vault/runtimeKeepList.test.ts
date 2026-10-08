// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { beforeEach, describe, expect, it } from 'vitest'

import { makeStateStore, type KeepListSource } from '../stores'
import type { BagVersion } from '../types'
import { VaultRuntime } from './runtime'
import { deps, vault } from './testVault'

function bagVersion(version: number): BagVersion {
  return {
    version,
    participantIds: [],
    verifiedParticipantIds: [],
    failedParticipantIds: [],
    secrets: [{ id: 'aa', name: 'Seed', data: 'one two' }],
    rawBytes: '',
    helpers: [],
  }
}

/**
 * The library asks for the list itself, from inside `start` / `process`, so a
 * spec has no public entry point to it: read the runtime's answer directly.
 */
function keepListOf(runtime: VaultRuntime): KeepListSource {
  return (runtime as unknown as { keepList: KeepListSource }).keepList
}

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

describe('VaultRuntime keepList', () => {
  beforeEach(() => localStorage.clear())

  /**
   * The QA case: v1 and v2 committed, confirming a replica made the library
   * publish v3 on its own, and v4 was added while v3 still waited on its
   * replica leg. v3 never passed through the app's round tracker, so v4 told
   * the helpers to drop it — and Discover All on a new device listed v4, v2,
   * v1 with no v3.
   */
  it('keeps a round the library started itself while it is still open', async () => {
    const runtime = new VaultRuntime(
      vault({
        secretBag: { secretId: '42', threshold: 2, currentVersion: bagVersion(2), previousVersions: [bagVersion(1)] },
      }),
      deps(),
    )
    // The library's own record of the open v3 round, as it writes it.
    await makeStateStore('vault:v1').save('42', encode({ kind: 3, version: 3, pending: [] }))

    expect(keepListOf(runtime)('42', 4)).toEqual([3, 2, 1])
  })

  it('stops keeping it once the library closes the round without committing it', async () => {
    const runtime = new VaultRuntime(
      vault({
        secretBag: { secretId: '42', threshold: 2, currentVersion: bagVersion(2), previousVersions: [bagVersion(1)] },
      }),
      deps(),
    )
    const store = makeStateStore('vault:v1')
    await store.save('42', encode({ kind: 3, version: 3, pending: [] }))
    await store.remove('42', encode({ kind: 3, version: 3 }))

    expect(keepListOf(runtime)('42', 4)).toEqual([2, 1])
  })
})
