// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { test, expect } from './fixtures'
import { setUpOwner } from './app'
import type { Browser, BrowserContext, Page } from '@playwright/test'

/**
 * A vault changes how it presents itself — its name — and a paired peer sees
 * the change: the protocol's `UpdateChannelInfo` round trip, end to end.
 *
 * Two browsers, because the receiving side is the half most likely to be
 * wrong: `ChannelInfoUpdated` names only the channel, and the new values have
 * to be read back from the store into the peer's row.
 */

async function newDevice(browser: Browser, name: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await context.newPage()
  await setUpOwner(page, { name, participants: 3, prePaired: 0, minParticipants: 2 })
  return { context, page }
}

/** An inline-keys contact's payload — no fingerprint gate to get through. */
async function contactPayload(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Share Contact' }).first().click()
  const modal = page.locator('.modal-overlay .modal')
  await modal.locator('.qr-wrapper svg').waitFor({ timeout: 60_000 })
  await modal.getByRole('button', { name: /Copy QR Payload/ }).click()
  const payload = await page.evaluate(() => navigator.clipboard.readText())
  await modal.getByRole('button', { name: 'Close' }).click()
  return payload
}

test('renaming a vault reaches its paired peer', async ({ browser }) => {
  const alice = await newDevice(browser, 'Alice')
  const bob = await newDevice(browser, 'Bob')

  try {
    // Bob pairs against Alice's contact; Alice accepts.
    const payload = await contactPayload(alice.page)
    await bob.page.getByRole('button', { name: 'Pair', exact: true }).first().click()
    const pairModal = bob.page.locator('.modal-overlay').last()
    await pairModal.locator('#qr-payload').fill(payload)
    await pairModal.getByRole('button', { name: /^Pair as/ }).click()
    await alice.page.getByRole('button', { name: 'Accept', exact: true }).click({ timeout: 60_000 })
    await expect(bob.page.getByText('Alice').first()).toBeVisible({ timeout: 60_000 })

    // Alice renames herself and tells every paired peer.
    await alice.page.getByRole('button', { name: 'Edit Identity' }).click()
    const dialog = alice.page.locator('[aria-labelledby="edit-identity-title"]')
    await dialog.locator('#identity-name').fill('Alice (laptop)')
    await dialog.getByRole('button', { name: 'Save and tell peers' }).click()

    // Her side: the peer acknowledged.
    await expect(dialog).toContainText('1 updated', { timeout: 60_000 })
    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(alice.page.locator('.owner-name')).toHaveText('Alice (laptop)')

    // Bob's side: the row for Alice now carries the new name.
    await expect(bob.page.getByText('Alice (laptop)').first()).toBeVisible({ timeout: 60_000 })
  } finally {
    await alice.context.close()
    await bob.context.close()
  }
})
