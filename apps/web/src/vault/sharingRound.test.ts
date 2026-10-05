// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'
import type { DeRecEvent } from '@derec-alliance/web'

import { VaultRuntime } from './runtime'
import { deps, vault } from './testVault'
import type { PairedParticipant, SecretBag } from '../types'

/**
 * The round-correlation contract between the commands that start a round and the
 * fold that resolves it.
 *
 * This exists because of a bug worth not repeating. The fold moved onto the
 * runtime along with `pendingBag`/`pendingShares`, but the commands that *write*
 * them stayed in the page — which kept its own copies. Both sides typechecked,
 * every unit test passed, and nothing marked a share confirmed ever again,
 * because the fold was reading a map the commands never wrote to. It surfaced
 * only as e2e tests timing out after 14 minutes.
 *
 * So: any test that starts a round and resolves it through the fold has to go
 * through one runtime, and fail loudly if the two halves are ever separated
 * again.
 */

function participant(overrides: Partial<PairedParticipant> = {}): PairedParticipant {
  return {
    id: 'h1',
    name: 'Alex',
    channelId: '900',
    transport: { protocol: 'https', uri: 'http://localhost:5000/derec/h1' },
    secretShares: [],
    connectionStatus: 'paired',
    ...overrides,
  }
}

function bagAt(version: number): SecretBag {
  return {
    secretId: '42',
    currentVersion: {
      version,
      participantIds: [],
      verifiedParticipantIds: [],
      failedParticipantIds: [],
      secrets: [],
      rawBytes: '',
      helpers: [],
    },
    previousVersions: [],
    threshold: 2,
  }
}

function event(e: Record<string, unknown>): DeRecEvent {
  return e as unknown as DeRecEvent
}

describe('sharing round correlation', () => {
  it('marks a share confirmed only after the round registered it', () => {
    const r = new VaultRuntime(vault({ participants: [participant()] }), deps())
    const before = vault({ participants: [participant()] })

    // Without a registered round the fold has nothing to correlate against and
    // must leave the vault alone — this is the guard that made the duplicated
    // state invisible, so it is asserted first.
    expect(
      r.applyEvent(before, event({ type: 'ShareConfirmed', channel_id: '900', version: 1 })),
    ).toBe(before)

    r.beginProtectRound({
      bag: bagAt(1),
      version: 1,
      protocolSecretId: '42',
      channelIds: ['900'],
    })

    const after = r.applyEvent(
      before,
      event({ type: 'ShareConfirmed', channel_id: '900', version: 1 }),
    )

    expect(after.participants[0].secretShares).toEqual([
      { version: 1, status: 'confirmed', verified: false },
    ])
  })

  it('registers the round on the same runtime the fold reads', () => {
    // The regression guard. If `beginProtectRound` ever writes state the fold
    // does not read — the exact shape of the bug — this fails while the test
    // above could still pass on a coincidence.
    const r = new VaultRuntime(vault({ participants: [participant()] }), deps())

    r.beginProtectRound({
      bag: bagAt(7),
      version: 7,
      protocolSecretId: '42',
      channelIds: ['900'],
    })

    expect(r.hasPendingRound(7)).toBe(true)
    expect(r.hasPendingRound(8)).toBe(false)
  })

  it('rolls the round back when it is abandoned', () => {
    const d = deps()
    const r = new VaultRuntime(
      vault({
        participants: [
          participant({ secretShares: [{ version: 3, status: 'pending', verified: false }] }),
        ],
      }),
      d,
    )
    r.beginProtectRound({
      bag: bagAt(3),
      version: 3,
      protocolSecretId: '42',
      channelIds: ['900'],
    })

    r.failSharingRound(3, 'timeout')

    // The unanswered marks for that version are settled as refused, so the UI
    // stops showing helpers as perpetually pending — and reaches its rollback
    // banner — rather than erased, which sent the progress view backwards.
    const committed = (d.onVaultChange as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const last = committed.at(-1)?.[0] as { participants: PairedParticipant[] }
    expect(last.participants[0].secretShares).toEqual([
      { version: 3, status: 'rejected', verified: false, failure: { status: 0, memo: 'No answer before the round closed' } },
    ])
    expect(r.hasPendingRound(3)).toBe(false)
    expect(r.state().busy).toBe(false)
  })

  it('ignores a rollback for a version that already resolved', () => {
    const d = deps()
    const r = new VaultRuntime(vault({ participants: [participant()] }), d)
    r.beginProtectRound({
      bag: bagAt(4),
      version: 4,
      protocolSecretId: '42',
      channelIds: ['900'],
    })

    r.failSharingRound(9, 'timeout')

    // A watchdog for an older round must not tear down the current one.
    expect(r.hasPendingRound(4)).toBe(true)
    expect(d.onVaultChange).not.toHaveBeenCalled()
  })
})
