// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { test, expect } from './fixtures'
import {
  addAndPairReplica,
  backToVaults,
  openVault,
  protectSecret,
  setUpAnotherVault,
  setUpOwner,
  tabCount,
  uniqueReplicaName,
} from './app'
import type { Page } from '@playwright/test'

/**
 * Several vaults in one browser tab.
 *
 * Every vault the tab holds runs at once — polling, ticking, answering its
 * counterparties — and the route only picks which one is on screen. What these
 * guard is the two ways that goes wrong: one vault's state showing up in
 * another, and a vault off screen asking for a decision that nobody sees.
 */

/** Mint a contact on the vault on screen and return its payload, as the QR encodes it. */
async function contactPayload(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Share Contact' }).first().click()

  const modal = page.locator('.modal-overlay .modal')
  await modal.locator('.qr-wrapper svg').waitFor({ timeout: 60_000 })
  await modal.getByRole('button', { name: /Copy QR Payload/ }).click()
  const payload = await page.evaluate(() => navigator.clipboard.readText())
  await modal.getByRole('button', { name: 'Close' }).click()
  return payload
}

/** A row of the vault list, found by the vault's name. */
function vaultRow(page: Page, name: string) {
  return page.getByRole('row').filter({ has: page.getByText(name, { exact: true }) })
}

test('two vaults in one tab keep their state apart', async ({ page }) => {
  await setUpOwner(page, { name: 'Alpha', participants: 3, prePaired: 2, minParticipants: 2 })
  await protectSecret(page, 'Alpha seed', 'alpha-only')
  expect(await tabCount(page, 'Secrets')).toBeGreaterThan(0)

  await setUpAnotherVault(page, { name: 'Beta', prePaired: 0 })

  // Nothing of Alpha's reached Beta: no secret, and no channel paired.
  expect(await tabCount(page, 'Secrets')).toBe(0)
  await expect(page.locator('.side-participant-item .status-tag', { hasText: 'Paired' })).toHaveCount(0)

  // And Alpha lost nothing while Beta was on screen.
  await openVault(page, 'Alpha')
  expect(await tabCount(page, 'Secrets')).toBeGreaterThan(0)

  await backToVaults(page)
  await expect(vaultRow(page, 'Alpha')).toContainText('Running')
  await expect(vaultRow(page, 'Beta')).toContainText('Running')
})

/** The list's Bag column for a vault, as a number — `null` while it has no bag. */
async function listedBagVersion(page: Page, name: string): Promise<number | null> {
  const text = (await vaultRow(page, name).getByRole('cell').nth(3).innerText()).trim()
  return text.startsWith('v') ? Number(text.slice(1)) : null
}

/** The list's Replicas column for a vault. */
async function listedReplicaCount(page: Page, name: string): Promise<number> {
  return Number((await vaultRow(page, name).getByRole('cell').nth(4).innerText()).trim())
}

test('two vaults in one tab keep their bag versions and replica counts apart', async ({ page }) => {
  // Alpha: a protected secret and a replica. Beta: a protected secret of its
  // own, and no replica.
  await setUpOwner(page, { name: 'Alpha', participants: 3, prePaired: 2, minParticipants: 2 })
  await protectSecret(page, 'Alpha seed', 'alpha-only')
  await addAndPairReplica(page, uniqueReplicaName('Alpha-replica'))

  await setUpAnotherVault(page, { name: 'Beta', prePaired: 2 })
  await protectSecret(page, 'Beta seed', 'beta-only')

  await backToVaults(page)
  await expect.poll(() => listedBagVersion(page, 'Beta'), { timeout: 30_000 }).toBe(1)
  await expect.poll(() => listedReplicaCount(page, 'Alpha'), { timeout: 30_000 }).toBe(1)
  expect(await listedReplicaCount(page, 'Beta')).toBe(0)
  const alphaBefore = await listedBagVersion(page, 'Alpha')
  expect(alphaBefore).not.toBeNull()

  // A new version of Alpha's bag moves Alpha's number, and only Alpha's.
  await openVault(page, 'Alpha')
  await protectSecret(page, 'Alpha second', 'alpha-again')
  await backToVaults(page)

  await expect
    .poll(() => listedBagVersion(page, 'Alpha'), { timeout: 30_000 })
    .toBeGreaterThan(alphaBefore ?? 0)
  expect(await listedBagVersion(page, 'Beta')).toBe(1)
  expect(await listedReplicaCount(page, 'Alpha')).toBe(1)
  expect(await listedReplicaCount(page, 'Beta')).toBe(0)
})

test('a vault off screen that needs a decision says so without interrupting', async ({ browser }) => {
  const first = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const second = await browser.newContext()

  try {
    const page = await first.newPage()
    await setUpOwner(page, { name: 'Alpha', participants: 3, prePaired: 0, minParticipants: 2 })
    await setUpAnotherVault(page, { name: 'Beta', prePaired: 0 })
    const betaContact = await contactPayload(page)
    await openVault(page, 'Alpha')

    // A second device pairs with Beta while Alpha is on screen.
    const other = await second.newPage()
    await setUpOwner(other, { name: 'Carol', participants: 3, prePaired: 0, minParticipants: 2 })
    await other.getByRole('button', { name: 'Pair', exact: true }).first().click()
    const pairModal = other.locator('.modal-overlay').last()
    await pairModal.locator('#qr-payload').fill(betaContact)
    await pairModal.getByRole('button', { name: /^Pair as/ }).click()

    // Alpha's page is told, in words, and not interrupted: the decision is Beta's.
    await expect(page.getByRole('button', { name: '1 other vault needs your decision' }))
      .toBeVisible({ timeout: 60_000 })
    const banner = page.getByRole('button', { name: /^Beta: Waiting for your decision/ })
    await expect(banner).toBeVisible()
    await expect(page.getByRole('button', { name: 'Accept', exact: true })).toBeHidden()

    // The banner leads to Beta, where the request is waiting.
    await banner.click()
    await expect(page.getByRole('button', { name: 'Accept', exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: /other vaults? needs? your decision/ })).toBeHidden()
  } finally {
    await first.close()
    await second.close()
  }
})
