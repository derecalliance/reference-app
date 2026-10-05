// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import {
  BACKEND_URL,
  type ContactMode,
  openTab,
  pairParticipant,
  protectSecret,
  setUpOwner,
} from './app'

/**
 * The transport matrix: three peer configurations covering three **library**
 * behaviours, not three transports.
 *
 * - `http`-only is a peer offering only what the browser speaks directly.
 * - `grpc`-only is a peer offering only what the browser must reach some other
 *   way — a browser cannot dial gRPC, so this is also the HTTP-to-gRPC
 *   crossing: the request leaves this device over gRPC (via the backend
 *   relay) and the response comes back over HTTP to the owner's mailbox.
 * - `both` is a peer offering a choice the library declines to make itself.
 *
 * A fourth spec covers the relay's absence: with it stubbed out, a grpc-only
 * peer must make the browser surface a no-usable-endpoint failure rather than
 * hang, since a browser genuinely has no other way to reach one.
 */


interface BackendTransport {
  protocol: 'https' | 'grpc'
  uri: string
}

interface BackendActor {
  id: string
  role: 'owner' | 'helper'
  name: string
  transports: BackendTransport[]
}

function modeOf(actor: BackendActor): 'http' | 'grpc' | 'both' {
  const protocols = new Set(actor.transports.map(t => t.protocol))
  if (protocols.has('grpc') && protocols.has('https')) return 'both'
  if (protocols.has('grpc')) return 'grpc'
  return 'http'
}

/**
 * Names of `count` helpers currently advertising exactly `mode`.
 *
 * The helper pool is shared and server-wide (see README's "End-to-end tests"
 * section): a fresh owner is handed the *whole* pool, in server registration
 * order, not just what its own setup call provisioned. `setUpOwner`'s
 * `transports` option drives the wizard's counters and guarantees at least the
 * requested count of a mode exists by the time it returns, but says nothing
 * about *where* in the participant list that mode ends up — other specs (and
 * earlier tests in this file) may already have populated the pool with plain
 * HTTP fixtures ahead of it. Position is therefore not a reliable way to reach
 * a specific transport mode; asking the backend which actors actually
 * advertise which protocol is.
 */
async function helperNamesByMode(
  page: Page,
  mode: 'grpc' | 'both',
  count: number,
): Promise<string[]> {
  const res = await page.request.get(`${BACKEND_URL}/actors`)
  const { actors } = (await res.json()) as { actors: BackendActor[] }
  const names = actors
    .filter(a => a.role === 'helper' && modeOf(a) === mode)
    .map(a => a.name)

  expect(
    names.length,
    `expected at least ${count} ${mode}-mode helper(s) in the pool, found ${names.length}`,
  ).toBeGreaterThanOrEqual(count)

  return names.slice(0, count)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A provisioned-participant row, matched by its exact display name.
 *
 * Matched on the whole name, the same way `replicaChannelRow` in `e2e/app.ts`
 * is: the backend is reused between runs, so a loose match could resolve to a
 * fixture an earlier run left behind.
 */
function participantRowByName(page: Page, name: string): Locator {
  return page.locator('.side-participant-item').filter({
    has: page.locator('.side-participant-name', { hasText: new RegExp(`^${escapeRegExp(name)}$`) }),
  })
}

/** Expand a row and pick its contact mode, mirroring `expandParticipant` in `e2e/app.ts`. */
async function expandAndSelectMode(row: Locator, mode: ContactMode): Promise<void> {
  if ((await row.locator('.side-participant-header').getAttribute('aria-expanded')) !== 'true') {
    await row.locator('.side-participant-header').click()
  }
  await expect(row.locator('.side-participant-details')).toBeVisible()

  await row.locator('label.role-option').filter({ hasText: mode }).click()
  await expect(row.getByRole('radio', { name: mode })).toBeChecked()
}

/**
 * Pair with a specific named participant row, this device initiating.
 *
 * Identical to `pairParticipant` in `e2e/app.ts` except for how the row is
 * found: that helper takes a pool position, which — as explained above — is
 * not enough to reach a specific transport mode once the shared pool holds a
 * mix.
 */
async function pairByName(page: Page, name: string): Promise<Locator> {
  const row = participantRowByName(page, name)
  await expect(row).toHaveCount(1)

  await expandAndSelectMode(row, 'Inline keys')
  await row.getByRole('button', { name: 'Pair', exact: true }).click()
  await expect(row.locator('.status-tag')).toHaveText('Paired', { timeout: 60_000 })

  return row
}

/** Verify every paired share and wait for the round to complete. */
async function verifyShares(page: Page, expected: string): Promise<void> {
  await openTab(page, 'Secrets')
  await page.getByRole('button', { name: 'Verify Shares' }).click()
  await expect(page.locator('.tab-panel')).toContainText(expected, { timeout: 90_000 })
}

test.describe('transport matrix', () => {
  test('an http-only helper pairs, protects and verifies', async ({ page, pageErrors }) => {
    await setUpOwner(page, {
      name: 'Alice',
      participants: 2,
      prePaired: 0,
      minParticipants: 2,
      transports: { http: 2, grpc: 0, both: 0 },
    })

    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })
    await protectSecret(page, 'grpc-matrix-http', 'http-only-secret')

    await verifyShares(page, '2/2 verified')
    expect(pageErrors).toEqual([])
  })

  test('a grpc-only helper pairs, protects and verifies through the relay', async ({ page, pageErrors }) => {
    // Proof that gRPC — not some fallback — actually carried the traffic:
    // `relayMessage` always posts to `/derec/relay`, and it is the only path a
    // grpc endpoint can travel from a browser, so seeing this request fire is
    // only possible if the crossing genuinely happened.
    const relayRequests: string[] = []
    page.on('request', request => {
      if (request.url().endsWith('/derec/relay')) relayRequests.push(request.url())
    })

    await setUpOwner(page, {
      name: 'Alice',
      participants: 2,
      prePaired: 0,
      minParticipants: 2,
      transports: { http: 0, grpc: 2, both: 0 },
    })

    const [first, second] = await helperNamesByMode(page, 'grpc', 2)
    await pairByName(page, first)
    await pairByName(page, second)
    await protectSecret(page, 'grpc-matrix-grpc', 'grpc-only-secret')

    await verifyShares(page, '2/2 verified')
    expect(pageErrors).toEqual([])

    expect(relayRequests.length).toBeGreaterThan(0)
  })

  test('a helper offering both endpoints pairs, protects and verifies', async ({ page, pageErrors }) => {
    await setUpOwner(page, {
      name: 'Alice',
      participants: 2,
      prePaired: 0,
      minParticipants: 2,
      transports: { http: 0, grpc: 0, both: 2 },
    })

    const [first, second] = await helperNamesByMode(page, 'both', 2)
    await pairByName(page, first)
    await pairByName(page, second)
    await protectSecret(page, 'grpc-matrix-both', 'both-secret')

    await verifyShares(page, '2/2 verified')
    expect(pageErrors).toEqual([])
  })

  test('with the relay off, a grpc-only helper fails rather than hanging', async ({ page }) => {
    // A browser genuinely has no other way to reach a grpc-only peer, so the
    // library must surface that as a visible failure — not hang waiting for a
    // reply that can never arrive.
    //
    // The library's WASM bindings throw plain objects rather than `Error`s
    // (see `pageErrors` in `e2e/fixtures.ts`), which the app's generic
    // `err instanceof Error ? err.message : String(err)` catch renders as the
    // unhelpful literal "[object Object]" — a pre-existing gap in error
    // surfacing that predates this transport work and is out of scope to fix
    // here. So this asserts on what is actually verifiable: the relay call
    // the grpc-only leg depends on was made and rejected, an error became
    // visible on the row within a bounded time (not a hang), and the row
    // never reports success.
    let relayRespondedWith: number | undefined
    page.on('response', response => {
      if (response.url().endsWith('/derec/relay')) relayRespondedWith = response.status()
    })

    await page.route('**/derec/relay', route =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"relay disabled"}',
      }),
    )

    // `minParticipants` below 2 is rejected outright — a threshold that low
    // would let a single helper reconstruct the secret — so this still
    // provisions two participants even though only one is ever touched.
    await setUpOwner(page, {
      name: 'Alice',
      participants: 2,
      prePaired: 0,
      minParticipants: 2,
      transports: { http: 0, grpc: 2, both: 0 },
    })

    const [name] = await helperNamesByMode(page, 'grpc', 1)
    const row = participantRowByName(page, name)
    await expect(row).toHaveCount(1)

    await expandAndSelectMode(row, 'Inline keys')
    await row.getByRole('button', { name: 'Pair', exact: true }).click()

    // Surfaces rather than hangs: a visible error within a bounded time.
    await expect(row.locator('.field-error')).toBeVisible({ timeout: 30_000 })
    await expect(row.locator('.field-error')).not.toBeEmpty()

    // And it is genuinely this failure, not something unrelated: the relay
    // was actually called, on the browser's behalf, and rejected — the same
    // 503 the stub above returns — and pairing never succeeded.
    expect(relayRespondedWith).toBe(503)
    await expect(row.locator('.status-tag')).not.toHaveText('Paired')
  })
})
