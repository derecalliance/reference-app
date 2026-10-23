// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { Locator, Page } from '@playwright/test'

import { test, expect } from './fixtures'
import { openTab, protectSecret, setUpOwner } from './app'

/**
 * The owner's standing controls (SDK 0.0.9 share retention): Vault Settings
 * choose which versions helpers keep and when this device deletes old
 * verification copies, and how often shares are verified on their own.
 */

/** Open Vault Settings, let `edit` change it, and save. */
async function editVaultSettings(page: Page, edit: (dialog: Locator) => Promise<void>): Promise<void> {
  await page.getByRole('button', { name: 'Vault Settings', exact: true }).click()
  const dialog = page.locator('.modal-overlay[aria-label="Vault settings"]')
  await edit(dialog)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()
}

/** Pick a Vault Settings option: its label is the hit target, the radio itself is hidden. */
async function choose(dialog: Locator, id: string): Promise<void> {
  await dialog.locator(`label[for="${id}"]`).click()
  await expect(dialog.locator(`#${id}`)).toBeChecked()
}

/** The versions Clean up lists, i.e. those this device still holds copies of. */
async function versionsWithCopies(page: Page): Promise<string[]> {
  await openTab(page, 'Secrets')
  await page.getByRole('button', { name: 'Clean up…' }).click()
  const dialog = page.locator('.modal-overlay[aria-label="Clean up verification copies"]')
  await expect(dialog).toBeVisible()
  const ids = await dialog.locator('input[id^="cu-"]').evaluateAll(els => els.map(el => el.id.slice(3)))
  await dialog.getByRole('button', { name: /^(Cancel|Done)$/ }).click()
  await expect(dialog).toBeHidden()
  return ids
}

test('"choose at each publish" asks which versions to keep, and automatic cleanup keeps only the newest copies', async ({ page, pageErrors }) => {
  test.setTimeout(300_000)

  await setUpOwner(page, { name: 'Alice', participants: 2, prePaired: 2, minParticipants: 2 })
  await protectSecret(page, 'First', 'one')
  await protectSecret(page, 'Second', 'two')
  await expect.poll(() => versionsWithCopies(page), { timeout: 60_000 }).toHaveLength(2)

  await editVaultSettings(page, async dialog => {
    await choose(dialog, 'vs-retention-select')
    await choose(dialog, 'vs-cleanup-auto')
    await choose(dialog, 'vs-cleanup-lastN')
    await dialog.locator('#vs-cleanup-n').fill('1')
  })

  // The publish dialog now lists the committed versions instead of a legend;
  // keep none of them.
  await page.getByRole('button', { name: 'Add Secret', exact: true }).click()
  const form = page.locator('.modal-overlay[aria-label="Add secret"] .modal')
  await expect(form).toContainText('Choose the earlier versions helpers keep')
  const optional = form.locator('input[id^="po-keep-"]:not([disabled])')
  await expect(optional).toHaveCount(2)
  for (const box of await optional.all()) await box.uncheck()
  await form.locator('#ps-name').fill('Third')
  await form.getByLabel('Secret data').fill('three')
  await form.getByRole('button', { name: 'Add Secret', exact: true }).click()
  const overlay = page.locator('.modal-overlay[aria-label="Add secret"]')
  await expect(overlay.getByRole('button', { name: 'Done' })).toBeVisible({ timeout: 90_000 })
  await overlay.getByRole('button', { name: 'Done' }).click()

  // Once the new version commits, "keep the last 1" deletes every earlier
  // version's copies without the owner opening Clean up.
  await expect.poll(() => versionsWithCopies(page), { timeout: 120_000 }).toHaveLength(1)

  expect(pageErrors).toEqual([])
})

test('periodic verification checks the shares on its own schedule', async ({ page, pageErrors }) => {
  // The shortest schedule is one minute, and the first check is one interval
  // after it is set.
  test.setTimeout(300_000)

  await setUpOwner(page, { name: 'Bob', participants: 2, prePaired: 2, minParticipants: 2 })
  await protectSecret(page, 'Passphrase', 'hunter2')
  await openTab(page, 'Secrets')
  const summary = page.locator('.verified-summary').first()
  await expect(summary).toHaveText('0/2 verified')

  await editVaultSettings(page, async dialog => {
    await dialog.locator('#vs-verify-auto').check()
    await dialog.locator('#vs-verify-every').fill('1')
    await dialog.locator('#vs-verify-unit').selectOption('minutes')
  })

  // Nobody presses Verify Shares.
  await expect(summary).toHaveText('2/2 verified', { timeout: 180_000 })
  await expect(page.getByText(/recoverable — 2 of 2 subshares verified/)).toBeVisible()

  expect(pageErrors).toEqual([])
})
