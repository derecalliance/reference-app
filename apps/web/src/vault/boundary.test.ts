// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import ownerPageSource from '../OwnerPage.tsx?raw'

/**
 * The engine's source: every module in this folder, specs and fixtures excluded.
 * The whole folder, not `runtime.ts`, because the engine now spans the runtime,
 * the round tracker and the event handlers — an invariant checked against one
 * file would stop meaning anything the moment code moved to another.
 */
const engineSource = Object.values(
  import.meta.glob<string>(['./**/*.ts', '!./**/*.test.ts', '!./testVault.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
).join('\n')

/**
 * The engine/view boundary, asserted against the source.
 *
 * These are structural invariants that no behavioural test caught. Round
 * correlation state moved onto `VaultRuntime` while the commands that write it
 * stayed in the page — which kept its own copies. Both halves typechecked, all
 * 504 unit tests passed, and the fold silently read maps nobody wrote to: no
 * share was ever marked confirmed again. It surfaced only as end-to-end tests
 * timing out after fourteen minutes.
 *
 * A source-level check is the cheap guard against a second copy reappearing,
 * because the failure mode is *absence* of a connection rather than wrong
 * behaviour at any one call site.
 */

/** State that must have exactly one home, and that home is the engine. */
const ENGINE_OWNED = [
  'pendingBagRef',
  'pendingSharesRef',
  'pendingVerificationsRef',
  'pendingRecoveryRef',
  'flowTimeoutRef',
  // The four confirmations. The drain gate reads the same queue, so a copy here
  // would let the gate disagree with what is actually on screen — and an
  // off-screen vault could not raise one at all.
  'setPendingPairingConfirmation',
  'setPendingStoreShareConfirmation',
  'setPendingVerifyShareConfirmation',
  'setPendingUnpairConfirmation',
  'pendingPairingConfirmationRef',
  'pendingStoreShareConfirmationRef',
  'pendingVerifyShareConfirmationRef',
  'pendingUnpairConfirmationRef',
  'pendingInboundRef',
  'protocolBusyRef',
]

describe('engine/view boundary', () => {
  it.each(ENGINE_OWNED)('the page keeps no copy of %s', name => {
    expect(ownerPageSource).not.toContain(name)
  })

  it('the engine registers the rounds its own commands start', () => {
    // The positive half: having established the page holds no copy, something
    // still has to connect the commands to the fold — and that is now the
    // engine, so the page must not be doing it too.
    for (const register of ['beginProtectRound(', 'beginVerification(', 'beginRecovery(']) {
      expect(engineSource).toContain(`.${register}`)
      expect(ownerPageSource).not.toContain(register)
    }
  })

  it('the page makes no protocol call of its own', () => {
    // Every call has to go through the engine's lock; one made from the page
    // could overlap the drain and raise "recursive use of an object".
    expect(ownerPageSource).not.toContain('withProtocolLock')
    expect(ownerPageSource).not.toContain('.start(FlowKind')
    expect(ownerPageSource).not.toContain('protocol.accept(')
    expect(ownerPageSource).not.toContain('protocol.reject(')
  })

  it('the engine drains and ticks; the page runs neither loop', () => {
    // A second loop in the page would drain the destructive mailbox behind the
    // engine's back, and the two would disagree about what is held back.
    expect(ownerPageSource).not.toContain('pollMailbox(')
    expect(ownerPageSource).not.toContain('.process(')
    expect(ownerPageSource).not.toContain('.tick(')
    expect(engineSource).toContain('drainOnce(')
    expect(engineSource).toContain('tickOnce(')
  })

  it('the engine raises and decides confirmations; the page only picks one', () => {
    // The gate held back the destructive mailbox drain by reading four page
    // refs. Anything that raises a confirmation without also updating those
    // would have let the drain mutate the state the owner was being asked about.
    expect(engineSource).toContain("kind: 'pairing', blocksDrain: true")
    expect(ownerPageSource).not.toContain('raiseAttention(')
    expect(ownerPageSource).toContain("acceptAttentionOf('pairing')")
    expect(ownerPageSource).toContain("rejectAttentionOf('pairing')")
  })

  it('the engine owns the busy flag the page renders', () => {
    // The page had its own `setProtocolBusy`, so the watchdog's `if (!this.busy)`
    // guard saw a flag nothing set: a stalled verify, discovery or recovery never
    // reported a timeout and left the UI disabled for good.
    expect(ownerPageSource).not.toContain('setProtocolBusy(')
    expect(ownerPageSource).toContain('runtimeRef.current?.setBusy(')
  })

  it('the engine imports nothing from React', () => {
    // A runtime has to keep polling and folding while its vault is off screen.
    // Anything imported from React here would tie it to being rendered.
    expect(engineSource).not.toMatch(/from ['"]react['"]/)
    expect(engineSource).not.toContain('useState')
    expect(engineSource).not.toContain('useEffect')
  })

  it('the engine never reads the vault through a page ref', () => {
    // The engine owns the record — the page commits through it — so reaching
    // for a page ref would reintroduce exactly the staleness that made the
    // engine commit new state on top of an old snapshot.
    expect(engineSource).not.toContain('vaultRef')
    expect(engineSource).not.toContain('onUpdateRef')
  })
})
