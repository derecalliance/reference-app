// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { test, expect } from './fixtures'
import {
  addAndPairReplica,
  backToSecrets,
  openSecret,
  protectSecret,
  setUpAnotherSecret,
  setUpOwner,
  tabCount,
  uniqueReplicaName,
} from './app'
import type { Page } from '@playwright/test'

/**
 * Several secrets in one browser tab.
 *
 * Every secret the tab holds runs at once — polling, ticking, answering its
 * counterparties — and the route only picks which one is on screen. What these
 * guard is the two ways that goes wrong: one secret's state showing up in
 * another, and a secret off screen asking for a decision that nobody sees.
 */

/** Mint a contact on the secret on screen and return its payload, as the QR encodes it. */
async function contactPayload(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Share Contact' }).first().click()

  const modal = page.locator('.modal-overlay .modal')
  await modal.locator('.qr-wrapper svg').waitFor({ timeout: 60_000 })
  await modal.getByRole('button', { name: /Copy QR Payload/ }).click()
  const payload = await page.evaluate(() => navigator.clipboard.readText())
  await modal.getByRole('button', { name: 'Close' }).click()
  return payload
}

/** A row of the secret list, found by the secret's name. */
function secretRow(page: Page, name: string) {
  return page.getByRole('row').filter({ has: page.getByText(name, { exact: true }) })
}

test('two secrets in one tab keep their state apart', async ({ page }) => {
  await setUpOwner(page, { name: 'Alpha', participants: 3, prePaired: 2, minParticipants: 2 })
  await protectSecret(page, 'Alpha seed', 'alpha-only')
  expect(await tabCount(page, 'Items')).toBeGreaterThan(0)

  await setUpAnotherSecret(page, { name: 'Beta', prePaired: 0 })

  // Nothing of Alpha's reached Beta: no secret, and no channel paired.
  expect(await tabCount(page, 'Items')).toBe(0)
  await expect(page.locator('.side-participant-item .status-tag', { hasText: 'Paired' })).toHaveCount(0)

  // And Alpha lost nothing while Beta was on screen.
  await openSecret(page, 'Alpha')
  expect(await tabCount(page, 'Items')).toBeGreaterThan(0)

  await backToSecrets(page)
  await expect(secretRow(page, 'Alpha')).toContainText('Running')
  await expect(secretRow(page, 'Beta')).toContainText('Running')
})

/** The list's Bag column for a secret, as a number — `null` while it has no bag. */
async function listedBagVersion(page: Page, name: string): Promise<number | null> {
  const text = (await secretRow(page, name).getByRole('cell').nth(3).innerText()).trim()
  return text.startsWith('v') ? Number(text.slice(1)) : null
}

/** The list's Replicas column for a secret. */
async function listedReplicaCount(page: Page, name: string): Promise<number> {
  return Number((await secretRow(page, name).getByRole('cell').nth(4).innerText()).trim())
}

test('two secrets in one tab keep their bag versions and replica counts apart', async ({ page }) => {
  // Each phase is a step, so a timeout names the phase it happened in. This
  // test once timed out in a full run with nothing to say where, and it has
  // not been reproduced since.

  // Alpha: a protected secret and a replica. Beta: a protected secret of its
  // own, and no replica.
  await test.step('Alpha protects a secret and pairs a replica', async () => {
    await setUpOwner(page, { name: 'Alpha', participants: 3, prePaired: 2, minParticipants: 2 })
    await protectSecret(page, 'Alpha seed', 'alpha-only')
    await addAndPairReplica(page, uniqueReplicaName('Alpha-replica'))
  })

  await test.step('Beta is set up and protects a secret', async () => {
    await setUpAnotherSecret(page, { name: 'Beta', prePaired: 2 })
    await protectSecret(page, 'Beta seed', 'beta-only')
  })

  const alphaBefore = await test.step('the list shows each secret its own numbers', async () => {
    await backToSecrets(page)
    await expect.poll(() => listedBagVersion(page, 'Beta'), { timeout: 30_000 }).toBe(1)
    await expect.poll(() => listedReplicaCount(page, 'Alpha'), { timeout: 30_000 }).toBe(1)
    expect(await listedReplicaCount(page, 'Beta')).toBe(0)
    const version = await listedBagVersion(page, 'Alpha')
    expect(version).not.toBeNull()
    return version
  })

  // A new version of Alpha's bag moves Alpha's number, and only Alpha's.
  await test.step('Alpha publishes a new version', async () => {
    await openSecret(page, 'Alpha')
    await protectSecret(page, 'Alpha second', 'alpha-again')
    await backToSecrets(page)
  })

  await test.step('only Alpha’s number moved', async () => {
    await expect
      .poll(() => listedBagVersion(page, 'Alpha'), { timeout: 30_000 })
      .toBeGreaterThan(alphaBefore ?? 0)
    expect(await listedBagVersion(page, 'Beta')).toBe(1)
    expect(await listedReplicaCount(page, 'Alpha')).toBe(1)
    expect(await listedReplicaCount(page, 'Beta')).toBe(0)
  })
})

test('a secret off screen that needs a decision says so without interrupting', async ({ browser }) => {
  const first = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const second = await browser.newContext()

  try {
    const page = await first.newPage()
    await setUpOwner(page, { name: 'Alpha', participants: 3, prePaired: 0, minParticipants: 2 })
    await setUpAnotherSecret(page, { name: 'Beta', prePaired: 0 })
    const betaContact = await contactPayload(page)
    await openSecret(page, 'Alpha')

    // A second device pairs with Beta while Alpha is on screen.
    const other = await second.newPage()
    await setUpOwner(other, { name: 'Carol', participants: 3, prePaired: 0, minParticipants: 2 })
    await other.getByRole('button', { name: 'Pair', exact: true }).first().click()
    const pairModal = other.locator('.modal-overlay').last()
    await pairModal.locator('#qr-payload').fill(betaContact)
    await pairModal.getByRole('button', { name: /^Pair as/ }).click()

    // Alpha's page is told, in words, and not interrupted: the decision is Beta's.
    await expect(page.getByRole('button', { name: '1 other secret needs your decision' }))
      .toBeVisible({ timeout: 60_000 })
    const banner = page.getByRole('button', { name: /^Beta: Waiting for your decision/ })
    await expect(banner).toBeVisible()
    await expect(page.getByRole('button', { name: 'Accept', exact: true })).toBeHidden()

    // The banner leads to Beta, where the request is waiting.
    await banner.click()
    await expect(page.getByRole('button', { name: 'Accept', exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: /other secrets? needs? your decision/ })).toBeHidden()
  } finally {
    await first.close()
    await second.close()
  }
})
