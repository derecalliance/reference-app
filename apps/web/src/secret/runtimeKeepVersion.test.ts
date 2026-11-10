// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { beforeEach, describe, expect, it } from 'vitest'

import { makeStateStore, type KeepVersionSource } from '../stores'
import type { BagVersion } from '../types'
import { SecretRuntime } from './runtime'
import { deps, secret } from './testSecret'

function bagVersion(version: number): BagVersion {
  return {
    version,
    participantIds: [],
    verifiedParticipantIds: [],
    failedParticipantIds: [],
    items: [{ id: 'aa', name: 'Seed', data: 'one two' }],
    rawBytes: '',
    helpers: [],
  }
}

/**
 * The library asks for the version itself, from inside `start` / `process`, so
 * a spec has no public entry point to it: read the runtime's answer directly.
 */
function keepVersionOf(runtime: SecretRuntime): KeepVersionSource {
  return (runtime as unknown as { keepVersion: KeepVersionSource }).keepVersion
}

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

describe('SecretRuntime keepVersion', () => {
  beforeEach(() => localStorage.clear())

  it('keeps the newest committed version', () => {
    const runtime = new SecretRuntime(
      secret({
        itemBag: { secretId: '42', threshold: 2, currentVersion: bagVersion(2), previousVersions: [bagVersion(1)] },
      }),
      deps(),
    )

    expect(keepVersionOf(runtime)('42', 3)).toBe(2)
  })

  /**
   * Up to SDK 0.0.9 the app also kept every round still open — the QA case was
   * a replica confirmation making the library publish v3 on its own while v4
   * was added. A single `keepVersion` (0.0.10) cannot name both, and the
   * library's advice is the newest committed version: if v3 then commits, the
   * helpers that stored v4 no longer hold it.
   */
  it('keeps the newest committed version over a round the library started that is still open', async () => {
    const runtime = new SecretRuntime(
      secret({
        itemBag: { secretId: '42', threshold: 2, currentVersion: bagVersion(2), previousVersions: [bagVersion(1)] },
      }),
      deps(),
    )
    // The library's own record of the open v3 round, as it writes it.
    await makeStateStore('secret:v1').save('42', encode({ kind: 3, version: 3, pending: [] }))

    expect(keepVersionOf(runtime)('42', 4)).toBe(2)
  })
})
